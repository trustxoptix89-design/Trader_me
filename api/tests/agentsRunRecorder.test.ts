import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAgentRunStore } from "../orchestrator/agentRuns";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { runSignalPipeline } from "../orchestrator/machine";
import { compareAgentRuns, PostgresAgentsRunRecorder, SequentialAgentsRunRecorder, TransactionUnsupportedError } from "../pipeline/agentsRunRecorder";
import { versions } from "./fixtures/agentRunContract";
import { baseInput } from "./fixtures/governanceFixtures";

describe("P3 reconciliation (pure)", () => {
  it("matching keys -> no issue", () => { expect(compareAgentRuns("s", ["a", "b"], ["b", "a"])).toBe(null); });
  it("no audit tracking and no runs -> no issue (legacy signal)", () => { expect(compareAgentRuns("s", null, [])).toBe(null); });
  it("runs without audit event", () => { expect(compareAgentRuns("s", null, ["a"])?.kind).toBe("RUNS_WITHOUT_AUDIT"); });
  it("audit event without runs", () => { const i = compareAgentRuns("s", ["a", "b"], []); expect(i?.kind).toBe("AUDIT_WITHOUT_RUNS"); expect(i?.missingInRuns.join(",")).toBe("a,b"); });
  it("partial overlap -> KEY_MISMATCH with both sides listed", () => {
    const i = compareAgentRuns("s", ["a", "b"], ["b", "c"]);
    expect(i?.kind).toBe("KEY_MISMATCH"); expect(i?.missingInRuns.join(",")).toBe("a"); expect(i?.missingInAudit.join(",")).toBe("c");
  });
});

describe("P3 pipeline wiring (sequential test double, NOT proof of atomicity)", () => {
  it("records one run per vote and the AGENTS_RUN event lists exactly those keys", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const r = await runSignalPipeline({ ...baseInput("up", defaultAgents()), symbol: "P3-WIRE", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
    expect(r.auditPersisted).toBe(true);
    const rows = await runs.listBySignal(r.signalId);
    expect(rows.length).toBe(7);
    const ev = r.events.find((e) => e.kind === "STATE_TRANSITION" && e.state === "AGENTS_RUN");
    const keys = ((ev?.detail as { agentRunKeys: string[] }).agentRunKeys);
    expect(keys.join("|")).toBe(rows.map((x) => x.idempotencyKey).sort().join("|"));
    expect(rows.every((x) => x.signalId === r.signalId)).toBe(true);
  });
  it("same input twice: second call is a duplicate and adds no rows", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const input = { ...baseInput("up", defaultAgents()), symbol: "P3-DUP", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } };
    const a = await runSignalPipeline(input), b = await runSignalPipeline(input);
    expect(b.duplicate).toBe(true);
    expect((await runs.listBySignal(a.signalId)).length).toBe(7);
  });
  it("recorder failure -> inconclusive with AUDIT_FAILURE, never approved or notified", async () => {
    const audit = new InMemoryAuditStore();
    let notified = 0;
    const r = await runSignalPipeline({ ...baseInput("up", defaultAgents()), symbol: "P3-FAIL", audit, notify: () => { notified++; }, agentRuns: { recorder: { record: async () => { throw new Error("db down"); } } } });
    expect(r.status).toBe("inconclusive");
    expect(notified).toBe(0);
    expect(r.haltReason?.includes("db down")).toBe(true);
  });
  it("a Postgres recorder over an executor with no transaction support refuses to run", async () => {
    let name = "";
    try { await new PostgresAgentsRunRecorder({ query: async () => [] }).record([], {} as never); } catch (e) { name = (e as Error).name; }
    expect(name).toBe(new TransactionUnsupportedError().name);
  });
});
