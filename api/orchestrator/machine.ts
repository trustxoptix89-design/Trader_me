import { createHash } from "node:crypto";
import type { Candle } from "@contracts/types";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import type { DeltaRangeOutput, DeltaTrendOutput, EliteCouncilOutput, ElitePayload } from "../types/advanced";
import { approvalConfigFrom, approvalRoom, type ApprovalConfig, type ApprovalDecision } from "./approval";
import { canonical, InMemoryAuditStore, recoverInterrupted, type AuditEvent, type AuditKind, type AuditStore, type StoredAuditEvent } from "./audit";
import { chartQualityRoom, type ChartClaims } from "./chartQuality";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";
import { DELTA_AGENT_ID, deltaForceVote } from "./deltaAgent";
import { evaluateEliteCouncil } from "./elite";
import { dataRoom, errorDetectionRoom, riskRoom, type AgentVote, type RoomResult } from "./rooms";
import type { AtomicDecisionRecorder } from "../pipeline/decisionRecorder";
import { cycleKey as cycleKeyOf, type Observation } from "../pipeline/signalIdentity";
import { checkRangeSetupIntegrity } from "../pipeline/setupIntegrity";
import { AGENT_TIMEFRAMES, buildAgentRunRecords, type AgentFailure } from "./agentRuns";
import type { IdentifiedAgent } from "./agents";
import type { AtomicAgentsRunRecorder } from "../pipeline/agentsRunRecorder";
import { signalIdFromKey, signalKey } from "../pipeline/signalIdentity";
import { independentVerifier, type VerifierResult } from "./verifier";

/** The pipeline states of the specification (Phase D), in order. POST_MORTEM happens after an outcome and is not part of this run. */
export const PIPELINE_STATES = ["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RISK_CHECKED", "GATED", "RECORDED", "NOTIFIED"] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];
export type SignalStatus = "approved" | "rejected" | "inconclusive";

/**
 * Allowed transitions. Any state before GATED may also jump to RECORDED (HALT / ESCALATE / error path); GATED can only go to RECORDED;
 * nothing may leave RECORDED except to NOTIFIED; NOTIFIED is terminal; no state may be re-entered or skipped on the happy path.
 * See docs/STATE_MACHINE.md.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
  DETECTED: ["DATA_VALIDATED", "RECORDED"],
  DATA_VALIDATED: ["INDICATORS_READY", "RECORDED"],
  INDICATORS_READY: ["AGENTS_RUN", "RECORDED"],
  AGENTS_RUN: ["RECONCILED", "RECORDED"],
  RECONCILED: ["RISK_CHECKED", "RECORDED"],
  RISK_CHECKED: ["GATED", "RECORDED"],
  GATED: ["RECORDED"],
  RECORDED: ["NOTIFIED"],
  NOTIFIED: [],
};
export function isAllowedTransition(from: PipelineState | null, to: PipelineState): boolean {
  return from === null ? to === "DETECTED" : ALLOWED_TRANSITIONS[from].includes(to);
}

const TF_MS = { "4H": 14_400_000, "1H": 3_600_000, "15m": 900_000, "5m": 300_000 } as const;
const TIMEFRAMES = ["4H", "1H", "15m", "5m"] as const;

export interface AgentContext {
  candles: PipelineInput["candles"];
  trend: DeltaTrendOutput;
  range?: DeltaRangeOutput;
}

export interface PipelineInput {
  symbol: string;
  market: "spot" | "futures";
  /** Decision timeframe recorded in the audit log. The decision candles are the "1H" series. */
  timeframe?: string;
  /** Epoch ms used for freshness and audit timestamps (injected so runs are reproducible). */
  now: number;
  candles: { "4H": Candle[]; "1H": Candle[]; "15m": Candle[]; "5m": Candle[] };
  setup: { entry: number; invalidation: number; targets: number[]; atr: number; liquidationDistance?: number; fundingRate?: number };
  /** Chart claims (S/R levels, BOS and sweep markers) checked by the Chart Quality Room. */
  chart?: ChartClaims;
  /** Other deterministic agents. Delta Force is always run by the machine itself. */
  agents?: Array<((ctx: AgentContext) => AgentVote) | IdentifiedAgent>;
  /** Learned agent weights (post-mortem). They never override the Delta Force ULTRA_TREND weight. */
  weights?: Record<string, number>;
  source?: string;
  primarySource?: string;
  /** Effective governance parameters. Defaults to the shipped, validated config (see config.ts). */
  config?: GovernanceConfig;
  /** Per-run approval overrides; prefer `config`. */
  approval?: Partial<ApprovalConfig>;
  /** Defaults to evaluateEliteCouncil (deterministic heuristic + circuit breaker). */
  elite?: (payload: ElitePayload) => Promise<EliteCouncilOutput>;
  /** Durable audit store. Defaults to an in-memory store (NOT durable): production callers must pass PostgresAuditStore. */
  audit?: AuditStore;
  notify?: (result: PipelineResult) => Promise<void> | void;
  /** When set, the per-agent run records and the AGENTS_RUN audit event are persisted together through this recorder (one transaction on Postgres). */
  agentRuns?: { recorder: AtomicAgentsRunRecorder; versions?: Record<string, string> };
  /** When set, the DECISION event, the Setup cycle events and the internal Outbox row are persisted together (one transaction on Postgres). */
  decision?: { recorder: AtomicDecisionRecorder };
}

