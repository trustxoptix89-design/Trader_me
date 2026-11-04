import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { candles } from "@db/schema";
import { closeDb, getDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { readPipelineCandles, TF_MS, type PipelineTimeframe } from "../pipeline/candleAdapter";
import { pgLoadRows } from "../pipeline/candleReader";

// DB_PROBE-gated: real PostgreSQL. Data class: SYNTHETIC timing grids written to a disposable database (CI service container).
const enabled = process.env.DB_PROBE === "true";
const DB_TF: Record<PipelineTimeframe, string> = { "4H": "4h", "1H": "1h", "15m": "15m", "5m": "5m" };
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % TF_MS["4H"]) + 1_000_000;
const lastClosed = (tf: PipelineTimeframe): number => Math.floor(NOW / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf];

describe.skipIf(!enabled)("candle adapter reads real PostgreSQL", () => {
  const symbol = `A${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}USDT`;
  afterAll(async () => { await getDb().delete(candles).where(eq(candles.symbol, symbol)); await closeDb(); });

  const seed = async (tf: PipelineTimeframe, n: number, opts: { formingExtra?: boolean; unfinalizedNewest?: boolean } = {}): Promise<void> => {
    const ms = TF_MS[tf];
    const rows = Array.from({ length: n }, (_, i) => {
      const time = lastClosed(tf) - (n - 1 - i) * ms;
      return { symbol, timeframe: DB_TF[tf], openTime: time, open: 100, high: 101, low: 99, close: 100.5, volume: 1, source: "binance", ingestedAt: new Date(time + ms + 1000) };
    });
    if (opts.unfinalizedNewest) rows[rows.length - 1].ingestedAt = new Date(rows[rows.length - 1].openTime + ms - 5);
    if (opts.formingExtra) rows.push({ symbol, timeframe: DB_TF[tf], openTime: lastClosed(tf) + ms, open: 1, high: 2, low: 1, close: 2, volume: 1, source: "binance", ingestedAt: new Date(NOW - 1) });
    await getDb().insert(candles).values(rows);
  };

  it("migrations are applied", async () => { await runMigrations(); });

  it("pgLoadRows returns the newest `limit` rows with ingestedAt in ms, and READY when 200/200/200/30 closed rows exist plus one forming 1H row", async () => {
    await seed("4H", 200); await seed("1H", 200, { formingExtra: true }); await seed("15m", 200); await seed("5m", 30);
    const raw = await pgLoadRows(symbol, "1h", 201);
    expect(raw.length).toBe(201);
    expect(typeof raw[0].ingestedAt).toBe("number");
    const r = await readPipelineCandles(symbol, NOW, pgLoadRows);
    expect(r.status).toBe("READY");
    expect(r.reports["1H"].excluded.map((e) => e.reason)).toEqual(["NOT_CLOSED"]);
    expect(r.candles["1H"].length).toBe(200);
  });

  it("a stored snapshot captured before close is excluded end-to-end; the series becomes one short -> ABSTAIN", async () => {
    await getDb().delete(candles).where(eq(candles.symbol, symbol));
    await seed("4H", 200); await seed("1H", 200, { unfinalizedNewest: true }); await seed("15m", 200); await seed("5m", 30);
    const r = await readPipelineCandles(symbol, NOW, pgLoadRows);
    expect(r.status).toBe("ABSTAIN");
    expect(r.reports["1H"].excluded.map((e) => e.reason)).toEqual(["UNFINALIZED_SNAPSHOT"]);
    expect(r.reason).toContain("1H: 199/200");
  });
});
