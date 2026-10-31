import { afterEach, describe, expect, it, vi } from "vitest";
import { rsiSeries } from "@contracts/indicators";
import { calcAdx, calcStochRsi, evaluateDeltaTrend } from "../indicators/deltaforce.trend";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { evaluateEliteCouncil } from "../orchestrator/elite";
import { callEliteLLM } from "../orchestrator/eliteLlm";
import { fiveMinuteBearishFvg, flatSeries, range4HAtTop, range4HTight, trendSeries } from "./fixtures/advancedFixtures";

vi.mock("../orchestrator/eliteLlm", () => ({ callEliteLLM: vi.fn() }));

const H = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(callEliteLLM).mockReset();
});

describe("Delta Force trend", () => {
  it("Trend 12/12: all 4 pillars align on 3 timeframes -> ULTRA_TREND", () => {
    const out = evaluateDeltaTrend(trendSeries(300, 4 * H, 100, 1), trendSeries(300, H, 100, 1), trendSeries(300, 900_000, 100, 1));
    expect(out.verdict).toBe("ULTRA_TREND");
    expect(out.direction).toBe("BULLISH");
    expect(out.score).toBe(12);
    for (const tf of ["4H", "1H", "15m"] as const) {
      expect(out.timeframes[tf].supertrend).toBe("BULLISH");
      expect(out.timeframes[tf].adx).toBeGreaterThan(25);
      expect(out.timeframes[tf].emaAligned).toBe(true);
      expect(out.timeframes[tf].ichimokuOk).toBe(true);
    }
  });

  it("4H ADX < 20 -> RANGE_DETECTED", () => {
    const out = evaluateDeltaTrend(flatSeries(300, 4 * H, 100, 1), trendSeries(300, H, 100, 1), trendSeries(300, 900_000, 100, 1));
    expect(out.timeframes["4H"].adx).toBeLessThan(20);
    expect(out.verdict).toBe("RANGE_DETECTED");
  });

  it("opposite directions across timeframes -> CONFLICT", () => {
    const out = evaluateDeltaTrend(trendSeries(300, 4 * H, 100, 1), trendSeries(300, H, 100, -1), trendSeries(300, 900_000, 100, 1));
    expect(out.verdict).toBe("CONFLICT");
  });

  it("too few candles -> ABSTAIN", () => {
    const out = evaluateDeltaTrend(trendSeries(50, 4 * H, 100, 1), trendSeries(50, H, 100, 1), trendSeries(50, 900_000, 100, 1));
    expect(out.verdict).toBe("ABSTAIN");
  });
});

describe("Delta Force range", () => {
  it("Range Short: 4H at the upper boundary + 5m bearish FVG + StochRSI > 80 -> RANGE_SHORT", () => {
    const m5 = fiveMinuteBearishFvg();
    // preconditions of the mock itself
    expect(m5[m5.length - 3].low).toBeGreaterThan(m5[m5.length - 1].high);
    expect(calcStochRsi(m5.map((c) => c.close), 14, 14)[m5.length - 1]).toBeGreaterThan(80);

    const out = evaluateDeltaRange(range4HAtTop(), m5);
    expect(out.verdict).toBe("RANGE_SHORT");
    expect(out.ltfConfirmation).toBe(true);
    expect(out.stopLoss).toBeGreaterThan(out.boundaries.upper);
    expect(out.targets).toEqual([out.boundaries.midpoint, out.boundaries.lower]);
  });

  it("Range Safety: Donchian width 1.2% -> RANGE_TOO_TIGHT", () => {
    const tight = range4HTight();
    const hi = Math.max(...tight.slice(-20).map((c) => c.high)), lo = Math.min(...tight.slice(-20).map((c) => c.low));
    const widthPct = ((hi - lo) / tight[tight.length - 1].close) * 100;
    expect(widthPct).toBeLessThan(1.5);
    expect(evaluateDeltaRange(tight, fiveMinuteBearishFvg()).verdict).toBe("RANGE_TOO_TIGHT");
  });
});

describe("Elite Council", () => {
  const payload = { symbol: "BTCUSDT", dataStale: false, rr: 2 };

  it("Elite Timeout: LLM hangs for 11s -> 10s circuit breaker returns NO_TRADE", async () => {
    vi.useFakeTimers();
    vi.mocked(callEliteLLM).mockImplementation(
      (_p, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ action: "LONG", reasoning: "too late", confidence: 0.9 }), 11_000);
          signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
        }),
    );
    const pending = evaluateEliteCouncil(payload);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await pending;
    expect(out.action).toBe("NO_TRADE");
    expect(out.confidence).toBe(0);
  });

  it("hard safety (stale data / R:R < 1.5) fails fast without calling the LLM", async () => {
    expect((await evaluateEliteCouncil({ ...payload, dataStale: true })).action).toBe("NO_TRADE");
    expect((await evaluateEliteCouncil({ ...payload, rr: 1.2 })).action).toBe("NO_TRADE");
    expect(callEliteLLM).not.toHaveBeenCalled();
  });

  it("schema failure -> NO_TRADE", async () => {
    vi.mocked(callEliteLLM).mockResolvedValue({ action: "YOLO" });
    expect((await evaluateEliteCouncil(payload)).action).toBe("NO_TRADE");
  });

  it("valid structured answer passes through", async () => {
    vi.mocked(callEliteLLM).mockResolvedValue({ action: "LONG", reasoning: "ok", confidence: 0.7 });
    expect((await evaluateEliteCouncil(payload)).action).toBe("LONG");
  });
});

describe("Look-ahead prevention", () => {
  it("Look-Ahead Prevention: RSI at index 99 is unchanged after appending a candle", () => {
    const candles = trendSeries(100, H, 100, 1).map((c, i) => ({ ...c, close: c.close + Math.sin(i) * 0.7 }));
    const closes = candles.map((c) => c.close);
    const before = rsiSeries(closes, 14);
    expect(before[99]).not.toBeNull();

    const extended = [...closes, closes[99] * 0.5]; // fake, wildly different candle
    const after = rsiSeries(extended, 14);
    expect(after[99]).toBe(before[99]); // EXACTLY the same
  });

  it("ADX and StochRSI at index 99 are also unchanged after appending a candle", () => {
    const candles = trendSeries(100, H, 100, 1).map((c, i) => ({ ...c, close: c.close + Math.sin(i) * 0.7 }));
    const fake = { ...candles[99], high: candles[99].high * 3, low: candles[99].low * 0.2, close: candles[99].close * 0.5 };
    const ext = [...candles, fake];
    const adxBefore = calcAdx(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close));
    const adxAfter = calcAdx(ext.map((c) => c.high), ext.map((c) => c.low), ext.map((c) => c.close));
    expect(adxAfter[99]).toBe(adxBefore[99]);
    const sBefore = calcStochRsi(candles.map((c) => c.close));
    const sAfter = calcStochRsi(ext.map((c) => c.close));
    expect(sAfter[99]).toBe(sBefore[99]);
  });
});
