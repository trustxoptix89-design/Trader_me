import { runCycle, type CycleDeps, type CycleReport, type SignalLabel, type SignalOutput } from "./cycle";

/**
 * Pipeline scheduler (TEST ENVIRONMENT ONLY: not wired into api/boot.ts, not deployed). It is separate from the legacy alert scheduler (api/scheduler.ts),
 * which is untouched. One tick = discover symbols -> one guarded cycle per symbol (sequential) -> tick report.
 * Overlapping ticks are refused; a failing cycle never stops the tick; repeated decisions are not re-emitted.
 */
export interface TickReport {
  tickId: string; startedAt: number; finishedAt: number;
  symbols: string[]; discoveryError: string | null;
  runs: CycleReport[];
  counts: Record<SignalLabel, number> & { skipped: number; duplicates: number; failed: number };
  newSignals: SignalOutput[];
}
export interface SchedulerDeps {
  cycle: Omit<CycleDeps, "newRunId"> & { newRunId: () => string };
  /** Market Discovery port. Returns the symbols to analyse this tick. */
  discover: () => Promise<string[]>;
  newTickId: () => string;
  market?: "spot";
  /** Observability sink (log / outbox): receives every completed tick report. */
  onTick?: (r: TickReport) => void | Promise<void>;
}

const emptyCounts = (): TickReport["counts"] => ({ BUY_NOW: 0, CONDITIONAL_BUY: 0, WAIT: 0, REJECT: 0, INSUFFICIENT_DATA: 0, skipped: 0, duplicates: 0, failed: 0 });

export function createPipelineScheduler(deps: SchedulerDeps) {
  let ticking = false;
  const emitted = new Set<string>(); // signalIds already surfaced in this process (the DB duplicate guard is the durable one)

  async function tick(): Promise<TickReport | { skipped: "TICK_IN_PROGRESS" }> {
    if (ticking) return { skipped: "TICK_IN_PROGRESS" };
    ticking = true;
    const startedAt = deps.cycle.now();
    const report: TickReport = { tickId: deps.newTickId(), startedAt, finishedAt: startedAt, symbols: [], discoveryError: null, runs: [], counts: emptyCounts(), newSignals: [] };
    try {
      try { report.symbols = [...new Set(await deps.discover())]; }
      catch (e) { report.discoveryError = e instanceof Error ? e.message : String(e); }
      for (const symbol of report.symbols) {
        let r: CycleReport;
        try { r = await runCycle(deps.cycle, { symbol, market: deps.market ?? "spot" }); }
        catch (e) {
          // runCycle already converts failures to reports; this is a last-resort guard so one symbol can never stop the tick.
          const msg = e instanceof Error ? e.message : String(e);
          report.counts.failed++; report.counts.INSUFFICIENT_DATA++;
          report.runs.push({ runId: "unassigned", symbol, market: "spot", startedAt, finishedAt: deps.cycle.now(), durationMs: 0, stages: [], outcome: { kind: "FAILED", stage: "CYCLE", reason: `CYCLE_ERROR: ${msg}` }, label: "INSUFFICIENT_DATA", reason: `CYCLE_ERROR: ${msg}`, quality: null, duplicate: false, persistenceUnknown: false, signal: null });
          continue;
        }
        report.runs.push(r);
        report.counts[r.label]++;
        if (r.outcome.kind === "SKIPPED") report.counts.skipped++;
        if (r.outcome.kind === "FAILED") report.counts.failed++;
        if (r.duplicate) report.counts.duplicates++;
        if (r.signal && !emitted.has(r.signal.signalId)) { emitted.add(r.signal.signalId); report.newSignals.push(r.signal); }
      }
      report.finishedAt = deps.cycle.now();
      if (deps.onTick) { try { await deps.onTick(report); } catch { /* observability must not break the scheduler */ } }
      return report;
    } finally { ticking = false; }
  }

  let timer: unknown = null;
  return {
    tick,
    start(intervalMs: number, set: (fn: () => void, ms: number) => unknown = setInterval): void {
      if (timer !== null) throw new Error("scheduler already started");
      timer = set(() => { void tick(); }, intervalMs);
    },
    stop(clear: (t: unknown) => void = (t) => clearInterval(t as ReturnType<typeof setInterval>)): void { if (timer !== null) { clear(timer); timer = null; } },
    get running(): boolean { return timer !== null; },
  };
}
