import type { Candle, CrossCheckStatus, Interval, SourceCrossCheck } from "@contracts/types";

/**
 * Independent reference price sources used ONLY to validate the primary exchange feed.
 * They never replace primary data: if no reference confirms, the snapshot says so.
 */
const TIMEOUT_MS = 8_000;

export interface ReferenceSource {
  name: string;
  fetchCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]>;
}

function baseOf(symbol: string): string | null {
  const m = /^([A-Z0-9]{2,15})USDT$/.exec(symbol);
  return m ? m[1] : null;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", "user-agent": "Sarmaye/1.0 public-market-data" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const OKX_BAR: Record<Interval, string> = { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };

export const okxSwap: ReferenceSource = {
  name: "OKX perpetual",
  async fetchCandles(symbol, interval, limit) {
    const base = baseOf(symbol);
    if (!base) throw new Error("unsupported symbol");
    const body = await json<{ code: string; msg: string; data?: string[][] }>(`https://www.okx.com/api/v5/market/candles?instId=${base}-USDT-SWAP&bar=${OKX_BAR[interval]}&limit=${Math.min(300, limit)}`);
    if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(body.msg || "bad payload");
    return normalizeOkx(body.data, interval);
  },
};

export function normalizeOkx(rows: string[][], interval: Interval): Candle[] {
  const ms = INTERVAL_MS[interval];
  return rows
    .filter((r) => r[8] === "1") // only confirmed (closed) candles
    .map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[0]) + ms - 1 }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

const COINBASE_GRAN: Partial<Record<Interval, number>> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

export const coinbaseSpot: ReferenceSource = {
  name: "Coinbase spot (USD)",
  async fetchCandles(symbol, interval) {
    const base = baseOf(symbol);
    const gran = COINBASE_GRAN[interval];
    if (!base || !gran) throw new Error("unsupported symbol/interval");
    const rows = await json<number[][]>(`https://api.exchange.coinbase.com/products/${base}-USD/candles?granularity=${gran}`);
    if (!Array.isArray(rows)) throw new Error("bad payload");
    return normalizeCoinbase(rows, interval);
  },
};

export function normalizeCoinbase(rows: number[][], interval: Interval): Candle[] {
  const ms = INTERVAL_MS[interval];
  return rows
    .map((r) => ({ time: Number(r[0]) * 1000, open: Number(r[3]), high: Number(r[2]), low: Number(r[1]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[0]) * 1000 + ms - 1 }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

const INTERVAL_MS: Record<Interval, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export const DEFAULT_REFERENCES: ReferenceSource[] = [okxSwap, coinbaseSpot];

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
