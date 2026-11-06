import { describe, expect, it } from "vitest";
import { approvalRoom, tallyVotes } from "../orchestrator/approval";
import { callEliteLLM } from "../orchestrator/eliteLlm";
import { deltaForceVote } from "../orchestrator/deltaAgent";
import { eliteHeuristic } from "../orchestrator/eliteHeuristic";
import { evaluateEliteCouncil } from "../orchestrator/elite";
import { PIPELINE_STATES, runSignalPipeline } from "../orchestrator/machine";
import { dataRoom, errorDetectionRoom, riskRoom, type AgentVote } from "../orchestrator/rooms";
import type { ElitePayload } from "../types/advanced";
import { H, NOW, agent, baseInput, longSetup, rangeOf, retime, shortSetup, trendOf } from "./fixtures/governanceFixtures";
import { trendSeries } from "./fixtures/advancedFixtures";

const vote = (agentId: string, verdict: AgentVote["verdict"], weight = 1, group = agentId.slice(0, 1)): AgentVote => ({ agentId, group, verdict, confidence: 0.6, weight, reason: "t" });
const passPayload: ElitePayload = { symbol: "BTCUSDT", dataStale: false, rr: 2, riskRoom: "PASS", proposedAction: "LONG", trend: trendOf("ULTRA_TREND", "BULLISH"), freshnessRatio: 0.5 };

describe("Elite Council deterministic fallback", () => {
  it("Delta Force CONFLICT -> NO_TRADE even with Risk Room PASS", () => {
    expect(eliteHeuristic({ ...passPayload, trend: trendOf("CONFLICT") }).action).toBe("NO_TRADE");
  });
  it("RANGE_TOO_TIGHT -> NO_TRADE", () => {
    expect(eliteHeuristic({ ...passPayload, trend: undefined, range: rangeOf("RANGE_TOO_TIGHT") }).action).toBe("NO_TRADE");
  });
  it("borderline R:R (1.7) or borderline freshness -> NO_TRADE", () => {
    expect(eliteHeuristic({ ...passPayload, rr: 1.7 }).action).toBe("NO_TRADE");
    expect(eliteHeuristic({ ...passPayload, freshnessRatio: 0.9 }).action).toBe("NO_TRADE");
  });
  it("Risk Room must be strictly PASS (HALT, ESCALATE, missing -> NO_TRADE)", () => {
    expect(eliteHeuristic({ ...passPayload, riskRoom: "HALT" }).action).toBe("NO_TRADE");
    expect(eliteHeuristic({ ...passPayload, riskRoom: "ESCALATE" }).action).toBe("NO_TRADE");
    expect(eliteHeuristic({ ...passPayload, riskRoom: undefined }).action).toBe("NO_TRADE");
  });
  it("no candidate direction, or Delta Force pointing the other way -> NO_TRADE", () => {
    expect(eliteHeuristic({ ...passPayload, proposedAction: undefined }).action).toBe("NO_TRADE");
    expect(eliteHeuristic({ ...passPayload, proposedAction: "SHORT" }).action).toBe("NO_TRADE");
  });
  it("Risk Room PASS + clean data + aligned Delta Force -> candidate direction", () => {
    const out = eliteHeuristic(passPayload);
    expect(out.action).toBe("LONG");
    expect(out.reasoning.length).toBeLessThanOrEqual(200);
  });
  it("is deterministic and goes through the real evaluateEliteCouncil (no mock)", async () => {
    expect(eliteHeuristic(passPayload)).toEqual(eliteHeuristic(passPayload));
    expect((await evaluateEliteCouncil(passPayload)).action).toBe("LONG");
    expect((await evaluateEliteCouncil({ ...passPayload, trend: trendOf("CONFLICT") })).action).toBe("NO_TRADE");
    expect((await evaluateEliteCouncil({ ...passPayload, rr: 1.2 })).action).toBe("NO_TRADE"); // hard gate still first
  });
  it("callEliteLLM honours an already aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    let rejected = false;
    await callEliteLLM(passPayload, c.signal).catch(() => { rejected = true; });
    expect(rejected).toBe(true);
  });
});