export interface PipelineResult {
  signalId: string;
  correlationId: string;
  status: SignalStatus;
  haltReason?: string;
  direction?: "long" | "short";
  mode: "trend" | "range";
  statesVisited: PipelineState[];
  /** Events of this correlation id as read back from the audit store. */
  events: StoredAuditEvent[];
  votes: AgentVote[];
  trend?: DeltaTrendOutput;
  range?: DeltaRangeOutput;
  rooms: RoomResult[];
  approval?: ApprovalDecision;
  verifier?: VerifierResult;
  rr?: number;
  notified: boolean;
  /** True when this request repeated an already decided correlation id: nothing was re-executed or re-written. */
  duplicate: boolean;
  /** False when the audit store failed: the outcome is then never approved. */
  auditPersisted: boolean;
}

const sha = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
const finiteNums = (...xs: unknown[]): boolean => xs.every((x) => typeof x === "number" && Number.isFinite(x));

/**
 * Deterministic orchestrator. The machine is only a protocol runner: it decides nothing analytically.
 * Hard invariants (tested):
 *  - approval requires: valid data, no room HALT/ESCALATE, Approval Room APPROVED, Independent Verifier OK and a persisted DECISION event;
 *  - any HALT / ESCALATE / error jumps to RECORDED (rejected for a Risk Room halt, inconclusive otherwise);
 *  - NOTIFIED is reached only after an approved DECISION has been persisted;
 *  - a repeated correlation id never re-executes and never writes a second record.
 */
