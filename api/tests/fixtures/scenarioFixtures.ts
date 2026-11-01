import type { Candle } from "@contracts/types";
import type { PipelineInput } from "../../orchestrator/machine";

/**
 * Explicit OHLCV generators for the end-to-end scenarios. Everything is a closed-form deterministic function of the index:
 * no randomness, no clock, no mocks of any room or agent. The setup helpers below derive entry / invalidation / targets from the
 * candles with their OWN simple rules (not from the verifier or the rooms), so a scenario is "raw data in -> decision out".
 */
const T0 = 1_700_000_000_000;

function bar(index: number, stepMs: number, open: number, close: number, volume = 1_000): Candle {
  const time = T0 + index * stepMs;
  const pad = Math.max(open, close) * 0.0006 + Math.abs(close - open) * 0.5; // body-dependent wick: no equal highs/lows at turning points
  return { time, closeTime: time + stepMs - 1, open, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad, close, volume };
}

export interface ZigzagOptions { drift?: number; amp?: number; period?: number }

/** Trend with real pullbacks: geometric drift times a sine wobble, so confirmed swing highs/lows exist. dir 1 = up, -1 = down. */
export function zigzagTrend(n: number, stepMs: number, start: number, dir: 1 | -1, o: ZigzagOptions = {}): Candle[] {
  const { drift = 0.004, amp = 0.012, period = 10 } = o;
  const out: Candle[] = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const close = start * Math.pow(1 + drift * dir, i) * (1 + amp * Math.sin((2 * Math.PI * i) / period));
    out.push(bar(i, stepMs, prev, close));
    prev = close;
  }
  return out;
}

/** Sideways market: oscillation around a centre, no drift. */
export function sidewaysSeries(n: number, stepMs: number, center: number, amplitude: number, period = 10): Candle[] {
  const out: Candle[] = [];
  let prev = center;
  for (let i = 0; i < n; i++) {
    const close = center + amplitude * Math.sin((2 * Math.PI * i) / period);
    out.push(bar(i, stepMs, prev, close));
    prev = close;
  }
  return out;
}

/** Re-times a series so its last candle opened exactly one timeframe before `now` (fresh, contiguous). */
export function retimeTo(candles: Candle[], stepMs: number, now: number): Candle[] {
  const lastOpen = now - stepMs;
  return candles.map((c, i) => {
    const time = lastOpen - (candles.length - 1 - i) * stepMs;
    return { ...c, time, closeTime: time + stepMs - 1 };
  });
}

function atrOf(c: Candle[], period = 14): number {
  const tr = (i: number) => Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  for (let i = period + 1; i < c.length; i++) a = (a * (period - 1) + tr(i)) / period;
  return a;
}

/** Latest confirmed fractal swing (3 bars each side) strictly beyond `ref`, searched backwards. */
function swingBeyond(c: Candle[], kind: "low" | "high", ref: number): number | undefined {
  for (let i = c.length - 4; i >= 3; i--) {
    let ok = true;
    for (let j = 1; j <= 3 && ok; j++) ok = kind === "low" ? c[i].low < c[i - j].low && c[i].low < c[i + j].low : c[i].high > c[i - j].high && c[i].high > c[i + j].high;
    if (ok && (kind === "low" ? c[i].low < ref : c[i].high > ref)) return kind === "low" ? c[i].low : c[i].high;
  }
  return undefined;
}

export interface SetupOptions { rr?: number; buffer?: number }

/** Entry at the last close, invalidation just beyond the latest protective swing, target at `rr` times the risk (two targets). */
export function setupFromCandles(c: Candle[], direction: "long" | "short", o: SetupOptions = {}): PipelineInput["setup"] {
  const { rr = 2.2, buffer = 0.1 } = o;
  const atr = atrOf(c);
  const entry = c[c.length - 1].close;
  const swing = swingBeyond(c, direction === "long" ? "low" : "high", entry);
  if (swing === undefined) throw new Error("fixture has no protective swing");
  const invalidation = direction === "long" ? swing - buffer * atr : swing + buffer * atr;
  const risk = Math.abs(entry - invalidation);
  const sign = direction === "long" ? 1 : -1;
  return { entry, invalidation, targets: [entry + sign * rr * risk, entry + sign * (rr + 1) * risk], atr };
}

/**
 * Ends the series at the latest bar whose protective swing is `minAtr`..`maxAtr` ATR away (a realistic entry just after a pullback),
 * so the scenario has a stop that is neither inside the noise nor absurdly far. Pure function of the candles.
 */
export function trimToPullbackEntry(c: Candle[], direction: "long" | "short", minAtr = 1.2, maxAtr = 2.4): Candle[] {
  for (let n = c.length; n > c.length - 40; n--) {
    const s = c.slice(0, n);
    const swing = swingBeyond(s, direction === "long" ? "low" : "high", s[n - 1].close);
    if (swing === undefined) continue;
    const dist = Math.abs(s[n - 1].close - swing) / atrOf(s);
    if (dist >= minAtr && dist <= maxAtr) return s;
  }
  throw new Error("no pullback entry window in fixture");
}
