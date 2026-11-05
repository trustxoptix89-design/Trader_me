import { afterAll, beforeAll, describe } from "vitest";
import { postgresJsExecutor } from "../orchestrator/audit.postgres";
import { PostgresOutboxStore } from "../pipeline/outbox";
import { closeDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { defineDecisionAtomicChecks, defineOutboxStoreContract } from "./fixtures/outboxContract";

const enabled = process.env.DB_PROBE === "true";
describe.skipIf(!enabled)("P5 Outbox on PostgreSQL (migration 0006)", () => {
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeDb(); });
  defineOutboxStoreContract("postgres", () => new PostgresOutboxStore(postgresJsExecutor()));
  defineDecisionAtomicChecks(postgresJsExecutor());
});
