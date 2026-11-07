import { describe, expect, it } from "vitest";
import { defaultAgents, identify } from "../orchestrator/agents";
import { InMemoryAgentRunStore } from "../orchestrator/agentRuns";
import { InMemoryAuditStore, type AuditStore } from "../orchestrator/audit";
import { type LoadRows } from "../pipeline/candleAdapter";
import { runCycle, labelOf, withTimeout, StageTimeoutError, type CycleDeps } from "../pipeline/cycle";
import { SequentialAgentsRunRecorder } from "../pipeline/agentsRunRecorder";
import { SequentialDecisionRecorder } from "../pipeline/decisionRecorder";
import { NOW } from "./fixtures/governanceFixtures";
import { loaderFrom } from "./fixtures/pipelineLoader";

// DATA CLASS: SYNTHETIC + in-memory mocks. These are NOT real-PostgreSQL or real-market tests (see docs/PHASE_E_STATUS.md for those).
const noSleep = async (): Promise<void> => {};
const mk = (loadRows: LoadRows, over: Partial<CycleDeps> = {}) => {
  const audit = new InMemoryAuditStore(), runs = new InMemoryAgentRunStore();
  let n = 0;
  const deps: CycleDeps = {
    loadRows, audit, agents: defaultAgents(), now: () => NOW, newRunId: () => `run-${++n}`,
    agentRuns: { recorder: new SequentialAgentsRunRecorder(audit, runs) }, decision: { recorder: new SequentialDecisionRecorder(audit) },
    limits: { readTimeoutMs: 50, pipelineTimeoutMs: 2000, maxAgeMs: 10_000, retry: { maxAttempts: 2, backoffMs: 1, sleep: noSleep } }, ...over,
  };
  return { deps, audit, runs };
};
const req = { symbol: "TESTUSDT", market: "spot" as const };

describe("cycle: valid data (range fixture)", () => {
  it("runs end to end with run id, stage records, data quality and a persisted decision", async () => {
    const { deps } = mk(loaderFrom("range"));
    const r = await runCycle(deps, req);
    expect(r.runId).toBe("run-1");
    expect(r.outcome.kind).toBe("PIPELINE");
    expect(r.stages.map((s) => s.stage)).toEqual(["READ", "PIPELINE"]);
    expect(r.stages[0].attempts).toBe(1); expect(r.stages[0].retries).toBe(0);
    expect(r.quality?.["1H"].ok).toBe(true);
    if (r.outcome.kind !== "PIPELINE") return;
    const dv = r.outcome.result.events.find((e) => e.kind === "STATE_TRANSITION" && e.state === "DATA_VALIDATED");
    expect(JSON.stringify(dv?.detail)).toContain("dataQuality");
    expect(r.outcome.result.events.filter((e) => e.kind === "DECISION")).toHaveLength(1);
    expect(["WAIT", "REJECT", "INSUFFICIENT_DATA", "BUY_NOW"]).toContain(r.label);
    expect(r.signal === null || r.label === "BUY_NOW").toBe(true);
  });
  it("trend mode -> no Setup -> INSUFFICIENT_DATA (TREND_SETUP_UNAVAILABLE), nothing emitted", async () => {
    const r = await runCycle(mk(loaderFrom("up")).deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.reason.startsWith("TREND_SETUP_UNAVAILABLE")).toBe(true); expect(r.signal).toBeNull();
  });
});

describe("cycle: data problems never approve", () => {
  it("incomplete data (no rows) -> INSUFFICIENT_DATA", async () => {
    const r = await runCycle(mk(async () => []).deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.signal).toBeNull();
  });
  it("stale data (clock two hours ahead) -> INSUFFICIENT_DATA, no pipeline write", async () => {
    const { deps, audit } = mk(loaderFrom("range"), { now: () => NOW + 2 * 3_600_000 });
    const r = await runCycle(deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.outcome.kind).toBe("ABSTAIN");
    expect((await audit.read("x")).length).toBe(0);
  });
  it("a hole in the 1H series -> INSUFFICIENT_DATA", async () => {
    const base = loaderFrom("range");
    const holed: LoadRows = async (s, tf, n) => { const rows = await base(s, tf, n); return tf === "1h" ? rows.filter((_, i) => i !== rows.length - 20) : rows; };
    const r = await runCycle(mk(holed).deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.signal).toBeNull();
  });
  it("futures stays BLOCKED -> INSUFFICIENT_DATA, nothing read", async () => {
    let reads = 0;
    const r = await runCycle(mk(async () => { reads++; return []; }).deps, { symbol: "X", market: "futures" });
    expect(r.outcome.kind).toBe("BLOCKED"); expect(r.label).toBe("INSUFFICIENT_DATA"); expect(reads).toBe(0);
  });
});

