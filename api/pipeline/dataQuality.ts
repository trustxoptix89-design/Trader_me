import type { Candle } from "@contracts/types";
import { validateCandle } from "../ingest/ingest";

/**
 * Data Quality Engine (pure). Reports facts about a candle series; it never repairs, merges or invents data.
 * Thresholds are caller-supplied: this module does not choose numbers (no invented rules).
 */
export interface QualityReport {
  total: number;
  outOfOrder: number;
  duplicates: number;
  invalid: Array<{ time: number; reason: string }>;
  zeroVolume: number;
  missingBars: number;
  gaps: Array<{ fromOpenTime: number; toOpenTime: number; missingBars: number }>;
  misaligned: number;
  incomplete: number;
  staleMs: number | null;
  ok: boolean;
}

/** `intervalMs` = the timeframe length; `now` = epoch ms. A candle is incomplete when openTime + intervalMs > now. */
export function assessSeries(candles: readonly Candle[], intervalMs: number, now: number): QualityReport {
  const invalid: QualityReport["invalid"] = [];
  const gaps: QualityReport["gaps"] = [];
  let outOfOrder = 0, duplicates = 0, zeroVolume = 0, misaligned = 0, incomplete = 0, missingBars = 0;
  const seen = new Set<number>();
  let prev: number | null = null;
  for (const c of candles) {
    const reason = validateCandle(c);
    if (reason) invalid.push({ time: c.time, reason });
    if (c.volume === 0) zeroVolume++;
    if (c.time % intervalMs !== 0) misaligned++;
    if (c.time + intervalMs > now) incomplete++;
    if (seen.has(c.time)) duplicates++;
    seen.add(c.time);
    if (prev !== null) {
      if (c.time < prev) outOfOrder++;
      else if (c.time > prev + intervalMs) { const m = Math.round((c.time - prev) / intervalMs) - 1; gaps.push({ fromOpenTime: prev, toOpenTime: c.time, missingBars: m }); missingBars += m; }
    }
    prev = prev === null ? c.time : Math.max(prev, c.time);
  }
  const last = candles.length ? Math.max(...candles.map((c) => c.time)) : null;
  const staleMs = last === null ? null : Math.max(0, now - (last + intervalMs));
  const ok = candles.length > 0 && invalid.length === 0 && outOfOrder === 0 && duplicates === 0 && missingBars === 0 && misaligned === 0 && incomplete === 0;
  return { total: candles.length, outOfOrder, duplicates, invalid, zeroVolume, missingBars, gaps, misaligned, incomplete, staleMs, ok };
}

export interface SourceComparison {
  overlap: number;
  onlyA: number;
  onlyB: number;
  maxCloseRelDiff: number;
  maxVolumeRelDiff: number;
  disagreements: Array<{ time: number; field: "close" | "volume"; a: number; b: number; relDiff: number }>;
  verdict: "AGREE" | "DISAGREE" | "NO_OVERLAP";
}

const rel = (a: number, b: number): number => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

/** Compares two sources on the shared open times. Never merges: the caller must keep sources separate. `tolerance` is the maximum allowed relative difference. */
export function compareSources(a: readonly Candle[], b: readonly Candle[], tolerance: number): SourceComparison {
  if (!(tolerance >= 0) || !Number.isFinite(tolerance)) throw new Error("tolerance must be a finite number >= 0 (no default is chosen)");
  const bm = new Map(b.map((c) => [c.time, c]));
  const am = new Set(a.map((c) => c.time));
  const disagreements: SourceComparison["disagreements"] = [];
  let overlap = 0, maxC = 0, maxV = 0;
  for (const x of a) {
    const y = bm.get(x.time);
    if (!y) continue;
    overlap++;
    const dc = rel(x.close, y.close), dv = rel(x.volume, y.volume);
    maxC = Math.max(maxC, dc); maxV = Math.max(maxV, dv);
    if (dc > tolerance) disagreements.push({ time: x.time, field: "close", a: x.close, b: y.close, relDiff: dc });
    if (dv > tolerance) disagreements.push({ time: x.time, field: "volume", a: x.volume, b: y.volume, relDiff: dv });
  }
  return { overlap, onlyA: a.filter((c) => !bm.has(c.time)).length, onlyB: b.filter((c) => !am.has(c.time)).length, maxCloseRelDiff: maxC, maxVolumeRelDiff: maxV, disagreements, verdict: overlap === 0 ? "NO_OVERLAP" : disagreements.length ? "DISAGREE" : "AGREE" };
}
