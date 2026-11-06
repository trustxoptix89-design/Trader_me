import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { assessSeries, compareSources } from "../pipeline/dataQuality";

// Data class: SYNTHETIC grids (logic of the checks only; says nothing about real market data).
const H = 3_600_000, T0 = 1_800_000_000_000 - (1_800_000_000_000 % H);
const mk = (i: number, over: Partial<Pick<Candle, "time" | "high" | "close" | "volume">> = {}): Candle => ({ time: T0 + i * H, open: 100, high: 101, low: 99, close: 100.5, volume: 10, ...over } as Candle);
const grid = (n: number): Candle[] => Array.from({ length: n }, (_, i) => mk(i));
const NOW = T0 + 100 * H;

describe("assessSeries", () => {
  it("clean closed series -> ok", () => { const r = assessSeries(grid(10), H, NOW); expect(r.ok).toBe(true); expect(r.missingBars).toBe(0); });
  it("empty -> not ok, staleMs null", () => { const r = assessSeries([], H, NOW); expect(r.ok).toBe(false); expect(r.staleMs).toBeNull(); });
  it("missing candles counted with gap boundaries", () => { const g = grid(10).filter((c) => c.time !== T0 + 4 * H && c.time !== T0 + 5 * H); const r = assessSeries(g, H, NOW); expect(r.missingBars).toBe(2); expect(r.gaps).toEqual([{ fromOpenTime: T0 + 3 * H, toOpenTime: T0 + 6 * H, missingBars: 2 }]); expect(r.ok).toBe(false); });
  it("duplicate timestamp", () => { const g = grid(5); g.push(mk(2)); expect(assessSeries(g, H, NOW).duplicates).toBe(1); });
  it("out-of-order timestamps", () => { const g = grid(5); [g[2], g[3]] = [g[3], g[2]]; const r = assessSeries(g, H, NOW); expect(r.outOfOrder).toBe(1); expect(r.ok).toBe(false); });
  it("invalid OHLC relationships", () => { const g = grid(3); g[1] = mk(1, { high: 98 }); const r = assessSeries(g, H, NOW); expect(r.invalid).toEqual([{ time: T0 + H, reason: "high < low" }]); });
  it("zero volume is reported (not silently dropped)", () => { const g = grid(3); g[0] = mk(0, { volume: 0 }); expect(assessSeries(g, H, NOW).zeroVolume).toBe(1); });
  it("negative volume is invalid", () => { const g = grid(2); g[0] = mk(0, { volume: -1 }); expect(assessSeries(g, H, NOW).invalid[0].reason).toBe("negative volume"); });
  it("timezone/alignment error: openTime off the grid", () => { const g = grid(3); g[1] = mk(1, { time: T0 + H + 30 * 60_000 }); expect(assessSeries(g, H, NOW).misaligned).toBe(1); });
  it("incomplete (forming) candle at the boundary", () => {
    expect(assessSeries(grid(3), H, T0 + 3 * H).incomplete).toBe(0);
    expect(assessSeries(grid(3), H, T0 + 3 * H - 1).incomplete).toBe(1);
  });
  it("staleness = time since the last candle should have closed", () => { expect(assessSeries(grid(3), H, T0 + 3 * H + 5000).staleMs).toBe(5000); });
});

describe("compareSources", () => {
  it("identical -> AGREE", () => { const r = compareSources(grid(5), grid(5), 0); expect(r.verdict).toBe("AGREE"); expect(r.overlap).toBe(5); });
  it("close difference above tolerance -> DISAGREE, reported per candle, nothing merged", () => {
    const b = grid(5); b[2] = mk(2, { close: 110 });
    const r = compareSources(grid(5), b, 0.01);
    expect(r.verdict).toBe("DISAGREE"); expect(r.disagreements).toHaveLength(1); expect(r.disagreements[0].time).toBe(T0 + 2 * H);
  });
  it("difference within tolerance -> AGREE; boundary is inclusive", () => { const b = grid(2); b[0] = mk(0, { close: 100.5 * 1.01 }); expect(compareSources(grid(2), b, 0.02).verdict).toBe("AGREE"); });
  it("volume disagreement detected", () => { const b = grid(2); b[1] = mk(1, { volume: 20 }); expect(compareSources(grid(2), b, 0.1).disagreements[0].field).toBe("volume"); });
  it("no overlap is not agreement", () => { expect(compareSources(grid(3), grid(3).map((c) => ({ ...c, time: c.time + 10 * H })), 0).verdict).toBe("NO_OVERLAP"); });
  it("counts candles present in only one source", () => { const r = compareSources(grid(5), grid(3), 0); expect(r.onlyA).toBe(2); expect(r.onlyB).toBe(0); });
  it("refuses to pick a tolerance by itself", () => {
    const thrown = (t: number): boolean => { try { compareSources([], [], t); return false; } catch { return true; } };
    expect(thrown(Number.NaN)).toBe(true); expect(thrown(-1)).toBe(true); expect(thrown(0)).toBe(false);
  });
});
