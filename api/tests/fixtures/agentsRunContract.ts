import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultAgents } from "../../orchestrator/agents";
import { buildAgentRunRecords, type AgentRunRecord } from "../../orchestrator/agentRuns";
import type { AuditEvent } from "../../orchestrator/audit";
import { PostgresAuditStore, type SqlExecutor } from "../../orchestrator/audit.postgres";
import { PostgresAgentRunStore } from "../../orchestrator/agentRuns";
import { runSignalPipeline } from "../../orchestrator/machine";
import { PostgresAgentsRunRecorder, reconcileAgentRuns, TransactionUnsupportedError } from "../../pipeline/agentsRunRecorder";
import { baseInput } from "./governanceFixtures";
import { realCandles, realRecords, versions } from "./agentRunContract";

/** Wraps an executor so that a statement matching `pattern` throws INSIDE the transaction (simulated crash / lost connection after earlier writes). */
export function faultyOn(db: SqlExecutor, pattern: RegExp): SqlExecutor {
  const wrap = (x: SqlExecutor): SqlExecutor => ({ query: async (t, p) => { if (pattern.test(t)) throw new Error("INJECTED_FAULT: connection lost"); return x.query(t, p); } });
  return { query: (t, p) => db.query(t, p), transaction: db.transaction ? (fn) => db.transaction!((tx) => fn(wrap(tx))) : undefined };
}

const eventFor = (sid: string, keys: string[], seq = 0): AuditEvent => ({
  correlationId: sid, seq, kind: "STATE_TRANSITION", state: "AGENTS_RUN", symbol: "ATOMIC", timeframe: "1H", timestamp: 1_800_000_000_000, inputDataHash: "h", dataFreshnessMs: 0, dataValid: true,
  roomVerdicts: {}, riskResult: null, verifierResult: null, decision: null, reason: "7 votes", configVersion: "t", configFingerprint: "t", idempotencyKey: `${sid}:${seq}:STATE_TRANSITION`, detail: { from: null, to: "AGENTS_RUN", verdict: "OK", agentRunKeys: keys },
});
const keysOf = (r: AgentRunRecord[]): string[] => r.map((x) => x.idempotencyKey).sort();

