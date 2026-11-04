import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { defaultAgents } from "../../orchestrator/agents";
import { AgentRunConflictError, buildAgentRunRecords, hashInputs, verifyAgentRuns, type AgentRunRecord, type AgentRunStore } from "../../orchestrator/agentRuns";
import { loadAgentSpecs } from "../../orchestrator/agentSpec";
import type { SqlExecutor } from "../../orchestrator/audit.postgres";
import type { AgentContext } from "../../orchestrator/machine";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** REAL data: 999 BTCUSDT 1h candles downloaded from Binance Vision (stored fixture, not a live feed). */
export const realCandles = (JSON.parse(readFileSync(`${root}fixtures/btcusdt_1h.json`, "utf8")) as { candles: Candle[] }).candles;
export const versions: Record<string, string> = Object.fromEntries(loadAgentSpecs(`${root}agents`).filter((s) => s.spec.code_agent_id).map((s) => [s.spec.code_agent_id as string, s.spec.version as string]));
const ctxOf = (c: Candle[]): AgentContext => ({ candles: { "4H": [], "1H": c, "15m": [], "5m": [] }, trend: {} as never });

/** Records produced by the real agent code on real candles (6 runnable agents; Delta Force needs 4 timeframes and is covered by its own tests). */
export function realRecords(signalId: string, candles: Candle[] = realCandles): AgentRunRecord[] {
  const votes = defaultAgents().map((a) => a(ctxOf(candles)));
  return buildAgentRunRecords({ signalId, runAt: 1_800_000_000_000, candles: { "1H": candles }, votes, versions });
}

export interface AgentRunContractOps { reconnect?: () => Promise<void>; severConnections?: () => Promise<void> }

