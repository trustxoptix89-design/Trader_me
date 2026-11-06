import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import {
  buildPipelineCandles, classifyCandles, DB_TIMEFRAME, MIN_CLOSED_CANDLES, PIPELINE_TIMEFRAMES, READ_MARGIN, readPipelineCandles, TF_MS,
  type PipelineTimeframe, type StoredCandle,
} from "../pipeline/candleAdapter";
import { fiveMinuteBearishFvg, range4HAtTop, trendSeries } from "./fixtures/advancedFixtures";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** HISTORICAL-REAL: 999 BTCUSDT 1h candles from Binance Vision (stored file). */
const real = (JSON.parse(readFileSync(`${root}fixtures/btcusdt_1h.json`, "utf8")) as { candles: Candle[] }).candles;

const H = TF_MS["1H"];
/** SYNTHETIC timing grid: n aligned candles ending at `lastOpen`, finalized one second after each close. Prices are arbitrary but valid. */
function grid(tf: PipelineTimeframe, n: number, lastOpen: number, over: (i: number, c: StoredCandle) => StoredCandle = (_, c) => c): StoredCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const time = lastOpen - (n - 1 - i) * TF_MS[tf];
    return over(i, { time, open: 100, high: 101, low: 99, close: 100.5, volume: 1, ingestedAt: time + TF_MS[tf] + 1000 });
  });
}
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % TF_MS["4H"]) + 1_000_000; // aligned base + offset, used as "now"
const lastClosedOpen = (tf: PipelineTimeframe): number => Math.floor(NOW / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf];

describe("candle adapter: constants", () => {
  it("covers exactly 4H, 1H, 15m, 5m with the documented DB names and sizes", () => {
    expect([...PIPELINE_TIMEFRAMES]).toEqual(["4H", "1H", "15m", "5m"]);
    expect(DB_TIMEFRAME).toEqual({ "4H": "4h", "1H": "1h", "15m": "15m", "5m": "5m" });
    expect(TF_MS).toEqual({ "4H": 14_400_000, "1H": 3_600_000, "15m": 900_000, "5m": 300_000 });
    expect(MIN_CLOSED_CANDLES).toEqual({ "4H": 360, "1H": 360, "15m": 360, "5m": 120 }); // measured: docs/HISTORY_DEPTH.md
    expect(READ_MARGIN).toBe(1);
  });
});

