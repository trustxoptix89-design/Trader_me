import { describe, expect, it } from "vitest";
import { discoverMarkets, inBatches, type MarketListing } from "../pipeline/marketDiscovery";

// DATA CLASS: SYNTHETIC listings (logic only; no provider is verified).
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const L = (symbol: string, over: Partial<MarketListing> = {}): MarketListing => ({ symbol, baseAsset: symbol.replace("USDT", ""), quoteAsset: "USDT", quoteVolume24h: 1000, marketCapUsd: null, firstSeenAt: null, tradable: true, ...over });
const opts = { quoteAsset: "USDT", minQuoteVolume24h: 500, newListingWindowMs: 7 * DAY, now: NOW, maxSelected: 10 };
const cov = (r: ReturnType<typeof discoverMarkets>, s: string) => r.assets.find((a) => a.symbol === s)?.coverage;

describe("discoverMarkets", () => {
  it("classifies every listing with an explicit coverage state", () => {
    const r = discoverMarkets([L("AUSDT"), L("BUSDT", { quoteVolume24h: 10 }), L("CUSDT", { quoteVolume24h: null }), L("DUSDT", { tradable: false }), L("EUSDT", { quoteAsset: "BTC" }), L("USDCUSDT", { baseAsset: "USDC" })], { ...opts, excludeBases: ["USDC"] });
    expect([cov(r, "AUSDT"), cov(r, "BUSDT"), cov(r, "CUSDT"), cov(r, "DUSDT"), cov(r, "EUSDT"), cov(r, "USDCUSDT")]).toEqual(["ANALYZABLE", "ILLIQUID", "VOLUME_UNKNOWN", "NOT_TRADABLE", "WRONG_QUOTE", "EXCLUDED"]);
    expect(r.selected).toEqual(["AUSDT"]);
  });
  it("unknown volume is never treated as liquid", () => { expect(discoverMarkets([L("AUSDT", { quoteVolume24h: null })], opts).selected).toEqual([]); });
  it("liquidity floor is inclusive", () => { expect(discoverMarkets([L("AUSDT", { quoteVolume24h: 500 })], opts).selected).toEqual(["AUSDT"]); });
  it("new listings are flagged and ranked first, then by volume", () => {
    const r = discoverMarkets([L("BIGUSDT", { quoteVolume24h: 9000 }), L("NEWUSDT", { quoteVolume24h: 600, firstSeenAt: NOW - DAY }), L("OLDUSDT", { quoteVolume24h: 700, firstSeenAt: NOW - 30 * DAY })], opts);
    expect(r.assets.find((a) => a.symbol === "NEWUSDT")?.isNew).toBe(true); expect(r.assets.find((a) => a.symbol === "OLDUSDT")?.isNew).toBe(false);
    expect(r.selected).toEqual(["NEWUSDT", "BIGUSDT", "OLDUSDT"]);
  });
  it("deep-analysis list is capped (resource control)", () => { expect(discoverMarkets([L("AUSDT"), L("BUSDT"), L("CUSDT")], { ...opts, maxSelected: 2 }).selected).toHaveLength(2); });
  it("dynamic update: reports added and removed versus the previous list", () => {
    const r = discoverMarkets([L("AUSDT"), L("CUSDT")], opts, ["AUSDT", "BUSDT"]);
    expect(r.added).toEqual(["CUSDT"]); expect(r.removed).toEqual(["BUSDT"]);
  });
  it("duplicate symbols from a provider are dropped and counted", () => { const r = discoverMarkets([L("AUSDT"), L("AUSDT")], opts); expect(r.duplicatesDropped).toBe(1); expect(r.assets).toHaveLength(1); });
  it("refuses to choose thresholds by itself", () => {
    const thrown = (o: Partial<typeof opts>): boolean => { try { discoverMarkets([], { ...opts, ...o }); return false; } catch { return true; } };
    expect(thrown({ minQuoteVolume24h: Number.NaN })).toBe(true); expect(thrown({ maxSelected: -1 })).toBe(true); expect(thrown({})).toBe(false);
  });
});

describe("inBatches (rate-limit helper)", () => {
  it("processes in batches of N with a pause between batches only", async () => {
    const pauses: number[] = [], order: number[] = [];
    const out = await inBatches([1, 2, 3, 4, 5], 2, 100, async (ms) => { pauses.push(ms); }, async (x) => { order.push(x); return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10]); expect(pauses).toEqual([100, 100]); expect(order).toEqual([1, 2, 3, 4, 5]);
  });
  it("rejects an invalid batch size", async () => { let t = false; try { await inBatches([1], 0, 0, async () => {}, async (x) => x); } catch { t = true; } expect(t).toBe(true); });
});
