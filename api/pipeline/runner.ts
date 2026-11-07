import { atrSeries } from "@contracts/indicators";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import type { AuditStore } from "../orchestrator/audit";
import type { Agent } from "../orchestrator/agents";
import { runSignalPipeline, type PipelineResult } from "../orchestrator/machine";
import type { AtomicAgentsRunRecorder } from "./agentsRunRecorder";
import { PIPELINE_TIMEFRAMES, readPipelineCandles, TF_MS, type LoadRows, type PipelineTimeframe } from "./candleAdapter";
import { assessSeries, type QualityReport } from "./dataQuality";
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
export type QualityByTimeframe = Record<PipelineTimeframe, QualityReport & { fresh: boolean }>;
export type RunnerOutcome =
  | { kind: "BLOCKED"; reason: string }
  | { kind: "ABSTAIN"; stage: "DATA" | "SETUP"; reason: string; quality?: QualityByTimeframe }
  | { kind: "PIPELINE"; result: PipelineResult; setup: { entry: number; invalidation: number; targets: number[]; atr: number }; quality: QualityByTimeframe };

export async function runSymbolOnce(deps: RunnerDeps, req: { symbol: string; market: "spot" | "futures" }): Promise<RunnerOutcome> {
  if (req.market === "futures") return { kind: "BLOCKED", reason: "FUTURES_DATA_SOURCE_NOT_APPROVED: no derivatives data source has been chosen" };
  const now = deps.now();
  const data = await readPipelineCandles(req.symbol, now, deps.loadRows);
  if (data.status !== "READY") return { kind: "ABSTAIN", stage: "DATA", reason: data.reason ?? "DATA_NOT_READY" };
  const c = data.candles;
  // Data Quality (second, independent check on the closed series the pipeline will actually use). Fresh = the last closed candle is the most recent one that can exist.
  const quality = Object.fromEntries(PIPELINE_TIMEFRAMES.map((tf) => { const q = assessSeries(c[tf], TF_MS[tf], now); return [tf, { ...q, fresh: q.staleMs !== null && q.staleMs < TF_MS[tf] }]; })) as QualityByTimeframe;
  const bad = PIPELINE_TIMEFRAMES.filter((tf) => !quality[tf].ok || !quality[tf].fresh);
  if (bad.length) return { kind: "ABSTAIN", stage: "DATA", reason: `DATA_QUALITY_FAILED: ${bad.map((tf) => `${tf}(${!quality[tf].fresh ? `stale ${quality[tf].staleMs}ms ` : ""}missing ${quality[tf].missingBars} invalid ${quality[tf].invalid.length} dup ${quality[tf].duplicates} order ${quality[tf].outOfOrder} misaligned ${quality[tf].misaligned})`).join(", ")}`, quality };
  const trend = evaluateDeltaTrend(c["4H"], c["1H"], c["15m"]);
  if (trend.verdict !== "RANGE_DETECTED") return { kind: "ABSTAIN", stage: "SETUP", quality, reason: `TREND_SETUP_UNAVAILABLE: Delta Trend verdict ${trend.verdict}; no approved Setup algorithm for Trend mode` };
  const range = evaluateDeltaRange(c["4H"], c["5m"]);
  if (range.verdict !== "RANGE_LONG" && range.verdict !== "RANGE_SHORT") return { kind: "ABSTAIN", stage: "SETUP", quality, reason: `RANGE_NO_SETUP: DeltaRange verdict ${range.verdict}` };
  const atr = atrSeries(c["1H"], 14).at(-1);
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return { kind: "ABSTAIN", stage: "SETUP", quality, reason: "ATR_UNAVAILABLE on 1H" };
  const setup = { entry: range.entry, invalidation: range.stopLoss, targets: [...range.targets], atr };
  const result = await runSignalPipeline({
    symbol: req.symbol, market: req.market, now, candles: c, source: deps.source, audit: deps.audit, agents: deps.agents,
    setup, agentRuns: deps.agentRuns, decision: deps.decision, dataQuality: { source: "api/pipeline/dataQuality.ts", ok: true, byTimeframe: Object.fromEntries(PIPELINE_TIMEFRAMES.map((tf) => [tf, { total: quality[tf].total, missingBars: quality[tf].missingBars, zeroVolume: quality[tf].zeroVolume, staleMs: quality[tf].staleMs }])) },
  });
  return { kind: "PIPELINE", result, setup, quality };
}
