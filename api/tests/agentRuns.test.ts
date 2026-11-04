import { describe, expect, it } from "vitest";
import { AGENT_TIMEFRAMES, AgentRunConflictError, CONFIDENCE_MEANING, InMemoryAgentRunStore, PostgresAgentRunStore, buildAgentRunRecords, evidenceRefsFor } from "../orchestrator/agentRuns";
import type { SqlExecutor } from "../orchestrator/audit.postgres";
import { loadAgentSpecs } from "../orchestrator/agentSpec";
import { defineAgentRunStoreContract, realCandles, realRecords, versions } from "./fixtures/agentRunContract";

describe("agent run records: builder (real BTCUSDT 1h candles as input, no database)", () => {
  it("builds one record per vote with the V6 fields, a deterministic key and traceable evidence refs", () => {
    const recs = realRecords("sig-1");
    expect(recs).toHaveLength(6);
    for (const r of recs) {
      expect(r.idempotencyKey).toBe(`sig-1:${r.agentId}`);
      expect(r.confidenceMeaning).toBe(CONFIDENCE_MEANING);
      expect(r.agentVersion).toBe(versions[r.agentId]);
      expect(r.findings.evidenceRefs[0]).toBe(`agent:${r.agentId}@${r.agentVersion}`);
      expect(r.findings.evidenceRefs[1]).toMatch(/^candles:1H:\d+\.\.\d+:n=999$/);
      expect(["OK", "ABSTAIN"]).toContain(r.validationOutcome);
    }
  });
  it("same inputs give identical records (deterministic); a different signal changes only the key", () => {
    expect(JSON.stringify(realRecords("a"))).toBe(JSON.stringify(realRecords("a")));
    expect(realRecords("a")[0].inputHash).toBe(realRecords("b")[0].inputHash);
    expect(realRecords("a")[0].idempotencyKey).not.toBe(realRecords("b")[0].idempotencyKey);
  });
  it("an agent without declared timeframes is refused instead of hashing a made-up input", () => {
    let msg = "";
    try { buildAgentRunRecords({ signalId: "s", runAt: 1, candles: {}, votes: [{ agentId: "ZZ_UNKNOWN", group: "A", verdict: "neutral", confidence: 0.5, weight: 1, reason: "r" }] }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no declared timeframes/);
  });
  it("a missing agent version is recorded as 'unspecified', never guessed", () => {
    const recs = buildAgentRunRecords({ signalId: "s", runAt: 1, candles: { "1H": realCandles }, votes: [{ agentId: "B11_MACD", group: "B", verdict: "neutral", confidence: 0.3, weight: 1, reason: "r" }] });
    expect(recs[0].agentVersion).toBe("unspecified");
  });
  it("AGENT_TIMEFRAMES covers exactly the runnable agents declared in /agents/*.yaml", () => {
    const root = new URL("../../agents", import.meta.url).pathname;
    const runnable = loadAgentSpecs(root).filter((s) => s.spec.implementation !== "stub").map((s) => s.spec.code_agent_id as string).sort();
    expect(Object.keys(AGENT_TIMEFRAMES).sort()).toEqual(runnable);
  });
  it("evidenceRefsFor handles an empty timeframe", () => {
    expect(evidenceRefsFor("A01_STRUCTURE", "1.0", { "1H": { count: 0, firstTime: null, lastTime: null } })[1]).toBe("candles:1H:none..none:n=0");
  });
});

defineAgentRunStoreContract("in-memory store, real-candle inputs", () => sharedMemory());
let mem: InMemoryAgentRunStore | null = null;
function sharedMemory(): InMemoryAgentRunStore { mem ??= new InMemoryAgentRunStore(); return mem; }

describe("PostgresAgentRunStore failure handling (fake executor, NOT a real database)", () => {
  const [rec] = realRecords("sig-f");
  it("a connection error propagates; nothing is reported as stored", async () => {
    const db: SqlExecutor = { async query() { throw new Error("connection terminated unexpectedly"); } };
    let msg = "";
    try { await new PostgresAgentRunStore(db).append(rec); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/connection terminated/);
  });
  it("a non-unique SQL error is not swallowed as a duplicate", async () => {
    const db: SqlExecutor = { async query() { throw Object.assign(new Error("check violation"), { code: "23514" }); } };
    let code = "";
    try { await new PostgresAgentRunStore(db).append(rec); } catch (e) { code = (e as { code?: string }).code ?? ""; }
    expect(code).toBe("23514");
  });
  it("a unique violation with identical stored content is a no-op; with different content a conflict", async () => {
    const hashOf = async (r: typeof rec) => { const m = new InMemoryAgentRunStore(); return (await m.append(r))?.rowHash; };
    const same: SqlExecutor = { async query(t) { if (/^\s*INSERT/i.test(t)) throw Object.assign(new Error("dup"), { code: "23505" }); return [{ row_hash: await hashOf(rec) }]; } };
    expect(await new PostgresAgentRunStore(same).append(rec)).toBeNull();
    const other: SqlExecutor = { async query(t) { if (/^\s*INSERT/i.test(t)) throw Object.assign(new Error("dup"), { code: "23505" }); return [{ row_hash: "0".repeat(64) }]; } };
    let err: unknown;
    try { await new PostgresAgentRunStore(other).append(rec); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AgentRunConflictError);
  });
});
