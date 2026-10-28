import type { Candle, CrossCheckStatus, Interval, SourceCrossCheck } from "@contracts/types";
import { fetchCoinGecko30m } from "./providers/coingecko";

/**
 * Independent verification of the primary feed. The reference is a different data provider with its own
 * aggregation (CoinGecko) — it only confirms prices and never supplies analysis data.
 * Comparison is always on 30-minute closes, which both providers expose.
 */
export interface ReferenceSource {
  name: string;
  fetchCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]>;
}

export const coinGeckoReference: ReferenceSource = {
  name: "CoinGecko",
  fetchCandles: (symbol) => fetchCoinGecko30m(symbol),
};

export const DEFAULT_REFERENCES: ReferenceSource[] = [coinGeckoReference];

export const CROSSCHECK_THRESHOLDS = { confirmedPct: 0.2, warningPct: 0.6, minBars: 5, maxBars: 30 };

/** Pure comparison of closed-bar closes between the primary feed and one reference feed. */
export function compareFeeds(primary: Candle[], reference: Candle[], referenceSource: string, now = Date.now()): SourceCrossCheck {
  const refByTime = new Map(reference.map((c) => [c.time, c]));
  const devs: number[] = [];
  for (const c of primary) {
    if (c.closeTime >= now) continue; // forming bar
    const r = refByTime.get(c.time);
    if (r) devs.push(Math.abs(c.close / r.close - 1) * 100);
  }
  const used = devs.slice(-CROSSCHECK_THRESHOLDS.maxBars);
  if (used.length < CROSSCHECK_THRESHOLDS.minBars) {
    return { status: "insufficient", referenceSource, alignedBars: used.length, medianDeviationPct: null, maxDeviationPct: null, detail: `فقط ${used.length} کندل هم‌زمان با ${referenceSource} قابل مقایسه است` };
  }
  const sorted = [...used].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const status: CrossCheckStatus = median <= CROSSCHECK_THRESHOLDS.confirmedPct ? "confirmed" : median <= CROSSCHECK_THRESHOLDS.warningPct ? "warning" : "divergent";
  const label = status === "confirmed" ? "هم‌خوانی دارد" : status === "warning" ? "اختلاف قابل‌توجه دارد" : "اختلاف زیاد دارد";
  return { status, referenceSource, alignedBars: used.length, medianDeviationPct: +median.toFixed(4), maxDeviationPct: +max.toFixed(4), detail: `قیمت بسته‌شدن با ${referenceSource} ${label} (میانهٔ اختلاف ${median.toFixed(3)}٪، بیشینه ${max.toFixed(3)}٪ روی ${used.length} کندل)` };
}

/** Tries references in order; first usable verdict wins. Never throws. */
export async function crossCheckFeed(primary: Candle[], symbol: string, interval: Interval, references: ReferenceSource[] = DEFAULT_REFERENCES, now = Date.now()): Promise<SourceCrossCheck> {
  const errors: string[] = [];
  let best: SourceCrossCheck | null = null;
  for (const ref of references) {
    try {
      const candles = await ref.fetchCandles(symbol, interval, 120);
      const result = compareFeeds(primary, candles, ref.name, now);
      if (result.status !== "insufficient") return result;
      best = best ?? result;
    } catch (error) {
      errors.push(`${ref.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (best) return best;
  return { status: "unavailable", referenceSource: null, alignedBars: 0, medianDeviationPct: null, maxDeviationPct: null, detail: `منبع مستقل برای تأیید در دسترس نبود (${errors.join(" | ") || "بدون منبع"})` };
}
