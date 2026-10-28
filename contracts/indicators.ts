import type { Candle } from "./types";

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

export interface MacdSeries { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] }

/** MACD line, signal line and histogram aligned 1:1 with the input values (null while warming up). */
export function macdSeries(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const f = emaSeries(values, fast), s = emaSeries(values, slow);
  const macd = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const signal: (number | null)[] = Array(values.length).fill(null);
  const first = macd.findIndex((v) => v !== null);
  if (first >= 0) {
    const compact = macd.slice(first) as number[];
    const sig = emaSeries(compact, signalPeriod);
    sig.forEach((v, i) => { signal[first + i] = v; });
  }
  const histogram = macd.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i]! : null));
  return { macd, signal, histogram };
}

/** Session VWAP anchored to each UTC day, from typical price (H+L+C)/3 weighted by volume. */
export function vwapSeries(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = -1, pv = 0, vol = 0;
  for (const c of candles) {
    const d = Math.floor(c.time / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += (c.high + c.low + c.close) / 3 * c.volume; vol += c.volume;
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

export interface SwingLevels { support: number[]; resistance: number[] }

/**
 * Confirmed swing pivots (a pivot needs `right` later bars, so the newest bars never repaint) split around the last close:
 * resistance = nearest pivot highs above price, support = nearest pivot lows below it.
 */
export function swingLevels(candles: Candle[], left = 3, right = 3, perSide = 2): SwingLevels {
  const highs: number[] = [], lows: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (candles[i - k].high >= candles[i].high) isHigh = false;
      if (candles[i - k].low <= candles[i].low) isLow = false;
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (candles[i + k].high > candles[i].high) isHigh = false;
      if (candles[i + k].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  const last = candles.at(-1)?.close;
  if (last === undefined) return { support: [], resistance: [] };
  const uniq = (xs: number[]) => [...new Set(xs)];
  return {
    resistance: uniq(highs.filter((v) => v > last)).sort((a, b) => a - b).slice(0, perSide),
    support: uniq(lows.filter((v) => v < last)).sort((a, b) => b - a).slice(0, perSide),
  };
}
