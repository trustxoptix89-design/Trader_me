import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorHealth, fetchCandles, intervalToMs, MarketDataError } from "./market";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public market connectors", () => {
  it("normalizes, sorts and de-duplicates Binance OHLCV payloads", async () => {
    const rows = [
      [2000, "11", "12", "10", "11.5", "20", 2899, "230", 10],
      [1000, "10", "11", "9", "10.5", "10", 1899, "105", 8],
      [1000, "10", "11", "9", "10.5", "10", 1899, "105", 8],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 })));
    const candles = await fetchCandles("binance", "TESTUSDT", "1m", 50);
    expect(candles).toHaveLength(2);
    expect(candles.map((c) => c.time)).toEqual([1000, 2000]);
    expect(candles[0].quoteVolume).toBe(105);
  });

  it("surfaces exchange failures instead of returning substitute candles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ retCode: 10001, retMsg: "symbol invalid" }), { status: 200 })));
    await expect(fetchCandles("bybit", "ERRORUSDT", "15m", 50)).rejects.toMatchObject({ name: "MarketDataError" });
    await expect(fetchCandles("bybit", "ERRORUSDT", "15m", 50)).rejects.toThrow("symbol invalid");
  });

  it("rejects malformed symbols before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCandles("binance", "BTC-USDT", "1m")).rejects.toBeInstanceOf(MarketDataError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports health from the actual connector outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const health = await connectorHealth("bybit");
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("اتصال");
    expect(health.checkedAt).toBeGreaterThan(0);
  });

  it("uses exact interval durations", () => {
    expect(intervalToMs("15m")).toBe(900_000);
    expect(intervalToMs("4h")).toBe(14_400_000);
    expect(intervalToMs("1d")).toBe(86_400_000);
  });
});
