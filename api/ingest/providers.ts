import type { Candle } from "@contracts/types";
import { coinGeckoId } from "../connectors/providers/coingecko";
import { parseYahooChart, resample, toYahooSymbol } from "../connectors/providers/yahoo";
import { getJson, IngestHttpError, type FetchLike } from "./http";

export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TF_MS: Record<Timeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export type SourceName = "coingecko" | "cryptocompare" | "binance" | "yahoo";

export interface ProviderResult {
  candles: Candle[];
  httpStatus: number;
  /** First raw item exactly as the provider returned it (evidence). */
  rawSample: unknown;
}

/** The provider has no usable granularity for this timeframe: not a failure of the source, just a skip. */
export class UnsupportedTimeframe extends Error {
  constructor(source: string, timeframe: string) {
    super(`${source} has no ${timeframe} granularity`);
    this.name = "UnsupportedTimeframe";
  }
}

export interface Provider {
  name: SourceName;
  fetch(symbol: string, timeframe: Timeframe, limit: number, fetchImpl?: FetchLike): Promise<ProviderResult>;
}

export const SYMBOL_RE = /^[A-Z0-9]{2,15}USDT$/;
export const baseAsset = (symbol: string) => symbol.replace(/USDT$/, "");

const bar = (time: number, tfMs: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ time, closeTime: time + tfMs - 1, open: o, high: h, low: l, close: c, volume: v });
const bad = (source: string, status: number, what: string) => new IngestHttpError(source, status, `unexpected payload: ${what}`);

/** 1) CoinGecko /coins/{id}/ohlc. `days` must be one of 1/7/14/30/90/180/365/max (others answer HTTP 400). Free granularity: days 1-2 → 30m, days 3-30 → 4h. No volume (stored as 0). Timestamps are bar END times. */
const CG_PLAN: Partial<Record<Timeframe, { days: number; nativeMs: number; resampleTo?: number }>> = {
  "30m": { days: 1, nativeMs: TF_MS["30m"] },
  "1h": { days: 1, nativeMs: TF_MS["30m"], resampleTo: TF_MS["1h"] },
  "4h": { days: 30, nativeMs: TF_MS["4h"] },
};

export const coingecko: Provider = {
  name: "coingecko",
  async fetch(symbol, timeframe, limit, fetchImpl) {
    const plan = CG_PLAN[timeframe];
    if (!plan) throw new UnsupportedTimeframe("coingecko", timeframe);
    const id = coinGeckoId(symbol);
    if (!id) throw new UnsupportedTimeframe("coingecko", `${symbol} (symbol not mapped)`);
    const { status, body } = await getJson(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${plan.days}`, "coingecko", fetchImpl);
    if (!Array.isArray(body)) throw bad("coingecko", status, "not an array");
    let candles = (body as number[][])
      .filter((r) => Array.isArray(r) && r.length >= 5)
      .map((r) => bar(Number(r[0]) - plan.nativeMs, plan.nativeMs, Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), 0));
    candles.sort((a, b) => a.time - b.time);
    if (plan.resampleTo) candles = resample(candles, plan.resampleTo);
    return { candles: candles.slice(-limit), httpStatus: status, rawSample: (body as unknown[])[0] ?? null };
  },
};

/** 2) CryptoCompare /data/v2/histo*. Returns HTTP 200 with Response:"Error" for rate limits, which is mapped to 429. */
const CC_PLAN: Record<Timeframe, { path: string; aggregate: number }> = {
  "1m": { path: "histominute", aggregate: 1 }, "5m": { path: "histominute", aggregate: 5 }, "15m": { path: "histominute", aggregate: 15 }, "30m": { path: "histominute", aggregate: 30 },
  "1h": { path: "histohour", aggregate: 1 }, "4h": { path: "histohour", aggregate: 4 }, "1d": { path: "histoday", aggregate: 1 },
};

export const cryptocompare: Provider = {
  name: "cryptocompare",
  async fetch(symbol, timeframe, limit, fetchImpl) {
    const plan = CC_PLAN[timeframe];
    const url = `https://min-api.cryptocompare.com/data/v2/${plan.path}?fsym=${baseAsset(symbol)}&tsym=USD&limit=${limit}&aggregate=${plan.aggregate}`;
    // CryptoCompare now answers 401 without a (free) key; the key is optional and read from the environment only.
    const key = process.env.CRYPTOCOMPARE_API_KEY;
    const { status, body } = await getJson(url, "cryptocompare", fetchImpl, undefined, key ? { authorization: `Apikey ${key}` } : {});
    const b = body as { Response?: string; Message?: string; Data?: { Data?: Record<string, number>[] } };
    if (b?.Response === "Error") {
      const rate = /rate limit/i.test(b.Message ?? "");
      throw new IngestHttpError("cryptocompare", rate ? 429 : status, `provider error: ${b.Message ?? "unknown"}`);
    }
    const rows = b?.Data?.Data;
    if (!Array.isArray(rows)) throw bad("cryptocompare", status, "Data.Data missing");
    const tfMs = TF_MS[timeframe];
    const candles = rows.map((r) => bar(Number(r.time) * 1000, tfMs, Number(r.open), Number(r.high), Number(r.low), Number(r.close), Number(r.volumefrom ?? 0)));
    return { candles: candles.slice(-limit), httpStatus: status, rawSample: rows[0] ?? null };
  },
};

/** 3) Binance public market data /api/v3/klines (no key, no account). The official data-only mirror is tried when the main host refuses the region. */
const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

export const binance: Provider = {
  name: "binance",
  async fetch(symbol, timeframe, limit, fetchImpl) {
    const tfMs = TF_MS[timeframe];
    const notes: string[] = [];
    let last: IngestHttpError | null = null;
    for (const host of BINANCE_HOSTS) {
      try {
        const { status, body } = await getJson(`${host}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`, "binance", fetchImpl);
        if (!Array.isArray(body)) throw bad("binance", status, "not an array");
        const candles = (body as (string | number)[][]).map((r) => bar(Number(r[0]), tfMs, Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])));
        return { candles, httpStatus: status, rawSample: (body as unknown[])[0] ?? null };
      } catch (error) {
        if (!(error instanceof IngestHttpError)) throw error;
        notes.push(`${new URL(host).hostname}:${error.status ?? "network"}`);
        last = error;
      }
    }
    throw new IngestHttpError("binance", last?.status ?? null, notes.join(" | "));
  },
};

