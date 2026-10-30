/**
 * Live proof for Phase A (run by .github/workflows/phase-a.yml, never mocked):
 *  1. probes each source on its own and records its HTTP status,
 *  2. runs the real cascade for BTCUSDT 1h into Postgres,
 *  3. re-inserts the same rows and re-runs the cascade to show idempotency,
 *  4. prints a raw provider row and the stored DB row.
 * Exit code 1 + BLOCKED_SOURCE_DATA when every source fails.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { desc, eq, and, sql } from "drizzle-orm";
import { candles } from "@db/schema";
import { closeDb, getDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { BlockedSourceDataError, ingest, type CandleRow } from "./ingest";
import { DEFAULT_PROVIDERS, TF_MS, type Timeframe } from "./providers";
import { createPgStore } from "./store";

const SYMBOL = "BTCUSDT";
const TF: Timeframe = "1h";
const out: Record<string, unknown> = { symbol: SYMBOL, timeframe: TF, startedAt: new Date().toISOString() };

const applied = await runMigrations();
out.migrationsApplied = applied;

// 1) isolated per-source probe (not the cascade): shows which sources this network can reach
const probe: Record<string, unknown>[] = [];
for (const p of DEFAULT_PROVIDERS) {
  const t = Date.now();
  try {
    const r = await p.fetch(SYMBOL, TF, 200);
    const aligned = r.candles.filter((c) => c.time % TF_MS[TF] === 0).length;
    probe.push({ source: p.name, ok: true, httpStatus: r.httpStatus, candles: r.candles.length, alignedToTimeframe: aligned, ms: Date.now() - t });
  } catch (error) {
    probe.push({ source: p.name, ok: false, httpStatus: (error as { status?: number | null }).status ?? null, error: error instanceof Error ? error.message : String(error), ms: Date.now() - t });
  }
}
out.sourceProbe = probe;

const store = createPgStore();
const db = getDb();
const countRows = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(candles).where(and(eq(candles.symbol, SYMBOL), eq(candles.timeframe, TF))))[0].n);
let exitCode = 0;

try {
  const before = await countRows();
  const run1 = await ingest(store, SYMBOL, TF, { limit: 200 });
  const afterRun1 = await countRows();
  out.run1 = { ...run1, gaps: run1.gaps.length, rowsBefore: before, rowsAfter: afterRun1 };

  // 2) idempotency: the exact same rows inserted again must add nothing
  const stored = await store.getCandles(SYMBOL, TF, 200);
  const reinserted = await store.insertCandles(stored as CandleRow[]);
  out.reinsertSameRows = { attempted: stored.length, inserted: reinserted, rowsAfter: await countRows() };

  // 3) second cascade run: only brand-new candles (at most the next hour) may be inserted
  const run2 = await ingest(store, SYMBOL, TF, { limit: 200 });
  const afterRun2 = await countRows();
  out.run2 = { source: run2.source, httpStatus: run2.httpStatus, valid: run2.valid, inserted: run2.inserted, alreadyStored: run2.alreadyStored, rowsAfter: afterRun2, rowsAddedEqualsInserted: afterRun2 === afterRun1 + run2.inserted };

  const latest = await db.select().from(candles).where(and(eq(candles.symbol, SYMBOL), eq(candles.timeframe, TF))).orderBy(desc(candles.openTime)).limit(1);
  out.latestStoredRow = latest[0] ?? null;
  out.ok = reinserted === 0 && afterRun2 === afterRun1 + run2.inserted && afterRun1 > 0 && run1.valid <= 200;
  if (!out.ok) exitCode = 1;
} catch (error) {
  exitCode = 1;
  if (error instanceof BlockedSourceDataError) {
    out.error = error.code;
    out.attempts = error.attempts;
  } else {
    out.error = error instanceof Error ? error.message : String(error);
  }
}

out.finishedAt = new Date().toISOString();
await mkdir("evidence", { recursive: true });
await writeFile("evidence/live-proof.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await closeDb();
process.exit(exitCode);