describe("candle adapter: closed-candle rule (HISTORICAL-REAL and SYNTHETIC)", () => {
  it("HISTORICAL-REAL: every one of the 999 real BTCUSDT 1h candles satisfies alignment/value rules when finalized", () => {
    const rows: StoredCandle[] = real.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, ingestedAt: c.time + H + 5 }));
    const now = real[real.length - 1].time + H + 10;
    const { closed, excluded } = classifyCandles(rows, "1H", now);
    expect(excluded).toEqual([]);
    expect(closed.length).toBe(real.length);
    expect(closed[0].closeTime).toBe(real[0].time + H - 1);
  });

  it("accepts a candle at the exact close instant (time + TF == now) when it was captured at/after close", () => {
    const t = lastClosedOpen("1H");
    const r = classifyCandles([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 0, ingestedAt: t + H }], "1H", t + H);
    expect(r.closed.length).toBe(1);
    expect(r.excluded).toEqual([]);
  });

  it("excludes the candle still forming (time + TF > now)", () => {
    const t = lastClosedOpen("1H") + H;
    const r = classifyCandles([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: NOW - 1 }], "1H", NOW);
    expect(r.closed.length).toBe(0);
    expect(r.excluded).toEqual([{ time: t, reason: "NOT_CLOSED" }]);
  });

  it("excludes a candle whose stored snapshot was taken BEFORE it closed, even though it has closed since (frozen partial values)", () => {
    const t = lastClosedOpen("1H");
    const r = classifyCandles([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: t + H - 1 }], "1H", NOW);
    expect(r.excluded).toEqual([{ time: t, reason: "UNFINALIZED_SNAPSHOT" }]);
  });

  it("rejects inconsistent clocks: captured in the future, or a non-finite now", () => {
    const t = lastClosedOpen("1H");
    expect(classifyCandles([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: NOW + 1 }], "1H", NOW).excluded[0].reason).toBe("CLOCK_INCONSISTENT");
    expect(classifyCandles([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: t + H }], "1H", Number.NaN).excluded[0].reason).toBe("CLOCK_INCONSISTENT");
  });

  it("rejects misaligned timestamps and invalid values", () => {
    const t = lastClosedOpen("1H");
    const base = { open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: t + H };
    expect(classifyCandles([{ ...base, time: t + 1 }], "1H", NOW).excluded[0].reason).toBe("MISALIGNED_TIMESTAMP");
    expect(classifyCandles([{ ...base, time: t + 0.5 }], "1H", NOW).excluded[0].reason).toBe("MISALIGNED_TIMESTAMP");
    expect(classifyCandles([{ ...base, time: t, high: 0.5 }], "1H", NOW).excluded[0].reason).toBe("INVALID_VALUE");
    expect(classifyCandles([{ ...base, time: t, close: 3 }], "1H", NOW).excluded[0].reason).toBe("INVALID_VALUE");
    expect(classifyCandles([{ ...base, time: t, volume: -1 }], "1H", NOW).excluded[0].reason).toBe("INVALID_VALUE");
    expect(classifyCandles([{ ...base, time: t, open: Number.NaN }], "1H", NOW).excluded[0].reason).toBe("INVALID_VALUE");
  });

  it("treats a duplicated timestamp as untrusted: ALL copies are excluded", () => {
    const t = lastClosedOpen("1H");
    const a = { time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: t + H };
    const r = classifyCandles([a, { ...a, close: 1.5 }], "1H", NOW);
    expect(r.closed.length).toBe(0);
    expect(r.excluded.map((e) => e.reason)).toEqual(["DUPLICATE_TIME", "DUPLICATE_TIME"]);
  });

  it("returns ascending order regardless of input order", () => {
    const rows = grid("1H", 5, lastClosedOpen("1H"));
    const r = classifyCandles([rows[3], rows[0], rows[4], rows[1], rows[2]], "1H", NOW);
    expect(r.closed.map((c) => c.time)).toEqual(rows.map((x) => x.time));
  });
});

