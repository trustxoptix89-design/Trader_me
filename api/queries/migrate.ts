import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getSql } from "./connection";
import { log } from "../lib/logger";

export function migrationsDir() {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "db/migrations");
}

/** Applies db/migrations/*.sql in name order exactly once each; serialised across instances with an advisory lock. */
export async function runMigrations(dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const sql = getSql();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`;
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS sarmaye");
    await tx.unsafe("CREATE TABLE IF NOT EXISTS sarmaye.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM sarmaye.schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(path.join(dir, file), "utf8"));
      await tx`INSERT INTO sarmaye.schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
  });
  if (applied.length) log.info("migrations applied", { files: applied });
  return applied;
}
