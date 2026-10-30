import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { candleGaps, candles } from "@db/schema";
import { ingest, type CandleRow } from "./ingest";
import { createPgStore } from "./store";
import type { Provider } from "./providers";

// Runs only when DB_PROBE=true and DATABASE_URL points at a disposable Postgres (CI provides one).
const enabled = process.env.DB_PROBE === "true";
const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H);

describe.skipIf(!enabled)("candles in real Postgres (spec acceptance 2 and 8)", () => {
  const symbol = `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}USDT`;
  afterAll(async () => {
    const db = getDb();
    await db.delete(candles).where(eq(candles.symbol, symbol));
    await db.delete(candleGaps).where(eq(candleGaps.symbol, symbol));
    await closeDb();
  });

  const rows = (n: number): CandleRow[] => Array.from({ length: n }, (_, i) => ({ symbol, timeframe: "1h", openTime: T0 + i * H, open: 100, high: 110, low: 90, close: 105, volume: 1, source: "binance" }));
  const count = async () => Number((await getDb().select({ n: sql<number>`count(*)` }).from(candles).where(and(eq(candles.symbol, symbol), eq(candles.timeframe, "1h"))))[0].n);

  it("migration 0002 creates the tables and re-running migrations applies nothing", async () => {
    await runMigrations();
    expect(await runMigrations()).toEqual([]);
  });

  it("re-inserting the same (symbol, timeframe, open_time) adds no rows", async () => {
    const store = createPgStore();
    expect(await store.insertCandles(rows(5))).toBe(5);
    expect(await store.insertCandles(rows(5))).toBe(0);
    expect(await store.insertCandles(rows(7))).toBe(2);
    expect(await count()).toBe(7);
  });

  it("the database itself rejects an invalid OHLCV row (CHECK constraint)", async () => {
    await expect(getDb().insert(candles).values({ symbol, timeframe: "1h", openTime: T0 + 99 * H, open: 1, high: 1, low: 2, close: 1, volume: 0, source: "binance" })).rejects.toThrow();
  });

  it("ingest() through the Postgres store is idempotent and getCandles returns ascending rows", async () => {
    const store = createPgStore();
    const provider: Provider = { name: "yahoo", fetch: async () => ({ httpStatus: 200, rawSample: null, candles: Array.from({ length: 10 }, (_, i) => ({ time: T0 + i * H, closeTime: T0 + (i + 1) * H - 1, open: 100, high: 110, low: 90, close: 105, volume: 1 })) }) };
    const a = await ingest(store, symbol, "1h", { providers: [provider] });
    const b = await ingest(store, symbol, "1h", { providers: [provider] });
    expect(a.inserted).toBe(3); // 7 rows already stored by the previous test
    expect(b.inserted).toBe(0);
    expect(await count()).toBe(10);
    const got = await store.getCandles(symbol, "1h", 200);
    expect(got.map((r) => r.openTime)).toEqual([...got.map((r) => r.openTime)].sort((x, y) => x - y));
    expect(got).toHaveLength(10);
  });
});
