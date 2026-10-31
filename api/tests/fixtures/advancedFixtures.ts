import type { Candle } from "@contracts/types";

const T0 = 1_700_000_000_000;

function candle(index: number, stepMs: number, open: number, close: number, pad: number): Candle {
  const time = T0 + index * stepMs;
  return { time, closeTime: time + stepMs - 1, open, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad, close, volume: 1_000 };
}

/** Deterministic steady trend (dir 1 = up, -1 = down) with a small wiggle: ADX high, EMAs aligned, price beyond the cloud. */
export function trendSeries(n: number, stepMs: number, start: number, dir: 1 | -1): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const close = start * Math.pow(1 + 0.004 * dir, i) * (1 + 0.0006 * Math.sin(i * 1.3));
    out.push(candle(i, stepMs, prev, close, prev * 0.0008));
    prev = close;
  }
  return out;
}

/** Flat oscillation (no trend) used to drive ADX below 20. */
export function flatSeries(n: number, stepMs: number, center: number, amplitude: number): Candle[] {
  const out: Candle[] = [];
  let prev = center;
  for (let i = 0; i < n; i++) {
    const close = center + amplitude * Math.sin(i * 0.9);
    out.push(candle(i, stepMs, prev, close, amplitude * 0.1));
    prev = close;
  }
  return out;
}

/** 4H bars oscillating in a ~100..110 box, the LAST bar sitting at the top (cos peak at i = n-1). */
export function range4HAtTop(n = 60, lo = 100, hi = 110, width = 20): Candle[] {
  const mid = (lo + hi) / 2, amp = (hi - lo) / 2 - 0.5;
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < n; i++) {
    const close = mid + amp * Math.cos((2 * Math.PI * (i - (n - 1))) / width);
    out.push(candle(i, 4 * 3_600_000, prev, close, 0.5));
    prev = close;
  }
  return out;
}

/** 4H box that is only ~1.2% wide: must trip the safety gate. */
export function range4HTight(n = 60): Candle[] {
  return range4HAtTop(n, 100, 101.2, 20);
}

/**
 * 5m bars: decline, strong rally (RSI max of the stoch window), then a bearish FVG on the last three bars
 * (bar[-3].low > bar[-1].high) while StochRSI(14) stays > 80.
 */
export function fiveMinuteBearishFvg(): Candle[] {
  const step = 300_000, out: Candle[] = [];
  let prev = 100, i = 0;
  for (; i < 20; i++) { const close = 100 - 0.2 * (i + 1); out.push(candle(i, step, prev, close, 0.05)); prev = close; }
  for (; i < 37; i++) { const close = prev + 0.9 * (1 + (i - 20) * 0.08); out.push(candle(i, step, prev, close, 0.05)); prev = close; }
  const c3Close = prev + 0.3;               // bar[-3]
  out.push(candle(i++, step, prev, c3Close, 0.01));
  const c2Close = c3Close - 0.05;           // bar[-2]
  out.push(candle(i++, step, c3Close, c2Close, 0.01));
  out.push(candle(i++, step, prev - 0.1, prev - 0.15, 0.01)); // bar[-1] gaps below bar[-3].low (= prev - 0.01)
  return out;
}
