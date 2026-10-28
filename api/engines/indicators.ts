import type { Candle, MarketMetrics, MarketSnapshot } from "@contracts/types";

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const part = values.slice(-period);
  return part.reduce((a, b) => a + b, 0) / period;
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = previous;
  for (let i = period; i < values.length; i++) {
    previous = values[i] * k + previous * (1 - k);
    out[i] = previous;
  }
  return out;
}

export function rsiSeries(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1]; gains += Math.max(0, change); losses += Math.max(0, -change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) { atr = (atr * (period - 1) + tr[i]) / period; out[i] = atr; }
  return out;
}

export function adxSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(candles.length).fill(null);
  if (candles.length < period * 2 + 1) return out;
  const tr: number[] = [0], plus: number[] = [0], minus: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
    plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0);
  }
  let trSm = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let pSm = plus.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let mSm = minus.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period; i < candles.length; i++) {
    if (i > period) { trSm = trSm - trSm / period + tr[i]; pSm = pSm - pSm / period + plus[i]; mSm = mSm - mSm / period + minus[i]; }
    const pdi = trSm ? 100 * pSm / trSm : 0, mdi = trSm ? 100 * mSm / trSm : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
    if (dx.length >= period) out[i] = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

export function macdHistogram(values: number[]): number | null {
  const ema12 = emaSeries(values, 12), ema26 = emaSeries(values, 26);
  const macd = values.map((_, i) => ema12[i] !== null && ema26[i] !== null ? ema12[i]! - ema26[i]! : null);
  const valid = macd.filter((v): v is number => v !== null);
  if (valid.length < 9) return null;
  const signal = emaSeries(valid, 9).at(-1);
  return signal === null || signal === undefined ? null : valid.at(-1)! - signal;
}

export function trendOf(candles: Candle[]): MarketMetrics["trend"] {
  const closes = candles.map((c) => c.close);
  const fast = emaSeries(closes, 20).at(-1), slow = emaSeries(closes, 50).at(-1);
  if (fast == null || slow == null) return "unknown";
  const threshold = (atrSeries(candles).at(-1) ?? 0) * 0.15;
  if (fast > slow + threshold) return "bullish";
  if (fast < slow - threshold) return "bearish";
  return "range";
}

export function structureOf(candles: Candle[]): MarketMetrics["structure"] {
  if (candles.length < 12) return "unknown";
  const recent = candles.slice(-12), midpoint = 6;
  const firstHigh = Math.max(...recent.slice(0, midpoint).map((c) => c.high));
  const secondHigh = Math.max(...recent.slice(midpoint).map((c) => c.high));
  const firstLow = Math.min(...recent.slice(0, midpoint).map((c) => c.low));
  const secondLow = Math.min(...recent.slice(midpoint).map((c) => c.low));
  if (secondHigh > firstHigh && secondLow > firstLow) return "higher-highs";
  if (secondHigh < firstHigh && secondLow < firstLow) return "lower-lows";
  return "mixed";
}

export function computeMetrics(snapshot: MarketSnapshot): MarketMetrics {
  const candles = snapshot.candles;
  const closes = candles.map((c) => c.close), volumes = candles.map((c) => c.volume);
  const price = closes.at(-1) ?? snapshot.derivatives.markPrice ?? 0;
  const atr = atrSeries(candles).at(-1) ?? null;
  const returns = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const avgVolume = sma(volumes.slice(0, -1), 20);
  const recent = candles.slice(-48);
  return {
    price, ema20: emaSeries(closes, 20).at(-1) ?? null, ema50: emaSeries(closes, 50).at(-1) ?? null,
    ema200: emaSeries(closes, 200).at(-1) ?? null, rsi14: rsiSeries(closes).at(-1) ?? null,
    atr14: atr, atrPct: atr && price ? atr / price * 100 : null, adx14: adxSeries(candles).at(-1) ?? null,
    macdHistogram: macdHistogram(closes), volumeRatio: avgVolume ? volumes.at(-1)! / avgVolume : null,
    realizedVolatilityPct: Math.sqrt(variance) * Math.sqrt(96) * 100,
    support: recent.length ? Math.min(...recent.map((c) => c.low)) : null,
    resistance: recent.length ? Math.max(...recent.map((c) => c.high)) : null,
    trend: trendOf(candles), structure: structureOf(candles),
    higherTrend: snapshot.higherTimeframes["4h"]?.length ? trendOf(snapshot.higherTimeframes["4h"]!) : "unknown",
    liquidityUsd: candles.at(-1)?.quoteVolume ?? (candles.at(-1) ? candles.at(-1)!.close * candles.at(-1)!.volume : null),
    priceChangePct: closes.length > 1 ? (price / closes.at(-2)! - 1) * 100 : null,
  };
}
