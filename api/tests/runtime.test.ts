import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../orchestrator/audit";
import type { SqlExecutor } from "../orchestrator/audit.postgres";
import { createAuditRuntime } from "../orchestrator/runtime";

const fakeDb: SqlExecutor = { async query() { return [{ "?column?": 1 }]; } };

describe("audit runtime selection (in-memory, no real DB)", () => {
  it("no database configured -> memory store flagged non-durable", () => {
    const r = createAuditRuntime({});
    expect(r.kind).toBe("memory"); expect(r.durable).toBe(false); expect(r.store).toBeInstanceOf(InMemoryAuditStore);
  });
  it("database configured -> postgres store flagged durable", () => {
    const r = createAuditRuntime({ executor: fakeDb });
    expect(r.kind).toBe("postgres"); expect(r.durable).toBe(true);
  });
});
