import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryAuditStore, verifyChainOf, type AuditStore, type StoredAuditEvent } from "../orchestrator/audit";
import { defaultAgents } from "../orchestrator/agents";
import { isAllowedTransition, runSignalPipeline, type PipelineInput, type PipelineResult, type PipelineState } from "../orchestrator/machine";
import { H, NOW, baseInput } from "./fixtures/governanceFixtures";
import { retimeTo, setupFromCandles, sidewaysSeries, trimToPullbackEntry, zigzagTrend } from "./fixtures/scenarioFixtures";

/**
 * End-to-end scenarios: explicit OHLCV in -> real rooms, real agents (no stubbed votes), real indicator maths, Independent Verifier
 * -> final decision -> audit persistence read back from the store. Nothing predetermines the decision.
 * Every scenario runs against the in-memory store; with DB_PROBE=true (CI) it also runs against the real Postgres audit_log.
 */
const dbEnabled = process.env.DB_PROBE === "true";
// Loaded only when a database is configured, so the suite runs without any DB driver installed.
const pg = dbEnabled ? await import("../orchestrator/audit.postgres") : undefined;
const conn = dbEnabled ? await import("../queries/connection") : undefined;
const mig = dbEnabled ? await import("../queries/migrate") : undefined;
const stores: [string, () => AuditStore][] = [["in-memory", () => new InMemoryAuditStore()]];
if (pg) stores.push(["postgres", () => new pg.PostgresAuditStore()]);

const kinds = (r: PipelineResult, k: string): StoredAuditEvent[] => r.events.filter((e) => e.kind === k);
const states = (r: PipelineResult): PipelineState[] => kinds(r, "STATE_TRANSITION").map((e) => e.state as PipelineState);
const roomStatus = (r: PipelineResult, room: string): string | undefined => (r.events[r.events.length - 1].roomVerdicts[room] as { status?: string } | undefined)?.status;

/** Common invariants of EVERY outcome: legal transitions, one decision, contiguous sequence, valid chain, nothing approved without verifier OK. */
function assertAuditInvariants(r: PipelineResult): void {
  const s = states(r);
  s.forEach((st, i) => expect(isAllowedTransition(i === 0 ? null : s[i - 1], st)).toBe(true));
  expect(kinds(r, "DECISION")).toHaveLength(1);
  expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
  expect(verifyChainOf(r.events).ok).toBe(true);
  const decision = kinds(r, "DECISION")[0].decision;
  expect(decision).toBe(r.status);
  if (r.status === "approved") {
    expect(r.verifier?.status).toBe("OK");
    expect(r.approval?.status).toBe("APPROVED");
    expect(r.rooms.every((x) => x.status === "PASS")).toBe(true);
  }
}

