import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { bollingerSeries } from "@contracts/indicators";
import * as engine from "../engines/indicators";
import { approvalConfigFrom, approvalRoom } from "../orchestrator/approval";
import { AuditSequenceError, GENESIS_HASH, InMemoryAuditStore, canonical, recoverInterrupted, verifyChainOf, type AuditEvent, type AuditStore, type StoredAuditEvent } from "../orchestrator/audit";
import { chartQualityRoom } from "../orchestrator/chartQuality";
import { DEFAULT_GOVERNANCE_CONFIG, GOVERNANCE_CONFIG_VERSION, GovernanceConfigError, PARAM_SPECS, loadGovernanceConfig } from "../orchestrator/config";
import { ALLOWED_TRANSITIONS, PIPELINE_STATES, isAllowedTransition, runSignalPipeline, type PipelineInput, type PipelineState } from "../orchestrator/machine";
import { riskRoom, type AgentVote } from "../orchestrator/rooms";
import { independentVerifier } from "../orchestrator/verifier";
import { NOW, agent, baseInput } from "./fixtures/governanceFixtures";
import { retimeTo, sidewaysSeries } from "./fixtures/scenarioFixtures";

const bulls = [agent("A1", "bullish"), agent("A2", "bullish"), agent("B1", "bullish"), agent("C1", "bullish")];
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return null; };
const decisionsOf = (events: StoredAuditEvent[]): StoredAuditEvent[] => events.filter((e) => e.kind === "DECISION");

// ───────────────────────────── Phase 1: state machine ─────────────────────────────
describe("Phase 1 - state machine transitions", () => {
  it("every state is declared and every target is a declared state", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS)).toEqual([...PIPELINE_STATES]);
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) for (const t of targets) expect(PIPELINE_STATES.includes(t)).toBe(true);
  });
  it("exhaustive matrix: allowed iff forward by one step or a jump to RECORDED from a state before it", () => {
    const idx = (s: PipelineState): number => PIPELINE_STATES.indexOf(s);
    for (const from of PIPELINE_STATES) {
      for (const to of PIPELINE_STATES) {
        const expected = to === PIPELINE_STATES[idx(from) + 1] || (to === "RECORDED" && idx(from) < idx("RECORDED"));
        expect(isAllowedTransition(from, to)).toBe(expected);
      }
    }
  });
  it("forbidden: skipping, going back, re-entering, leaving NOTIFIED, entering anything but DETECTED first", () => {
    expect(isAllowedTransition("DATA_VALIDATED", "GATED")).toBe(false); // skip
    expect(isAllowedTransition("RISK_CHECKED", "AGENTS_RUN")).toBe(false); // back
    expect(isAllowedTransition("GATED", "GATED")).toBe(false); // re-enter
    expect(isAllowedTransition("RECORDED", "RECORDED")).toBe(false);
    expect(isAllowedTransition("RECORDED", "GATED")).toBe(false);
    expect(isAllowedTransition("NOTIFIED", "DETECTED")).toBe(false);
    expect(ALLOWED_TRANSITIONS.NOTIFIED).toEqual([]);
    expect(isAllowedTransition(null, "DETECTED")).toBe(true);
    for (const s of PIPELINE_STATES) if (s !== "DETECTED") expect(isAllowedTransition(null, s)).toBe(false);
    expect(isAllowedTransition("GATED", "NOTIFIED")).toBe(false); // approval must pass through RECORDED
  });
  it("every recorded run only ever follows allowed transitions", async () => {
    const approved = await runSignalPipeline(baseInput("up", bulls));
    const stale = await runSignalPipeline({ ...baseInput("up", bulls), now: NOW + 10 * 3_600_000 });
    for (const r of [approved, stale]) {
      const states = r.events.filter((e) => e.kind === "STATE_TRANSITION").map((e) => e.state as PipelineState);
      states.forEach((s, i) => expect(isAllowedTransition(i === 0 ? null : states[i - 1], s)).toBe(true));
    }
  });
});

