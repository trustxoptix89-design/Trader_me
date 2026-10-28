import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { closeDb, getDb } from "./connection";
import { runMigrations } from "./migrate";
import * as schema from "@db/schema";

// Runs only when DB_PROBE=true and DATABASE_URL points at a disposable/safe Postgres (CI provides one).
const enabled = process.env.DB_PROBE === "true";

describe.skipIf(!enabled)("postgres schema, migrations and upserts", () => {
  afterAll(async () => { await closeDb(); });

  it("applies migrations once and is idempotent on re-run", async () => {
    await runMigrations();
    expect(await runMigrations()).toEqual([]);
  });

  it("every Drizzle table and column exists in the migrated database with matching names", async () => {
    const db = getDb();
    const tables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
    expect(tables.length).toBeGreaterThanOrEqual(12);
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const rows = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${cfg.schema ?? "public"} AND table_name = ${cfg.name}`);
      const actual = new Set((rows as unknown as { column_name: string }[]).map((r) => r.column_name));
      const missing = cfg.columns.map((c) => c.name).filter((n) => !actual.has(n));
      expect({ table: cfg.name, missing }).toEqual({ table: cfg.name, missing: [] });
    }
  });

  it("upserts: watchlist, risk settings, scheduler counter and notification de-duplication", async () => {
    const db = getDb();
    const userId = 900_000 + Math.floor(Math.random() * 90_000);
    try {
      const w = { userId, symbol: "BTCUSDT", exchange: "binance" as const };
      await db.insert(schema.watchlist).values(w).onConflictDoUpdate({ target: [schema.watchlist.userId, schema.watchlist.symbol, schema.watchlist.exchange], set: { enabled: false } });
      await db.insert(schema.watchlist).values(w).onConflictDoUpdate({ target: [schema.watchlist.userId, schema.watchlist.symbol, schema.watchlist.exchange], set: { enabled: true } });
      const rows = await db.select().from(schema.watchlist).where(eq(schema.watchlist.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].enabled).toBe(true);

      await db.insert(schema.riskSettings).values({ userId }).onConflictDoUpdate({ target: schema.riskSettings.userId, set: { equity: 1234.5 } });
      await db.insert(schema.riskSettings).values({ userId }).onConflictDoUpdate({ target: schema.riskSettings.userId, set: { equity: 4321.5 } });
      const risk = await db.select().from(schema.riskSettings).where(eq(schema.riskSettings.userId, userId));
      expect(risk).toHaveLength(1);
      expect(risk[0].equity).toBe(4321.5);

      const key = `probe:${randomUUID()}`;
      const n = { userId, kind: "signal", title: "t", body: "b", dedupeKey: key };
      await db.insert(schema.notifications).values(n).onConflictDoNothing({ target: schema.notifications.dedupeKey });
      await db.insert(schema.notifications).values(n).onConflictDoNothing({ target: schema.notifications.dedupeKey });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, key))).toHaveLength(1);

      const id = `probe-${userId}`;
      for (let i = 0; i < 2; i++) {
        await db.insert(schema.schedulerState).values({ id, lastRunAt: new Date(), runCount: 1 })
          .onConflictDoUpdate({ target: schema.schedulerState.id, set: { lastRunAt: new Date(), runCount: sql`${schema.schedulerState.runCount} + 1` } });
      }
      const [state] = await db.select().from(schema.schedulerState).where(eq(schema.schedulerState.id, id));
      expect(state.runCount).toBe(2);
    } finally {
      await db.delete(schema.watchlist).where(eq(schema.watchlist.userId, userId));
      await db.delete(schema.riskSettings).where(eq(schema.riskSettings.userId, userId));
      await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
      await db.delete(schema.schedulerState).where(eq(schema.schedulerState.id, `probe-${userId}`));
    }
  });

  it("owner user upsert is idempotent and keeps the admin role; JSON and timestamps round-trip", async () => {
    const db = getDb();
    const unionId = `probe-owner-${randomUUID()}`;
    try {
      for (let i = 0; i < 2; i++) await db.insert(schema.users).values({ unionId, name: "Owner", role: "admin" }).onConflictDoUpdate({ target: schema.users.unionId, set: { name: "Owner", role: "admin", lastSignInAt: new Date() } });
      const users = await db.select().from(schema.users).where(eq(schema.users.unionId, unionId));
      expect(users).toHaveLength(1);
      expect(users[0].role).toBe("admin");
      const id = `probe-run-${randomUUID()}`;
      const result = { nested: { a: [1, 2, 3], b: "فارسی" } };
      await db.insert(schema.analysisRuns).values({ id, userId: users[0].id, symbol: "BTCUSDT", exchange: "binance", status: "no-entry", result });
      const [run] = await db.select().from(schema.analysisRuns).where(and(eq(schema.analysisRuns.id, id)));
      expect(run.result).toEqual(result);
      expect(run.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      await db.delete(schema.analysisRuns).where(eq(schema.analysisRuns.id, id));
    } finally {
      await db.delete(schema.users).where(eq(schema.users.unionId, unionId));
    }
  });
});