describe("Delta Force as an agent", () => {
  it("ULTRA_TREND carries weight 3, every other verdict weight 1", () => {
    const up = deltaForceVote(trendOf("ULTRA_TREND", "BULLISH"));
    expect(up.verdict).toBe("bullish");
    expect(up.weight).toBe(3);
    expect(deltaForceVote(trendOf("ULTRA_TREND", "BEARISH")).verdict).toBe("bearish");
    expect(deltaForceVote(trendOf("WEAK_TREND")).weight).toBe(1);
    expect(deltaForceVote(trendOf("CONFLICT")).verdict).toBe("neutral");
  });
  it("weight 3 changes the outcome of the weighted tally", () => {
    const rest = [vote("A1", "bearish"), vote("A2", "bearish"), vote("A3", "bearish"), vote("A4", "bullish")];
    expect(tallyVotes([{ ...vote("DELTA_FORCE", "bullish"), weight: 3 }, ...rest]).leading).toBe("bullish"); // 4 vs 3
    expect(tallyVotes([vote("DELTA_FORCE", "bullish"), ...rest]).leading).toBe("bearish"); // 2 vs 3
  });
  it("RANGE_DETECTED is routed to Range Mode, not ABSTAIN", () => {
    expect(deltaForceVote(trendOf("RANGE_DETECTED"), rangeOf("RANGE_SHORT")).verdict).toBe("bearish");
    expect(deltaForceVote(trendOf("RANGE_DETECTED"), rangeOf("RANGE_LONG")).verdict).toBe("bullish");
    expect(deltaForceVote(trendOf("RANGE_DETECTED"), rangeOf("RANGE_TOO_TIGHT")).verdict).toBe("abstain");
    expect(deltaForceVote(trendOf("RANGE_DETECTED")).verdict).toBe("abstain"); // range not evaluated
  });
});

describe("Rooms (pure rules)", () => {
  const candles = retime(trendSeries(100, H, 100, 1), H);
  it("Data Room: stale -> HALT, duplicate -> HALT, gap > 5% -> HALT, fallback source -> flag only", () => {
    expect(dataRoom({ candles, timeframeMs: H, now: NOW }).status).toBe("PASS");
    expect(dataRoom({ candles, timeframeMs: H, now: NOW + 3 * H }).reason).toBe("DATA_STALE");
    expect(dataRoom({ candles: [...candles, candles[candles.length - 1]], timeframeMs: H, now: NOW }).reason).toBe("DUPLICATE_DATA");
    expect(dataRoom({ candles: candles.filter((_, i) => i % 10 !== 5 || i === 0), timeframeMs: H, now: NOW }).reason).toBe("DATA_GAP");
    const fb = dataRoom({ candles, timeframeMs: H, now: NOW, source: "yahoo", primarySource: "coingecko" });
    expect(fb.status).toBe("PASS");
    expect(fb.flags).toEqual(["FALLBACK_SOURCE"]);
    expect(dataRoom({ candles: [], timeframeMs: H, now: NOW }).status).toBe("HALT");
  });
  it("Error Detection Room: volume 0 -> HALT; same-group contradiction in 2 groups -> HALT", () => {
    expect(errorDetectionRoom([], { ...candles[0], volume: 0 }).reason).toContain("SUSPICIOUS_DATA");
    const two = [vote("A1", "bullish"), vote("A2", "bearish"), vote("B1", "bullish"), vote("B2", "bearish")];
    expect(errorDetectionRoom(two).status).toBe("HALT");
    expect(errorDetectionRoom(two.slice(0, 2)).status).toBe("PASS"); // only one group contradicts
  });
  it("Risk Room: R:R < 1.5, invalidation too far / too tight, leverage, funding flag", () => {
    const ok = { direction: "long" as const, market: "spot" as const, entry: 100, invalidation: 98, targets: [104], atr: 1.5 };
    expect(riskRoom(ok).status).toBe("PASS");
    expect(riskRoom({ ...ok, targets: [102] }).reason).toBe("RISK_REJECT"); // R:R 1
    expect(riskRoom({ ...ok, invalidation: 94, targets: [112] }).reason).toBe("INVALIDATION_TOO_FAR"); // 4 ATR
    expect(riskRoom({ ...ok, invalidation: 99.5, targets: [101] }).reason).toBe("INVALIDATION_TOO_TIGHT"); // 0.33 ATR
    expect(riskRoom({ ...ok, invalidation: 102 }).reason).toContain("RISK_REJECT"); // wrong side
    const fut = { ...ok, market: "futures" as const };
    expect(riskRoom({ ...fut, liquidationDistance: 3 }).reason).toBe("LEVERAGE_TOO_HIGH"); // < 2 x 2
    expect(riskRoom(fut).status).toBe("ESCALATE");
    const p = riskRoom({ ...fut, liquidationDistance: 10, fundingRate: 0.001 });
    expect(p.status).toBe("PASS");
    expect(p.flags).toEqual(["FUNDING_RISK"]);
  });
});

