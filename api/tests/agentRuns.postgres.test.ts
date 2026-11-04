import { afterAll, beforeAll, describe } from "vitest";
import { PostgresAgentRunStore } from "../orchestrator/agentRuns";
import { postgresJsExecutor } from "../orchestrator/audit.postgres";
import { closeDb, getSql } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { defineAgentRunStoreContract, definePostgresAgentRunChecks } from "./fixtures/agentRunContract";

// REAL PostgreSQL: runs only when DB_PROBE=true and DATABASE_URL points at a disposable database (CI provides Postgres 17).
const enabled = process.env.DB_PROBE === "true";

describe.skipIf(!enabled)("Postgres agent_runs (migration 0004 + PostgresAgentRunStore)", () => {
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeDb(); });
  const make = () => new PostgresAgentRunStore(postgresJsExecutor());
  definePostgresAgentRunChecks(postgresJsExecutor(), make);
  defineAgentRunStoreContract("postgres", make, {
    reconnect: async () => { await closeDb(); },
    severConnections: async () => { await getSql().unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"); },
  });
});
