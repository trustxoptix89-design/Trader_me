import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { atrSeries, emaSeries, macdSeries, rsiSeries, vwapSeries } from "@contracts/indicators";
import { calcAdx, calcStochRsi } from "../indicators/deltaforce.trend";

/**
 * Golden-value (reference) tests: our indicators vs TA-Lib 0.8.3 / pandas on REAL BTCUSDT 1h candles
 * (fixtures/btcusdt_1h.json + fixtures/golden_values.json, produced by tools/golden/generate_golden.py).
 * Tolerances are the ones in the specification (RSI +-0.5, MACD +-0.1%, EMA +-0.01%, ATR +-0.5%, VWAP +-0.1%).
 * ADX and StochRSI have no PDF tolerance: +-0.5 absolute is a project choice.
 */
const read = <T>(rel: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as T;
const candles = read<{ candles: Candle[] }>("../../fixtures/btcusdt_1h.json").candles;
const golden = read<{ points: { index: number; iso: string; values: Record<string, number> }[] }>("../../fixtures/golden_values.json");
const close = candles.map((c) => c.close);

const ours: Record<string, (number | null)[]> = {
  rsi14: rsiSeries(close, 14),
  ema20: emaSeries(close, 20),
  ema50: emaSeries(close, 50),
  ema200: emaSeries(close, 200),
  macd: macdSeries(close).macd,
  atr14: atrSeries(candles, 14),
  vwap_daily: vwapSeries(candles),
  adx14: calcAdx(candles.map((c) => c.high), candles.map((c) => c.low), close, 14),
  stochrsi_k: calcStochRsi(close),
};
type Tol = { abs: number } | { relPct: number };
const tolerance: Record<string, Tol> = {
  rsi14: { abs: 0.5 }, ema20: { relPct: 0.01 }, ema50: { relPct: 0.01 }, ema200: { relPct: 0.01 },
  macd: { relPct: 0.1 }, atr14: { relPct: 0.5 }, vwap_daily: { relPct: 0.1 }, adx14: { abs: 0.5 }, stochrsi_k: { abs: 0.5 },
};
const within = (a: number, ref: number, t: Tol): boolean => ("abs" in t ? Math.abs(a - ref) <= t.abs : (Math.abs(a - ref) / Math.abs(ref)) * 100 <= t.relPct);

describe("golden values vs TA-Lib on real BTCUSDT 1h candles", () => {
  it("the fixture holds real candles and at least 3 reference points", () => {
    expect(candles.length).toBeGreaterThan(900);
    expect(golden.points.length).toBeGreaterThanOrEqual(3);
  });
  for (const [name, tol] of Object.entries(tolerance)) {
    it(`${name} matches the reference at every golden point`, () => {
      for (const p of golden.points) {
        const value = ours[name][p.index];
        expect(value).not.toBeNull();
        expect(within(value as number, p.values[name], tol)).toBe(true);
      }
    });
  }
});