describe("Approval Room + Elite trigger (dissent > 30%)", () => {
  const ctx = (log: number[], action: "LONG" | "SHORT" | "NO_TRADE" = "LONG") => ({
    setupDirection: "bullish" as const,
    consultElite: async (_c: "LONG" | "SHORT", d: number) => { log.push(d); return { action, reasoning: "stub", confidence: 0.5 }; },
  });
  const unanimous = [vote("A1", "bullish"), vote("A2", "bullish"), vote("B1", "bullish"), vote("B2", "bullish"), vote("C1", "bullish")];

  it("dissent <= 30%: no Elite call, APPROVED", async () => {
    const log: number[] = [];
    const d = await approvalRoom(unanimous, ctx(log));
    expect(d.status).toBe("APPROVED");
    expect(d.eliteTriggered).toBe(false);
    expect(log).toHaveLength(0);
  });
  it("dissent > 30%: Elite is consulted; NO_TRADE -> INCONCLUSIVE", async () => {
    const log: number[] = [];
    const votes = [...unanimous.slice(0, 4), vote("C1", "bearish")]; // 4/5 -> dissent 20%
    expect((await approvalRoom(votes, ctx(log))).eliteTriggered).toBe(false);
    const more = [...unanimous.slice(0, 4), vote("C1", "neutral"), vote("C2", "bearish")]; // 4/6 -> dissent 33%
    const d = await approvalRoom(more, ctx(log, "NO_TRADE"));
    expect(d.eliteTriggered).toBe(true);
    expect(d.haltReason).toBe("ELITE_NO_TRADE");
    expect(d.status).toBe("INCONCLUSIVE");
    expect(log).toHaveLength(1);
  });
  it("Elite confirmation lets a non-deadlocked 62% majority through", async () => {
    const votes = [vote("A1", "bullish", 3), vote("A2", "bullish"), vote("B1", "bullish"), vote("C1", "neutral"), vote("C2", "neutral"), vote("C3", "neutral")]; // 5/8
    const d = await approvalRoom(votes, ctx([]));
    expect(d.eliteTriggered).toBe(true);
    expect(d.status).toBe("APPROVED");
  });
  it("hard deadlock (both sides >= 30%) is never approved, even if Elite says LONG", async () => {
    const votes = [vote("A1", "bullish", 3), vote("B1", "bullish"), vote("C1", "bearish"), vote("D1", "bearish"), vote("E1", "bearish")]; // 4 vs 3
    expect((await approvalRoom(votes, ctx([]))).haltReason).toBe("GROUP_DEADLOCK");
  });
  it("Elite disagreeing with the leading direction -> INCONCLUSIVE", async () => {
    const votes = [vote("A1", "bullish", 3), vote("A2", "bullish"), vote("B1", "bullish"), vote("C1", "neutral"), vote("C2", "neutral"), vote("C3", "neutral")];
    expect((await approvalRoom(votes, ctx([], "SHORT"))).haltReason).toBe("ELITE_DISAGREES");
  });
  it("too few valid votes, tie, and setup/vote direction mismatch -> INCONCLUSIVE", async () => {
    expect((await approvalRoom(unanimous.slice(0, 4), ctx([]))).haltReason).toBe("INSUFFICIENT_VOTES");
    expect((await approvalRoom([...unanimous.slice(0, 3), vote("X1", "bearish"), vote("X2", "bearish"), vote("X3", "bearish")], ctx([]))).haltReason).toBe("NO_CONSENSUS");
    expect((await approvalRoom(unanimous, { ...ctx([]), setupDirection: "bearish" })).haltReason).toBe("DIRECTION_MISMATCH");
  });
});

