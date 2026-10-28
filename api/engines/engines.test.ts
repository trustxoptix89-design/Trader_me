import { describe, expect, it } from "vitest";
import { DEFAULT_RISK, type Candle, type MarketMetrics, type MarketSnapshot } from "@contracts/types";
import { atrSeries, emaSeries, macdSeries, rsiSeries, sma, swingLevels, vwapSeries } from "./indicators";
import { assessRisk, calculatePosition } from "./risk";
import { runCouncil } from "./council";
import { buyAndHold, classifyRobustness, runBacktest, STRATEGY_VERSION, wilson95 } from "./backtest";

function candleAt(index: number, values: Partial<Candle> = {}): Candle {
  const time = 1_700_000_000_000 + index * 900_000;
  return { time, closeTime: time + 899_999, open: 100, high: 101, low: 99, close: 100, volume: 1_000, quoteVolume: 100_000, ...values };
}

function metricFixture(): MarketMetrics {
  return {
    price: 110, ema20: 105, ema50: 100, ema200: 90, rsi14: 65, atr14: 1, atrPct: 0.91,
    adx14: 25, macdHistogram: 0.5, volumeRatio: 1.2, realizedVolatilityPct: 2,
    support: 100, resistance: 120, trend: "bullish", structure: "higher-highs",
    higherTrend: "bullish", liquidityUsd: 200_000, priceChangePct: 1,
  };
}

function snapshotFixture(): MarketSnapshot {
  const candles = Array.from({ length: 200 }, (_, i) => candleAt(i));
  return {
    exchange: "binance", symbol: "BTCUSDT", interval: "15m", candles,
    higherTimeframes: { "4h": candles.slice(-50) },
    derivatives: { markPrice: 110, fundingRate: 0, nextFundingTime: null, openInterest: 1000, openInterestChangePct: 0 },
    fetchedAt: Date.now(), sourceServerTime: candles.at(-1)!.closeTime, isFresh: true, warnings: [],
  };
}

describe("technical indicators", () => {
  it("computes SMA and EMA only after enough observations", () => {
    expect(sma([1, 2, 3, 4], 4)).toBe(2.5);
    expect(sma([1, 2, 3], 4)).toBeNull();
    expect(emaSeries([1, 2, 3], 4)).toEqual([null, null, null]);
    expect(emaSeries([1, 2, 3, 4], 4)).toEqual([null, null, null, 2.5]);
  });

  it("handles one-way RSI and ATR warm-up without invented values", () => {
    const rsi = rsiSeries(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rsi[13]).toBeNull();
    expect(rsi.at(-1)).toBe(100);
    const candles = Array.from({ length: 15 }, (_, i) => candleAt(i, { high: 102, low: 100 }));
    expect(atrSeries(candles)[13]).toBeNull();
    expect(atrSeries(candles)[14]).toBe(2);
  });
});

describe("risk engine", () => {
  it("calculates quantity from the equity risk budget", () => {
    const position = calculatePosition(DEFAULT_RISK, 100_000, 98_000);
    expect(position.riskAmount).toBe(50);
    expect(position.quantity).toBeCloseTo(0.025);
    expect(position.notional).toBeCloseTo(2500);
    expect(position.leverage).toBeCloseTo(0.25);
  });

  it("approves a valid two-to-one setup and rejects daily-loss and leverage breaches", () => {
    const valid = assessRisk(DEFAULT_RISK, "long", 100_000, 98_000, 104_000, metricFixture());
    expect(valid.approved).toBe(true);
    const dailyLoss = assessRisk(DEFAULT_RISK, "long", 100_000, 98_000, 104_000, metricFixture(), { dailyPnl: -200 });
    expect(dailyLoss.approved).toBe(false);
    expect(dailyLoss.reasons.join(" ")).toContain("زیان روزانه");
    const leveraged = assessRisk(DEFAULT_RISK, "long", 100_000, 99_900, 100_200, metricFixture());
    expect(leveraged.approved).toBe(false);
    expect(leveraged.reasons.join(" ")).toContain("اهرم");
  });
});

describe("20-role council", () => {
  it("contains ten observers and ten experts and approves only when every role approves", () => {
    const risk = assessRisk(DEFAULT_RISK, "long", 100_000, 98_000, 104_000, metricFixture());
    const context = {
      direction: "long" as const, risk,
      macro: { available: true, safe: true, details: ["پنجره امن"] },
      strategy: { available: true, approved: true, details: ["OOS معتبر"] }, correlatedPositions: 0, maxCorrelatedPositions: 1,
    };
    const approved = runCouncil(snapshotFixture(), metricFixture(), context);
    expect(approved).toHaveLength(20);
    expect(approved.filter((r) => r.category === "observer")).toHaveLength(10);
    expect(approved.filter((r) => r.category === "expert")).toHaveLength(10);
    expect(approved.every((r) => r.verdict === "approve")).toBe(true);
    expect(new Set(approved.map((r) => r.analysisVersion)).size).toBe(1);

    const blocked = runCouncil(snapshotFixture(), metricFixture(), {
      ...context, macro: { available: false, safe: false, details: ["داده کلان ناقص"] },
    });
    expect(blocked[15].verdict).toBe("reject");
    expect(blocked[19].verdict).toBe("reject");
    expect(blocked[19].reasonsAgainst.join(" ")).toContain("کارشناس کلان و اخبار");
  });
});

