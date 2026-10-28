import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./connection";
import { systemEvents } from "@db/schema";

const enabled = process.env.DB_PROBE === "true";
const expectedTables = [
  "users", "risk_settings", "watchlist", "analysis_runs", "backtests", "paper_trades",
  "journal_entries", "alerts", "notifications", "push_subscriptions", "system_events", "scheduler_state",
];

describe.skipIf(!enabled)("live database verification", () => {
  it("verifies all tables and performs an isolated create/read-back/delete probe", async () => {
    const db = getDb();
    const result = await db.execute(sql`SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`) as unknown as [{ tableName: string }[], unknown] | { rows: { tableName: string }[] };
    const rows = Array.isArray(result) ? result[0] : result.rows;
    const actual = rows.map((row) => row.tableName);
    expect(expectedTables.filter((table) => !actual.includes(table))).toEqual([]);

    const marker = `probe:${randomUUID()}`;
    await db.insert(systemEvents).values({ level: "info", event: "verification.probe", detail: marker });
    const readBack = await db.select().from(systemEvents).where(eq(systemEvents.detail, marker)).limit(1);
    expect(readBack).toHaveLength(1);
    expect(readBack[0].event).toBe("verification.probe");
    await db.delete(systemEvents).where(eq(systemEvents.id, readBack[0].id));
    const afterDelete = await db.select().from(systemEvents).where(eq(systemEvents.id, readBack[0].id)).limit(1);
    expect(afterDelete).toHaveLength(0);
  }, 20_000);
});