describe("cycle: agents, timeout, retry", () => {
  it("one failing agent -> INSUFFICIENT_DATA with AGENT_FAILURE, never BUY_NOW", async () => {
    const agents = [identify("B11_MACD", "B", () => { throw new Error("boom"); })];
    const r = await runCycle(mk(loaderFrom("range"), { agents }).deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.reason).toBe("AGENT_FAILURE: B11_MACD"); expect(r.signal).toBeNull();
  });
  it("a read that never answers times out after bounded retries -> FAILED, attempts recorded", async () => {
    const never: LoadRows = () => new Promise(() => {});
    const r = await runCycle(mk(never).deps, req);
    expect(r.outcome.kind).toBe("FAILED"); expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.reason).toContain("TIMEOUT");
    expect(r.stages[0].attempts).toBe(2); expect(r.stages[0].retries).toBe(1);
  });
  it("a transient read failure is retried once and the cycle succeeds; the retry is recorded", async () => {
    const base = loaderFrom("range");
    let calls = 0;
    const flaky: LoadRows = async (s, tf, n) => { if (++calls === 1) throw new Error("db hiccup"); return base(s, tf, n); };
    const r = await runCycle(mk(flaky).deps, req);
    expect(r.outcome.kind).toBe("PIPELINE"); expect(r.stages[0].attempts).toBe(2); expect(r.stages[0].retries).toBe(1); expect(r.stages[0].error).toContain("recovered after retry");
  });
  it("retry is bounded: persistent read error -> FAILED after maxAttempts", async () => {
    let calls = 0;
    const r = await runCycle(mk(async () => { calls++; throw new Error("down"); }).deps, req);
    expect(r.outcome.kind).toBe("FAILED"); expect(calls).toBe(2);
  });
  it("pipeline stage timeout -> FAILED with persistenceUnknown", async () => {
    const { deps } = mk(loaderFrom("range"), { limits: { readTimeoutMs: 50, pipelineTimeoutMs: 5, maxAgeMs: 1e9, retry: { maxAttempts: 1, backoffMs: 0, sleep: noSleep } } });
    const slow = Object.assign(Object.create(deps.audit as object), { append: () => new Promise(() => {}) }) as AuditStore;
    const r = await runCycle({ ...deps, audit: slow, decision: undefined, agentRuns: undefined }, req);
    expect(r.outcome.kind).toBe("FAILED"); expect(r.persistenceUnknown).toBe(true);
  });
  it("withTimeout resolves fast promises and rejects slow ones with StageTimeoutError", async () => {
    expect(await withTimeout(Promise.resolve(1), 20, "s")).toBe(1);
    let err: unknown = null;
    try { await withTimeout(new Promise(() => {}), 5, "s"); } catch (e) { err = e; }
    expect(err instanceof StageTimeoutError).toBe(true);
  });
});

