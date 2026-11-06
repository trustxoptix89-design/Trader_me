import { describe, expect, it } from "vitest";
import { defaultAgents, identify, structureAgent } from "../orchestrator/agents";
import { InMemoryAgentRunStore } from "../orchestrator/agentRuns";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { runSignalPipeline } from "../orchestrator/machine";
import { SequentialAgentsRunRecorder } from "../pipeline/agentsRunRecorder";
import { versions } from "./fixtures/agentRunContract";
import { baseInput } from "./fixtures/governanceFixtures";

// P-next: agent error accountability. Data class: SYNTHETIC fixtures. Atomicity on PostgreSQL is covered by agentsRunRecorder.postgres.test.ts.
const boom = (id: string, group: string) => identify(id, group, () => { throw new Error(`${id} exploded`); });

describe("agent failure accountability", () => {
  for (const agent of defaultAgents()) {
    it(`${agent.agentId} failing -> ERROR row with its own id, AGENT_FAILURE, never approved`, async () => {
      const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
      let notified = 0;
      const agents = defaultAgents().map((a) => (a.agentId === agent.agentId ? boom(a.agentId, a.agentGroup) : a));
      const r = await runSignalPipeline({ ...baseInput("up", agents), symbol: `ACC-${agent.agentId}`, audit, notify: () => { notified++; }, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
      expect(r.status).toBe("inconclusive");
      expect(r.haltReason).toBe(`AGENT_FAILURE: ${agent.agentId}`);
      expect(notified).toBe(0);
      expect(r.statesVisited).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECORDED"]);
      const rows = await runs.listBySignal(r.signalId);
      const bad = rows.filter((x) => x.validationOutcome === "ERROR");
      expect(bad.map((x) => x.agentId)).toEqual([agent.agentId]);
      expect(bad[0].error).toContain("exploded");
      expect(rows.length).toBe(7);
      const ev = r.events.find((e) => e.kind === "STATE_TRANSITION" && e.state === "AGENTS_RUN");
      expect((ev?.detail as { verdict: string }).verdict).toBe("ERROR");
      expect(r.events.filter((e) => e.kind === "ERROR").length).toBe(1);
      expect(r.events.filter((e) => e.kind === "DECISION").length).toBe(1);
    });
  }

  it("a vote signed with another agent's id is rejected as AGENT_IDENTITY_MISMATCH", async () => {
    const spoof = identify("B09_EMA_TREND", "B", (ctx) => ({ ...structureAgent(ctx), agentId: "A01_STRUCTURE" }));
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const r = await runSignalPipeline({ ...baseInput("up", [spoof]), symbol: "ACC-SPOOF", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toBe("AGENT_FAILURE: B09_EMA_TREND");
    const rows = await runs.listBySignal(r.signalId);
    expect(rows.find((x) => x.agentId === "B09_EMA_TREND")?.error).toContain("AGENT_IDENTITY_MISMATCH");
  });

  it("two agents with the same id -> the second is an AGENT_DUPLICATE_ID failure", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const r = await runSignalPipeline({ ...baseInput("up", [structureAgent, structureAgent]), symbol: "ACC-DUP", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toBe("AGENT_FAILURE: A01_STRUCTURE");
  });

  it("an anonymous agent that throws gets no fabricated identity or run row", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const r = await runSignalPipeline({ ...baseInput("up", [() => { throw new Error("x"); }]), symbol: "ACC-ANON", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("UNIDENTIFIED_AGENT#0");
    expect((await runs.listBySignal(r.signalId)).every((x) => x.validationOutcome !== "ERROR")).toBe(true);
  });

  it("a failing agent without the recorder still halts (no agent_runs wiring required for safety)", async () => {
    const r = await runSignalPipeline({ ...baseInput("up", [boom("B11_MACD", "B")]), symbol: "ACC-NOREC" });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toBe("AGENT_FAILURE: B11_MACD");
  });

  it("retry of the same failing input is a duplicate and adds no rows", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const input = { ...baseInput("up", [boom("B12_BB", "B")]), symbol: "ACC-RETRY", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } };
    const a = await runSignalPipeline(input), b = await runSignalPipeline(input);
    expect(b.duplicate).toBe(true);
    expect((await runs.listBySignal(a.signalId)).length).toBe(2);
  });

  it("all agents healthy -> unchanged behaviour (7 OK rows, AGENTS_RUN verdict OK)", async () => {
    const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
    const r = await runSignalPipeline({ ...baseInput("up", defaultAgents()), symbol: "ACC-OK", audit, agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs), versions } });
    const rows = await runs.listBySignal(r.signalId);
    expect(rows.length).toBe(7);
    expect(rows.some((x) => x.validationOutcome === "ERROR")).toBe(false);
  });
});
