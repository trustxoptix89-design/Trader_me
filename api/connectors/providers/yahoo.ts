import type { Candle, Interval } from "@contracts/types";
import { getJson, MarketDataError } from "../http";

export const INTERVAL_MS: Record<Interval, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** Yahoo has no 3m/4h bars: those are built from 1m/1h. `range` is chosen to give >= 300 bars of the requested interval. */
const PLAN: Record<Interval, { native: string; range: string; resampleTo?: number }> = {
  "1m": { native: "1m", range: "5d" },
  "3m": { native: "1m", range: "5d", resampleTo: INTERVAL_MS["3m"] },
  "5m": { native: "5m", range: "5d" },
  "15m": { native: "15m", range: "1mo" },
  "30m": { native: "30m", range: "1mo" },
  "1h": { native: "60m", range: "6mo" },
  "4h": { native: "60m", range: "6mo", resampleTo: INTERVAL_MS["4h"] },
  "1d": { native: "1d", range: "2y" },
};

export function toYahooSymbol(symbol: string): string {
  const m = /^([A-Z0-9]{2,15})USDT$/.exec(symbol);
  if (!m) throw new MarketDataError("Yahoo Finance", "نماد باید به شکل BASEUSDT باشد");
  return `${m[1]}-USD`;
}

interface YahooChart {
  chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[]; error?: { description?: string } | null };
}

/** Pure: normalizes a Yahoo chart payload; drops bars with missing OHLC; sorts and de-duplicates by time. */
export function parseYahooChart(body: YahooChart, nativeMs: number): Candle[] {
  const result = body.chart?.result?.[0];
  const q = result?.indicators?.quote?.[0];
  const ts = result?.timestamp;
  if (!result || !q || !Array.isArray(ts)) throw new MarketDataError("Yahoo Finance", `Yahoo: ${body.chart?.error?.description ?? "ساختار پاسخ نامعتبر است"}`);
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c].some((x) => typeof x !== "number" || !Number.isFinite(x))) continue;
    const time = ts[i] * 1000;
    out.push({ time, closeTime: time + nativeMs - 1, open: o as number, high: Math.max(h as number, o as number, c as number), low: Math.min(l as number, o as number, c as number), close: c as number, volume: typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);
}

/** Pure: aggregates candles into larger epoch-aligned buckets; a leading partial bucket is dropped. */
export function resample(candles: Candle[], bucketMs: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const start = Math.floor(c.time / bucketMs) * bucketMs;
    (buckets.get(start) ?? buckets.set(start, []).get(start)!).push(c);
  }
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  for (const start of starts) {
    const group = buckets.get(start)!.sort((a, b) => a.time - b.time);
    if (out.length === 0 && group[0].time !== start) continue;
    out.push({
      time: start, closeTime: start + bucketMs - 1, open: group[0].open, close: group[group.length - 1].close,
      high: Math.max(...group.map((c) => c.high)), low: Math.min(...group.map((c) => c.low)), volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

export async function fetchYahooCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  const plan = PLAN[interval];
  const nativeMs = plan.native === "60m" ? 3_600_000 : INTERVAL_MS[plan.native as Interval];
  const body = await getJson<YahooChart>(`https://query1.finance.yahoo.com/v8/finance/chart/${toYahooSymbol(symbol)}?interval=${plan.native}&range=${plan.range}&includePrePost=false`, "Yahoo Finance", 20_000);
  let candles = parseYahooChart(body, nativeMs);
  if (plan.resampleTo) candles = resample(candles, plan.resampleTo);
  if (!candles.length) throw new MarketDataError("Yahoo Finance", "پاسخ Yahoo کندل معتبر ندارد");
  return candles.slice(-limit);
}