export async function runSignalPipeline(input: PipelineInput): Promise<PipelineResult> {
  const cfg = input.config ?? DEFAULT_GOVERNANCE_CONFIG;
  const store = input.audit ?? new InMemoryAuditStore();
  const timeframe = input.timeframe ?? "1H";
  const direction: "long" | "short" | undefined = !finiteNums(input.setup?.entry) || !Array.isArray(input.setup?.targets) || !finiteNums(input.setup.targets[0]) ? undefined : input.setup.targets[0] > input.setup.entry ? "long" : "short";
  /** Deterministic identity (P2): no `now`; same market/direction/setup/closed candle/config => same id. Malformed input falls back to the legacy hash so it is still audited. */
  const lastClosedOpen = (() => { const c = input.candles?.[timeframe as "1H"]; const t = Array.isArray(c) && c.length ? c[c.length - 1]?.time : undefined; return typeof t === "number" ? t : undefined; })();
  const signalId = (() => {
    try {
      if (direction === undefined || lastClosedOpen === undefined) throw new Error("no identity");
      return signalIdFromKey(signalKey({ symbol: input.symbol, market: input.market, direction, referenceTimeframe: timeframe, lastClosedCandleOpenTime: lastClosedOpen, setup: { entry: input.setup.entry, invalidation: input.setup.invalidation, targets: input.setup.targets, atr: input.setup.atr }, configFingerprint: cfg.fingerprint }));
    } catch {
      return `${input.symbol}-${input.now}-${sha({ s: input.setup, m: input.market, tf: timeframe, c: cfg.fingerprint }).slice(0, 8)}`;
    }
  })();
  const correlationId = signalId;

  const visited: PipelineState[] = [];
  const rooms: RoomResult[] = [];
  const roomVerdicts: Record<string, unknown> = {};
  let votes: AgentVote[] = [];
  let trend: DeltaTrendOutput | undefined;
  let range: DeltaRangeOutput | undefined;
  let approval: ApprovalDecision | undefined;
  let verifier: VerifierResult | undefined;
  let riskResult: RoomResult | null = null;
  let rr: number | undefined;
  let freshnessMs: number | null = null;
  let dataValid: boolean | null = null;
  let decided: { status: SignalStatus; reason?: string } | undefined;
  let seq = 0;

  let inputDataHash = "unhashable";
  try { inputDataHash = sha({ symbol: input.symbol, now: input.now, tf: TIMEFRAMES.map((t) => (input.candles?.[t] ?? []).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume])) }); } catch { /* recorded as "unhashable" */ }

  /** Returns true when this call stored the event, false when an identical event (same idempotency key) already existed. */
  const emit = async (kind: AuditKind, state: PipelineState | null, extra: Partial<AuditEvent> = {}, via?: (e: AuditEvent) => Promise<StoredAuditEvent | null>): Promise<boolean> => {
    const event: AuditEvent = {
      correlationId, seq, kind, state, symbol: input.symbol, timeframe, timestamp: input.now, inputDataHash, dataFreshnessMs: freshnessMs, dataValid,
      roomVerdicts: { ...roomVerdicts }, riskResult, verifierResult: verifier ?? null, decision: null, reason: null,
      configVersion: cfg.version, configFingerprint: cfg.fingerprint, idempotencyKey: `${correlationId}:${seq}:${kind}`, detail: null, ...extra,
    };
    const stored = await (via ? via(event) : store.append(event));
    seq++;
    return stored !== null;
  };
  const transition = async (to: PipelineState, verdict: string, reason: string, more?: { detail?: Record<string, unknown>; via?: (e: AuditEvent) => Promise<StoredAuditEvent | null> }): Promise<void> => {
    const from = visited.length ? visited[visited.length - 1] : null;
    if (!isAllowedTransition(from, to)) throw new Error(`FORBIDDEN_TRANSITION ${from ?? "START"} -> ${to}`);
    visited.push(to);
    await emit("STATE_TRANSITION", to, { reason, detail: { from, to, verdict, ...(more?.detail ?? {}) } }, more?.via);
  };
  const roomEvent = async (r: RoomResult, state: PipelineState): Promise<void> => {
    rooms.push(r);
    roomVerdicts[r.room] = { status: r.status, reason: r.reason, flags: r.flags, metrics: r.metrics };
    await emit("ROOM_VERDICT", state, { reason: r.reason, detail: { room: r.room, status: r.status } });
  };
  const mode = (): "trend" | "range" => (range ? "range" : "trend");
  const snapshot = async (extra: Partial<PipelineResult>): Promise<PipelineResult> => {
    let events: StoredAuditEvent[] = [];
    try { events = await store.read(correlationId); } catch { /* reported through auditPersisted */ }
    return { signalId, correlationId, status: "inconclusive", mode: mode(), statesVisited: [...visited], events, votes, trend, range, rooms, approval, verifier, rr, direction, notified: false, duplicate: false, auditPersisted: true, ...extra };
  };
  /** Identity observation for the cycle store; null when the input has no valid identity (then no cycle is registered). */
  const observationOf = (): Observation | null => {
    try {
      const c = input.candles?.["1H"];
      if (direction === undefined || lastClosedOpen === undefined || !Array.isArray(c) || !c.length) return null;
      const sk = signalKey({ symbol: input.symbol, market: input.market, direction, referenceTimeframe: timeframe, lastClosedCandleOpenTime: lastClosedOpen, setup: { entry: input.setup.entry, invalidation: input.setup.invalidation, targets: input.setup.targets, atr: input.setup.atr }, configFingerprint: cfg.fingerprint });
      return { cycleKey: cycleKeyOf({ symbol: input.symbol, market: input.market, direction, referenceTimeframe: timeframe }), signalKey: sk, direction, setup: { entry: input.setup.entry, invalidation: input.setup.invalidation, targets: [...input.setup.targets], atr: input.setup.atr }, closedCandleOpenTime: lastClosedOpen, lastClosedClose: c[c.length - 1].close };
    } catch { return null; }
  };
  const finish = async (status: SignalStatus, reason: string | undefined, fromState: PipelineState): Promise<PipelineResult> => {
    if (visited[visited.length - 1] !== "RECORDED") await transition("RECORDED", status, reason ?? "approved");
    const rec = input.decision?.recorder;
    const via = rec ? async (e: AuditEvent) => (await rec.record(e, { approved: status === "approved", observation: observationOf(), now: input.now })).audit : undefined;
    const fresh = await emit("DECISION", "RECORDED", { decision: status, reason: reason ?? "approved", detail: { fromState } }, via);
    decided = { status, reason };
    // A concurrent run with the same correlation id already persisted the decision: this one is a duplicate and must not notify.
    return snapshot({ status, haltReason: reason, duplicate: !fresh });
  };

  // Duplicate / interrupted request: never re-execute, never write a second record.
  try {
    const existing = await store.read(correlationId);
    if (existing.length) {
      if (!existing.some((e) => e.kind === "DECISION")) await recoverInterrupted(store, correlationId, input.now);
      const events = await store.read(correlationId);
      const d = events.find((e) => e.kind === "DECISION");
      return {
        signalId, correlationId, status: (d?.decision as SignalStatus | null) ?? "inconclusive", haltReason: d?.reason && d.reason !== "approved" ? d.reason : undefined, direction,
        mode: "trend", statesVisited: events.filter((e) => e.kind === "STATE_TRANSITION").map((e) => e.state as PipelineState), events, votes: [], rooms: [],
        notified: false, duplicate: true, auditPersisted: true,
      };
    }
  } catch (e) {
    return { signalId, correlationId, status: "inconclusive", haltReason: `AUDIT_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), mode: "trend", statesVisited: [], events: [], votes: [], rooms: [], notified: false, duplicate: false, auditPersisted: false };
  }

  try {
    await transition("DETECTED", "OK", "signal candidate created");
    if (!finiteNums(input.setup?.entry, input.setup?.invalidation, input.setup?.atr) || !Array.isArray(input.setup.targets) || input.setup.targets.length === 0 || !finiteNums(...input.setup.targets)) {
      await emit("ERROR", "DETECTED", { reason: "INVALID_SETUP" });
      return await finish("inconclusive", "INVALID_SETUP: entry, invalidation, atr and targets must be finite numbers", "DETECTED");
    }

    // DATA_VALIDATED (Data Room on every timeframe in use)
    let maxFreshness = 0;
    for (const tf of TIMEFRAMES) {
      const r = dataRoom({ candles: input.candles?.[tf], timeframeMs: TF_MS[tf], now: input.now, source: input.source, primarySource: input.primarySource }, cfg);
      const named = { ...r, reason: `${tf}: ${r.reason}` };
      if (tf === "1H") freshnessMs = r.metrics.freshnessMs ?? null;
      maxFreshness = Math.max(maxFreshness, r.metrics.freshnessRatio ?? 0);
      if (r.status !== "PASS") {
        dataValid = false;
        await transition("DATA_VALIDATED", "HALT", named.reason);
        await roomEvent(named, "DATA_VALIDATED");
        return await finish("inconclusive", named.reason, "DATA_VALIDATED");
      }
      rooms.push(named);
      roomVerdicts[`DATA_${tf}`] = { status: r.status, reason: r.reason, flags: r.flags, metrics: r.metrics };
    }
    dataValid = true;
    await transition("DATA_VALIDATED", "PASS", "all timeframes valid");

    // INDICATORS_READY: Delta Force. RANGE_DETECTED is routed to Range Mode instead of ABSTAIN.
    trend = evaluateDeltaTrend(input.candles["4H"], input.candles["1H"], input.candles["15m"]);
    if (trend.verdict === "RANGE_DETECTED") range = evaluateDeltaRange(input.candles["4H"], input.candles["5m"]);
    await transition("INDICATORS_READY", trend.verdict, range ? `routed to Range Mode: ${range.verdict}` : trend.reasoning);

    // P4 Setup integrity: in Range Mode the DeltaRange output is the only Setup reference. Any difference rejects the candidate (audited, inconclusive).
    if (range) {
      const integrity = checkRangeSetupIntegrity(input.setup, range, direction);
      if (!integrity.ok) {
        await emit("ERROR", "INDICATORS_READY", { reason: integrity.code, detail: { code: integrity.code, fields: integrity.fields } });
        return await finish("inconclusive", integrity.reason, "INDICATORS_READY");
      }
    }

    // AGENTS_RUN
    const ctx: AgentContext = { candles: input.candles, trend, range };
    // Agent accountability: every agent runs inside its own try/catch. A failure, a vote signed with another id or a duplicate id is a
    // structured ERROR (never a silent skip) and the pipeline halts as inconclusive: a failed agent can never lead to an approved decision.
    const others: AgentVote[] = [];
    const failures: AgentFailure[] = [];
    const unidentified: string[] = [];
    const seenIds = new Set<string>([DELTA_AGENT_ID]);
    (input.agents ?? []).forEach((run, i) => {
      const meta = run as Partial<IdentifiedAgent>;
      try {
        const v = run(ctx);
        if (meta.agentId !== undefined && v.agentId !== meta.agentId) throw new Error(`AGENT_IDENTITY_MISMATCH: declared ${meta.agentId}, vote signed ${String(v.agentId)}`);
        if (seenIds.has(v.agentId)) throw new Error(`AGENT_DUPLICATE_ID: ${v.agentId}`);
        seenIds.add(v.agentId);
        const w = input.weights?.[v.agentId];
        others.push(w !== undefined && v.agentId !== DELTA_AGENT_ID ? { ...v, weight: w } : v);
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        if (meta.agentId !== undefined && meta.agentGroup !== undefined) failures.push({ agentId: meta.agentId, agentGroup: meta.agentGroup, message });
        else unidentified.push(`UNIDENTIFIED_AGENT#${i}: ${message}`);
      }
    });
    votes = [deltaForceVote(trend, range, cfg), ...others];
    const failed = failures.length > 0 || unidentified.length > 0;
    if (input.agentRuns) {
      const rec = input.agentRuns.recorder;
      // Only agents with a declared input contract can be persisted as runs; anything else is reported in the event detail, never invented as a row.
      const voted = new Set(votes.map((v) => v.agentId));
      const persistable = failures.filter((f) => AGENT_TIMEFRAMES[f.agentId] !== undefined && !voted.has(f.agentId)); // a duplicate id would collide with the stored OK run
      const runs = buildAgentRunRecords({ signalId, runAt: input.now, candles: input.candles, votes, failures: persistable, versions: input.agentRuns.versions });
      const detail = { agentRunKeys: runs.map((r) => r.idempotencyKey).sort(), ...(failed ? { failedAgents: failures.map((f) => ({ agentId: f.agentId, error: f.message })), unidentifiedFailures: unidentified } : {}) };
      await transition("AGENTS_RUN", failed ? "ERROR" : "OK", failed ? `${failures.length + unidentified.length} agent failure(s)` : `${votes.length} votes`, { detail, via: async (e) => (await rec.record(runs, e)).audit });
    } else {
      await transition("AGENTS_RUN", failed ? "ERROR" : "OK", failed ? `${failures.length + unidentified.length} agent failure(s)` : `${votes.length} votes`);
    }
    if (failed) {
      const ids = [...failures.map((f) => f.agentId), ...unidentified.map((u) => u.split(":")[0])];
      await emit("ERROR", "AGENTS_RUN", { reason: "AGENT_FAILURE", detail: { failedAgents: failures, unidentifiedFailures: unidentified } });
      return await finish("inconclusive", `AGENT_FAILURE: ${ids.join(", ")}`.slice(0, 200), "AGENTS_RUN");
    }

    // RECONCILED (Error Detection Room + Chart Quality Room)
    const err = errorDetectionRoom(votes, input.candles["1H"][input.candles["1H"].length - 1], trend);
    await transition("RECONCILED", err.status, err.reason);
    await roomEvent(err, "RECONCILED");
    if (err.status !== "PASS") return await finish("inconclusive", err.reason, "RECONCILED");
    const chart = chartQualityRoom(input.candles["1H"], input.chart, input.now, cfg);
    await roomEvent(chart, "RECONCILED");
    if (chart.status !== "PASS") return await finish("inconclusive", `CHART_QUALITY_${chart.status}: ${chart.reason}`.slice(0, 200), "RECONCILED");

    // RISK_CHECKED (Risk Room)
    const risk = riskRoom({ direction: direction ?? "long", market: input.market, entry: input.setup.entry, invalidation: input.setup.invalidation, targets: input.setup.targets, atr: input.setup.atr, liquidationDistance: input.setup.liquidationDistance, fundingRate: input.setup.fundingRate }, cfg);
    riskResult = risk;
    rr = risk.metrics.rr;
    await transition("RISK_CHECKED", risk.status, risk.reason);
    await roomEvent(risk, "RISK_CHECKED");
    if (risk.status === "HALT") return await finish("rejected", risk.reason, "RISK_CHECKED");
    if (risk.status !== "PASS") return await finish("inconclusive", risk.reason, "RISK_CHECKED");

    // GATED: Independent Verifier (absolute veto) and Approval Room. Both are always evaluated and recorded.
    await transition("GATED", "RUNNING", "verifier and approval room");
    verifier = independentVerifier(input.candles["1H"], { direction: direction ?? "long", market: input.market, entry: input.setup.entry, invalidation: input.setup.invalidation, targets: input.setup.targets }, cfg);
    await emit("VERIFIER_RESULT", "GATED", { verifierResult: verifier, reason: verifier.reasons.join("; ") || "verified", detail: { status: verifier.status } });
    const elite = input.elite ?? ((p: ElitePayload) => evaluateEliteCouncil(p, cfg));
    approval = await approvalRoom(
      votes,
      {
        setupDirection: direction === "short" ? "bearish" : "bullish",
        consultElite: (candidate, dissentRatio) =>
          elite({ symbol: input.symbol, dataStale: false, rr: rr ?? 0, trend, range, riskRoom: risk.status, proposedAction: candidate, dissentRatio, freshnessRatio: maxFreshness }),
      },
      { ...approvalConfigFrom(cfg), ...input.approval },
    );
    roomVerdicts.APPROVAL = { status: approval.status, reason: approval.haltReason ?? "approved", eliteTriggered: approval.eliteTriggered, dissentRatio: approval.tally.dissentRatio };
    await emit("ROOM_VERDICT", "GATED", { reason: approval.haltReason ?? "approved", detail: { room: "APPROVAL", status: approval.status, eliteTriggered: approval.eliteTriggered } });
    if (verifier.status === "VETO") return await finish("inconclusive", `VERIFIER_VETO: ${verifier.reasons.join("; ")}`.slice(0, 200), "GATED");
    if (approval.status !== "APPROVED") return await finish("inconclusive", approval.haltReason, "GATED");

    // RECORDED (decision persisted first) -> NOTIFIED
    const recorded = await finish("approved", undefined, "GATED");
    if (recorded.duplicate) return recorded;
    if (!input.notify) {
      await transition("NOTIFIED", "SKIPPED", "no notifier configured");
      return await snapshot({ status: "approved", notified: false });
    }
    try {
      await input.notify(recorded);
      await transition("NOTIFIED", "SENT", "notifier called");
      return await snapshot({ status: "approved", notified: true });
    } catch (e) {
      await emit("ERROR", "RECORDED", { reason: `NOTIFY_FAILED: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }).catch(() => undefined);
      return await snapshot({ status: "approved", notified: false });
    }
  } catch (e) {
    const reason = `PIPELINE_ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    if (decided) return snapshot({ status: decided.status, haltReason: decided.reason }); // decision already persisted; never contradict it
    try {
      await emit("ERROR", visited[visited.length - 1] ?? null, { reason });
      return await finish("inconclusive", reason, visited[visited.length - 1] ?? "DETECTED");
    } catch (auditError) {
      return snapshot({ status: "inconclusive", haltReason: `AUDIT_FAILURE: ${auditError instanceof Error ? auditError.message : String(auditError)}; ${reason}`.slice(0, 200), auditPersisted: false });
    }
  }
}
