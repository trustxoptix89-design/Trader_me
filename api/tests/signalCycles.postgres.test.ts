import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../queries/connection";
import { runMigrations } from "../queries/migrate";
import { postgresJsExecutor } from "../orchestrator/audit.postgres";
import { PostgresCycleStore } from "../pipeline/cycleStore";
import { defineCycleStoreContract, definePostgresCycleChecks } from "./fixtures/cycleContract";

// DB_PROBE-gated: real PostgreSQL (CI service container). Data class: SYNTHETIC observations.
const enabled = process.env.DB_PROBE === "true";

describe.skipIf(!enabled)("signal cycles in real PostgreSQL", () => {
  afterAll(async () => { await closeDb(); });
  it("migrations are applied (0005 included) and re-running applies nothing", async () => { await runMigrations(); expect(await runMigrations()).toEqual([]); });
  const make = (): PostgresCycleStore => new PostgresCycleStore(postgresJsExecutor());
  defineCycleStoreContract("postgres", make);
  definePostgresCycleChecks(postgresJsExecutor(), make);
});
