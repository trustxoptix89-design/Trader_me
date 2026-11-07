import { runSymbolOnce, type QualityByTimeframe, type RunnerDeps, type RunnerOutcome } from "./runner";

/**
 * Operational cycle for ONE symbol: guarded execution around the P6 runner.
 *  - run id + per-stage durations + retry counts + failure causes in a report
 *  - timeout at every awaited stage (a synchronous CPU step cannot be interrupted; only awaited I/O is raced)
 *  - bounded retry ONLY on the read stage (I/O). The write stage is never retried: a retry could duplicate DB rows; the recorders are idempotent
 *    and a repeated run is detected as `duplicate`.
 *  - in-process guard against concurrent runs of the same symbol/market
 *  - an output older than `maxAgeMs` (from the start of the cycle) is EXPIRED and not emitted
 * Decision label mapping (see labelOf) uses only statuses that exist in V6 code; CONDITIONAL_BUY has no approved rule and is never produced.
 */
export type SignalLabel = "BUY_NOW" | "CONDITIONAL_BUY" | "WAIT" | "REJECT" | "INSUFFICIENT_DATA";

export class StageTimeoutError extends Error {
  constructor(public readonly stage: string, public readonly ms: number) { super(`TIMEOUT: stage ${stage} exceeded ${ms}ms`); this.name = "StageTimeoutError"; }
}
export function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StageTimeoutError(stage, ms)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface RetryPolicy { maxAttempts: number; backoffMs: number; sleep?: (ms: number) => Promise<void> }
export interface CycleDeps extends RunnerDeps {
  newRunId: () => string;
  /** Caller-supplied limits: this module chooses no numbers. */
  limits: { readTimeoutMs: number; pipelineTimeoutMs: number; maxAgeMs: number; retry: RetryPolicy };
  inflight?: Set<string>;
}

/** READ: `attempts` = the largest number of tries any single read needed, `retries` = total extra tries across all reads. */
export interface StageRecord { stage: "READ" | "PIPELINE"; attempts: number; retries: number; durationMs: number; error: string | null }
export interface SignalOutput { symbol: string; market: "spot" | "futures"; direction: "long" | "short" | null; entry: number; stopLoss: number; targets: number[]; riskReward: number | null; decision: SignalLabel; signalId: string; timestamp: number }
export interface CycleReport {
  runId: string; symbol: string; market: "spot" | "futures"; startedAt: number; finishedAt: number; durationMs: number;
  stages: StageRecord[];
  outcome: RunnerOutcome | { kind: "SKIPPED"; reason: string } | { kind: "FAILED"; stage: string; reason: string } | { kind: "EXPIRED"; reason: string };
  label: SignalLabel; reason: string;
  quality: QualityByTimeframe | null;
  duplicate: boolean; persistenceUnknown: boolean;
  signal: SignalOutput | null;
}

