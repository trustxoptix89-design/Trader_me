import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAuditStore, type AuditEvent, type AuditStore, type StoredAuditEvent } from "../orchestrator/audit";
import { ALLOWED_TRANSITIONS, PIPELINE_STATES, isAllowedTransition, runSignalPipeline, type PipelineState } from "../orchestrator/machine";
import { baseInput } from "./fixtures/governanceFixtures";

const S = PIPELINE_STATES as readonly PipelineState[];
const idx = (s: PipelineState): number => S.indexOf(s);
const last = S[S.length - 1], rec: PipelineState = "RECORDED", gated: PipelineState = "GATED";
/** Independent oracle (derived from state ORDER, so it survives an 8/9-state decision): next state, or a jump to RECORDED from any state before it. */
const expected = (from: PipelineState | null, to: PipelineState): boolean => {
  if (from === null) return to === S[0];
  if (from === last) return false;
  if (idx(to) === idx(from) + 1) return true;
  return to === rec && idx(from) < idx(rec);
};

describe("P6 state machine: every (from, to) pair against an independent oracle", () => {
  const froms: (PipelineState | null)[] = [null, ...S];
  for (const from of froms) for (const to of S) {
    it(`${from ?? "START"} -> ${to}: ${expected(from, to) ? "allowed" : "forbidden"}`, () => { expect(isAllowedTransition(from, to)).toBe(expected(from, to)); });
  }
  it("the table has no entries outside PIPELINE_STATES and the terminal state has none", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort().join()).toBe([...S].sort().join());
    expect(ALLOWED_TRANSITIONS[last].length).toBe(0);
  });
  it("GATED can only go to RECORDED; no state can be skipped on the happy path", () => {
    expect(ALLOWED_TRANSITIONS[gated].join()).toBe(rec);
    for (const from of S) for (const to of S) if (idx(to) > idx(from) + 1 && to !== rec) expect(isAllowedTransition(from, to)).toBe(false);
  });
});

/** Fails the n-th append (0-based) with an error, otherwise delegates. */
class FailAt implements AuditStore {
  private n = 0; readonly inner = new InMemoryAuditStore();
  constructor(private readonly at: number) {}
  async append(e: AuditEvent): Promise<StoredAuditEvent | null> { if (this.n++ === this.at) throw new Error("INJECTED_FAULT: store down"); return this.inner.append(e); }
  read(id: string): Promise<StoredAuditEvent[]> { return this.inner.read(id); }
  verifyChain(id: string) { return this.inner.verifyChain(id); }
}

describe("P6 fault injection: a failing audit store at every possible write", () => {
  for (let at = 0; at < 14; at++) {
    it(`store fails at write #${at}: never approved-without-record, never notified before a persisted DECISION`, async () => {
      const store = new FailAt(at);
      let notifiedWithDecision: boolean | null = null;
      const input = { ...baseInput("up", defaultAgents()), symbol: `P6-FI-${at}`, audit: store, notify: async (r: { correlationId: string }) => { notifiedWithDecision = (await store.read(r.correlationId)).some((e) => e.kind === "DECISION" && e.decision === "approved"); } };
      const r = await runSignalPipeline(input);
      if (notifiedWithDecision !== null) expect(notifiedWithDecision).toBe(true);
      const persisted = (await store.read(r.correlationId)).filter((e) => e.kind === "DECISION");
      if (r.status === "approved") expect(persisted.length).toBe(1);
      expect(r.status === "approved" && r.auditPersisted === false).toBe(false);
    });
  }
});

describe("P6 approval guards (all scenarios)", () => {
  const kinds = ["up", "conflict", "range"] as const;
  for (const kind of kinds) {
    it(`${kind}: approved only if GATED visited, verifier OK, Approval APPROVED and one DECISION persisted; every jump to RECORDED has a reason`, async () => {
      const r = await runSignalPipeline({ ...baseInput(kind, defaultAgents()), symbol: `P6-AG-${kind}`, audit: new InMemoryAuditStore() });
      const decisions = r.events.filter((e) => e.kind === "DECISION");
      expect(decisions.length).toBe(1);
      if (r.status === "approved") {
        expect(r.statesVisited.includes(gated)).toBe(true);
        expect(r.verifier?.status).toBe("OK");
        expect(r.approval?.status).toBe("APPROVED");
      }
      const recorded = r.events.find((e) => e.kind === "STATE_TRANSITION" && e.state === rec);
      expect(recorded !== undefined && String(recorded.reason ?? "").length > 0).toBe(true);
      if (!r.statesVisited.includes(gated)) expect(r.status).not.toBe("approved");
    });
  }
});