describe("deterministic backtest", () => {
  function fixture(): Candle[] {
    const candles = Array.from({ length: 300 }, (_, i) => candleAt(i));
    candles[50] = candleAt(50, { open: 100, high: 111, low: 99, close: 110 });
    candles[51] = candleAt(51, { open: 110, high: 120, low: 100, close: 110 });
    return candles;
  }

  it("enters on the next bar and resolves ambiguous entry candles Stop-First", () => {
    const result = runBacktest({
      candles: fixture(), settings: DEFAULT_RISK, symbol: "BTCUSDT", exchange: "binance", interval: "15m",
      params: { fast: 2, slow: 3, atrStop: 1, rewardRisk: 2, maxHoldingBars: 48 },
    });
    expect(result.trades.length).toBeGreaterThan(0);
    const first = result.trades[0];
    expect(first.signalTime).toBe(fixture()[50].time);
    expect(first.entryTime).toBe(fixture()[51].time);
    expect(first.exitReason).toBe("stop");
    expect(first.fees).toBeGreaterThan(0);
    expect(result.sensitivity).toHaveLength(6);
    expect(result.walkForward).toHaveLength(3);
    expect(result.strategyVersion).toBe(STRATEGY_VERSION);
    expect(result.biasChecks.find((b) => b.name === "Funding coverage")?.passed).toBe(false);
  });

  it("repeats trade results exactly for identical frozen inputs", () => {
    const options = {
      candles: fixture(), settings: DEFAULT_RISK, symbol: "BTCUSDT", exchange: "binance" as const, interval: "15m" as const,
      params: { fast: 2, slow: 3, atrStop: 1, rewardRisk: 2, maxHoldingBars: 48 },
    };
    const a = runBacktest(options), b = runBacktest(options);
    expect(a.trades).toEqual(b.trades);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.outOfSample).toEqual(b.outOfSample);
    expect(a.runId).not.toBe(b.runId);
  });

  it("rejects insufficient history and invalid parameters", () => {
    expect(() => runBacktest({ candles: fixture().slice(0, 200), settings: DEFAULT_RISK, symbol: "BTCUSDT", exchange: "binance", interval: "15m" })).toThrow("۳۰۰");
    expect(() => runBacktest({ candles: fixture(), settings: DEFAULT_RISK, symbol: "BTCUSDT", exchange: "binance", interval: "15m", params: { fast: 50, slow: 20 } })).toThrow("پارامتر");
  });
});

