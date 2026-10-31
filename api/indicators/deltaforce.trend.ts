import type { Candle } from "@contracts/types";
import { atrSeries, rsiSeries } from "@contracts/indicators";
import type { DeltaTrendOutput } from "../types/advanced";

// All helpers are strict time-series functions: value[i] depends only on inputs[0..i]. NEVER use future data.

/** Standard EMA: k = 2 / (period + 1), seeded with the SMA of the first `period` values. NaN while warming up. */
export function calcEma(data: number[], period: number): number[] {
  const out: number[] = Array(data.length).fill(Number.NaN);
  if (period < 1 || data.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += data[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < data.length; i++) {
    prev = (data[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

/**
 * ADX with Wilder smoothing for TR, +DM, -DM, then DX -> ADX.
 * ADX[0 .. 2*period-2] is 0 (warm-up): the first ADX is the mean of the first `period` DX values.
 */
export function calcAdx(high: number[], low: number[], close: number[], period: number = 14): number[] {
  const n = close.length;
  const adx: number[] = Array(n).fill(0);
  if (n < period * 2) return adx;
  const tr: number[] = Array(n).fill(0);
  const plusDm: number[] = Array(n).fill(0);
  const minusDm: number[] = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let trSm = 0, pSm = 0, mSm = 0;
  for (let i = 1; i <= period; i++) { trSm += tr[i]; pSm += plusDm[i]; mSm += minusDm[i]; }
  const dx: number[] = Array(n).fill(0);
  const dxAt = (): number => {
    const pdi = trSm === 0 ? 0 : 100 * (pSm / trSm);
    const mdi = trSm === 0 ? 0 : 100 * (mSm / trSm);
    return pdi + mdi === 0 ? 0 : 100 * (Math.abs(pdi - mdi) / (pdi + mdi));
  };
  dx[period] = dxAt();
  for (let i = period + 1; i < n; i++) {
    trSm = trSm - trSm / period + tr[i];
    pSm = pSm - pSm / period + plusDm[i];
    mSm = mSm - mSm / period + minusDm[i];
    dx[i] = dxAt();
  }
  const first = period * 2 - 1;
  let sum = 0;
  for (let i = period; i <= first; i++) sum += dx[i];
  adx[first] = sum / period;
  for (let i = first + 1; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return adx;
}

/**
 * Ichimoku cloud for the CURRENT (last) index, no look-ahead.
 * Tenkan = (9-high + 9-low)/2, Kijun = (26-high + 26-low)/2,
 * SenkouA = (Tenkan + Kijun)/2 shifted +26, SenkouB = (52-high + 52-low)/2 shifted +26.
 * A +26 shift means the cloud at index i is the one computed at index i-26.
 * Returns NaN cloud edges when there is not enough history.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `close` kept for the specified signature
export function calcIchimoku(high: number[], low: number[], close: number[]): { cloudTop: number; cloudBottom: number } {
  const mid = (end: number, len: number): number => {
    let hi = -Infinity, lo = Infinity;
    for (let i = end - len + 1; i <= end; i++) { hi = Math.max(hi, high[i]); lo = Math.min(lo, low[i]); }
    return (hi + lo) / 2;
  };
  const src = high.length - 1 - 26;
  if (src < 51) return { cloudTop: Number.NaN, cloudBottom: Number.NaN };
  const senkouA = (mid(src, 9) + mid(src, 26)) / 2;
  const senkouB = mid(src, 52);
  return { cloudTop: Math.max(senkouA, senkouB), cloudBottom: Math.min(senkouA, senkouB) };
}

/** Supertrend(period, multiplier) with Wilder ATR. `bullish[i]` true => line is the lower band (price above). */
export function calcSupertrend(candles: Candle[], period: number = 10, multiplier: number = 3): { value: number[]; bullish: boolean[] } {
  const n = candles.length;
  const value: number[] = Array(n).fill(Number.NaN);
  const bullish: boolean[] = Array(n).fill(false);
  const atr = atrSeries(candles, period);
  let finalUpper = Number.NaN, finalLower = Number.NaN, bull = true, started = false;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (a === null) continue;
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (!started) {
      finalUpper = basicUpper; finalLower = basicLower; bull = c.close > hl2; started = true;
    } else {
      const prevClose = candles[i - 1].close;
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (bull && c.close < finalLower) bull = false;
      else if (!bull && c.close > finalUpper) bull = true;
    }
    value[i] = bull ? finalLower : finalUpper;
    bullish[i] = bull;
  }
  return { value, bullish };
}

/** Wilder ATR (shared with the range module). NaN while warming up. */
export function calcAtr(candles: Candle[], period: number = 14): number[] {
  return atrSeries(candles, period).map((v) => (v === null ? Number.NaN : v));
}

/** Stochastic RSI on a 0..100 scale: (RSI - min(RSI,n)) / (max(RSI,n) - min(RSI,n)) * 100. NaN while warming up. */
export function calcStochRsi(close: number[], rsiPeriod: number = 14, stochPeriod: number = 14): number[] {
  const rsi = rsiSeries(close, rsiPeriod);
  const out: number[] = Array(close.length).fill(Number.NaN);
  for (let i = 0; i < close.length; i++) {
    if (i - stochPeriod + 1 < 0) continue;
    const window = rsi.slice(i - stochPeriod + 1, i + 1);
    if (window.some((v) => v === null)) continue;
    const vals = window as number[];
    const hi = Math.max(...vals), lo = Math.min(...vals);
    out[i] = hi === lo ? 0 : ((vals[vals.length - 1] - lo) / (hi - lo)) * 100;
  }
  return out;
}

type TfDetail = DeltaTrendOutput["timeframes"]["4H"];
interface TfEval { bullPts: number; bearPts: number; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; detail: TfDetail; ready: boolean }

const EMPTY_TF: TfDetail = { supertrend: "NA", adx: 0, emaAligned: false, ichimokuOk: false };
const MIN_CANDLES = 200; // EMA200 needs 200 closed candles; also covers ADX(14) and Ichimoku(52+26).

function evaluateTimeframe(candles: Candle[]): TfEval {
  if (candles.length < MIN_CANDLES) return { bullPts: 0, bearPts: 0, direction: "NEUTRAL", detail: { ...EMPTY_TF }, ready: false };
  const high = candles.map((c) => c.high), low = candles.map((c) => c.low), close = candles.map((c) => c.close);
  const last = close.length - 1, price = close[last];
  const st = calcSupertrend(candles, 10, 3);
  const adx = calcAdx(high, low, close, 14)[last];
  const e20 = calcEma(close, 20)[last], e50 = calcEma(close, 50)[last], e200 = calcEma(close, 200)[last];
  const cloud = calcIchimoku(high, low, close);

  // Pillar A: Close > Supertrend[10,3] (bullish) / Close < Supertrend (bearish)
  const aBull = price > st.value[last], aBear = price < st.value[last];
  // Pillar B: ADX > 25 (direction-neutral strength)
  const b = adx > 25;
  // Pillar C: EMA20 > EMA50 > EMA200 strictly (bullish) / reverse strictly (bearish)
  const cBull = e20 > e50 && e50 > e200, cBear = e20 < e50 && e50 < e200;
  // Pillar D: Close > Cloud Top (bullish) / Close < Cloud Bottom (bearish)
  const dBull = price > cloud.cloudTop, dBear = price < cloud.cloudBottom;

  const bullPts = (aBull ? 1 : 0) + (b ? 1 : 0) + (cBull ? 1 : 0) + (dBull ? 1 : 0);
  const bearPts = (aBear ? 1 : 0) + (b ? 1 : 0) + (cBear ? 1 : 0) + (dBear ? 1 : 0);
  const direction = bullPts > bearPts ? "BULLISH" : bearPts > bullPts ? "BEARISH" : "NEUTRAL";
  return {
    bullPts, bearPts, direction, ready: true,
    detail: { supertrend: st.bullish[last] ? "BULLISH" : "BEARISH", adx, emaAligned: cBull || cBear, ichimokuOk: dBull || dBear },
  };
}

export function evaluateDeltaTrend(tf4H: Candle[], tf1H: Candle[], tf15m: Candle[]): DeltaTrendOutput {
  const e4 = evaluateTimeframe(tf4H), e1 = evaluateTimeframe(tf1H), e15 = evaluateTimeframe(tf15m);
  const timeframes = { "4H": e4.detail, "1H": e1.detail, "15m": e15.detail };

  if (!e4.ready || !e1.ready || !e15.ready) {
    return { verdict: "ABSTAIN", direction: "NEUTRAL", score: 0, timeframes, reasoning: `Insufficient candles (need >= ${MIN_CANDLES} per timeframe).` };
  }
  // 1. ADX on 4H < 20 -> RANGE_DETECTED
  if (e4.detail.adx < 20) {
    return { verdict: "RANGE_DETECTED", direction: "NEUTRAL", score: 0, timeframes, reasoning: `4H ADX ${e4.detail.adx.toFixed(1)} < 20: ranging market, trend logic not applicable.` };
  }
  // 2/3. Sum pillar points (1 pt each for a bullish/bearish match, 0 otherwise)
  const evals = [e4, e1, e15];
  const bull = evals.reduce((s, e) => s + e.bullPts, 0);
  const bear = evals.reduce((s, e) => s + e.bearPts, 0);
  const hasBull = evals.some((e) => e.direction === "BULLISH");
  const hasBear = evals.some((e) => e.direction === "BEARISH");
  const score = Math.max(bull, bear);

  if (hasBull && hasBear) {
    return { verdict: "CONFLICT", direction: "NEUTRAL", score, timeframes, reasoning: "Conflicting timeframe directions." };
  }
  if (evals.every((e) => e.direction === "BULLISH") && bull === 12) {
    return { verdict: "ULTRA_TREND", direction: "BULLISH", score: 12, timeframes, reasoning: "All 4 pillars bullish on 4H, 1H and 15m (12/12)." };
  }
  if (evals.every((e) => e.direction === "BEARISH") && bear === 12) {
    return { verdict: "ULTRA_TREND", direction: "BEARISH", score: 12, timeframes, reasoning: "All 4 pillars bearish on 4H, 1H and 15m (12/12)." };
  }
  if (score >= 8) {
    return { verdict: "WEAK_TREND", direction: "NEUTRAL", score, timeframes, reasoning: `Mixed alignment ${score}/12 (>= 8): abstain.` };
  }
  return { verdict: "ABSTAIN", direction: "NEUTRAL", score, timeframes, reasoning: `Alignment ${score}/12 < 8: abstain.` };
}
