import { atrSeries } from "@contracts/indicators";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import type { AuditStore } from "../orchestrator/audit";
import type { Agent } from "../orchestrator/agents";
import { runSignalPipeline, type PipelineResult } from "../orchestrator/machine";
import type { AtomicAgentsRunRecorder } from "./agentsRunRecorder";
import { readPipelineCandles, type LoadRows } from "./candleAdapter";
import type { AtomicDecisionRecorder } from "./decisionRecorder";

/**
 * P6 controlled runner: ONE symbol, ONE pass, invoked explicitly (CLI / internal call). No public endpoint, no Scheduler (P7 is separate).
 * Setup source: Range mode uses the DeltaRange output as the Setup (the only approved reference). Trend mode has NO approved Setup algorithm
 * (R1 not approved, Trend Setup closed): the runner reports ABSTAIN and writes nothing. Futures has no approved data source: BLOCKED.
 */
export interface RunnerDeps {
  loadRows: LoadRows;
  audit: AuditStore;
  agents: Agent[];
  now: () => number;
  agentRuns?: { recorder: AtomicAgentsRunRecorder; versions?: Record<string, string> };
  decision?: { recorder: AtomicDecisionRecorder };
  source?: string;
}
export type RunnerOutcome =
  | { kind: "BLOCKED"; reason: string }
  | { kind: "ABSTAIN"; stage: "DATA" | "SETUP"; reason: string }
  | { kind: "PIPELINE"; result: PipelineResult };

export async function runSymbolOnce(deps: RunnerDeps, req: { symbol: string; market: "spot" | "futures" }): Promise<RunnerOutcome> {
  if (req.market === "futures") return { kind: "BLOCKED", reason: "FUTURES_DATA_SOURCE_NOT_APPROVED: no derivatives data source has been chosen" };
  const now = deps.now();
  const data = await readPipelineCandles(req.symbol, now, deps.loadRows);
  if (data.status !== "READY") return { kind: "ABSTAIN", stage: "DATA", reason: data.reason ?? "DATA_NOT_READY" };
  const c = data.candles;
  const trend = evaluateDeltaTrend(c["4H"], c["1H"], c["15m"]);
  if (trend.verdict !== "RANGE_DETECTED") return { kind: "ABSTAIN", stage: "SETUP", reason: `TREND_SETUP_UNAVAILABLE: Delta Trend verdict ${trend.verdict}; no approved Setup algorithm for Trend mode` };
  const range = evaluateDeltaRange(c["4H"], c["5m"]);
  if (range.verdict !== "RANGE_LONG" && range.verdict !== "RANGE_SHORT") return { kind: "ABSTAIN", stage: "SETUP", reason: `RANGE_NO_SETUP: DeltaRange verdict ${range.verdict}` };
  const atr = atrSeries(c["1H"], 14).at(-1);
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return { kind: "ABSTAIN", stage: "SETUP", reason: "ATR_UNAVAILABLE on 1H" };
  const result = await runSignalPipeline({
    symbol: req.symbol, market: req.market, now, candles: c, source: deps.source, audit: deps.audit, agents: deps.agents,
    setup: { entry: range.entry, invalidation: range.stopLoss, targets: [...range.targets], atr }, agentRuns: deps.agentRuns, decision: deps.decision,
  });
  return { kind: "PIPELINE", result };
}
