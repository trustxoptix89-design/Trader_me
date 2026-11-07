import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { SequentialDecisionRecorder } from "../pipeline/decisionRecorder";
import type { LoadRows } from "../pipeline/candleAdapter";
import { createPipelineScheduler, type TickReport } from "../pipeline/pipelineScheduler";
import { NOW } from "./fixtures/governanceFixtures";
import { loaderFrom } from "./fixtures/pipelineLoader";

// DATA CLASS: SYNTHETIC + in-memory mocks (test-environment scheduler; not connected to boot or any deployment).
const mk = (loadRows: LoadRows, discover: () => Promise<string[]>, onTick?: (r: TickReport) => void) => {
  const audit = new InMemoryAuditStore(); let n = 0, t = 0;
  const s = createPipelineScheduler({
    cycle: { loadRows, audit, agents: defaultAgents(), now: () => NOW, newRunId: () => `r${++n}`, decision: { recorder: new SequentialDecisionRecorder(audit) }, limits: { readTimeoutMs: 100, pipelineTimeoutMs: 3000, maxAgeMs: 1e9, retry: { maxAttempts: 1, backoffMs: 0 } } },
    discover, newTickId: () => `tick-${++t}`, onTick,
  });
  return { s, audit };
};
const isReport = (x: unknown): x is TickReport => typeof x === "object" && x !== null && "runs" in x;

describe("pipeline scheduler (test environment)", () => {
  it("one tick runs a cycle per discovered symbol, deduplicates symbols and reports counts", async () => {
    const { s } = mk(loaderFrom("range"), async () => ["AUSDT", "BUSDT", "AUSDT"]);
    const r = await s.tick();
    expect(isReport(r)).toBe(true);
    if (!isReport(r)) return;
    expect(r.symbols).toEqual(["AUSDT", "BUSDT"]);
    expect(r.runs.map((x) => x.symbol)).toEqual(["AUSDT", "BUSDT"]);
    expect(new Set(r.runs.map((x) => x.runId)).size).toBe(2);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
  it("a failing symbol (no data) does not stop the others", async () => {
    const base = loaderFrom("range");
    const load: LoadRows = async (sym, tf, n) => (sym === "BADUSDT" ? [] : base(sym, tf, n));
    const { s } = mk(load, async () => ["BADUSDT", "GOODUSDT"]);
    const r = await s.tick();
    if (!isReport(r)) throw new Error("tick skipped");
    expect(r.runs[0].label).toBe("INSUFFICIENT_DATA");
    expect(r.runs[1].outcome.kind).toBe("PIPELINE");
  });
  it("discovery failure is reported, no cycle runs, the scheduler survives", async () => {
    const { s } = mk(loaderFrom("range"), async () => { throw new Error("discovery down"); });
    const r = await s.tick();
    if (!isReport(r)) throw new Error("tick skipped");
    expect(r.discoveryError).toBe("discovery down"); expect(r.runs).toHaveLength(0);
    expect(isReport(await s.tick())).toBe(true);
  });
  it("a repeated tick over the same data is flagged duplicate and emits no new signal", async () => {
    const { s } = mk(loaderFrom("range"), async () => ["AUSDT"]);
    await s.tick();
    const r2 = await s.tick();
    if (!isReport(r2)) throw new Error("tick skipped");
    expect(r2.counts.duplicates).toBe(1); expect(r2.newSignals).toHaveLength(0);
  });
  it("overlapping ticks are refused", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { s } = mk(loaderFrom("range"), async () => { await gate; return ["AUSDT"]; });
    const first = s.tick();
    const second = await s.tick();
    expect(second).toEqual({ skipped: "TICK_IN_PROGRESS" });
    release(); await first;
    expect(isReport(await s.tick())).toBe(true);
  });
  it("onTick receives the report; an onTick failure does not break the scheduler", async () => {
    const seen: string[] = [];
    const { s } = mk(loaderFrom("range"), async () => ["AUSDT"], (r) => { seen.push(r.tickId); throw new Error("sink down"); });
    expect(isReport(await s.tick())).toBe(true);
    expect(seen).toEqual(["tick-1"]);
  });
  it("start/stop use the injected timer and refuse a double start", async () => {
    const { s } = mk(loaderFrom("range"), async () => []);
    let cleared = 0; const fns: Array<() => void> = [];
    s.start(1000, (fn) => { fns.push(fn); return 1; });
    expect(s.running).toBe(true); expect(fns).toHaveLength(1);
    let threw = false; try { s.start(1000, () => 2); } catch { threw = true; }
    expect(threw).toBe(true);
    s.stop(() => { cleared++; });
    expect(s.running).toBe(false); expect(cleared).toBe(1);
  });
});