describe.each(stores)("8 end-to-end scenarios [%s audit store]", (_name, makeStore) => {
  afterAll(async () => { await conn?.closeDb(); });
  const input = (kind: "up" | "conflict" | "range", tag: string, over: Partial<PipelineInput> = {}): PipelineInput => ({
    ...baseInput(kind, defaultAgents()), symbol: `E2E-${tag}-${randomUUID().slice(0, 8)}`, audit: makeStore(), ...over,
  });
  it("(setup) the database schema is migrated", async () => { if (dbEnabled) await mig?.runMigrations(); });

  it("1. Valid Uptrend -> approved long, all rooms PASS, verifier OK, notified once", async () => {
    let notified = 0;
    const r = await runSignalPipeline(input("up", "up", { notify: () => { notified++; } }));
    expect(r.trend?.verdict).toBe("ULTRA_TREND");
    expect(r.direction).toBe("long");
    expect(r.status).toBe("approved");
    expect(r.verifier?.status).toBe("OK");
    expect(states(r)).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RISK_CHECKED", "GATED", "RECORDED", "NOTIFIED"]);
    expect(r.approval?.tally.leading).toBe("bullish"); // real agents, not a unanimous stub: MACD may dissent after a pullback
    expect(r.votes.length).toBe(6); // Delta Force + the 5 implemented agents
    expect(notified).toBe(1);
    assertAuditInvariants(r);
  });

  it("2. Valid Downtrend -> approved short", async () => {
    const i = baseInput("up", defaultAgents());
    // mirror of the uptrend: every timeframe falls (the governance "conflict" bundle only flips 1H)
    const z = (n: number, step: number) => zigzagTrend(n, step, 100, -1, { drift: 0.001, amp: 0.008, period: 12 });
    const oneH = retimeTo(trimToPullbackEntry(z(300, H), "short"), H, NOW);
    const candles = { "4H": retimeTo(z(300, 4 * H), 4 * H, NOW), "1H": oneH, "15m": retimeTo(z(300, 900_000), 900_000, NOW), "5m": retimeTo(z(60, 300_000), 300_000, NOW) };
    const r = await runSignalPipeline({ ...i, symbol: `E2E-down-${randomUUID().slice(0, 8)}`, audit: makeStore(), candles, setup: setupFromCandles(oneH, "short", { rr: 3 }) });
    expect(r.trend?.verdict).toBe("ULTRA_TREND");
    expect(r.trend?.direction).toBe("BEARISH");
    expect(r.direction).toBe("short");
    expect(r.status).toBe("approved");
    assertAuditInvariants(r);
  });

  it("3. Range market -> Range Mode, never approved by the trend logic", async () => {
    const i = input("range", "range");
    const oneH = retimeTo(sidewaysSeries(300, H, 105, 4.5), H, NOW);
    const r = await runSignalPipeline({ ...i, candles: { ...i.candles, "1H": oneH } });
    expect(r.trend?.verdict).toBe("RANGE_DETECTED");
    expect(r.mode).toBe("range");
    expect(r.range).toBeDefined();
    expect(r.status).not.toBe("approved"); // the 1H agents and the verifier do not confirm a short at a random phase of the box
    assertAuditInvariants(r);
  });

  it("4. Conflicting indicators (4H up, 1H down, 15m up) -> halted at RECONCILED, no approval vote", async () => {
    const r = await runSignalPipeline(input("conflict", "conflict"));
    expect(r.trend?.verdict).toBe("CONFLICT");
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("CONTRADICTION_INDICATORS");
    expect(r.approval).toBeUndefined();
    expect(states(r)).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RECORDED"]);
    assertAuditInvariants(r);
  });

  it("5a. Stale data -> inconclusive at DATA_VALIDATED", async () => {
    const r = await runSignalPipeline(input("up", "stale", { now: NOW + 10 * H }));
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("DATA_STALE");
    expect(states(r)).toEqual(["DETECTED", "DATA_VALIDATED", "RECORDED"]);
    expect(kinds(r, "DECISION")[0].dataValid).toBe(false);
    assertAuditInvariants(r);
  });
  it("5b. Incomplete data (a hole in the history) -> inconclusive at DATA_VALIDATED", async () => {
    const i = input("up", "gap");
    const c = i.candles["1H"];
    const r = await runSignalPipeline({ ...i, candles: { ...i.candles, "1H": [...c.slice(0, 100), ...c.slice(140)] } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("DATA_GAP");
    expect(states(r)).toEqual(["DETECTED", "DATA_VALIDATED", "RECORDED"]);
    assertAuditInvariants(r);
  });

  it("6. Unacceptable risk (R:R < 1.5) -> Risk Room HALT -> rejected at RISK_CHECKED, verifier never consulted", async () => {
    const i = input("up", "risk");
    const r = await runSignalPipeline({ ...i, setup: { ...i.setup, targets: [i.setup.entry + 0.5 * (i.setup.entry - i.setup.invalidation)] } });
    expect(r.status).toBe("rejected");
    expect(r.haltReason).toBe("RISK_REJECT");
    expect(roomStatus(r, "RISK")).toBe("HALT");
    expect(states(r)).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RISK_CHECKED", "RECORDED"]);
    expect(kinds(r, "VERIFIER_RESULT")).toHaveLength(0);
    assertAuditInvariants(r);
  });

  it("7. Independent Verifier VETO overrides unanimous positive rooms -> inconclusive, VETO recorded", async () => {
    const i = input("up", "veto");
    const entry = i.setup.entry, atr = i.setup.atr;
    const r = await runSignalPipeline({ ...i, setup: { entry, atr, invalidation: entry - 0.6 * atr, targets: [entry + 1.8 * 0.6 * atr * 1.6] } });
    expect(r.rooms.every((x) => x.status === "PASS")).toBe(true);
    expect(r.approval?.status).toBe("APPROVED");
    expect(r.verifier?.status).toBe("VETO");
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("VERIFIER_VETO");
    expect(kinds(r, "VERIFIER_RESULT")).toHaveLength(1);
    assertAuditInvariants(r);
  });

  it("8a. Computation error (an agent throws) -> inconclusive PIPELINE_ERROR, error and decision recorded", async () => {
    const r = await runSignalPipeline(input("up", "err", { agents: [() => { throw new Error("indicator exploded"); }] }));
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("PIPELINE_ERROR");
    expect(kinds(r, "ERROR")).toHaveLength(1);
    assertAuditInvariants(r);
  });
  it("8b. Service error (the audit store fails) -> never approved, nothing notified", async () => {
    let notified = 0;
    const broken: AuditStore = { append: async () => { throw new Error("db down"); }, read: async () => [], verifyChain: async () => ({ ok: false, events: 0 }) };
    const r = await runSignalPipeline(input("up", "audit", { audit: broken, notify: () => { notified++; } }));
    expect(r.status).toBe("inconclusive");
    expect(r.auditPersisted).toBe(false);
    expect(notified).toBe(0);
  });

  it("persistence: the decision read back from the store matches the returned result, and a repeat is a no-op duplicate", async () => {
    const i = input("up", "persist");
    const a = await runSignalPipeline(i);
    const stored = await i.audit!.read(a.correlationId);
    expect(stored.map((e) => e.rowHash)).toEqual(a.events.map((e) => e.rowHash));
    const b = await runSignalPipeline(i);
    expect(b.duplicate).toBe(true);
    expect(await i.audit!.read(a.correlationId)).toHaveLength(stored.length);
  });
});
