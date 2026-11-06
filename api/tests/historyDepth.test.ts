import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { buildPipelineCandles, MIN_CLOSED_CANDLES, PIPELINE_TIMEFRAMES, TF_MS, type StoredCandle } from "../pipeline/candleAdapter";
import { INDICATOR_HISTORY, MIN_VALID_CANDLES, STABILITY_EPSILON, STABLE_CLOSED_CANDLES, TIMEFRAME_INDICATORS } from "../pipeline/historyRequirements";
import { DEFAULT_STUDY, runStudy } from "../pipeline/historyStudy";
import { fiveMinuteBearishFvg, fiveMinuteBearishFvgLong, range4HAtTop } from "./fixtures/advancedFixtures";

// DATA CLASS: HISTORICAL-REAL (fixtures/btcusdt_1h.json) for the measurements; SYNTHETIC for the adapter/range boundary checks.
const real = (JSON.parse(readFileSync(new URL("../../fixtures/btcusdt_1h.json", import.meta.url), "utf8")) as { candles: Record<string, number>[] }).candles
  .map((c) => ({ time: +c.time, closeTime: +c.closeTime, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume })) as Candle[];
const study = runStudy(real, DEFAULT_STUDY, undefined, false); // measured once; the tests below read it

describe("history depth: the published table is what the code measures (HISTORICAL-REAL)", () => {
  it("the study covers 999 real candles and 200 end positions", () => { expect(study.candles).toBe(999); expect(study.endPositions).toBe(200); });
  for (const h of INDICATOR_HISTORY) {
    const row = study.rows.find((r) => r.indicator === h.indicator);
    it(`${h.indicator}: minValid ${h.minValid} and stable ${h.stable} (eps ${STABILITY_EPSILON}) are re-measured`, () => {
      expect(row === undefined).toBe(false);
      if (!row) return;
      expect(row.minValid).toBe(h.minValid);
      expect(row.stable[String(STABILITY_EPSILON)]).toBe(h.stable);
    });
    it(`${h.indicator}: error <= eps at every depth >= stable, and the depth just below stable is NOT within eps (tight)`, () => {
      if (!row) return;
      for (const [d, e] of Object.entries(row.maxErrByDepth)) if (Number(d) >= h.stable) expect(e <= STABILITY_EPSILON).toBe(true);
      const below = row.maxErrByDepth[h.stable - DEFAULT_STUDY.step];
      if (below !== undefined) expect(below > STABILITY_EPSILON).toBe(true);
    });
  }
  it("different indicators need different warm-ups: the spread between the shortest and longest stable depth is large", () => {
    const s = INDICATOR_HISTORY.map((h) => h.stable);
    expect(Math.max(...s) / Math.min(...s) >= 4).toBe(true);
  });
  it("every indicator named by a timeframe exists in the table (no silent NaN)", () => {
    for (const tf of PIPELINE_TIMEFRAMES) for (const n of TIMEFRAME_INDICATORS[tf]) expect(INDICATOR_HISTORY.some((h) => h.indicator === n)).toBe(true);
  });
  it("per-timeframe requirement = max stable depth of its indicators and never below the module minimum", () => {
    expect(STABLE_CLOSED_CANDLES).toEqual({ "4H": 360, "1H": 360, "15m": 360, "5m": 120 });
    for (const tf of PIPELINE_TIMEFRAMES) expect(STABLE_CLOSED_CANDLES[tf] >= MIN_VALID_CANDLES[tf]).toBe(true);
    expect(MIN_CLOSED_CANDLES).toEqual(STABLE_CLOSED_CANDLES);
  });
});

describe("history depth: insufficient history never produces a pipeline input (SYNTHETIC grids)", () => {
  const NOW = 1_800_000_000_000 + 60_000; // aligned base + offset so every ingestedAt <= now
  const grid = (tf: (typeof PIPELINE_TIMEFRAMES)[number], n: number): StoredCandle[] => Array.from({ length: n }, (_, i) => {
    const time = Math.floor(NOW / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf] - (n - 1 - i) * TF_MS[tf];
    return { time, open: 100, high: 101, low: 99, close: 100.5, volume: 1, ingestedAt: time + TF_MS[tf] + 1000 };
  });
  for (const tf of PIPELINE_TIMEFRAMES) {
    it(`${tf}: between the module minimum (${MIN_VALID_CANDLES[tf]}) and the stable depth (${MIN_CLOSED_CANDLES[tf]}) -> ABSTAIN with empty arrays`, () => {
      for (const n of [MIN_VALID_CANDLES[tf], MIN_CLOSED_CANDLES[tf] - 1]) {
        const rows = Object.fromEntries(PIPELINE_TIMEFRAMES.map((t) => [t, grid(t, MIN_CLOSED_CANDLES[t])])) as Record<(typeof PIPELINE_TIMEFRAMES)[number], StoredCandle[]>;
        rows[tf] = grid(tf, n);
        const r = buildPipelineCandles(rows, NOW);
        expect(r.status).toBe("ABSTAIN");
        expect(r.reason).toContain(`${tf}: ${n}/${MIN_CLOSED_CANDLES[tf]}`);
        expect(PIPELINE_TIMEFRAMES.every((t) => r.candles[t].length === 0)).toBe(true);
      }
    });
  }
  it("a missing candle inside the series reduces the closed count below the requirement (it is not papered over)", () => {
    const rows = Object.fromEntries(PIPELINE_TIMEFRAMES.map((t) => [t, grid(t, MIN_CLOSED_CANDLES[t])])) as Record<(typeof PIPELINE_TIMEFRAMES)[number], StoredCandle[]>;
    rows["1H"] = rows["1H"].filter((_, i) => i !== 50); // hole in the middle
    expect(buildPipelineCandles(rows, NOW).status).toBe("ABSTAIN");
  });
});

describe("history depth: the original Range observation (SYNTHETIC 5m fixture, real code)", () => {
  it("the same fixture triggers with 40 candles but not with the shortest legal read of the old rule (31): the result depends on depth", () => {
    const five = fiveMinuteBearishFvg(), box = range4HAtTop(300, 100, 110, 10);
    expect(evaluateDeltaRange(box, five).verdict).toBe("RANGE_SHORT");
    expect(evaluateDeltaRange(box, five.slice(-31)).verdict).toBe("ABSTAIN");
  });
  it("FINDING: the original 40-candle fixture triggers only because of RSI warm-up; the same shape with stable history (>=120) does not", () => {
    const box = range4HAtTop(300, 100, 110, 10);
    expect(evaluateDeltaRange(box, fiveMinuteBearishFvgLong(130, 1, -0.05, -0.15)).verdict).toBe("ABSTAIN");
  });
  it("a fixture whose trigger is stable (StochRSI stays above 80 from 40 to 340 candles) triggers at every depth >= the measured requirement", () => {
    const box = range4HAtTop(300, 100, 110, 10);
    for (const pre of [80, 130, 300]) expect(evaluateDeltaRange(box, fiveMinuteBearishFvgLong(pre, 1, -0.3, -0.04)).verdict).toBe("RANGE_SHORT");
  });
});
