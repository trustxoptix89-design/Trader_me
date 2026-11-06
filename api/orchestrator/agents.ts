import { bollingerSeries, emaSeries, macdSeries, rsiSeries } from "@contracts/indicators";
import { calcStochRsi } from "../indicators/deltaforce.trend";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";
import type { AgentContext } from "./machine";
import type { AgentVote, VoteVerdict } from "./rooms";

/**
 * The deterministic agents that exist today (5 of the 33 in the PDF; the rest are NOT IMPLEMENTED and are not simulated).
 * They read the raw 1H candles with the indicator engine; nothing here is a fixed answer. Each abstains on insufficient history.
 */
export type Agent = (ctx: AgentContext) => AgentVote;
/** An agent with a stable identity. The machine uses it to attribute failures and to reject votes signed with another id. */
export type IdentifiedAgent = Agent & { readonly agentId: string; readonly agentGroup: string };
export const identify = (agentId: string, agentGroup: string, run: Agent): IdentifiedAgent => Object.assign((ctx: AgentContext) => run(ctx), { agentId, agentGroup });

const vote = (agentId: string, group: string, verdict: VoteVerdict, confidence: number, reason: string): AgentVote => ({ agentId, group, verdict, confidence, weight: 1, reason });
const lastOf = (xs: (number | null)[]): number | null => (xs.length ? xs[xs.length - 1] : null);

/** A01: market structure from the two most recent 6-candle windows (higher highs + higher lows = bullish). */
export const structureAgent: IdentifiedAgent = identify("A01_STRUCTURE", "A", ({ candles }) => {
  const c = candles["1H"];
  if (c.length < 12) return vote("A01_STRUCTURE", "A", "abstain", 0, "fewer than 12 candles");
  const r = c.slice(-12), a = r.slice(0, 6), b = r.slice(6);
  const hi = (x: typeof a) => Math.max(...x.map((k) => k.high)), lo = (x: typeof a) => Math.min(...x.map((k) => k.low));
  if (hi(b) > hi(a) && lo(b) > lo(a)) return vote("A01_STRUCTURE", "A", "bullish", 0.6, "higher highs and higher lows");
  if (hi(b) < hi(a) && lo(b) < lo(a)) return vote("A01_STRUCTURE", "A", "bearish", 0.6, "lower highs and lower lows");
  return vote("A01_STRUCTURE", "A", "neutral", 0.3, "mixed structure");
});

/** B09: EMA20 / EMA50 and close position. */
export const emaTrendAgent: IdentifiedAgent = identify("B09_EMA_TREND", "B", ({ candles }) => {
  const close = candles["1H"].map((k) => k.close);
  const e20 = lastOf(emaSeries(close, 20)), e50 = lastOf(emaSeries(close, 50)), px = close[close.length - 1];
  if (e20 === null || e50 === null) return vote("B09_EMA_TREND", "B", "abstain", 0, "not enough history for EMA50");
  if (e20 > e50 && px > e50) return vote("B09_EMA_TREND", "B", "bullish", 0.6, "EMA20 > EMA50 and close above EMA50");
  if (e20 < e50 && px < e50) return vote("B09_EMA_TREND", "B", "bearish", 0.6, "EMA20 < EMA50 and close below EMA50");
  return vote("B09_EMA_TREND", "B", "neutral", 0.3, "EMAs and price disagree");
});

/** B10: RSI regime with project thresholds from the governance config. */
export const rsiAgent = (cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): IdentifiedAgent => identify("B10_RSI", "B", ({ candles }) => {
  const r = lastOf(rsiSeries(candles["1H"].map((k) => k.close), 14));
  if (r === null) return vote("B10_RSI", "B", "abstain", 0, "not enough history for RSI(14)");
  if (r > cfg.values.agentRsiBull) return vote("B10_RSI", "B", "bullish", 0.5, `RSI ${r.toFixed(1)}`);
  if (r < cfg.values.agentRsiBear) return vote("B10_RSI", "B", "bearish", 0.5, `RSI ${r.toFixed(1)}`);
  return vote("B10_RSI", "B", "neutral", 0.3, `RSI ${r.toFixed(1)}`);
});

/** B11: MACD histogram sign. */
export const macdAgent: IdentifiedAgent = identify("B11_MACD", "B", ({ candles }) => {
  const h = lastOf(macdSeries(candles["1H"].map((k) => k.close)).histogram);
  if (h === null) return vote("B11_MACD", "B", "abstain", 0, "not enough history for MACD");
  return h > 0 ? vote("B11_MACD", "B", "bullish", 0.5, "histogram > 0") : h < 0 ? vote("B11_MACD", "B", "bearish", 0.5, "histogram < 0") : vote("B11_MACD", "B", "neutral", 0.3, "histogram = 0");
});

/** B12: close versus the Bollinger(20, 2) midline. */
export const bollingerAgent: IdentifiedAgent = identify("B12_BB", "B", ({ candles }) => {
  const close = candles["1H"].map((k) => k.close);
  const mid = lastOf(bollingerSeries(close, 20, 2).mid), px = close[close.length - 1];
  if (mid === null) return vote("B12_BB", "B", "abstain", 0, "not enough history for Bollinger(20)");
  return px > mid ? vote("B12_BB", "B", "bullish", 0.4, "close above midline") : px < mid ? vote("B12_BB", "B", "bearish", 0.4, "close below midline") : vote("B12_BB", "B", "neutral", 0.3, "close on midline");
});

/**
 * B15: Stochastic RSI cross (V6 Appendix 2 section 6): StochRSI(14,14) crossing its 3-period SMA signal line on the LAST closed
 * candle, inside the < 20 zone = bullish, inside the > 80 zone = bearish. Anything else is neutral (no cross / no extreme zone).
 */
export const stochRsiAgent: IdentifiedAgent = identify("B15_STOCH_RSI", "B", ({ candles }) => {
  const stoch = calcStochRsi(candles["1H"].map((k) => k.close), 14, 14);
  const n = stoch.length;
  const sig = (i: number): number => (i >= 2 && [0, 1, 2].every((d) => Number.isFinite(stoch[i - d])) ? (stoch[i] + stoch[i - 1] + stoch[i - 2]) / 3 : Number.NaN);
  const [s0, s1, g0, g1] = [stoch[n - 1], stoch[n - 2], sig(n - 1), sig(n - 2)];
  if (![s0, s1, g0, g1].every(Number.isFinite)) return vote("B15_STOCH_RSI", "B", "abstain", 0, "not enough history for StochRSI(14,14) with its 3-period signal");
  const up = s1 <= g1 && s0 > g0, down = s1 >= g1 && s0 < g0;
  if (up && s0 < 20) return vote("B15_STOCH_RSI", "B", "bullish", 0.5, `StochRSI ${s0.toFixed(1)} crossed above its signal below 20`);
  if (down && s0 > 80) return vote("B15_STOCH_RSI", "B", "bearish", 0.5, `StochRSI ${s0.toFixed(1)} crossed below its signal above 80`);
  return vote("B15_STOCH_RSI", "B", "neutral", 0.3, `StochRSI ${s0.toFixed(1)}: no cross inside an extreme zone`);
});

export const defaultAgents = (cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): IdentifiedAgent[] => [structureAgent, emaTrendAgent, rsiAgent(cfg), macdAgent, bollingerAgent, stochRsiAgent];
