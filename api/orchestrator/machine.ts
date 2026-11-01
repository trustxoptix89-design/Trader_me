import { createHash } from "node:crypto";
import type { Candle } from "@contracts/types";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import type { DeltaRangeOutput, DeltaTrendOutput, EliteCouncilOutput, ElitePayload } from "../types/advanced";
import { approvalRoom, DEFAULT_APPROVAL_CONFIG, type ApprovalConfig, type ApprovalDecision } from "./approval";
import { DELTA_AGENT_ID, deltaForceVote } from "./deltaAgent";
import { evaluateEliteCouncil } from "./elite";
import { dataRoom, errorDetectionRoom, riskRoom, type AgentVote, type RoomResult } from "./rooms";

/** The 8 pipeline states of the specification (Phase D), in order. POST_MORTEM happens after an outcome and is not part of this run. */
export const PIPELINE_STATES = ["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RISK_CHECKED", "GATED", "RECORDED", "NOTIFIED"] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];
export type SignalStatus = "approved" | "rejected" | "inconclusive";

const TF_MS = { "4H": 14_400_000, "1H": 3_600_000, "15m": 900_000, "5m": 300_000 } as const;

export interface AuditEntry {
  signalId: string;
  state: PipelineState;
  room: string | null;
  verdict: string;
  reason: string;
  inputHash: string;
  outputHash: string;
  timestamp: number;
  idempotencyKey: string;
}

export interface AgentContext {
  candles: PipelineInput["candles"];
  trend: DeltaTrendOutput;
  range?: DeltaRangeOutput;
}

export interface PipelineInput {
  symbol: string;
  market: "spot" | "futures";
  /** Epoch ms used for freshness and audit timestamps (injected so runs are reproducible). */
  now: number;
  candles: { "4H": Candle[]; "1H": Candle[]; "15m": Candle[]; "5m": Candle[] };
  setup: { entry: number; invalidation: number; targets: number[]; atr: number; liquidationDistance?: number; fundingRate?: number };
  /** Other deterministic agents. Delta Force is always run by the machine itself. */
  agents?: Array<(ctx: AgentContext) => AgentVote>;
  /** Learned agent weights (post-mortem). They never override the Delta Force ULTRA_TREND weight. */
  weights?: Record<string, number>;
  source?: string;
  primarySource?: string;
  approval?: Partial<ApprovalConfig>;
  /** Defaults to evaluateEliteCouncil (deterministic heuristic + 10s circuit breaker). */
  elite?: (payload: ElitePayload) => Promise<EliteCouncilOutput>;
  notify?: (result: PipelineResult) => Promise<void> | void;
}

export interface PipelineResult {
  signalId: string;
  status: SignalStatus;
  haltReason?: string;
  direction?: "long" | "short";
  mode: "trend" | "range";
  statesVisited: PipelineState[];
  audit: AuditEntry[];
  votes: AgentVote[];
  trend?: DeltaTrendOutput;
  range?: DeltaRangeOutput;
  rooms: RoomResult[];
  approval?: ApprovalDecision;
  rr?: number;
  notified: boolean;
}

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

/**
 * Deterministic 8-state orchestrator. The machine is only a protocol runner: it decides nothing analytically.
 * Any HALT / error jumps straight to RECORDED with status rejected (Risk Room) or inconclusive (everything else);
 * NOTIFIED is reached only for approved signals. Audit entries are append-only values (database persistence is a separate step).
 */
