// P1 — Postgres loader for the candle adapter (read-only; never writes).
import { and, desc, eq } from "drizzle-orm";
import { candles } from "@db/schema";
import { getDb } from "../queries/connection";
import type { LoadRows, StoredCandle } from "./candleAdapter";

export const pgLoadRows: LoadRows = async (symbol, dbTimeframe, limit): Promise<StoredCandle[]> => {
  const rows = await getDb().select().from(candles).where(and(eq(candles.symbol, symbol), eq(candles.timeframe, dbTimeframe))).orderBy(desc(candles.openTime)).limit(limit);
  return rows.map((r) => ({ time: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, ingestedAt: r.ingestedAt.getTime() }));
};
