import type { Candle } from "@contracts/types";
import type { DeltaRangeOutput, DeltaTrendOutput } from "../../types/advanced";
import type { AgentContext, PipelineInput } from "../../orchestrator/machine";
import type { AgentVote } from "../../orchestrator/rooms";
import { fiveMinuteBearishFvg, range4HAtTop, trendSeries } from "./advancedFixtures";
import { retimeTo, setupFromCandles, trimToPullbackEntry, zigzagTrend } from "./scenarioFixtures";

export const H = 3_600_000;
export const NOW = 1_800_000_000_000;
export const TF = { "4H": 4 * H, "1H": H, "15m": 900_000, "5m": 300_000 } as const;

/** Re-times a series so that its LAST candle opens exactly one timeframe before `now` (fresh, no gaps). */
export function retime(candles: Candle[], stepMs: number, now: number = NOW): Candle[] {
  const lastOpen = now - stepMs;
  return candles.map((c, i) => {
    const time = lastOpen - (candles.length - 1 - i) * stepMs;
    return { ...c, time, closeTime: time + stepMs - 1 };
  });
}

export function candlesBundle(kind: "up" | "conflict" | "range"): PipelineInput["candles"] {
  if (kind === "range") {
    return {
      "4H": retime(range4HAtTop(300, 100, 110, 10), TF["4H"]),
      "1H": retime(trendSeries(300, H, 100, 1), TF["1H"]),
      "15m": retime(trendSeries(300, 900_000, 100, 1), TF["15m"]),
      "5m": retime(fiveMinuteBearishFvg(), TF["5m"]),
    };
  }
  // Trend bundles have real pullbacks (confirmed swings) so the Independent Verifier can evaluate the stop structure.
  const z = (n: number, step: number, dir: 1 | -1) => zigzagTrend(n, step, 100, dir, ZZ);
  const oneH = trimToPullbackEntry(z(300, H, kind === "conflict" ? -1 : 1), kind === "conflict" ? "short" : "long");
  return {
    "4H": retimeTo(z(300, 4 * H, 1), TF["4H"], NOW),
    "1H": retimeTo(oneH, TF["1H"], NOW),
    "15m": retimeTo(z(300, 900_000, 1), TF["15m"], NOW),
    "5m": retimeTo(z(60, 300_000, 1), TF["5m"], NOW),
  };
}

const ZZ = { drift: 0.001, amp: 0.008, period: 12 } as const;

/** A fixed vote from a stub agent (the 33-agent council is not implemented yet). */
export const agent = (agentId: string, verdict: AgentVote["verdict"], group = agentId.slice(0, 1), weight = 1): ((ctx: AgentContext) => AgentVote) =>
  () => ({ agentId, group, verdict, confidence: 0.6, weight, reason: "test stub" });

export const longSetup = { entry: 100, invalidation: 98, targets: [104], atr: 1.5 }; // R:R 2.0, risk 1.33 ATR
export const shortSetup = { entry: 109.5, invalidation: 112, targets: [100], atr: 2 }; // R:R 3.8, risk 1.25 ATR

/** Setup coherent with the 1H candles of the bundle (entry = last close, stop behind the latest swing). Explicit `setup` overrides it. */
export function baseInput(kind: "up" | "conflict" | "range", agents: PipelineInput["agents"], setup?: PipelineInput["setup"]): PipelineInput {
  const candles = candlesBundle(kind);
  const own = setup ?? (kind === "range" ? shortSetup : setupFromCandles(candles["1H"], kind === "conflict" ? "short" : "long", { rr: 3 }));
  return { symbol: "BTCUSDT", market: "spot", now: NOW, candles, setup: own, agents };
}

export const dummyTf = { supertrend: "BULLISH", adx: 30, emaAligned: true, ichimokuOk: true };
export const trendOf = (verdict: DeltaTrendOutput["verdict"], direction: DeltaTrendOutput["direction"] = "NEUTRAL"): DeltaTrendOutput => ({
  verdict, direction, score: verdict === "ULTRA_TREND" ? 12 : 0, timeframes: { "4H": dummyTf, "1H": dummyTf, "15m": dummyTf }, reasoning: `stub ${verdict}`,
});
export const rangeOf = (verdict: DeltaRangeOutput["verdict"]): DeltaRangeOutput => ({
  verdict, boundaries: { upper: 110, lower: 100, midpoint: 105 }, ltfConfirmation: verdict === "RANGE_SHORT" || verdict === "RANGE_LONG",
  entry: 109.5, stopLoss: 112, targets: [105, 100], reasoning: `stub ${verdict}`,
});
