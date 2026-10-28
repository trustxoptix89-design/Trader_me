import { crossCheckFeed } from "./reference";
import type { Candle, DerivativesSnapshot, Exchange, Interval, MarketSnapshot } from "@contracts/types";

const TIMEOUT_MS = 12_000;
const cache = new Map<string, { at: number; value: unknown }>();

export class MarketDataError extends Error {
  exchange: string;
  causeMessage?: string;
  constructor(exchange: string, message: string, causeMessage?: string) {
    super(message); this.name = "MarketDataError"; this.exchange = exchange; this.causeMessage = causeMessage;
  }
}

async function getJson<T>(url: string, exchange: string, cacheMs = 0): Promise<T> {
  const hit = cache.get(url);
  if (cacheMs && hit && Date.now() - hit.at < cacheMs) return hit.value as T;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", "user-agent": "EvidenceFutures/1.0 public-market-data" } });
  } catch (error) {
    throw new MarketDataError(exchange, `اتصال به ${exchange} برقرار نشد`, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new MarketDataError(exchange, `${exchange} با کد ${response.status} پاسخ داد`, body);
  }
  const data = await response.json() as T;
  if (cacheMs) cache.set(url, { at: Date.now(), value: data });
  return data;
}

function candle(values: unknown[]): Candle {
  const nums = values.map(Number);
  if (nums.slice(0, 6).some((n) => !Number.isFinite(n))) throw new Error("Invalid candle payload");
  return { time: nums[0], open: nums[1], high: nums[2], low: nums[3], close: nums[4], volume: nums[5], closeTime: nums[6] || nums[0], quoteVolume: nums[7], trades: nums[8] };
}

function validateCandles(candles: Candle[], exchange: Exchange): Candle[] {
  const clean = candles.filter((c) => c.open > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0).sort((a, b) => a.time - b.time);
  const unique = clean.filter((c, i) => i === 0 || c.time !== clean[i - 1].time);
  if (!unique.length) throw new MarketDataError(exchange, "پاسخ صرافی کندل معتبر ندارد");
  return unique;
}

export async function fetchCandles(exchange: Exchange, symbol: string, interval: Interval, limit = 300): Promise<Candle[]> {
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new MarketDataError(exchange, "نماد نامعتبر است");
  const safeLimit = Math.min(1000, Math.max(50, limit));
  if (exchange === "binance") {
    const data = await getJson<unknown[][]>(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}`, exchange, 20_000);
    if (!Array.isArray(data)) throw new MarketDataError(exchange, "ساختار کندل‌های Binance نامعتبر است");
    return validateCandles(data.map((v) => candle(v)), exchange);
  }
  const data = await getJson<{ retCode: number; retMsg: string; result?: { list?: string[][] } }>(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval(interval)}&limit=${safeLimit}`, exchange, 20_000);
  if (data.retCode !== 0 || !data.result?.list) throw new MarketDataError(exchange, `Bybit: ${data.retMsg || "پاسخ نامعتبر"}`);
  const candles = data.result.list.map((v) => candle([Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3]), Number(v[4]), Number(v[5]), Number(v[0]), Number(v[6])]));
  return validateCandles(candles, exchange);
}

function bybitInterval(interval: Interval): string {
  return ({ "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" } as const)[interval];
}

