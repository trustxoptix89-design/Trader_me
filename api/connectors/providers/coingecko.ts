import type { Candle } from "@contracts/types";
import { getJson, MarketDataError } from "../http";

/** CoinGecko ids for the symbols the app offers. Unknown symbols have no independent confirmation. */
const COIN_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", XRP: "ripple", DOGE: "dogecoin",
  ADA: "cardano", AVAX: "avalanche-2", LINK: "chainlink", DOT: "polkadot", LTC: "litecoin", TRX: "tron",
};

export function coinGeckoId(symbol: string): string | null {
  const m = /^([A-Z0-9]{2,15})USDT$/.exec(symbol);
  return m ? COIN_IDS[m[1]] ?? null : null;
}

/** Pure. CoinGecko OHLC rows are [END timestamp ms, o, h, l, c] at 30-minute granularity for days=1; there is no volume. */
export function normalizeCoinGeckoOhlc(rows: number[][], barMs = 1_800_000): Candle[] {
  return rows
    .map((r) => ({ time: Number(r[0]) - barMs, closeTime: Number(r[0]) - 1, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: 0 }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

export async function fetchCoinGecko30m(symbol: string): Promise<Candle[]> {
  const id = coinGeckoId(symbol);
  if (!id) throw new MarketDataError("CoinGecko", "این نماد در نگاشت CoinGecko نیست");
  const rows = await getJson<number[][]>(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`, "CoinGecko", 60_000);
  if (!Array.isArray(rows)) throw new MarketDataError("CoinGecko", "ساختار پاسخ CoinGecko نامعتبر است");
  return normalizeCoinGeckoOhlc(rows);
}
