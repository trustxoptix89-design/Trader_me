import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { candleGaps, candles } from "@db/schema";
import type { CandleRow, CandleStore, GapRow } from "./ingest";
import type { Timeframe } from "./providers";

/** Postgres adapter. UNIQUE(symbol,timeframe,open_time) + ON CONFLICT DO NOTHING makes inserts idempotent. */
export function createPgStore(): CandleStore {
  return {
    async insertCandles(rows) {
      if (!rows.length) return 0;
      const res = await getDb().insert(candles).values(rows).onConflictDoNothing({ target: [candles.symbol, candles.timeframe, candles.openTime] }).returning({ id: candles.id });
      return res.length;
    },
    async insertGaps(rows) {
      if (!rows.length) return 0;
      const res = await getDb().insert(candleGaps).values(rows).onConflictDoNothing({ target: [candleGaps.symbol, candleGaps.timeframe, candleGaps.fromOpenTime, candleGaps.toOpenTime] }).returning({ id: candleGaps.id });
      return res.length;
    },
    async getCandles(symbol, timeframe, limit) {
      const rows = await getDb().select().from(candles).where(and(eq(candles.symbol, symbol), eq(candles.timeframe, timeframe))).orderBy(desc(candles.openTime)).limit(limit);
      return rows.reverse().map((r) => ({ symbol: r.symbol, timeframe: r.timeframe as Timeframe, openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, source: r.source as CandleRow["source"] }));
    },
  };
}

/** In-memory store with the same uniqueness semantics (used by unit tests). */
export function createMemoryStore(): CandleStore & { rows: CandleRow[]; gaps: GapRow[] } {
  const rows: CandleRow[] = [];
  const gaps: GapRow[] = [];
  return {
    rows, gaps,
    async insertCandles(input) {
      let n = 0;
      for (const r of input) {
        if (rows.some((x) => x.symbol === r.symbol && x.timeframe === r.timeframe && x.openTime === r.openTime)) continue;
        rows.push({ ...r }); n++;
      }
      return n;
    },
    async insertGaps(input) {
      let n = 0;
      for (const g of input) {
        if (gaps.some((x) => x.symbol === g.symbol && x.timeframe === g.timeframe && x.fromOpenTime === g.fromOpenTime && x.toOpenTime === g.toOpenTime)) continue;
        gaps.push({ ...g }); n++;
      }
      return n;
    },
    async getCandles(symbol, timeframe, limit) {
      return rows.filter((r) => r.symbol === symbol && r.timeframe === timeframe).sort((a, b) => a.openTime - b.openTime).slice(-limit);
    },
  };
}