describe("8-state orchestrator (Phase D wiring)", () => {
  const bulls = [agent("A1", "bullish"), agent("A2", "bullish"), agent("B1", "bullish"), agent("C1", "bullish")];

  it("ULTRA_TREND: Delta Force is a weight-3 agent and the signal is approved through all states", async () => {
    const r = await runSignalPipeline(baseInput("up", bulls));
    expect(r.trend?.verdict).toBe("ULTRA_TREND");
    expect(r.votes[0].agentId).toBe("DELTA_FORCE");
    expect(r.votes[0].weight).toBe(3);
    expect(r.status).toBe("approved");
    expect(r.mode).toBe("trend");
    expect(r.statesVisited).toEqual([...PIPELINE_STATES]);
    expect(new Set(r.events.map((a) => a.idempotencyKey)).size).toBe(r.events.length);
    expect(r.verifier?.status).toBe("OK");
    expect(r.events[r.events.length - 1].kind).toBe("STATE_TRANSITION");
    expect(r.notified).toBe(false); // no notifier injected: skipped, not faked
  });
  it("calls the notifier only for approved signals", async () => {
    let calls = 0;
    const ok = await runSignalPipeline({ ...baseInput("up", bulls), notify: () => { calls++; } });
    expect(ok.notified).toBe(true);
    const bad = await runSignalPipeline({ ...baseInput("up", bulls, { ...longSetup, targets: [101] }), notify: () => { calls++; } });
    expect(bad.status).toBe("rejected");
    expect(calls).toBe(1);
  });
  it("RANGE_DETECTED is routed to Range Mode; a hand-made Setup that is not the DeltaRange output is rejected before any agent runs (P4)", async () => {
    const bears = [agent("A1", "bearish"), agent("A2", "bearish"), agent("B1", "bearish"), agent("C1", "bearish")];
    const r = await runSignalPipeline(baseInput("range", bears, shortSetup));
    expect(r.trend?.verdict).toBe("RANGE_DETECTED");
    expect(r.range?.verdict).toBe("RANGE_SHORT");
    expect(r.mode).toBe("range");
    expect(r.direction).toBe("short");
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("RANGE_SETUP_MISMATCH");
    expect(r.votes.length).toBe(0);
    expect(r.statesVisited).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "RECORDED"]);
  });
  it("Delta Force CONFLICT halts at RECONCILED (CONTRADICTION_INDICATORS): never reaches the approval vote", async () => {
    const mix = [agent("A1", "bullish"), agent("A2", "bullish"), agent("B1", "bullish"), agent("C1", "bullish"), agent("D1", "bearish")];
    const r = await runSignalPipeline(baseInput("conflict", mix));
    expect(r.trend?.verdict).toBe("CONFLICT");
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("CONTRADICTION_INDICATORS");
    expect(r.approval).toBeUndefined();
    expect(r.statesVisited).toEqual(["DETECTED", "DATA_VALIDATED", "INDICATORS_READY", "AGENTS_RUN", "RECONCILED", "RECORDED"]);
  });
  it("dissent > 30% with ULTRA_TREND and Risk Room PASS: Elite confirms and the signal is approved", async () => {
    const dissent = [agent("A1", "bullish"), agent("A2", "bullish"), agent("C1", "neutral"), agent("C2", "neutral"), agent("C3", "neutral")];
    const r = await runSignalPipeline(baseInput("up", dissent)); // bullish 5 of 8 = 62.5%, dissent 37.5%
    expect(r.approval?.eliteTriggered).toBe(true);
    expect(r.approval?.elite?.action).toBe("LONG");
    expect(r.status).toBe("approved");
  });
  it("Risk Room HALT -> rejected and the machine jumps to RECORDED", async () => {
    const r = await runSignalPipeline(baseInput("up", bulls, { ...longSetup, targets: [101] }));
    expect(r.status).toBe("rejected");
    expect(r.haltReason).toBe("RISK_REJECT");
    expect(r.statesVisited[r.statesVisited.length - 1]).toBe("RECORDED");
    expect(r.statesVisited).not.toContain("GATED");
  });
  it("stale data -> inconclusive at DATA_VALIDATED", async () => {
    const r = await runSignalPipeline({ ...baseInput("up", bulls), now: NOW + 10 * H });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("DATA_STALE");
    expect(r.statesVisited).toEqual(["DETECTED", "DATA_VALIDATED", "RECORDED"]);
  });
  it("an exception inside the pipeline is recorded as inconclusive, never thrown", async () => {
    const boom = (): AgentVote => { throw new Error("agent exploded"); };
    const r = await runSignalPipeline(baseInput("up", [boom]));
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason).toContain("AGENT_FAILURE");
  });
  it("is reproducible: same input -> same audit hash chain", async () => {
    const a = await runSignalPipeline(baseInput("up", bulls));
    const b = await runSignalPipeline(baseInput("up", bulls));
    expect(a.events.map((x) => x.rowHash)).toEqual(b.events.map((x) => x.rowHash));
  });
});