describe("candle adapter: sufficiency and the pipeline input (SYNTHETIC grids)", () => {
  const full = (n: Record<PipelineTimeframe, number>, over?: (tf: PipelineTimeframe) => ((i: number, c: StoredCandle) => StoredCandle) | undefined): Record<PipelineTimeframe, StoredCandle[]> =>
    Object.fromEntries(PIPELINE_TIMEFRAMES.map((tf) => [tf, grid(tf, n[tf], lastClosedOpen(tf), over?.(tf))])) as Record<PipelineTimeframe, StoredCandle[]>;
  const exact = { ...MIN_CLOSED_CANDLES };

  it("READY with exactly the required closed candles; 4 timeframes, ascending, closeTime set", () => {
    const r = buildPipelineCandles(full(exact), NOW);
    expect(r.status).toBe("READY");
    for (const tf of PIPELINE_TIMEFRAMES) {
      expect(r.candles[tf].length).toBe(MIN_CLOSED_CANDLES[tf]);
      expect(r.reports[tf].sufficient).toBe(true);
      expect(r.reports[tf].lastClosedTime).toBe(lastClosedOpen(tf));
    }
  });

  it("ABSTAIN with a reason and EMPTY arrays when one timeframe is one candle short (199 on 15m)", () => {
    const r = buildPipelineCandles(full({ ...exact, "15m": exact["15m"] - 1 }), NOW);
    expect(r.status).toBe("ABSTAIN");
    expect(r.reason).toContain(`15m: ${exact["15m"] - 1}/${exact["15m"]}`);
    for (const tf of PIPELINE_TIMEFRAMES) expect(r.candles[tf].length).toBe(0);
  });

  it("a forming candle in the rows read leaves required-1 closed -> ABSTAIN; reading required+1 rows with one forming -> READY", () => {
    const withForming = (n: number) => {
      const rows = full({ ...exact, "1H": n });
      const t = lastClosedOpen("1H") + H;
      rows["1H"].push({ time: t, open: 1, high: 2, low: 1, close: 2, volume: 1, ingestedAt: NOW - 1 });
      return rows;
    };
    const short = buildPipelineCandles(withForming(exact["1H"] - 1), NOW);
    expect(short.status).toBe("ABSTAIN");
    expect(short.reports["1H"].excluded).toEqual([{ time: lastClosedOpen("1H") + H, reason: "NOT_CLOSED" }]);
    expect(buildPipelineCandles(withForming(exact["1H"]), NOW).status).toBe("READY");
  });

  it("an UNFINALIZED newest candle is dropped and reported (the previous closed candle remains the last)", () => {
    const rows = full({ ...exact, "1H": exact["1H"] + 1 }, (tf) => (tf === "1H" ? (i, c) => (i === exact["1H"] ? { ...c, ingestedAt: c.time + H - 5 } : c) : undefined));
    const r = buildPipelineCandles(rows, NOW);
    expect(r.status).toBe("READY");
    expect(r.reports["1H"].excluded.map((e) => e.reason)).toEqual(["UNFINALIZED_SNAPSHOT"]);
    expect(r.reports["1H"].lastClosedTime).toBe(lastClosedOpen("1H") - H);
  });

  it("readPipelineCandles reads exactly required + margin rows per timeframe, mapped to the DB names, and tolerates any row order", async () => {
    const asked: string[] = [];
    const r = await readPipelineCandles("BTCUSDT", NOW, async (symbol, dbTf, limit) => {
      asked.push(`${symbol}:${dbTf}:${limit}`);
      const tf = (Object.keys(DB_TIMEFRAME) as PipelineTimeframe[]).find((k) => DB_TIMEFRAME[k] === dbTf) as PipelineTimeframe;
      return grid(tf, limit - 1, lastClosedOpen(tf)).reverse(); // newest first; one row short because the extra row is the forming one we do not add
    });
    expect(asked).toEqual(PIPELINE_TIMEFRAMES.map((tf) => `BTCUSDT:${DB_TIMEFRAME[tf]}:${MIN_CLOSED_CANDLES[tf] + READ_MARGIN}`));
    expect(r.status).toBe("READY");
    expect(r.candles["4H"][0].time < r.candles["4H"][MIN_CLOSED_CANDLES["4H"] - 1].time).toBe(true);
  });
});

describe("minimums are tied to the real indicator behaviour (SYNTHETIC series, real code)", () => {
  const H4 = TF_MS["4H"], M15 = TF_MS["15m"];
  const insufficient = (reasoning: string): boolean => reasoning.includes("Insufficient");
  it("Delta Trend: 199 candles on any of 4H/1H/15m -> ABSTAIN(insufficient); 200 on all -> evaluated", () => {
    const mk = (a: number, b: number, c: number) => evaluateDeltaTrend(trendSeries(a, H4, 100, 1), trendSeries(b, H, 100, 1), trendSeries(c, M15, 100, 1));
    for (const [a, b, c] of [[199, 200, 200], [200, 199, 200], [200, 200, 199]] as const) {
      const out = mk(a, b, c);
      expect(out.verdict).toBe("ABSTAIN");
      expect(insufficient(out.reasoning)).toBe(true);
    }
    expect(insufficient(mk(200, 200, 200).reasoning)).toBe(false);
  });
  it("Delta Range: 4H 34 / 35 and 5m 29 / 30 are the exact thresholds", () => {
    const five = fiveMinuteBearishFvg();
    expect(insufficient(evaluateDeltaRange(range4HAtTop(34), five.slice(-30)).reasoning)).toBe(true);
    expect(insufficient(evaluateDeltaRange(range4HAtTop(35), five.slice(-29)).reasoning)).toBe(true);
    expect(insufficient(evaluateDeltaRange(range4HAtTop(35), five.slice(-30)).reasoning)).toBe(false);
  });
});
