import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { compareFeeds, crossCheckFeed, type ReferenceSource } from "./reference";
import { coinGeckoId, normalizeCoinGeckoOhlc } from "./providers/coingecko";

const H = 3_600_000;
const mk = (n: number, f: (i: number) => number, start = 0): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: start + i * H, open: f(i), high: f(i) + 1, low: f(i) - 1, close: f(i), volume: 1, closeTime: start + (i + 1) * H - 1 }));
const NOW = 100 * H;

describe("cross-source validation", () => {
  it("confirms when closes agree within tolerance", () => {
    const p = mk(40, (i) => 100 + i), r = mk(40, (i) => (100 + i) * 1.0005);
    const res = compareFeeds(p, r, "ref", NOW);
    expect(res.status).toBe("confirmed");
    expect(res.alignedBars).toBe(30);
    expect(res.medianDeviationPct).toBeLessThan(0.2);
  });

  it("flags warning and divergent deviations by median", () => {
    const p = mk(40, () => 100);
    expect(compareFeeds(p, mk(40, () => 100.4), "ref", NOW).status).toBe("warning");
    expect(compareFeeds(p, mk(40, () => 102), "ref", NOW).status).toBe("divergent");
  });

  it("ignores the still-forming bar and reports insufficient overlap", () => {
    const p = mk(10, () => 100);
    p[9].closeTime = NOW + H; // forming
    const r = mk(10, () => 100);
    expect(compareFeeds(p, r, "ref", 9 * H + 10).alignedBars).toBe(9);
    expect(compareFeeds(mk(3, () => 100), mk(3, () => 100), "ref", NOW).status).toBe("insufficient");
    expect(compareFeeds(mk(40, () => 100), mk(40, () => 100, 1e12), "ref", NOW).status).toBe("insufficient");
  });

  it("falls through failing references and never throws; reports unavailable honestly", async () => {
    const bad: ReferenceSource = { name: "bad", fetchCandles: async () => { throw new Error("HTTP 403"); } };
    const good: ReferenceSource = { name: "good", fetchCandles: async () => mk(40, () => 100) };
    const p = mk(40, () => 100);
    expect((await crossCheckFeed(p, "BTCUSDT", "1h", [bad, good], NOW)).referenceSource).toBe("good");
    const none = await crossCheckFeed(p, "BTCUSDT", "1h", [bad], NOW);
    expect(none.status).toBe("unavailable");
    expect(none.detail).toContain("HTTP 403");
  });

  it("normalizes CoinGecko rows: the timestamp is the END of the 30-minute bar", () => {
    const c = normalizeCoinGeckoOhlc([[1793212200000, 80808, 81010, 80649, 80850], [1793210400000, 80508, 80860, 80508, 80808]]);
    expect(c.map((x) => x.time)).toEqual([1793208600000, 1793210400000]);
    expect(c[1]).toMatchObject({ open: 80808, close: 80850, closeTime: 1793212199999 });
    expect(coinGeckoId("BTCUSDT")).toBe("bitcoin");
    expect(coinGeckoId("NOPEUSDT")).toBeNull();
  });
});