describe("Phase 1 - invalid data can never lead to approval", () => {
  const mutate = (f: (i: PipelineInput) => PipelineInput): PipelineInput => f(baseInput("up", bulls));
  const cases: [string, (i: PipelineInput) => PipelineInput][] = [
    ["stale data", (i) => ({ ...i, now: NOW + 10 * 3_600_000 })],
    ["empty 1H series", (i) => ({ ...i, candles: { ...i.candles, "1H": [] } })],
    ["NaN close", (i) => ({ ...i, candles: { ...i.candles, "1H": i.candles["1H"].map((c, k, a) => (k === a.length - 1 ? { ...c, close: NaN } : c)) } })],
    ["high below low", (i) => ({ ...i, candles: { ...i.candles, "1H": i.candles["1H"].map((c, k, a) => (k === a.length - 5 ? { ...c, high: c.low - 1 } : c)) } })],
    ["negative volume", (i) => ({ ...i, candles: { ...i.candles, "1H": i.candles["1H"].map((c, k, a) => (k === a.length - 5 ? { ...c, volume: -1 } : c)) } })],
    ["duplicate candle", (i) => ({ ...i, candles: { ...i.candles, "1H": i.candles["1H"].map((c, k, a) => (k === a.length - 2 ? { ...a[a.length - 3] } : c)) } })],
    ["gap in history", (i) => ({ ...i, candles: { ...i.candles, "1H": [...i.candles["1H"].slice(0, 100), ...i.candles["1H"].slice(140)] } })],
    ["future candle", (i) => ({ ...i, now: NOW - 5 * 3_600_000 })],
    ["missing timeframe", (i) => ({ ...i, candles: { ...i.candles, "15m": undefined as never } })],
    ["NaN entry", (i) => ({ ...i, setup: { ...i.setup, entry: NaN } })],
    ["no targets", (i) => ({ ...i, setup: { ...i.setup, targets: [] } })],
    ["Infinity invalidation", (i) => ({ ...i, setup: { ...i.setup, invalidation: Infinity } })],
    ["setup missing entirely", (i) => ({ ...i, setup: undefined as never })],
    ["agent throws", (i) => ({ ...i, agents: [() => { throw new Error("boom"); }] })],
    ["too few valid votes", (i) => ({ ...i, agents: [agent("A1", "bullish")] })],
    ["agents disagree", (i) => ({ ...i, agents: [agent("A1", "bullish"), agent("B1", "bearish"), agent("C1", "bearish"), agent("D1", "bearish")] })],
    ["verifier veto (stop inside structure)", (i) => ({ ...i, setup: { ...i.setup, invalidation: i.setup.entry - 0.6 * i.setup.atr, targets: [i.setup.entry + 1.5 * i.setup.atr] } })],
  ];
  it("control: the unmodified input IS approved (so the matrix below is not vacuous)", async () => {
    expect((await runSignalPipeline(baseInput("up", bulls))).status).toBe("approved");
  });
  for (const [name, f] of cases) {
    it(`${name} -> never approved, one non-approved DECISION recorded`, async () => {
      let notified = 0;
      const r = await runSignalPipeline({ ...mutate(f), notify: () => { notified++; } });
      expect(r.status).not.toBe("approved");
      expect(notified).toBe(0);
      expect(decisionsOf(r.events)).toHaveLength(1);
      expect(decisionsOf(r.events)[0].decision).not.toBe("approved");
      expect(r.statesVisited).not.toContain("NOTIFIED");
    });
  }
  it("audit store failure -> never approved, never notified", async () => {
    const broken: AuditStore = { append: async () => { throw new Error("disk full"); }, read: async () => [], verifyChain: async () => ({ ok: true, events: 0 }) };
    let notified = 0;
    const r = await runSignalPipeline({ ...baseInput("up", bulls), audit: broken, notify: () => { notified++; } });
    expect(r.status).toBe("inconclusive");
    expect(r.auditPersisted).toBe(false);
    expect(notified).toBe(0);
  });
  it("audit store that fails only on the DECISION write -> never approved", async () => {
    const inner = new InMemoryAuditStore();
    const flaky: AuditStore = { ...inner, read: (c) => inner.read(c), verifyChain: (c) => inner.verifyChain(c), append: async (e) => { if (e.kind === "DECISION") throw new Error("write refused"); return inner.append(e); } };
    let notified = 0;
    const r = await runSignalPipeline({ ...baseInput("up", bulls), audit: flaky, notify: () => { notified++; } });
    expect(r.status).toBe("inconclusive");
    expect(notified).toBe(0);
  });
});

