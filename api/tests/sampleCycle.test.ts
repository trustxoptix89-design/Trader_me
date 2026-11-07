import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { runCycle } from "../pipeline/cycle";
import { SequentialDecisionRecorder } from "../pipeline/decisionRecorder";
import { NOW } from "./fixtures/governanceFixtures";
import { loaderFrom } from "./fixtures/pipelineLoader";

// Prints one SYNTHETIC cycle report: illustration of the output shape, NOT market data.
describe("sample cycle report (SYNTHETIC)", () => {
  it("has the documented shape", async () => {
    const audit = new InMemoryAuditStore();
    const r = await runCycle({ loadRows: loaderFrom("range"), audit, agents: defaultAgents(), now: () => NOW, newRunId: () => "sample-run-1", decision: { recorder: new SequentialDecisionRecorder(audit) }, limits: { readTimeoutMs: 1000, pipelineTimeoutMs: 5000, maxAgeMs: 60_000, retry: { maxAttempts: 2, backoffMs: 10 } } }, { symbol: "SAMPLEUSDT", market: "spot" });
    const o = r.outcome.kind === "PIPELINE" ? { kind: "PIPELINE", status: r.outcome.result.status, haltReason: r.outcome.result.haltReason ?? null, states: r.outcome.result.statesVisited, rr: r.outcome.result.rr ?? null } : r.outcome;
    console.log("SAMPLE_CYCLE " + JSON.stringify({ dataClass: "SYNTHETIC", runId: r.runId, symbol: r.symbol, label: r.label, reason: r.reason, stages: r.stages.map((s) => ({ stage: s.stage, attempts: s.attempts, retries: s.retries })), outcome: o, qualityOk: r.quality ? Object.fromEntries(Object.entries(r.quality).map(([k, v]) => [k, { ok: v.ok, fresh: v.fresh, missingBars: v.missingBars }])) : null, signal: r.signal }));
    expect(r.runId).toBe("sample-run-1");
  });
});
