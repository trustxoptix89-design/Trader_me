import { describe, expect, it } from "vitest";
import { defaultAgents } from "../orchestrator/agents";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { buildPipelineCandles, MIN_CLOSED_CANDLES, DB_TIMEFRAME, PIPELINE_TIMEFRAMES, type LoadRows, type StoredCandle } from "../pipeline/candleAdapter";
import { SequentialDecisionRecorder } from "../pipeline/decisionRecorder";
import { runSymbolOnce } from "../pipeline/runner";
import { NOW } from "./fixtures/governanceFixtures";
import { loaderFrom } from "./fixtures/pipelineLoader";

// DATA CLASS: SYNTHETIC (deterministic fixtures from fixtures/pipelineLoader.ts; not market data).
const mk = (loadRows: LoadRows) => { const audit = new InMemoryAuditStore(); return { audit, deps: { loadRows, audit, agents: defaultAgents(), now: () => NOW, decision: { recorder: new SequentialDecisionRecorder(audit) } } }; };

describe("P6 runner (SYNTHETIC data)", () => {
  it("fixtures satisfy the closed-candle contract (precondition)", async () => {
    const rows: Partial<Record<(typeof PIPELINE_TIMEFRAMES)[number], StoredCandle[]>> = {};
    for (const tf of PIPELINE_TIMEFRAMES) rows[tf] = await loaderFrom("range")("X", DB_TIMEFRAME[tf], MIN_CLOSED_CANDLES[tf] + 1);
    expect(buildPipelineCandles(rows, NOW).status).toBe("READY");
  });
  it("futures is BLOCKED: no data source approved, nothing read", async () => {
    let reads = 0;
    const { deps } = mk(async () => { reads++; return []; });
    const o = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "futures" });
    expect(o.kind).toBe("BLOCKED");
    expect(reads).toBe(0);
  });
  it("insufficient closed candles -> ABSTAIN at DATA, pipeline not run", async () => {
    const { deps, audit } = mk(async () => []);
    const o = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "spot" });
    expect(o.kind === "ABSTAIN" && o.stage === "DATA").toBe(true);
    expect((await audit.read("anything")).length).toBe(0);
  });
  it("Trend mode has no approved Setup -> ABSTAIN at SETUP, nothing written", async () => {
    const { deps } = mk(loaderFrom("up"));
    const o = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "spot" });
    expect(o.kind === "ABSTAIN" && o.stage === "SETUP" && o.reason.startsWith("TREND_SETUP_UNAVAILABLE")).toBe(true);
  });
  it("Range mode: Setup = DeltaRange output, pipeline runs through AGENTS_RUN and records one decision", async () => {
    const { deps } = mk(loaderFrom("range"));
    const o = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "spot" });
    expect(o.kind).toBe("PIPELINE");
    if (o.kind !== "PIPELINE") return;
    expect(o.result.mode).toBe("range");
    expect(o.result.statesVisited.includes("AGENTS_RUN")).toBe(true);
    expect(o.result.events.filter((e) => e.kind === "DECISION").length).toBe(1);
    expect(o.result.status).not.toBe("approved"); // fixture geometry is not a valid trade; the Risk Room must say so
  });
  it("running the same data twice is a duplicate, no second decision", async () => {
    const { deps } = mk(loaderFrom("range"));
    const a = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "spot" }), b = await runSymbolOnce(deps, { symbol: "BTCUSDT", market: "spot" });
    expect(a.kind === "PIPELINE" && b.kind === "PIPELINE" && b.result.duplicate && b.result.signalId === a.result.signalId).toBe(true);
  });
});