describe("cycle: duplicates, concurrency, expiry, database failure", () => {
  it("duplicate run: second cycle is flagged duplicate, adds no records and emits no signal", async () => {
    const { deps, audit } = mk(loaderFrom("range"));
    const a = await runCycle(deps, req), eventsAfterFirst = a.outcome.kind === "PIPELINE" ? (await audit.read(a.outcome.result.signalId)).length : 0;
    const b = await runCycle(deps, req);
    expect(b.duplicate).toBe(true); expect(b.signal).toBeNull(); expect(b.runId).not.toBe(a.runId);
    if (b.outcome.kind === "PIPELINE") expect((await audit.read(b.outcome.result.signalId)).length).toBe(eventsAfterFirst);
  });
  it("concurrent runs of the same symbol: the second is SKIPPED", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const base = loaderFrom("range");
    const slowLoad: LoadRows = async (s, tf, n) => { await gate; return base(s, tf, n); };
    const { deps } = mk(slowLoad, { limits: { readTimeoutMs: 1000, pipelineTimeoutMs: 5000, maxAgeMs: 1e9, retry: { maxAttempts: 1, backoffMs: 0, sleep: noSleep } } });
    const first = runCycle(deps, req);
    const second = await runCycle(deps, req);
    expect(second.outcome.kind).toBe("SKIPPED"); expect(second.reason).toContain("CONCURRENT_RUN");
    release();
    expect((await first).outcome.kind).toBe("PIPELINE");
    expect((await runCycle(deps, req)).outcome.kind).not.toBe("SKIPPED"); // the guard is released
  });
  it("an output older than maxAgeMs is EXPIRED and not emitted", async () => {
    let t = NOW;
    const { deps } = mk(loaderFrom("range"), { now: () => (t += 1), limits: { readTimeoutMs: 50, pipelineTimeoutMs: 5000, maxAgeMs: 0, retry: { maxAttempts: 1, backoffMs: 0, sleep: noSleep } } });
    const r = await runCycle(deps, req);
    expect(r.outcome.kind).toBe("EXPIRED"); expect(r.signal).toBeNull();
  });
  it("database failure (audit store throws) -> never approved, INSUFFICIENT_DATA", async () => {
    const broken: AuditStore = { append: async () => { throw new Error("db down"); }, read: async () => [], verifyChain: async () => ({ ok: false, events: 0 }) };
    const r = await runCycle(mk(loaderFrom("range"), { audit: broken, decision: undefined, agentRuns: undefined }).deps, req);
    expect(r.label).toBe("INSUFFICIENT_DATA"); expect(r.signal).toBeNull();
  });
  it("rollback: a decision recorder that throws leaves no DECISION event and no signal", async () => {
    const { deps, audit } = mk(loaderFrom("range"), { decision: { recorder: { record: async () => { throw new Error("tx rolled back"); } } } });
    const r = await runCycle(deps, req);
    expect(r.signal).toBeNull(); expect(r.label).toBe("INSUFFICIENT_DATA");
    if (r.outcome.kind === "PIPELINE") expect((await audit.read(r.outcome.result.signalId)).filter((e) => e.kind === "DECISION")).toHaveLength(0);
  });
});

describe("labelOf mapping", () => {
  const base = { mode: "range" as const, statesVisited: [], events: [], votes: [], rooms: [], notified: false, duplicate: false, auditPersisted: true, signalId: "s", correlationId: "c" };
  const p = (status: string, haltReason?: string) => ({ kind: "PIPELINE" as const, result: { ...base, status, haltReason } as never, setup: { entry: 1, invalidation: 0, targets: [2], atr: 1 }, quality: {} as never });
  it("approved -> BUY_NOW", () => { expect(labelOf(p("approved")).label).toBe("BUY_NOW"); });
  it("rejected -> REJECT", () => { expect(labelOf(p("rejected", "RISK_RR")).label).toBe("REJECT"); });
  it("inconclusive (conflict/no-trade) -> WAIT", () => { expect(labelOf(p("inconclusive", "ELITE_NO_TRADE")).label).toBe("WAIT"); });
  it("inconclusive data/agent problems -> INSUFFICIENT_DATA", () => {
    for (const r of ["DATA_STALE", "AGENT_FAILURE: B11_MACD", "AUDIT_FAILURE", "INSUFFICIENT_CLOSED_CANDLES"]) expect(labelOf(p("inconclusive", r)).label).toBe("INSUFFICIENT_DATA");
  });
  it("CONDITIONAL_BUY is never produced (no approved V6 rule)", () => {
    for (const s of ["approved", "rejected", "inconclusive"]) expect(labelOf(p(s, "X")).label).not.toBe("CONDITIONAL_BUY");
  });
});