/** Real-PostgreSQL checks for the P3 transaction boundary. `db` must support transactions. */
export function defineAtomicRecorderChecks(db: SqlExecutor): void {
  const countRuns = async (sid: string): Promise<number> => (await new PostgresAgentRunStore(db).listBySignal(sid)).length;
  const countAudit = async (sid: string): Promise<number> => (await new PostgresAuditStore(db).read(sid)).length;
  describe("P3 atomic agent_runs + AGENTS_RUN audit event [real PostgreSQL]", () => {
    it("writes all runs and the audit event together; reconciliation is clean", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid), rec = new PostgresAgentsRunRecorder(db);
      const out = await rec.record(runs, eventFor(sid, keysOf(runs)));
      expect(out.runsInserted).toBe(runs.length);
      expect(out.audit === null).toBe(false);
      expect(await countRuns(sid)).toBe(runs.length);
      expect(await countAudit(sid)).toBe(1);
      expect((await reconcileAgentRuns(db, sid)).length).toBe(0);
    });
    it("crash while writing the audit event: NO agent_runs rows survive (rollback)", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid), rec = new PostgresAgentsRunRecorder(faultyOn(db, /INSERT INTO sarmaye\.audit_log/));
      let failed = false;
      try { await rec.record(runs, eventFor(sid, keysOf(runs))); } catch (e) { failed = /INJECTED_FAULT/.test(String(e)); }
      expect(failed).toBe(true);
      expect(await countRuns(sid)).toBe(0);
      expect(await countAudit(sid)).toBe(0);
    });
    it("crash in the middle of the run rows: neither runs nor audit event exist", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid);
      let n = 0;
      const base: SqlExecutor = { query: (t, p) => db.query(t, p), transaction: (fn) => db.transaction!((tx) => fn({ query: async (t, p) => { if (/INSERT INTO sarmaye\.agent_runs/.test(t) && ++n === 3) throw new Error("INJECTED_FAULT: mid-batch"); return tx.query(t, p); } })) };
      let failed = false;
      try { await new PostgresAgentsRunRecorder(base).record(runs, eventFor(sid, keysOf(runs))); } catch (e) { failed = /INJECTED_FAULT/.test(String(e)); }
      expect(failed).toBe(true);
      expect(await countRuns(sid)).toBe(0);
      expect(await countAudit(sid)).toBe(0);
    });
    it("re-running the identical unit is a no-op (no duplicate rows, no second event)", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid), rec = new PostgresAgentsRunRecorder(db), ev = eventFor(sid, keysOf(runs));
      await rec.record(runs, ev);
      const again = await rec.record(runs, ev);
      expect(again.runsInserted).toBe(0);
      expect(again.audit).toBeNull();
      expect(await countRuns(sid)).toBe(runs.length);
      expect(await countAudit(sid)).toBe(1);
    });
    it("a run that conflicts with stored content aborts the whole unit: the new audit event is not written", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid), rec = new PostgresAgentsRunRecorder(db);
      await new PostgresAgentRunStore(db).append(runs[0]); // pre-existing row, same key
      const changed = runs.map((r, i) => (i === 0 ? { ...r, confidence: r.confidence === 1 ? 0.5 : 1 } : r));
      let failed = false;
      try { await rec.record(changed, eventFor(sid, keysOf(changed))); } catch (e) { failed = (e as Error).name === "AgentRunConflictError"; }
      expect(failed).toBe(true);
      expect(await countAudit(sid)).toBe(0);
      expect(await countRuns(sid)).toBe(1); // only the pre-existing row; rows 2..n rolled back
    });
    it("an executor without transactions is refused, never silently non-atomic", async () => {
      const sid = `ar-${randomUUID()}`, runs = realRecords(sid);
      let name = "";
      try { await new PostgresAgentsRunRecorder({ query: (t, p) => db.query(t, p) }).record(runs, eventFor(sid, keysOf(runs))); } catch (e) { name = (e as Error).name; }
      expect(name).toBe(new TransactionUnsupportedError().name);
      expect(await countRuns(sid)).toBe(0);
    });
    it("reconciliation reports runs without an audit event and an audit event without runs", async () => {
      const a = `ar-${randomUUID()}`, b = `ar-${randomUUID()}`, runsA = realRecords(a), runsB = realRecords(b);
      const store = new PostgresAgentRunStore(db);
      for (const r of runsA) await store.append(r); // orphan runs, no audit event
      await new PostgresAuditStore(db).append(eventFor(b, keysOf(runsB))); // audit event declares runs that were never stored
      const ia = await reconcileAgentRuns(db, a), ib = await reconcileAgentRuns(db, b);
      expect(ia.map((i) => i.kind)).toEqual(["RUNS_WITHOUT_AUDIT"]);
      expect(ib.map((i) => i.kind)).toEqual(["AUDIT_WITHOUT_RUNS"]);
      expect(ib[0].missingInRuns.length).toBe(runsB.length);
    });
    it("full pipeline on real PostgreSQL: per-agent rows + chained audit, reconciliation clean, re-run is a duplicate", async () => {
      const symbol = `P3-${randomUUID().slice(0, 8)}`;
      const input = { ...baseInput("up", defaultAgents()), symbol, audit: new PostgresAuditStore(db), agentRuns: { recorder: new PostgresAgentsRunRecorder(db), versions } };
      const r = await runSignalPipeline(input);
      expect(r.auditPersisted).toBe(true);
      expect(r.votes.length).toBe(7);
      const rows = await new PostgresAgentRunStore(db).listBySignal(r.signalId);
      expect(rows.length).toBe(7);
      expect((await new PostgresAuditStore(db).verifyChain(r.signalId)).ok).toBe(true);
      expect((await reconcileAgentRuns(db, r.signalId)).length).toBe(0);
      const again = await runSignalPipeline(input);
      expect(again.duplicate).toBe(true);
      expect((await new PostgresAgentRunStore(db).listBySignal(r.signalId)).length).toBe(7);
    });
  });
  void realCandles; void buildAgentRunRecords;
}
