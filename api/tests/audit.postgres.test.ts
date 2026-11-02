import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgresAuditStore, postgresJsExecutor } from "../orchestrator/audit.postgres";
import { closeDb, getSql } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { defineAuditStoreContract } from "./fixtures/auditContract";

// Runs only when DB_PROBE=true and DATABASE_URL points at a disposable Postgres (CI provides one).
const enabled = process.env.DB_PROBE === "true";

describe.skipIf(!enabled)("Postgres audit_log (migration 0003 + PostgresAuditStore)", () => {
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeDb(); });
  it("migration 0003 is applied", async () => {
    const rows = await postgresJsExecutor().query("SELECT to_regclass('sarmaye.audit_log') AS t");
    if (rows[0].t === null) throw new Error("sarmaye.audit_log is missing");
  });
  defineAuditStoreContract("postgres", (db) => new PostgresAuditStore(db), postgresJsExecutor(), {
    reconnect: async () => { await closeDb(); },
    severConnections: async () => { await getSql().unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"); },
  });
});
