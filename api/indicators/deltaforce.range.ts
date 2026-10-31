import type { Candle } from "@contracts/types";
import type { DeltaRangeOutput } from "../types/advanced";
import { calcAtr, calcStochRsi } from "./deltaforce.trend";

const ZERO_TARGETS: [number, number] = [0, 0];

export function evaluateDeltaRange(candles4H: Candle[], candles5m: Candle[]): DeltaRangeOutput {
  const empty = (verdict: DeltaRangeOutput["verdict"], boundaries: DeltaRangeOutput["boundaries"], reasoning: string): DeltaRangeOutput => ({
    verdict, boundaries, ltfConfirmation: false, entry: 0, stopLoss: 0, targets: [...ZERO_TARGETS], reasoning,
  });
  const none = { upper: 0, lower: 0, midpoint: 0 };
  // Data sufficiency: 20 Donchian bars + ATR(14) on 4H; StochRSI(14,14) needs 28+ bars on 5m, plus 3 for the patterns.
  if (candles4H.length < 35 || candles5m.length < 30) {
    return empty("ABSTAIN", none, "Insufficient candles for range evaluation.");
  }

  // 1. Donchian Channels (20 periods) on 4H
  const last20 = candles4H.slice(-20);
  const upper = Math.max(...last20.map((c) => c.high));
  const lower = Math.min(...last20.map((c) => c.low));
  const midpoint = (upper + lower) / 2;
  const boundaries = { upper, lower, midpoint };
  const currentPrice = candles4H[candles4H.length - 1].close;

  // 2. Safety Gate
  const widthPct = ((upper - lower) / currentPrice) * 100;
  const rrToMid = Math.abs(midpoint - currentPrice) / Math.abs(upper - currentPrice); // Approximation
  if (widthPct < 1.5 || rrToMid < 1.5) {
    return empty("RANGE_TOO_TIGHT", boundaries, `Range too tight (width ${widthPct.toFixed(2)}%, rr-to-mid ${rrToMid.toFixed(2)}).`);
  }

  // 3. LTF Confirmation (5m candles)
  const c1 = candles5m[candles5m.length - 1];
  const c2 = candles5m[candles5m.length - 2];
  const c3 = candles5m[candles5m.length - 3];
  const bearishFvg = c3.low > c1.high;
  const bullishFvg = c3.high < c1.low;
  const bullishEngulfing = c1.close > c1.open && c1.close > c2.high;
  const bearishEngulfing = c1.close < c1.open && c1.close < c2.low;
  const stoch = calcStochRsi(candles5m.map((c) => c.close), 14, 14)[candles5m.length - 1];
  const overbought = stoch > 80;
  const oversold = stoch < 20;
  const atr4h = calcAtr(candles4H, 14)[candles4H.length - 1];
  if (!Number.isFinite(atr4h) || !Number.isFinite(stoch)) {
    return empty("ABSTAIN", boundaries, "ATR/StochRSI not available (warm-up).");
  }

  // 4. Trigger Logic
  if (currentPrice >= upper * 0.995 && (bearishFvg || bearishEngulfing) && overbought) {
    return {
      verdict: "RANGE_SHORT", boundaries, ltfConfirmation: true,
      entry: c1.close, stopLoss: upper + 1.5 * atr4h, targets: [midpoint, lower],
      reasoning: `Price at range top, bearish ${bearishFvg ? "FVG" : "engulfing"} on 5m, StochRSI ${stoch.toFixed(1)} > 80.`,
    };
  }
  // Mirror for RANGE_LONG
  if (currentPrice <= lower * 1.005 && (bullishFvg || bullishEngulfing) && oversold) {
    return {
      verdict: "RANGE_LONG", boundaries, ltfConfirmation: true,
      entry: c1.close, stopLoss: lower - 1.5 * atr4h, targets: [midpoint, upper],
      reasoning: `Price at range bottom, bullish ${bullishFvg ? "FVG" : "engulfing"} on 5m, StochRSI ${stoch.toFixed(1)} < 20.`,
    };
  }
  return empty("ABSTAIN", boundaries, "No range-edge trigger with 5m confirmation.");
}