/** 4) Yahoo Finance BASE-USD chart API (fallback). 4h is built from 60m bars. */
const Y_PLAN: Record<Timeframe, { native: string; nativeMs: number; range: string; resampleTo?: number }> = {
  "1m": { native: "1m", nativeMs: 60_000, range: "5d" }, "5m": { native: "5m", nativeMs: 300_000, range: "5d" },
  "15m": { native: "15m", nativeMs: 900_000, range: "1mo" }, "30m": { native: "30m", nativeMs: 1_800_000, range: "1mo" },
  "1h": { native: "60m", nativeMs: 3_600_000, range: "6mo" }, "4h": { native: "60m", nativeMs: 3_600_000, range: "6mo", resampleTo: TF_MS["4h"] },
  "1d": { native: "1d", nativeMs: 86_400_000, range: "2y" },
};

export const yahoo: Provider = {
  name: "yahoo",
  async fetch(symbol, timeframe, limit, fetchImpl) {
    const plan = Y_PLAN[timeframe];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${toYahooSymbol(symbol)}?interval=${plan.native}&range=${plan.range}&includePrePost=false`;
    const { status, body } = await getJson(url, "yahoo", fetchImpl);
    let candles: Candle[];
    try {
      candles = parseYahooChart(body as Parameters<typeof parseYahooChart>[0], plan.nativeMs);
    } catch (error) {
      throw bad("yahoo", status, error instanceof Error ? error.message : String(error));
    }
    if (plan.resampleTo) candles = resample(candles, plan.resampleTo);
    // Yahoo reports the still-forming bar with the quote time instead of the bar start; keep only bars on the timeframe grid.
    if (timeframe !== "1d") candles = candles.filter((c) => c.time % TF_MS[timeframe] === 0);
    const result = (body as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: Record<string, unknown[]>[] } }[] } }).chart?.result?.[0];
    const q = result?.indicators?.quote?.[0];
    const rawSample = result?.timestamp?.length ? { timestamp: result.timestamp[0], open: q?.open?.[0], high: q?.high?.[0], low: q?.low?.[0], close: q?.close?.[0], volume: q?.volume?.[0] } : null;
    return { candles: candles.slice(-limit), httpStatus: status, rawSample };
  },
};

/** Cascade order is fixed by the spec: CoinGecko → CryptoCompare → Binance public → Yahoo. */
export const DEFAULT_PROVIDERS: Provider[] = [coingecko, cryptocompare, binance, yahoo];