const DATA_REASONS = ["DATA_", "INSUFFICIENT", "AGENT_FAILURE", "PIPELINE_ERROR", "AUDIT_FAILURE", "TREND_SETUP_UNAVAILABLE", "ATR_UNAVAILABLE", "RANGE_SETUP_MISMATCH", "FUTURES_", "TIMEOUT", "EXPIRED", "CONCURRENT"];
/** Mapping of the machine/runner outcome to the five output labels. approved -> BUY_NOW, rejected -> REJECT, data/infrastructure problems -> INSUFFICIENT_DATA, any other inconclusive (conflict, no setup, risk/Elite no-trade) -> WAIT. */
export function labelOf(o: CycleReport["outcome"]): { label: SignalLabel; reason: string } {
  const dataLike = (r: string): boolean => DATA_REASONS.some((p) => r.startsWith(p));
  switch (o.kind) {
    case "BLOCKED": return { label: "INSUFFICIENT_DATA", reason: o.reason };
    case "SKIPPED": case "FAILED": case "EXPIRED": return { label: "INSUFFICIENT_DATA", reason: o.reason };
    case "ABSTAIN": return { label: o.stage === "DATA" || dataLike(o.reason) ? "INSUFFICIENT_DATA" : "WAIT", reason: o.reason };
    case "PIPELINE": {
      const r = o.result.haltReason ?? "approved";
      if (!o.result.auditPersisted) return { label: "INSUFFICIENT_DATA", reason: "AUDIT_FAILURE: decision not persisted" };
      if (o.result.status === "approved") return { label: "BUY_NOW", reason: r };
      if (o.result.status === "rejected") return { label: "REJECT", reason: r };
      return { label: dataLike(r) ? "INSUFFICIENT_DATA" : "WAIT", reason: r };
    }
  }
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runCycle(deps: CycleDeps, req: { symbol: string; market: "spot" | "futures" }): Promise<CycleReport> {
  const startedAt = deps.now(), runId = deps.newRunId();
  const key = `${req.market}:${req.symbol}`, inflight = deps.inflight ?? defaultInflight;
  const stages: StageRecord[] = [];
  const done = (outcome: CycleReport["outcome"], extra: Partial<CycleReport> = {}): CycleReport => {
    const { label, reason } = labelOf(outcome);
    const finishedAt = deps.now();
    return { runId, symbol: req.symbol, market: req.market, startedAt, finishedAt, durationMs: finishedAt - startedAt, stages, outcome, label, reason, quality: null, duplicate: false, persistenceUnknown: false, signal: null, ...extra };
  };
  if (inflight.has(key)) return done({ kind: "SKIPPED", reason: `CONCURRENT_RUN: ${key} is already running` });
  inflight.add(key);
  try {
    // READ stage: loadRows is wrapped so a transient I/O error / timeout is retried (bounded); data problems are NOT retried.
    let attempts = 0, retries = 0, readError: string | null = null;
    const t0 = deps.now();
    const sleep = deps.limits.retry.sleep ?? sleepReal;
    let outcome: RunnerOutcome | null = null;
    const guardedLoad: RunnerDeps["loadRows"] = async (s, tf, n) => {
      for (let tries = 1; ; tries++) {
        attempts = Math.max(attempts, tries);
        try { return await withTimeout(deps.loadRows(s, tf, n), deps.limits.readTimeoutMs, `READ:${tf}`); }
        catch (e) {
          readError = e instanceof Error ? e.message : String(e);
          if (tries >= deps.limits.retry.maxAttempts) throw e;
          retries++;
          await sleep(deps.limits.retry.backoffMs * tries);
        }
      }
    };
    // The runner reads, checks quality, builds the Setup and runs the pipeline. Reading and writing are separate awaits: the timeout for the whole pipeline stage covers both.
    const t1 = deps.now();
    try {
      outcome = await withTimeout(runSymbolOnce({ ...deps, loadRows: guardedLoad }, req), deps.limits.pipelineTimeoutMs, "PIPELINE");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stages.push({ stage: "READ", attempts, retries, durationMs: deps.now() - t0, error: readError });
      stages.push({ stage: "PIPELINE", attempts: 1, retries: 0, durationMs: deps.now() - t1, error: msg });
      const timeout = e instanceof StageTimeoutError;
      return done({ kind: "FAILED", stage: timeout ? e.stage : "PIPELINE", reason: timeout ? msg : `PIPELINE_ERROR: ${msg}` }, { persistenceUnknown: timeout && e.stage === "PIPELINE" });
    }
    stages.push({ stage: "READ", attempts: Math.max(attempts, 1), retries, durationMs: deps.now() - t0, error: readError && retries > 0 ? `recovered after retry: ${readError}` : null });
    stages.push({ stage: "PIPELINE", attempts: 1, retries: 0, durationMs: deps.now() - t1, error: null });
    const quality = "quality" in outcome && outcome.quality ? outcome.quality : null;
    if (outcome.kind === "PIPELINE" && deps.now() - startedAt > deps.limits.maxAgeMs)
      return done({ kind: "EXPIRED", reason: `EXPIRED: cycle took ${deps.now() - startedAt}ms > maxAgeMs ${deps.limits.maxAgeMs}; output not emitted` }, { quality, duplicate: outcome.result.duplicate, persistenceUnknown: false });
    const rep = done(outcome, { quality });
    if (outcome.kind === "PIPELINE") {
      rep.duplicate = outcome.result.duplicate;
      // Signal output only for a fresh (non-duplicate) BUY_NOW: repeated runs never re-emit.
      if (rep.label === "BUY_NOW" && !rep.duplicate) {
        rep.signal = { symbol: req.symbol, market: req.market, direction: outcome.result.direction ?? null, entry: outcome.setup.entry, stopLoss: outcome.setup.invalidation, targets: outcome.setup.targets, riskReward: outcome.result.rr ?? null, decision: "BUY_NOW", signalId: outcome.result.signalId, timestamp: startedAt };
      }
    }
    return rep;
  } finally { inflight.delete(key); }
}
const defaultInflight = new Set<string>();
