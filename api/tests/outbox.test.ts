import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { runSignalPipeline } from "../orchestrator/machine";
import { SequentialDecisionRecorder } from "../pipeline/decisionRecorder";
import { backoffMs, InMemoryDeliveryLog, InMemoryOutboxStore, logChannel, runOutboxOnce, PROPOSED_OUTBOX_CONFIG } from "../pipeline/outbox";
import { baseInput } from "./fixtures/governanceFixtures";
import { defineOutboxStoreContract } from "./fixtures/outboxContract";

defineOutboxStoreContract("in-memory", () => new InMemoryOutboxStore());

describe("P5 backoff", () => {
  it("exponential and capped", () => {
    const c = { maxAttempts: 9, baseDelayMs: 100, maxDelayMs: 1000, leaseMs: 1 };
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, c)).join(",")).toBe("100,200,400,800,1000,1000");
  });
});

describe("P5 pipeline wiring (sequential double)", () => {
  it("approved -> NEW_CYCLE enqueued once; log channel delivers once; the same input again is a duplicate", async () => {
    const audit = new InMemoryAuditStore(), rec = new SequentialDecisionRecorder(audit), log = new InMemoryDeliveryLog();
    const input = { ...baseInput("up", defaultAgents()), symbol: "P5-WIRE", audit, decision: { recorder: rec } };
    const r = await runSignalPipeline(input);
    expect(r.status).toBe("approved");
    expect((await rec.outbox.list(r.signalId)).map((x) => x.kind).join()).toBe("NEW_CYCLE");
    await runOutboxOnce(rec.outbox, { log: logChannel(log) }, PROPOSED_OUTBOX_CONFIG, 2e12, "w");
    await runOutboxOnce(rec.outbox, { log: logChannel(log) }, PROPOSED_OUTBOX_CONFIG, 2e12 + 1, "w");
    expect(log.lines.size).toBe(1);
    const again = await runSignalPipeline(input);
    expect(again.duplicate).toBe(true);
    expect((await rec.outbox.list(r.signalId)).length).toBe(1);
  });
  it("a non-approved decision registers no cycle and enqueues nothing", async () => {
    const audit = new InMemoryAuditStore(), rec = new SequentialDecisionRecorder(audit);
    const r = await runSignalPipeline({ ...baseInput("conflict", defaultAgents()), symbol: "P5-NO", audit, decision: { recorder: rec } });
    expect(r.status).not.toBe("approved");
    expect((await rec.outbox.list(r.signalId)).length).toBe(0);
  });
});