describe("Phase 1 - concurrency, duplicates, idempotency, interruption", () => {
  it("5 concurrent identical requests: exactly one decision, one notification, a valid chain", async () => {
    const store = new InMemoryAuditStore();
    let notified = 0;
    const input = { ...baseInput("up", bulls), audit: store, notify: () => { notified++; } };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => runSignalPipeline(input)));
    const id = results[0].correlationId;
    const events = await store.read(id);
    expect(decisionsOf(events)).toHaveLength(1);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(events.length);
    expect(notified).toBe(1);
    expect((await store.verifyChain(id)).ok).toBe(true);
    for (const r of results) expect(r.status).toBe("approved");
  });
  it("sequential duplicate request: not re-executed, no new events, no second notification", async () => {
    const store = new InMemoryAuditStore();
    let notified = 0;
    const input = { ...baseInput("up", bulls), audit: store, notify: () => { notified++; } };
    const first = await runSignalPipeline(input);
    const before = (await store.read(first.correlationId)).length;
    const second = await runSignalPipeline(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.status).toBe(first.status);
    expect((await store.read(first.correlationId)).length).toBe(before);
    expect(notified).toBe(1);
  });
  it("process interruption: a run that died mid-way is finalized INCONCLUSIVE exactly once, never approved", async () => {
    const inner = new InMemoryAuditStore();
    let writes = 0;
    const dying: AuditStore = { read: (c) => inner.read(c), verifyChain: (c) => inner.verifyChain(c), append: async (e) => { if (++writes > 4) throw new Error("process killed"); return inner.append(e); } };
    const crashed = await runSignalPipeline({ ...baseInput("up", bulls), audit: dying });
    expect(crashed.status).not.toBe("approved");
    const id = crashed.correlationId;
    expect(decisionsOf(await inner.read(id))).toHaveLength(0); // the crash left no decision behind

    const recovered = await runSignalPipeline({ ...baseInput("up", bulls), audit: inner });
    expect(recovered.duplicate).toBe(true);
    expect(recovered.status).toBe("inconclusive");
    expect(recovered.haltReason).toBe("PROCESS_INTERRUPTED");
    expect(decisionsOf(await inner.read(id))).toHaveLength(1);
    await runSignalPipeline({ ...baseInput("up", bulls), audit: inner }); // repeating must not add another
    expect(decisionsOf(await inner.read(id))).toHaveLength(1);
    expect((await inner.verifyChain(id)).ok).toBe(true);
    expect(await recoverInterrupted(inner, id, NOW)).toBe("COMPLETE");
    expect(await recoverInterrupted(inner, "unknown-id", NOW)).toBe("NOTHING");
  });
});