/** Store-level contract, run against the in-memory store AND the PostgreSQL store. */
export function defineAgentRunStoreContract(label: string, makeStore: () => AgentRunStore, ops: AgentRunContractOps = {}): void {
  const fresh = (): string => `ar-${randomUUID()}`;
  describe(`agent_runs store contract [${label}]`, () => {
    it("stores one row per agent with every field, in insertion order, and the integrity hash verifies", async () => {
      const s = makeStore(), sid = fresh(), recs = realRecords(sid);
      for (const r of recs) expect(await s.append(r)).not.toBeNull();
      const rows = await s.listBySignal(sid);
      expect(rows.map((r) => r.agentId)).toEqual(recs.map((r) => r.agentId));
      for (const [i, r] of rows.entries()) {
        const want = recs[i];
        expect(r.signalId).toBe(sid);
        expect(r.agentVersion).toBe(want.agentVersion);
        expect(r.agentGroup).toBe(want.agentGroup);
        expect(r.runAt).toBe(want.runAt);
        expect(r.inputHash).toBe(want.inputHash);
        expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(r.findings).toEqual(want.findings);
        expect(r.findings.evidenceRefs.length).toBeGreaterThan(1);
        expect(r.confidence).toBe(want.confidence);
        expect(r.validationOutcome).toBe(want.validationOutcome);
        expect(r.timeframes).toEqual(["1H"]);
        expect(r.inputRefs["1H"].count).toBe(realCandles.length);
        expect(r.inputRefs["1H"].lastTime).toBe(realCandles[realCandles.length - 1].time);
      }
      expect(verifyAgentRuns(rows)).toEqual({ ok: true, checked: recs.length });
    });
    it("a repeated identical run creates NO duplicate row (exactly-once)", async () => {
      const s = makeStore(), sid = fresh(), recs = realRecords(sid);
      for (const r of recs) await s.append(r);
      for (const r of recs) expect(await s.append(r)).toBeNull();
      expect((await s.listBySignal(sid)).length).toBe(recs.length);
    });
    it("the same (signal, agent) with DIFFERENT content is a conflict, never an overwrite", async () => {
      const s = makeStore(), sid = fresh(), [first] = realRecords(sid);
      await s.append(first);
      const changed = { ...first, inputHash: "b".repeat(64) };
      let err: unknown;
      try { await s.append(changed); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AgentRunConflictError);
      const rows = await s.listBySignal(sid);
      expect(rows).toHaveLength(1);
      expect(rows[0].inputHash).toBe(first.inputHash);
    });
    it("concurrent identical writers: exactly one stores, the rest are no-ops", async () => {
      const s = makeStore(), sid = fresh(), [rec] = realRecords(sid);
      const results = await Promise.all(Array.from({ length: 8 }, () => s.append(rec)));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await s.listBySignal(sid)).toHaveLength(1);
    });
    it("concurrent writers of DIFFERENT agents for one signal all persist", async () => {
      const s = makeStore(), sid = fresh(), recs = realRecords(sid);
      await Promise.all(recs.map((r) => s.append(r)));
      expect((await s.listBySignal(sid)).map((r) => r.agentId).sort()).toEqual(recs.map((r) => r.agentId).sort());
    });
    it("incomplete data: abstaining agents are stored with outcome ABSTAIN, zero confidence and the reason", async () => {
      const s = makeStore(), sid = fresh(), recs = realRecords(sid, realCandles.slice(0, 5));
      for (const r of recs) await s.append(r);
      const rows = await s.listBySignal(sid);
      expect(rows.length).toBe(recs.length);
      for (const r of rows) {
        expect(r.abstained).toBe(true);
        expect(r.validationOutcome).toBe("ABSTAIN");
        expect(r.confidence).toBe(0);
        expect(r.missingInfo && r.missingInfo.length).toBeGreaterThan(0);
        expect(r.inputRefs["1H"].count).toBe(5);
      }
    });
    it("a failed agent is stored as ERROR with its message and no verdict", async () => {
      const s = makeStore(), sid = fresh();
      const [rec] = buildAgentRunRecords({ signalId: sid, runAt: 1_800_000_000_000, candles: { "1H": realCandles }, votes: [], failures: [{ agentId: "B11_MACD", agentGroup: "B", message: "TypeError: boom" }], versions });
      await s.append(rec);
      const [row] = await s.listBySignal(sid);
      expect(row.validationOutcome).toBe("ERROR");
      expect(row.error).toBe("TypeError: boom");
      expect(row.findings.verdict).toBeNull();
      expect(row.abstained).toBe(false);
    });
    it("input_hash is stable for identical candles and changes when any candle changes", () => {
      const a = hashInputs({ "1H": realCandles }, ["1H"]).inputHash;
      expect(hashInputs({ "1H": [...realCandles] }, ["1H"]).inputHash).toBe(a);
      const tampered = realCandles.map((k) => ({ ...k }));
      tampered[500] = { ...tampered[500], close: tampered[500].close + 0.01 };
      expect(hashInputs({ "1H": tampered }, ["1H"]).inputHash).not.toBe(a);
    });
    it("a different signal never sees another signal's rows", async () => {
      const s = makeStore(), a = fresh(), b = fresh();
      for (const r of realRecords(a)) await s.append(r);
      expect(await s.listBySignal(b)).toEqual([]);
    });
    if (ops.reconnect) {
      it("data survives dropping and re-opening the client connection", async () => {
        const s = makeStore(), sid = fresh(), recs = realRecords(sid);
        for (const r of recs) await s.append(r);
        await ops.reconnect?.();
        const rows = await makeStore().listBySignal(sid);
        expect(rows).toHaveLength(recs.length);
        expect(verifyAgentRuns(rows).ok).toBe(true);
      });
    }
    if (ops.severConnections) {
      it("after the server kills the connections, a retry succeeds and still yields exactly one row", async () => {
        const s = makeStore(), sid = fresh(), [rec] = realRecords(sid);
        await s.append(rec);
        await ops.severConnections?.();
        let last: unknown;
        for (let i = 0; i < 4; i++) { try { await s.append(rec); last = undefined; break; } catch (e) { last = e; } }
        expect(last).toBeUndefined();
        expect(await s.listBySignal(sid)).toHaveLength(1);
      });
    }
  });
}