export async function runSignalPipeline(input: PipelineInput): Promise<PipelineResult> {
  const signalId = `${input.symbol}-${input.now}-${hash({ s: input.setup, m: input.market }).slice(0, 8)}`;
  const audit: AuditEntry[] = [];
  const visited: PipelineState[] = [];
  const rooms: RoomResult[] = [];
  let votes: AgentVote[] = [];
  let trend: DeltaTrendOutput | undefined;
  let range: DeltaRangeOutput | undefined;
  let approval: ApprovalDecision | undefined;
  let rr: number | undefined;

  const step = (state: PipelineState, room: string | null, verdict: string, reason: string, inp: unknown, out: unknown): void => {
    visited.push(state);
    audit.push({ signalId, state, room, verdict, reason, inputHash: hash(inp), outputHash: hash(out), timestamp: input.now, idempotencyKey: `${signalId}:${state}` });
  };
  const mode = (): "trend" | "range" => (range ? "range" : "trend");
  const base = (): Omit<PipelineResult, "status" | "haltReason" | "notified" | "direction"> => ({ signalId, mode: mode(), statesVisited: visited, audit, votes, trend, range, rooms, approval, rr });
  const direction: "long" | "short" | undefined = input.setup.targets[0] === undefined ? undefined : input.setup.targets[0] > input.setup.entry ? "long" : "short";
  const finish = (status: SignalStatus, haltReason: string | undefined, fromState: PipelineState): PipelineResult => {
    step("RECORDED", null, status, haltReason ?? "approved", { fromState }, { status, haltReason });
    return { ...base(), status, haltReason, direction, notified: false };
  };

  try {
    step("DETECTED", null, "OK", "signal candidate created", { symbol: input.symbol, setup: input.setup }, { signalId });

    // DATA_VALIDATED (Data Room, every timeframe in use)
    let maxFreshness = 0;
    for (const tf of ["4H", "1H", "15m", "5m"] as const) {
      const r = dataRoom({ candles: input.candles[tf], timeframeMs: TF_MS[tf], now: input.now, source: input.source, primarySource: input.primarySource });
      rooms.push({ ...r, reason: `${tf}: ${r.reason}` });
      maxFreshness = Math.max(maxFreshness, r.metrics.freshnessRatio ?? 0);
      if (r.status !== "PASS") {
        step("DATA_VALIDATED", "DATA", "HALT", `${tf}: ${r.reason}`, { tf }, r);
        return finish("inconclusive", `${tf}: ${r.reason}`, "DATA_VALIDATED");
      }
    }
    step("DATA_VALIDATED", "DATA", "PASS", "all timeframes valid", { symbol: input.symbol }, { maxFreshnessRatio: maxFreshness });

    // INDICATORS_READY: Delta Force. RANGE_DETECTED is routed to Range Mode instead of ABSTAIN.
    trend = evaluateDeltaTrend(input.candles["4H"], input.candles["1H"], input.candles["15m"]);
    if (trend.verdict === "RANGE_DETECTED") range = evaluateDeltaRange(input.candles["4H"], input.candles["5m"]);
    step("INDICATORS_READY", null, trend.verdict, range ? `routed to Range Mode: ${range.verdict}` : trend.reasoning, { symbol: input.symbol }, { trend, range });

    // AGENTS_RUN
    const ctx: AgentContext = { candles: input.candles, trend, range };
    const others = (input.agents ?? []).map((run) => {
      const v = run(ctx);
      const w = input.weights?.[v.agentId];
      return w !== undefined && v.agentId !== DELTA_AGENT_ID ? { ...v, weight: w } : v;
    });
    votes = [deltaForceVote(trend, range), ...others];
    step("AGENTS_RUN", null, "OK", `${votes.length} votes`, { agents: votes.map((v) => v.agentId) }, votes);

    // RECONCILED (Error Detection Room)
    const err = errorDetectionRoom(votes, input.candles["1H"][input.candles["1H"].length - 1]);
    rooms.push(err);
    step("RECONCILED", "ERROR_DETECTION", err.status, err.reason, { votes: votes.length }, err);
    if (err.status !== "PASS") return finish("inconclusive", err.reason, "RECONCILED");

    // RISK_CHECKED (Risk Room)
    const risk = riskRoom({ direction: direction ?? "long", market: input.market, entry: input.setup.entry, invalidation: input.setup.invalidation, targets: input.setup.targets, atr: input.setup.atr, liquidationDistance: input.setup.liquidationDistance, fundingRate: input.setup.fundingRate });
    rooms.push(risk);
    rr = risk.metrics.rr;
    step("RISK_CHECKED", "RISK", risk.status, risk.reason, input.setup, risk);
    if (risk.status === "HALT") return finish("rejected", risk.reason, "RISK_CHECKED");
    if (risk.status !== "PASS") return finish("inconclusive", risk.reason, "RISK_CHECKED");

    // GATED (Approval Room; the Independent Verifier is NOT IMPLEMENTED yet and is not simulated)
    const elite = input.elite ?? evaluateEliteCouncil;
    approval = await approvalRoom(
      votes,
      {
        setupDirection: direction === "short" ? "bearish" : "bullish",
        consultElite: (candidate, dissentRatio) =>
          elite({ symbol: input.symbol, dataStale: false, rr: rr ?? 0, trend, range, riskRoom: risk.status, proposedAction: candidate, dissentRatio, freshnessRatio: maxFreshness }),
      },
      { ...DEFAULT_APPROVAL_CONFIG, ...input.approval },
    );
    step("GATED", "APPROVAL", approval.status, approval.haltReason ?? "approved", { votes: votes.length }, approval);
    if (approval.status !== "APPROVED") return finish("inconclusive", approval.haltReason, "GATED");

    // RECORDED -> NOTIFIED
    const recorded = finish("approved", undefined, "GATED");
    if (input.notify) {
      await input.notify(recorded);
      step("NOTIFIED", null, "SENT", "notifier called", { signalId }, { ok: true });
      return { ...recorded, notified: true };
    }
    step("NOTIFIED", null, "SKIPPED", "no notifier configured", { signalId }, { ok: false });
    return recorded;
  } catch (e) {
    const reason = `PIPELINE_ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    return finish("inconclusive", reason, visited[visited.length - 1] ?? "DETECTED");
  }
}
