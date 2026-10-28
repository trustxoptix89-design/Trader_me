import type { Candle, DataSource, DerivativesSnapshot, Interval, MarketSnapshot } from "@contracts/types";
import { MarketDataError } from "./http";
import { crossCheckFeed } from "./reference";
import { fetchYahooCandles, INTERVAL_MS } from "./providers/yahoo";

export { MarketDataError };

export const SOURCE_LABEL: Record<DataSource, string> = { yahoo: "Yahoo Finance (شاخص تجمیعی اسپات USD)" };

function validateCandles(candles: Candle[]): Candle[] {
  const clean = candles.filter((c) => c.open > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0).sort((a, b) => a.time - b.time);
  const unique = clean.filter((c, i) => i === 0 || c.time !== clean[i - 1].time);
  if (!unique.length) throw new MarketDataError("yahoo", "پاسخ منبع کندل معتبر ندارد");
  return unique;
}

export async function fetchCandles(source: DataSource, symbol: string, interval: Interval, limit = 300): Promise<Candle[]> {
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new MarketDataError(source, "نماد نامعتبر است");
  const safeLimit = Math.min(1000, Math.max(50, limit));
  return validateCandles(await fetchYahooCandles(symbol, interval, safeLimit));
}

/** No keyless independent source provides perpetual mark price, funding or open interest: report that honestly (all null). */
export function noDerivatives(): DerivativesSnapshot {
  return { markPrice: null, fundingRate: null, nextFundingTime: null, openInterest: null, openInterestChangePct: null };
}
export async function fetchDerivatives(): Promise<DerivativesSnapshot> { return noDerivatives(); }

/** Share of recent CLOSED bars with zero volume. The source fills volume late/incompletely for some assets. */
export function volumeQuality(candles: Candle[], now = Date.now(), window = 50): { volumeZeroPct: number; volumeReliable: boolean } {
  const recent = candles.filter((c) => c.closeTime < now).slice(-window);
  if (!recent.length) return { volumeZeroPct: 100, volumeReliable: false };
  const zero = recent.filter((c) => c.volume <= 0).length;
  const volumeZeroPct = +(zero / recent.length * 100).toFixed(1);
  return { volumeZeroPct, volumeReliable: volumeZeroPct <= 20 };
}

export async function fetchSnapshot(source: DataSource, symbol: string, interval: Interval = "15m", candleLimit = 300): Promise<MarketSnapshot> {
  const [candles, oneHour, fourHour] = await Promise.all([
    fetchCandles(source, symbol, interval, candleLimit),
    interval === "1h" ? Promise.resolve([]) : fetchCandles(source, symbol, "1h", 220),
    interval === "4h" ? Promise.resolve([]) : fetchCandles(source, symbol, "4h", 220),
  ]);
  const last = candles.at(-1)!;
  const age = Date.now() - last.closeTime;
  const warnings: string[] = ["منبع داده شاخص تجمیعی اسپات (USD) است؛ قیمت قرارداد دائمی، Funding و Open Interest تأیید نشده‌اند"];
  const dataQuality = volumeQuality(candles);
  if (!dataQuality.volumeReliable) warnings.push(`حجم منبع در ${dataQuality.volumeZeroPct}٪ از کندل‌های اخیر صفر است؛ بررسی‌های حجم و نقدشوندگی قابل‌اتکا نیستند`);
  const thirty = interval === "30m" ? candles : await fetchCandles(source, symbol, "30m", 120).catch(() => [] as Candle[]);
  const crossCheck = thirty.length ? await crossCheckFeed(thirty, symbol, "30m") : await crossCheckFeed([], symbol, "30m");
  if (crossCheck.status === "warning" || crossCheck.status === "divergent") warnings.push(crossCheck.detail);
  if (crossCheck.status === "unavailable" || crossCheck.status === "insufficient") warnings.push("تأیید مستقل قیمت از منبع دوم (CoinGecko) انجام نشد؛ این تحلیل فقط به یک منبع متکی است");
  const fresh = age <= INTERVAL_MS[interval] * 2.5;
  if (!fresh) warnings.push("آخرین کندل از آستانهٔ تازگی عبور کرده است");
  return {
    exchange: source, symbol, interval, candles, crossCheck, marketType: "spot-index", dataQuality,
    higherTimeframes: { ...(oneHour.length ? { "1h": oneHour } : {}), ...(fourHour.length ? { "4h": fourHour } : {}) },
    derivatives: noDerivatives(), fetchedAt: Date.now(), sourceServerTime: last.closeTime,
    isFresh: fresh, warnings,
  };
}

/** Single independent source: there is deliberately no silent fallback to another market. */
export const fetchSnapshotWithFallback = fetchSnapshot;

/** Latest completed-or-forming close; refuses data older than maxAgeMs instead of returning a stale price. */
export async function fetchLatestPrice(source: DataSource, symbol: string, maxAgeMs = 5 * 60_000): Promise<number> {
  const candles = await fetchCandles(source, symbol, "1m", 50);
  const last = candles.at(-1)!;
  if (Date.now() - last.closeTime > maxAgeMs) throw new MarketDataError(source, "آخرین قیمت منبع کهنه است");
  return last.close;
}

export async function fetchFundingHistory(): Promise<{ time: number; rate: number }[]> { return []; }

export async function connectorHealth(source: DataSource): Promise<{ exchange: DataSource; ok: boolean; latencyMs: number; detail: string; checkedAt: number }> {
  const start = Date.now();
  try {
    const candles = await fetchCandles(source, "BTCUSDT", "1m", 50);
    return { exchange: source, ok: true, latencyMs: Date.now() - start, detail: `${candles.length} کندل واقعی BTC دریافت شد`, checkedAt: Date.now() };
  } catch (error) {
    return { exchange: source, ok: false, latencyMs: Date.now() - start, detail: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
  }
}

export function intervalToMs(interval: Interval): number { return INTERVAL_MS[interval]; }