export async function fetchDerivatives(exchange: Exchange, symbol: string): Promise<DerivativesSnapshot> {
  if (exchange === "binance") {
    const [premium, oi, oiHist] = await Promise.all([
      getJson<{ markPrice: string; lastFundingRate: string; nextFundingTime: number }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, exchange),
      getJson<{ openInterest: string }>(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, exchange),
      getJson<{ sumOpenInterest: string; timestamp: number }[]>(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=31`, exchange).catch(() => []),
    ]);
    const first = oiHist[0] ? Number(oiHist[0].sumOpenInterest) : null;
    const last = oiHist.at(-1) ? Number(oiHist.at(-1)!.sumOpenInterest) : null;
    return { markPrice: Number(premium.markPrice), fundingRate: Number(premium.lastFundingRate), nextFundingTime: Number(premium.nextFundingTime), openInterest: Number(oi.openInterest), openInterestChangePct: first && last ? (last / first - 1) * 100 : null };
  }
  const [tickers, oi] = await Promise.all([
    getJson<{ retCode: number; retMsg: string; result?: { list?: Record<string, string>[] } }>(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`, exchange),
    getJson<{ retCode: number; retMsg: string; result?: { list?: { openInterest: string; timestamp: string }[] } }>(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=31`, exchange).catch(() => ({ retCode: -1, retMsg: "unavailable" })),
  ]);
  const ticker = tickers.result?.list?.[0];
  if (tickers.retCode !== 0 || !ticker) throw new MarketDataError(exchange, `Bybit: ${tickers.retMsg || "دادهٔ مشتقات unavailable"}`);
  const list = "result" in oi ? oi.result?.list ?? [] : [];
  const first = list.at(-1) ? Number(list.at(-1)!.openInterest) : null;
  const last = list[0] ? Number(list[0].openInterest) : null;
  return { markPrice: Number(ticker.markPrice), fundingRate: Number(ticker.fundingRate), nextFundingTime: Number(ticker.nextFundingTime) || null, openInterest: Number(ticker.openInterest), openInterestChangePct: first && last ? (last / first - 1) * 100 : null };
}

export async function fetchSnapshot(exchange: Exchange, symbol: string, interval: Interval = "15m", candleLimit = 300): Promise<MarketSnapshot> {
  const [candles, oneHour, fourHour, derivatives] = await Promise.all([
    fetchCandles(exchange, symbol, interval, candleLimit),
    interval === "1h" ? Promise.resolve([]) : fetchCandles(exchange, symbol, "1h", 220),
    interval === "4h" ? Promise.resolve([]) : fetchCandles(exchange, symbol, "4h", 220),
    fetchDerivatives(exchange, symbol),
  ]);
  const last = candles.at(-1)!;
  const intervalMs = intervalToMs(interval);
  const age = Date.now() - last.closeTime;
  const warnings: string[] = [];
  if (age > intervalMs * 2.5) warnings.push("آخرین کندل از آستانهٔ تازگی عبور کرده است");
  if (derivatives.openInterestChangePct === null) warnings.push("تغییرات Open Interest در دسترس نیست");
  const crossCheck = await crossCheckFeed(candles, symbol, interval);
  if (crossCheck.status === "warning" || crossCheck.status === "divergent") warnings.push(crossCheck.detail);
  if (crossCheck.status === "unavailable" || crossCheck.status === "insufficient") warnings.push("تأیید مستقل داده از منبع دوم انجام نشد؛ این تحلیل فقط به یک صرافی متکی است");
  return {
    exchange, symbol, interval, candles, crossCheck,
    higherTimeframes: { ...(oneHour.length ? { "1h": oneHour } : {}), ...(fourHour.length ? { "4h": fourHour } : {}) },
    derivatives, fetchedAt: Date.now(), sourceServerTime: last.closeTime,
    isFresh: age <= intervalMs * 2.5, warnings,
  };
}

export async function fetchSnapshotWithFallback(preferred: Exchange, symbol: string, interval: Interval): Promise<MarketSnapshot> {
  const errors: string[] = [];
  for (const exchange of [preferred, preferred === "binance" ? "bybit" : "binance"] as Exchange[]) {
    try { return await fetchSnapshot(exchange, symbol, interval); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new MarketDataError("all", `هیچ منبع داده‌ای در دسترس نیست؛ ${errors.join(" | ")}`);
}

export async function fetchFundingHistory(exchange: Exchange, symbol: string, startTime: number, endTime: number): Promise<{ time: number; rate: number }[]> {
  if (exchange === "binance") {
    const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`, exchange);
    return Array.isArray(rows) ? rows.map((r) => ({ time: Number(r.fundingTime), rate: Number(r.fundingRate) })) : [];
  }
  const rows = await getJson<{ retCode: number; result?: { list?: { fundingRate: string; fundingRateTimestamp: string }[] } }>(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=200`, exchange);
  return rows.result?.list?.map((r) => ({ time: Number(r.fundingRateTimestamp), rate: Number(r.fundingRate) })) ?? [];
}

export async function connectorHealth(exchange: Exchange): Promise<{ exchange: Exchange; ok: boolean; latencyMs: number; detail: string; checkedAt: number }> {
  const start = Date.now();
  try {
    const candles = await fetchCandles(exchange, "BTCUSDT", "1m", 50);
    return { exchange, ok: true, latencyMs: Date.now() - start, detail: `${candles.length} کندل واقعی BTCUSDT دریافت شد`, checkedAt: Date.now() };
  } catch (error) {
    return { exchange, ok: false, latencyMs: Date.now() - start, detail: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
  }
}

export function intervalToMs(interval: Interval): number {
  return ({ "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const)[interval];
}