describe("backtest reporting integrity", () => {
  const recovering = (): Candle[] => {
    const c = Array.from({ length: 300 }, (_, i) => candleAt(i));
    c[50] = candleAt(50, { open: 100, high: 111, low: 99, close: 110 });
    c[51] = candleAt(51, { open: 110, high: 110.5, low: 109.8, close: 110 });
    c[52] = candleAt(52, { open: 110, high: 110.2, low: 108, close: 109.5 });
    c[53] = candleAt(53, { open: 109.5, high: 117, low: 109.4, close: 116 });
    return c;
  };
  const run = () => runBacktest({
    candles: recovering(), settings: DEFAULT_RISK, symbol: "BTCUSDT", exchange: "binance", interval: "15m",
    params: { fast: 2, slow: 3, atrStop: 1, rewardRisk: 2, maxHoldingBars: 48 },
  });

  it("mark-to-market drawdown captures the intra-trade dip that closed-trade drawdown hides", () => {
    const r = run();
    expect(r.trades[0].exitReason).toBe("target");
    expect(r.trades[0].pnl).toBeGreaterThan(0);
    // hand-computed: qty = 50/(110.033-107.3187)=18.42; unrealised at low 108 = (108-110.033)*qty - entry fee
    expect(r.metrics.maxDrawdownMtmPct).toBeCloseTo(0.3846, 3);
    expect(r.metrics.maxDrawdownMtmPct!).toBeGreaterThan(r.metrics.maxDrawdownPct);
  });

  it("never reports a mark-to-market drawdown below the closed-trade drawdown", () => {
    const r = run();
    expect(r.metrics.maxDrawdownMtmPct!).toBeGreaterThan(r.metrics.maxDrawdownPct - 1e-9);
  });

  it("includes the unlevered buy-and-hold baseline with an explicit non-comparability note", () => {
    const r = run();
    expect(r.baselineBuyHold?.note).toContain("هم‌اندازه");
    expect(r.baselineBuyHold?.endTime).toBe(recovering().at(-1)!.time);
  });

  it("buy-and-hold math: zero-cost +10% run with a 5% dip", () => {
    const zero = { ...DEFAULT_RISK, feePct: 0, slippagePct: 0, spreadPct: 0 };
    const c = [
      candleAt(0, { open: 100, high: 100, low: 100, close: 100 }),
      candleAt(1, { open: 100, high: 105, low: 100, close: 105 }),
      candleAt(2, { open: 105, high: 105, low: 99.75, close: 100 }),
      candleAt(3, { open: 100, high: 110, low: 100, close: 110 }),
    ];
    const b = buyAndHold(c, 0, zero);
    expect(b.netReturnPct).toBeCloseTo(10, 6);
    expect(b.maxDrawdownPct).toBeCloseTo(5, 6);
  });

  it("Wilson interval: undefined for n=0 and matches the known 5/10 value", () => {
    expect(wilson95(0, 0)).toBeNull();
    const ci = wilson95(5, 10)!;
    expect(ci[0]).toBeCloseTo(23.66, 1);
    expect(ci[1]).toBeCloseTo(76.34, 1);
    expect(wilson95(50, 100)![1] - wilson95(50, 100)![0]).toBeLessThan(ci[1] - ci[0]);
  });

  it("robust needs 30 OOS trades; 10-29 profitable trades are capped at conditional", () => {
    expect(classifyRobustness(9, 500, true)).toBe("unsupported");
    expect(classifyRobustness(10, 500, true)).toBe("conditional");
    expect(classifyRobustness(29, 500, true)).toBe("conditional");
    expect(classifyRobustness(30, 500, true)).toBe("robust");
    expect(classifyRobustness(30, 500, false)).toBe("conditional");
    expect(classifyRobustness(30, -1, true)).toBe("fragile");
  });
});

describe("shared chart indicators (same code as the analysis engine)", () => {
  it("MACD is aligned to the input, zero on a flat series, and histogram = macd - signal", () => {
    const flat = macdSeries(Array(60).fill(100));
    expect(flat.macd).toHaveLength(60);
    expect(flat.macd[24]).toBeNull();
    expect(flat.macd[25]).toBe(0);
    expect(flat.signal[32]).toBe(0);
    expect(flat.signal[31]).toBeNull();
    const rising = macdSeries(Array.from({ length: 80 }, (_, i) => 100 + i));
    const i = 79;
    expect(rising.macd[i]!).toBeGreaterThan(0);
    expect(rising.histogram[i]!).toBeCloseTo(rising.macd[i]! - rising.signal[i]!, 12);
  });

  it("VWAP: volume-weighted typical price, resetting at each UTC day", () => {
    const day = 86_400_000;
    const a = candleAt(0, { time: 10 * day, high: 12, low: 8, close: 10, volume: 1 });       // tp 10
    const b = candleAt(1, { time: 10 * day + 900_000, high: 24, low: 16, close: 20, volume: 3 }); // tp 20
    const c = candleAt(2, { time: 11 * day, high: 31, low: 29, close: 30, volume: 5 });      // new day, tp 30
    const v = vwapSeries([a, b, c]);
    expect(v[0]).toBe(10);
    expect(v[1]).toBeCloseTo((10 * 1 + 20 * 3) / 4, 12);
    expect(v[2]).toBe(30);
    expect(vwapSeries([candleAt(0, { volume: 0 })])[0]).toBeNull();
  });

  it("swing levels use only confirmed pivots and split around the last close", () => {
    const highs = [10, 11, 12, 20, 12, 11, 10, 11, 12, 13, 12, 11, 10, 9, 9];
    const candles = highs.map((h, i) => candleAt(i, { high: h, low: h - 2, close: h - 1 }));
    candles[candles.length - 1] = candleAt(14, { high: 9, low: 7, close: 8 });
    const levels = swingLevels(candles, 3, 3, 2);
    expect(levels.resistance).toContain(20);
    expect(levels.resistance).toContain(13);
    expect(levels.resistance[0]).toBe(13);
    // a bar inside the last 3 cannot be a confirmed pivot
    const unconfirmed = [...candles.slice(0, 14), candleAt(14, { high: 99, low: 7, close: 8 })];
    expect(swingLevels(unconfirmed, 3, 3, 2).resistance).not.toContain(99);
    expect(swingLevels([], 3, 3, 2)).toEqual({ support: [], resistance: [] });
  });
});