// ───────────────────────────── Phase 2: parameter governance ─────────────────────────────
describe("Phase 2 - parameter governance", () => {
  it("default config is versioned, fingerprinted and frozen", () => {
    expect(DEFAULT_GOVERNANCE_CONFIG.version).toBe(GOVERNANCE_CONFIG_VERSION);
    expect(DEFAULT_GOVERNANCE_CONFIG.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(loadGovernanceConfig().fingerprint).toBe(DEFAULT_GOVERNANCE_CONFIG.fingerprint);
    expect(thrown(() => { (DEFAULT_GOVERNANCE_CONFIG.values as { minRr: number }).minRr = 99; })).not.toBeNull();
    expect(DEFAULT_GOVERNANCE_CONFIG.values.minRr).toBe(1.5);
  });
  it("every parameter is classified, sourced and justified; the three non-PDF thresholds are PROPOSED", () => {
    for (const [key, spec] of Object.entries(PARAM_SPECS)) {
      expect(["REFERENCE", "EMPIRICAL", "PROPOSED"].includes(spec.class)).toBe(true);
      expect(spec.source.length).toBeGreaterThan(0);
      expect(spec.rationale.length).toBeGreaterThan(0);
      expect(spec.min <= spec.value && spec.value <= spec.max).toBe(true);
      void key;
    }
    expect(PARAM_SPECS.borderlineRr.class).toBe("PROPOSED");
    expect(PARAM_SPECS.borderlineFreshnessRatio.class).toBe("PROPOSED");
    expect(PARAM_SPECS.approvalThreshold.class).toBe("PROPOSED");
    expect(PARAM_SPECS.minRr.class).toBe("REFERENCE");
    // Nothing has been calibrated on data yet: claiming EMPIRICAL would be false.
    expect(Object.values(PARAM_SPECS).filter((s) => (s.class as string) === "EMPIRICAL")).toHaveLength(0);
  });
  it("invalid or missing values are rejected with GovernanceConfigError", () => {
    const bad: Record<string, unknown>[] = [
      { notAParam: 1 }, { minRr: NaN }, { minRr: Infinity }, { minRr: "1.5" }, { minRr: undefined }, { minRr: null }, { minRr: 0.5 }, { approvalThreshold: 1.5 },
      { invalidationMinAtr: 3, invalidationMaxAtr: 2 }, { borderlineRr: 1.5, minRr: 2 },
    ];
    for (const o of bad) expect(thrown(() => loadGovernanceConfig(o)) instanceof GovernanceConfigError).toBe(true);
  });
  it("overrides are recorded, change the fingerprint and flow into the rooms", async () => {
    const strict = loadGovernanceConfig({ minRr: 3, borderlineRr: 3.5 });
    expect([...strict.overridden].sort()).toEqual(["borderlineRr", "minRr"]);
    expect(strict.fingerprint).not.toBe(DEFAULT_GOVERNANCE_CONFIG.fingerprint);
    const setup = { direction: "long" as const, market: "spot" as const, entry: 100, invalidation: 98, targets: [104], atr: 1.5 }; // R:R 2
    expect(riskRoom(setup).status).toBe("PASS");
    expect(riskRoom(setup, strict).reason).toBe("RISK_REJECT");
    const votes: AgentVote[] = ["A1", "A2", "B1", "B2", "C1"].map((id) => ({ agentId: id, group: id[0], verdict: "bullish", confidence: 1, weight: 1, reason: "t" }));
    const ctx = { setupDirection: "bullish" as const, consultElite: async () => ({ action: "LONG" as const, reasoning: "x", confidence: 1 }) };
    expect((await approvalRoom(votes, ctx, approvalConfigFrom(DEFAULT_GOVERNANCE_CONFIG))).status).toBe("APPROVED");
    const needs = loadGovernanceConfig({ minValidVotes: 6 });
    expect((await approvalRoom(votes, ctx, approvalConfigFrom(needs))).haltReason).toBe("INSUFFICIENT_VOTES");
    const r = await runSignalPipeline({ ...baseInput("up", bulls), config: needs });
    expect(r.status).toBe("inconclusive"); // 5 valid votes (Delta + 4) < 6
    expect(r.events[0].configFingerprint).toBe(needs.fingerprint);
  });
});

// ───────────────────────────── Phase 3: Independent Verifier ─────────────────────────────
describe("Phase 3 - Independent Verifier", () => {
  const input = baseInput("up", bulls);
  const c1 = input.candles["1H"];
  const s = input.setup;
  const cand = (o: Partial<{ direction: "long" | "short"; entry: number; invalidation: number; targets: number[] }> = {}) => ({ direction: "long" as const, market: "spot" as const, entry: s.entry, invalidation: s.invalidation, targets: s.targets, ...o });
  const reasons = (c: Candle[], k: ReturnType<typeof cand>): string => independentVerifier(c, k).reasons.join("|");

  it("accepts a coherent setup and reports its own metrics", () => {
    const v = independentVerifier(c1, cand());
    expect(v.status).toBe("OK");
    expect(v.metrics.netRr as number).toBeGreaterThan(1.5);
    expect(v.metrics.swing as number).toBeLessThan(s.entry);
  });
  it("VETO: stop inside the structure", () => { expect(reasons(c1, cand({ invalidation: s.entry - 0.6 * s.atr }))).toContain("INVALIDATION_INSIDE_STRUCTURE"); });
  it("VETO: stop too far / too tight", () => {
    expect(reasons(c1, cand({ invalidation: s.entry - 6 * s.atr }))).toContain("INVALIDATION_TOO_FAR");
    expect(reasons(c1, cand({ invalidation: s.entry - 0.1 * s.atr }))).toContain("INVALIDATION_TOO_TIGHT");
  });
  it("VETO: wrong side, unordered targets, unrealistic target, entry away from market", () => {
    expect(reasons(c1, cand({ invalidation: s.entry + 1 }))).toContain("WRONG_SIDE");
    expect(reasons(c1, cand({ targets: [s.targets[1], s.targets[0]] }))).toContain("TARGETS_NOT_ORDERED");
    expect(reasons(c1, cand({ targets: [s.entry + 30 * s.atr] }))).toContain("TARGET_UNREALISTIC");
    expect(reasons(c1, cand({ entry: s.entry + 5 * s.atr }))).toContain("ENTRY_NOT_NEAR_MARKET");
  });
  it("VETO: net R:R after fees and slippage is below the floor even if the gross R:R looks fine", () => {
    const risk = s.entry - s.invalidation;
    const v = independentVerifier(c1, cand({ targets: [s.entry + 1.6 * risk] })); // gross 1.6 > 1.5, net lower
    expect(v.status).toBe("VETO");
    expect(v.reasons.join("|")).toContain("NET_RR_TOO_LOW");
    expect(v.metrics.costAbs as number).toBeGreaterThan(0);
  });
  it("VETO: no confirmed structure in the data (straight ramp)", () => {
    const ramp: Candle[] = Array.from({ length: 120 }, (_, i) => ({ time: i * 3_600_000, closeTime: i * 3_600_000 + 3_599_999, open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.8 + i, volume: 1000 }));
    const last = ramp[ramp.length - 1].close;
    expect(reasons(ramp, cand({ entry: last, invalidation: last - 2, targets: [last + 5] }))).toContain("NO_STRUCTURE_FOUND");
  });
  it("VETO (inconclusive input): too little history, corrupt raw data, invalid candidate", () => {
    expect(reasons(c1.slice(-30), cand())).toContain("INSUFFICIENT_HISTORY");
    expect(reasons(c1.map((c, i) => (i === 100 ? { ...c, close: NaN } : c)), cand())).toContain("INVALID_RAW_DATA");
    expect(reasons(c1, cand({ entry: NaN }))).toContain("INVALID_CANDIDATE");
    expect(reasons(c1, cand({ targets: [] }))).toContain("INVALID_CANDIDATE");
  });
  it("supports shorts symmetrically", () => {
    const sh = baseInput("conflict", bulls);
    const v = independentVerifier(sh.candles["1H"], { direction: "short", market: "spot", entry: sh.setup.entry, invalidation: sh.setup.invalidation, targets: sh.setup.targets });
    expect(v.status).toBe("OK");
  });
  it("is logically independent: it imports nothing from the indicator engine, rooms, approval or agents", () => {
    const src = readFileSync(fileURLToPath(new URL("../orchestrator/verifier.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1].split("/").pop()?.replace(/\.ts$/, ""));
    expect(imports.sort()).toEqual(["config", "types"]);
  });
  it("ABSOLUTE VETO: a structurally invalid setup is not approved even when every room and every vote approves", async () => {
    const bad = { ...baseInput("up", bulls), setup: { ...s, invalidation: s.entry - 0.6 * s.atr, targets: [s.entry + 1.5 * s.atr * 1.6] } };
    const r = await runSignalPipeline(bad);
    expect(r.rooms.every((x) => x.status === "PASS")).toBe(true);
    expect(r.approval?.status).toBe("APPROVED");
    expect(r.verifier?.status).toBe("VETO");
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("VERIFIER_VETO");
    expect(r.events.some((e) => e.kind === "VERIFIER_RESULT" && (e.verifierResult as { status: string }).status === "VETO")).toBe(true);
    expect(decisionsOf(r.events)[0].decision).toBe("inconclusive");
  });
});

// ───────────────────────────── Phase 4: audit log ─────────────────────────────
describe("Phase 4 - append-only audit log (contract, in-memory implementation)", () => {
  const ev = (seq: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
    correlationId: "c1", seq, kind: "STATE_TRANSITION", state: "DETECTED", symbol: "BTCUSDT", timeframe: "1H", timestamp: NOW, inputDataHash: "h", dataFreshnessMs: 1, dataValid: true,
    roomVerdicts: {}, riskResult: null, verifierResult: null, decision: null, reason: null, configVersion: "v", configFingerprint: "f", idempotencyKey: `c1:${seq}`, detail: null, ...over,
  });
  it("append is exactly-once per idempotency key and never overwrites", async () => {
    const s = new InMemoryAuditStore();
    expect(await s.append(ev(0))).not.toBeNull();
    expect(await s.append(ev(0))).toBeNull(); // same key again: no-op
    const overwrite = await s.append(ev(0, { reason: "overwrite attempt", idempotencyKey: "other-key" })).catch((e: unknown) => e); // same seq, new key
    expect(overwrite).toBeInstanceOf(AuditSequenceError);
    const rows = await s.read("c1");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBeNull();
  });
  it("rejects sequence gaps", async () => {
    const s = new InMemoryAuditStore();
    await s.append(ev(0));
    expect(await s.append(ev(2)).catch((e) => e)).toBeInstanceOf(AuditSequenceError);
    expect((await s.read("c1")).length).toBe(1);
  });
  it("read returns copies: mutating them cannot change the stored log", async () => {
    const s = new InMemoryAuditStore();
    await s.append(ev(0));
    const copy = await s.read("c1");
    copy[0].reason = "tampered";
    copy.length = 0;
    expect((await s.read("c1"))[0].reason).toBeNull();
    expect((await s.verifyChain("c1")).ok).toBe(true);
  });
  it("hash chain detects tampering, deletion and reordering", async () => {
    const s = new InMemoryAuditStore();
    for (let i = 0; i < 4; i++) await s.append(ev(i));
    const rows = await s.read("c1");
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(verifyChainOf(rows).ok).toBe(true);
    const edited = rows.map((r, i) => (i === 1 ? { ...r, reason: "edited" } : r));
    expect(verifyChainOf(edited).ok).toBe(false);
    expect(verifyChainOf([rows[0], rows[2], rows[3]]).ok).toBe(false); // silent delete
    expect(verifyChainOf([rows[0], rows[2], rows[1], rows[3]]).ok).toBe(false); // reorder
    expect(verifyChainOf(rows.slice(0, 3)).ok).toBe(true); // truncation of the tail is visible only through the DECISION requirement
    expect(verifyChainOf(rows.slice(1)).ok).toBe(false); // missing head
  });
  it("canonical form is independent of key order", () => {
    expect(canonical({ a: 1, b: { c: 2, d: 3 } })).toBe(canonical({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("a full approved run records every required field, each event exactly once", async () => {
    const r = await runSignalPipeline({ ...baseInput("up", bulls), notify: () => undefined });
    const count = (k: string) => r.events.filter((e) => e.kind === k).length;
    expect(count("STATE_TRANSITION")).toBe(PIPELINE_STATES.length);
    expect(count("VERIFIER_RESULT")).toBe(1);
    expect(count("DECISION")).toBe(1);
    const rooms = r.events.filter((e) => e.kind === "ROOM_VERDICT").map((e) => (e.detail as { room: string }).room);
    expect(rooms).toEqual(["ERROR_DETECTION", "CHART_QUALITY", "RISK", "APPROVAL"]);
    expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
    expect(new Set(r.events.map((e) => e.idempotencyKey)).size).toBe(r.events.length);
    const d = decisionsOf(r.events)[0];
    expect(d.decision).toBe("approved");
    expect(d.symbol).toBe("BTCUSDT");
    expect(d.timeframe).toBe("1H");
    expect(d.timestamp).toBe(NOW);
    expect(d.inputDataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.dataValid).toBe(true);
    expect(typeof d.dataFreshnessMs).toBe("number");
    expect(d.riskResult).not.toBeNull();
    expect(d.verifierResult).not.toBeNull();
    expect(Object.keys(d.roomVerdicts).sort()).toEqual(["APPROVAL", "CHART_QUALITY", "DATA_15m", "DATA_1H", "DATA_4H", "DATA_5m", "ERROR_DETECTION", "RISK"]);
    expect(d.configVersion).toBe(GOVERNANCE_CONFIG_VERSION);
    expect(d.configFingerprint).toBe(DEFAULT_GOVERNANCE_CONFIG.fingerprint);
    expect(d.correlationId).toBe(r.correlationId);
    expect(verifyChainOf(r.events).ok).toBe(true);
  });
  it("a run halted early records only the events that really happened", async () => {
    const r = await runSignalPipeline({ ...baseInput("up", bulls), now: NOW + 10 * 3_600_000 });
    expect(r.events.filter((e) => e.kind === "VERIFIER_RESULT")).toHaveLength(0);
    expect(r.events.filter((e) => e.kind === "STATE_TRANSITION").map((e) => e.state)).toEqual(["DETECTED", "DATA_VALIDATED", "RECORDED"]);
    expect(decisionsOf(r.events)[0].dataValid).toBe(false);
  });
});

// ───────────────────────────── Phase 5: Bollinger + Chart Quality ─────────────────────────────
describe("Phase 5 - Bollinger Bands", () => {
  it("matches a hand-computed reference (population standard deviation)", () => {
    const b = bollingerSeries([1, 2, 3, 4, 5], 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect(b.mid.slice(0, 2)).toEqual([null, null]);
    expect(b.mid[2]).toBeCloseTo(2, 10);
    expect(b.upper[2] as number).toBeCloseTo(2 + 2 * sd, 10);
    expect(b.lower[4] as number).toBeCloseTo(4 - 2 * sd, 10);
  });
  it("period and multiplier are configurable; a constant series has zero width", () => {
    const a = bollingerSeries([1, 2, 3, 4, 5], 3, 1), c = bollingerSeries([1, 2, 3, 4, 5], 3, 3);
    expect((c.upper[3] as number) - (c.mid[3] as number)).toBeCloseTo(3 * ((a.upper[3] as number) - (a.mid[3] as number)), 10);
    const flat = bollingerSeries([7, 7, 7, 7], 2, 2);
    expect(flat.upper[3]).toBe(7);
    expect(flat.lower[3]).toBe(7);
  });
  it("is causal: changing future values never changes earlier bands", () => {
    const xs = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 10 + 100);
    const a = bollingerSeries(xs), b = bollingerSeries([...xs.slice(0, 30), ...xs.slice(30).map((x) => x + 50)]);
    expect(a.upper.slice(0, 30)).toEqual(b.upper.slice(0, 30));
  });
  it("rejects invalid parameters", () => {
    for (const [p, m] of [[1, 2], [0, 2], [2.5, 2], [20, 0], [20, -1], [20, NaN]] as const) expect(thrown(() => bollingerSeries([1, 2, 3], p, m)) instanceof RangeError).toBe(true);
  });
  it("is exported by the indicator engine without removing the existing indicators", () => {
    for (const name of ["emaSeries", "rsiSeries", "atrSeries", "adxSeries", "macdSeries", "macdHistogram", "vwapSeries", "sma", "swingLevels", "bollingerSeries"] as const) expect(typeof engine[name]).toBe("function");
    expect(engine.bollingerSeries).toBe(bollingerSeries);
  });
});

describe("Phase 5 - Chart Quality Room", () => {
  const room = (c: Candle[], claims = undefined as Parameters<typeof chartQualityRoom>[1], now = NOW) => chartQualityRoom(c, claims, now);
  const bars = retimeTo(sidewaysSeries(120, 3_600_000, 100, 5), 3_600_000, NOW);
  const peak = Math.max(...bars.map((c) => c.high));

  it("clean closed candles with no claims pass", () => { expect(room(bars).status).toBe("PASS"); });
  it("data integrity: non-monotonic time and an unclosed last candle escalate", () => {
    const swapped = bars.map((c, i) => (i === 50 ? { ...c, time: bars[10].time } : c));
    expect(room(swapped).reason).toContain("CANDLES_NOT_MONOTONIC");
    expect(room(bars, undefined, bars[bars.length - 1].closeTime).reason).toContain("UNCLOSED_LAST_CANDLE"); // now == closeTime: still open
    expect(room([]).reason).toBe("CHART_DATA_MISSING");
  });
  it("S/R: a level with >= 2 real touches passes; an invented level escalates", () => {
    expect(room(bars, { levels: [{ price: peak, kind: "resistance" }] }).status).toBe("PASS");
    const invented = room(bars, { levels: [{ price: peak * 1.2, kind: "resistance" }] });
    expect(invented.status).toBe("ESCALATE");
    expect(invented.reason).toContain("SR_UNSUPPORTED");
  });
  // Hand-built series: flat base with a swing high of 110 at index 20 (confirmed by 5 lower bars each side), then the test candle.
  const base = (): Candle[] => Array.from({ length: 40 }, (_, i) => ({ time: i * 3_600_000, closeTime: i * 3_600_000 + 3_599_999, open: 100, high: i === 20 ? 110 : 101, low: 99, close: 100, volume: 1000 }));
  const T = 40 * 3_600_000 + 3_600_000;
  it("BOS: a CLOSE beyond the swing confirms; a wick alone escalates", () => {
    const closeBreak = [...base(), { time: 40 * 3_600_000, closeTime: 41 * 3_600_000 - 1, open: 100, high: 113, low: 100, close: 112, volume: 1000 }];
    expect(room(closeBreak, { bos: [{ index: 40, direction: "up" }] }, T).status).toBe("PASS");
    const wickOnly = [...base(), { time: 40 * 3_600_000, closeTime: 41 * 3_600_000 - 1, open: 100, high: 113, low: 100, close: 105, volume: 1000 }];
    const w = room(wickOnly, { bos: [{ index: 40, direction: "up" }] }, T);
    expect(w.status).toBe("ESCALATE");
    expect(w.reason).toContain("BOS_ON_WICK");
  });
  it("BOS on a candle that is not closed yet escalates", () => {
    const open = [...base(), { time: 40 * 3_600_000, closeTime: 41 * 3_600_000 - 1, open: 100, high: 113, low: 100, close: 112, volume: 1000 }];
    expect(room(open, { bos: [{ index: 40, direction: "up" }] }, 40 * 3_600_000 + 1_000).reason).toContain("BOS_ON_UNCLOSED_CANDLE");
  });
  it("Sweep: needs wick > 0.3%, a close back inside and volume > 1.5x average", () => {
    const sweepBar = (volume: number, close: number, high = 111): Candle => ({ time: 40 * 3_600_000, closeTime: 41 * 3_600_000 - 1, open: 105, high, low: 104, close, volume });
    expect(room([...base(), sweepBar(2500, 108)], { sweeps: [{ index: 40, direction: "up" }] }, T).status).toBe("PASS");
    expect(room([...base(), sweepBar(1200, 108)], { sweeps: [{ index: 40, direction: "up" }] }, T).reason).toContain("SWEEP_WITHOUT_VOLUME");
    expect(room([...base(), sweepBar(2500, 112)], { sweeps: [{ index: 40, direction: "up" }] }, T).reason).toContain("SWEEP_INVALID"); // closed beyond: that is a breakout, not a sweep
    expect(room([...base(), sweepBar(2500, 108, 110.1)], { sweeps: [{ index: 40, direction: "up" }] }, T).reason).toContain("SWEEP_INVALID"); // wick 0.09% < 0.3%
  });
  it("a Chart Quality failure ends the pipeline as inconclusive, never approved", async () => {
    const i = baseInput("up", bulls);
    const r = await runSignalPipeline({ ...i, chart: { levels: [{ price: i.setup.entry * 3, kind: "resistance" }] } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("CHART_QUALITY_ESCALATE");
    expect(r.statesVisited).not.toContain("RISK_CHECKED");
  });
});
