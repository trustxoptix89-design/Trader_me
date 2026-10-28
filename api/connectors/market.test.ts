import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@contracts/types";
import { connectorHealth, fetchCandles, fetchLatestPrice, intervalToMs, MarketDataError, volumeQuality } from "./market";
import { parseYahooChart, resample, toYahooSymbol } from "./providers/yahoo";

afterEach(() => { vi.unstubAllGlobals(); });

const chart = (ts: number[], q: Record<string, (number | null)[]>) => ({ chart: { result: [{ timestamp: ts, indicators: { quote: [q] } }], error: null } });

describe("independent market data (Yahoo Finance)", () => {
  it("maps symbols and rejects malformed ones before any request", async () => {
    expect(toYahooSymbol("BTCUSDT")).toBe("BTC-USD");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCandles("yahoo", "BTC-USDT", "1m")).rejects.toBeInstanceOf(MarketDataError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a chart payload: drops null bars, sorts, de-duplicates, zeroes missing volume", () => {
    const c = parseYahooChart(chart([120, 60, 60, 180], { open: [2, 1, 1, null], high: [3, 2, 2, 3], low: [1, 0.5, 0.5, 1], close: [2.5, 1.5, 1.5, 2], volume: [10, null, null, 5] }), 60_000);
    expect(c.map((x) => x.time)).toEqual([60_000, 120_000]);
    expect(c[0].volume).toBe(0);
    expect(c[1]).toMatchObject({ open: 2, close: 2.5, volume: 10, closeTime: 179_999 });
  });

  it("reports provider errors instead of inventing candles", () => {
    expect(() => parseYahooChart({ chart: { result: null as never, error: { description: "No data found" } } }, 60_000)).toThrow("No data found");
  });

  it("resamples to epoch-aligned buckets and drops a leading partial bucket", () => {
    const H = 3_600_000, base = 4 * H; // aligned to a 4h boundary
    const mk = (i: number, v: number): Candle => ({ time: base + i * H, closeTime: base + (i + 1) * H - 1, open: v, high: v + 1, low: v - 1, close: v + 0.5, volume: 2 });
    const four = resample([mk(0, 10), mk(1, 11), mk(2, 12), mk(3, 13), mk(4, 20)], 4 * H);
    expect(four).toHaveLength(2);
    expect(four[0]).toMatchObject({ time: base, open: 10, close: 13.5, high: 14, low: 9, volume: 8 });
    const partialFirst = resample([mk(1, 11), mk(2, 12), mk(3, 13), mk(4, 20), mk(5, 21), mk(6, 22), mk(7, 23)], 4 * H);
    expect(partialFirst[0].time).toBe(base + 4 * H);
  });

  it("flags unreliable volume from the share of zero-volume closed bars", () => {
    const bars = (zeros: number): Candle[] => Array.from({ length: 50 }, (_, i) => ({ time: i * 1000, closeTime: i * 1000 + 999, open: 1, high: 1, low: 1, close: 1, volume: i < zeros ? 0 : 5 }));
    expect(volumeQuality(bars(5), 1e9).volumeReliable).toBe(true);
    expect(volumeQuality(bars(25), 1e9)).toMatchObject({ volumeZeroPct: 50, volumeReliable: false });
    expect(volumeQuality([], 1e9).volumeReliable).toBe(false);
  });

  it("refuses stale latest prices", async () => {
    const old = Math.floor((Date.now() - 3_600_000) / 1000);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(chart([old - 60, old], { open: [1, 1], high: [2, 2], low: [1, 1], close: [1.5, 1.5], volume: [1, 1] })), { status: 200 })));
    await expect(fetchLatestPrice("yahoo", "STALEUSDT")).rejects.toThrow("کهنه");
  });

  it("reports health from the actual connector outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const health = await connectorHealth("yahoo");
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("اتصال");
  });

  it("uses exact interval durations", () => {
    expect(intervalToMs("15m")).toBe(900_000);
    expect(intervalToMs("4h")).toBe(14_400_000);
    expect(intervalToMs("1d")).toBe(86_400_000);
  });
});
