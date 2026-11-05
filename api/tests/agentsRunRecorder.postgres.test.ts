import { afterAll, beforeAll, describe } from "vitest";
import { postgresJsExecutor } from "../orchestrator/audit.postgres";
import { closeDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { defineAtomicRecorderChecks } from "./fixtures/agentsRunContract";

// REAL PostgreSQL: runs only when DB_PROBE=true (CI provides Postgres 17).
const enabled = process.env.DB_PROBE === "true";
describe.skipIf(!enabled)("P3 transactions on PostgreSQL (postgres.js begin)", () => {
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeDb(); });
  defineAtomicRecorderChecks(postgresJsExecutor());
});