/** PostgreSQL-only checks that need a privileged channel (`admin`): schema constraints, immutability triggers, jsonb typing, tamper detection. */
export function definePostgresAgentRunChecks(admin: SqlExecutor, makeStore: () => AgentRunStore): void {
  const fresh = (): string => `ar-${randomUUID()}`;
  const fails = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); } return ""; };
  const raw = (sid: string, over: Record<string, unknown> = {}): { sql: string; params: unknown[] } => {
    const v = { signal_id: sid, agent_id: `X-${randomUUID()}`.slice(0, 40), agent_version: "1.0", agent_group: "A", run_at: 1, input_hash: "a".repeat(64), input_refs_json: {}, timeframes_json: ["1H"], findings_json: {}, confidence: 0.5, confidence_meaning: "m", missing_info: null, contradictions_json: [], abstained: false, error: null, validation_outcome: "OK", idempotency_key: `k-${randomUUID()}`, row_hash: "c".repeat(64), ...over };
    const keys = Object.keys(v);
    return { sql: `INSERT INTO sarmaye.agent_runs (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, params: keys.map((k) => v[k as keyof typeof v]) };
  };
  describe("agent_runs PostgreSQL schema checks", () => {
    it("migration 0004 created the table", async () => {
      expect((await admin.query("SELECT to_regclass('sarmaye.agent_runs') AS t"))[0].t).not.toBeNull();
    });
    it("json columns are stored as real jsonb objects/arrays, not JSON strings", async () => {
      const s = makeStore(), sid = fresh();
      await s.append(realRecords(sid)[0]);
      const r = (await admin.query("SELECT jsonb_typeof(input_refs_json) AS a, jsonb_typeof(findings_json) AS b, jsonb_typeof(timeframes_json) AS c, jsonb_typeof(contradictions_json) AS d FROM sarmaye.agent_runs WHERE signal_id = $1", [sid]))[0];
      expect([r.a, r.b, r.c, r.d]).toEqual(["object", "object", "array", "array"]);
    });
    for (const [name, over] of [
      ["confidence above 1", { confidence: 1.5 }],
      ["confidence below 0", { confidence: -0.1 }],
      ["unknown outcome", { validation_outcome: "MAYBE" }],
      ["group outside A-E", { agent_group: "Z" }],
      ["abstained flag without ABSTAIN outcome", { abstained: true, validation_outcome: "OK" }],
      ["ABSTAIN outcome without the abstained flag", { abstained: false, validation_outcome: "ABSTAIN", missing_info: "x" }],
      ["abstention without a reason", { abstained: true, validation_outcome: "ABSTAIN", missing_info: null }],
      ["ERROR outcome without an error message", { validation_outcome: "ERROR", error: null }],
      ["an error message on a non-ERROR row", { validation_outcome: "OK", error: "x" }],
    ] as [string, Record<string, unknown>][]) {
      it(`database rejects: ${name}`, async () => {
        const { sql, params } = raw(fresh(), over);
        expect(await fails(admin.query(sql, params))).not.toBe("");
      });
    }
    it("database enforces one row per (signal, agent) and per idempotency key", async () => {
      const sid = fresh(), a = raw(sid, { agent_id: "DUP", idempotency_key: `k-${sid}` });
      await admin.query(a.sql, a.params);
      const sameAgent = raw(sid, { agent_id: "DUP" });
      expect(await fails(admin.query(sameAgent.sql, sameAgent.params))).not.toBe("");
      const sameKey = raw(sid, { agent_id: "DUP2", idempotency_key: `k-${sid}` });
      expect(await fails(admin.query(sameKey.sql, sameKey.params))).not.toBe("");
    });
    it("UPDATE, DELETE and TRUNCATE are rejected by the immutability triggers", async () => {
      const s = makeStore(), sid = fresh();
      await s.append(realRecords(sid)[0]);
      expect(await fails(admin.query("UPDATE sarmaye.agent_runs SET confidence = 0.99 WHERE signal_id = $1", [sid]))).toMatch(/append-only/);
      expect(await fails(admin.query("DELETE FROM sarmaye.agent_runs WHERE signal_id = $1", [sid]))).toMatch(/append-only/);
      expect(await fails(admin.query("TRUNCATE sarmaye.agent_runs"))).toMatch(/append-only/);
      expect(await s.listBySignal(sid)).toHaveLength(1);
    });
    it("KNOWN LIMIT: a superuser who disables the trigger CAN alter a row, but verifyAgentRuns detects it", async () => {
      const s = makeStore(), sid = fresh();
      await s.append(realRecords(sid)[0]);
      try {
        await admin.query("ALTER TABLE sarmaye.agent_runs DISABLE TRIGGER agent_runs_no_update_delete");
        await admin.query("UPDATE sarmaye.agent_runs SET confidence = 0.99 WHERE signal_id = $1", [sid]);
      } finally {
        await admin.query("ALTER TABLE sarmaye.agent_runs ENABLE TRIGGER agent_runs_no_update_delete");
      }
      const check = verifyAgentRuns(await s.listBySignal(sid));
      expect(check.ok).toBe(false);
      expect(check.problem).toMatch(/row hash mismatch/);
    });
  });
}
