import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditSequenceError, recoverInterrupted, verifyChainOf, type AuditEvent, type AuditStore } from "../../orchestrator/audit";
import { runSignalPipeline } from "../../orchestrator/machine";
import { defaultAgents } from "../../orchestrator/agents";
import { baseInput } from "./governanceFixtures";
import type { SqlExecutor } from "../../orchestrator/audit.postgres";

/**
 * Contract every durable audit store must satisfy. `admin` is a privileged SQL channel used ONLY to attack the table
 * (UPDATE / DELETE / TRUNCATE, and trigger-disabled tampering) and to count rows independently of the store under test.
 */
export interface ContractOps {
  /** Drops the client connection(s) and creates new ones (CI: closeDb + lazy re-open). */
  reconnect?: () => Promise<void>;
  /** Terminates the server-side backends of OTHER sessions (pg_terminate_backend), simulating a network cut / server restart of the pool. */
  severConnections?: () => Promise<void>;
}

export function defineAuditStoreContract(label: string, makeStoreOn: (db: SqlExecutor) => AuditStore, admin: SqlExecutor, ops: ContractOps = {}): void {
  const makeStore = (): AuditStore => makeStoreOn(admin);
  const ev = (cid: string, seq: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
    correlationId: cid, seq, kind: seq === 0 ? "STATE_TRANSITION" : "ROOM_VERDICT", state: "DETECTED", symbol: "BTCUSDT", timeframe: "1H", timestamp: 1_800_000_000_000 + seq,
    inputDataHash: "a".repeat(64), dataFreshnessMs: 1200, dataValid: true, roomVerdicts: { RISK: { status: "PASS", metrics: { rr: 2.2 } } }, riskResult: { status: "PASS" },
    verifierResult: null, decision: null, reason: `r${seq}`, configVersion: "v1", configFingerprint: "f".repeat(64), idempotencyKey: `${cid}:${seq}:k`, detail: { n: seq }, ...over,
  });
  const count = async (cid: string): Promise<number> => Number((await admin.query("SELECT count(*)::int AS n FROM sarmaye.audit_log WHERE correlation_id = $1", [cid]))[0].n);
  const fails = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); } return ""; };
  const fresh = (): string => `contract-${randomUUID()}`;

  describe(`audit store contract [${label}]`, () => {
    it("round-trips every field and keeps a valid hash chain", async () => {
      const s = makeStore(), cid = fresh();
      for (let i = 0; i < 3; i++) await s.append(ev(cid, i));
      const rows = await s.read(cid);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
      expect(rows[1].roomVerdicts).toEqual({ RISK: { status: "PASS", metrics: { rr: 2.2 } } });
      expect(rows[1].dataFreshnessMs).toBe(1200);
      expect(rows[1].timestamp).toBe(1_800_000_000_001);
      expect(rows[2].riskResult).toEqual({ status: "PASS" });
      expect(rows[0].verifierResult).toBeNull();
      expect((await s.verifyChain(cid)).ok).toBe(true);
    });
    it("a repeated idempotency key is stored exactly once (no overwrite)", async () => {
      const s = makeStore(), cid = fresh();
      expect(await s.append(ev(cid, 0))).not.toBeNull();
      expect(await s.append(ev(cid, 0, { reason: "different content, same key" }))).toBeNull();
      expect(await count(cid)).toBe(1);
      expect((await s.read(cid))[0].reason).toBe("r0");
    });
    it("rejects a sequence gap and a second writer claiming an existing sequence number", async () => {
      const s = makeStore(), cid = fresh();
      await s.append(ev(cid, 0));
      expect(await fails(s.append(ev(cid, 2)))).toContain("expected seq 1");
      const clash = await s.append(ev(cid, 0, { idempotencyKey: `${cid}:other` })).catch((e: unknown) => e);
      expect(clash).toBeInstanceOf(AuditSequenceError);
      expect(await count(cid)).toBe(1);
    });
    it("concurrent identical appends: exactly one row", async () => {
      const s = makeStore(), cid = fresh();
      const results = await Promise.all(Array.from({ length: 8 }, () => s.append(ev(cid, 0)).catch((e: unknown) => e)));
      expect(results.filter((r) => r !== null && !(r instanceof Error))).toHaveLength(1);
      expect(await count(cid)).toBe(1);
    });
    it("concurrent DIFFERENT events for the same sequence: exactly one wins, the rest are rejected, nothing is overwritten", async () => {
      const s = makeStore(), cid = fresh();
      await s.append(ev(cid, 0));
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => s.append(ev(cid, 1, { idempotencyKey: `${cid}:1:w${i}`, reason: `writer ${i}` })).catch((e: unknown) => e)));
      expect(results.filter((r) => r !== null && !(r instanceof Error))).toHaveLength(1);
      expect(await count(cid)).toBe(2);
      expect((await s.verifyChain(cid)).ok).toBe(true);
    });
    it("the database itself rejects UPDATE, DELETE and TRUNCATE; rows are unchanged afterwards", async () => {
      const s = makeStore(), cid = fresh();
      await s.append(ev(cid, 0));
      expect(await fails(admin.query("UPDATE sarmaye.audit_log SET reason = 'changed' WHERE correlation_id = $1", [cid]))).toContain("append-only");
      expect(await fails(admin.query("DELETE FROM sarmaye.audit_log WHERE correlation_id = $1", [cid]))).toContain("append-only");
      expect(await fails(admin.query("TRUNCATE sarmaye.audit_log"))).toContain("append-only");
      expect(await count(cid)).toBe(1);
      expect((await s.read(cid))[0].reason).toBe("r0");
    });
    it("tampering by someone who disables the triggers is DETECTED by the hash chain", async () => {
      const s = makeStore(), cid = fresh();
      for (let i = 0; i < 3; i++) await s.append(ev(cid, i));
      await admin.query("ALTER TABLE sarmaye.audit_log DISABLE TRIGGER USER");
      try { await admin.query("UPDATE sarmaye.audit_log SET reason = 'forged' WHERE correlation_id = $1 AND seq = 1", [cid]); }
      finally { await admin.query("ALTER TABLE sarmaye.audit_log ENABLE TRIGGER USER"); }
      const v = await s.verifyChain(cid);
      expect(v.ok).toBe(false);
      expect(v.problem).toContain("hash mismatch");
    });
    it("a silent deletion in the middle of a run is detected", async () => {
      const s = makeStore(), cid = fresh();
      for (let i = 0; i < 3; i++) await s.append(ev(cid, i));
      await admin.query("ALTER TABLE sarmaye.audit_log DISABLE TRIGGER USER");
      try { await admin.query("DELETE FROM sarmaye.audit_log WHERE correlation_id = $1 AND seq = 1", [cid]); }
      finally { await admin.query("ALTER TABLE sarmaye.audit_log ENABLE TRIGGER USER"); }
      expect((await s.verifyChain(cid)).ok).toBe(false);
    });
    it("keeps event order: interleaved writers on different correlation ids never mix, and insertion order equals seq", async () => {
      const s = makeStore(), a = fresh(), b = fresh();
      const writer = async (cid: string): Promise<void> => { for (let i = 0; i < 8; i++) await s.append(ev(cid, i)); };
      await Promise.all([writer(a), writer(b)]);
      for (const cid of [a, b]) {
        expect((await s.read(cid)).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect((await admin.query("SELECT seq FROM sarmaye.audit_log WHERE correlation_id = $1 ORDER BY id", [cid])).map((r) => Number(r.seq))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect((await s.verifyChain(cid)).ok).toBe(true);
      }
    });
    it("events survive a client disconnect + reconnect, and appending continues the same chain", async () => {
      const s = makeStore(), cid = fresh();
      for (let i = 0; i < 3; i++) await s.append(ev(cid, i));
      const before = (await s.read(cid)).map((r) => r.rowHash);
      await ops.reconnect?.();
      const s2 = makeStore();
      expect((await s2.read(cid)).map((r) => r.rowHash)).toEqual(before);
      await s2.append(ev(cid, 3));
      expect((await s2.read(cid))).toHaveLength(4);
      expect((await s2.verifyChain(cid)).ok).toBe(true);
    });
    it("after the server cuts the connections, a retry succeeds and no event is lost or duplicated", async () => {
      const s = makeStore(), cid = fresh();
      await s.append(ev(cid, 0));
      await ops.severConnections?.();
      let appended = false;
      for (let attempt = 0; attempt < 5 && !appended; attempt++) {
        try { await s.append(ev(cid, 1)); appended = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      expect(appended).toBe(true);
      expect((await s.read(cid)).map((r) => r.seq)).toEqual([0, 1]);
      expect(await count(cid)).toBe(2);
    });
    it("a failed write is reported, leaves no partial row, and the same event can be appended afterwards", async () => {
      const cid = fresh();
      let failNext = true;
      const flaky: SqlExecutor = { query: async (text, params) => { if (failNext && text.startsWith("INSERT")) { failNext = false; throw new Error("connection terminated unexpectedly"); } return admin.query(text, params); } };
      const s = makeStoreOn(flaky);
      expect(await fails(s.append(ev(cid, 0)))).toContain("connection terminated");
      expect(await count(cid)).toBe(0);
      expect(await s.append(ev(cid, 0))).not.toBeNull();
      expect(await count(cid)).toBe(1);
    });
    it("pipeline: a database failure on the DECISION write is never approved and never notified; no DECISION row exists", async () => {
      let notified = 0;
      const failing: SqlExecutor = { query: async (text, params) => { if (text.startsWith("INSERT") && params?.[2] === "DECISION") throw new Error("disk full"); return admin.query(text, params); } };
      const r = await runSignalPipeline({ ...baseInput("up", defaultAgents()), symbol: `PGF-${randomUUID().slice(0, 8)}`, audit: makeStoreOn(failing), notify: () => { notified++; } });
      expect(r.status).not.toBe("approved");
      expect(notified).toBe(0);
      expect(Number((await admin.query("SELECT count(*)::int AS n FROM sarmaye.audit_log WHERE correlation_id = $1 AND kind = 'DECISION'", [r.correlationId]))[0].n)).toBe(0);
    });
    it("pipeline: database unreachable from the start -> inconclusive AUDIT_UNAVAILABLE, nothing executed or notified", async () => {
      let notified = 0;
      const down: SqlExecutor = { query: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }); } };
      const r = await runSignalPipeline({ ...baseInput("up", defaultAgents()), symbol: `PGD-${randomUUID().slice(0, 8)}`, audit: makeStoreOn(down), notify: () => { notified++; } });
      expect(r.status).toBe("inconclusive");
      expect(r.auditPersisted).toBe(false);
      expect(r.haltReason).toContain("AUDIT_UNAVAILABLE");
      expect(notified).toBe(0);
    });
    it("ACCESS CONTROL: a role with only INSERT/SELECT cannot UPDATE, DELETE, TRUNCATE or switch triggers off; INSERT still works", async () => {
      const role = `audit_app_${randomUUID().replace(/-/g, "").slice(0, 10)}`, cid = fresh();
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      try {
        await admin.query(`GRANT USAGE ON SCHEMA sarmaye TO ${role}`);
        await admin.query(`GRANT SELECT, INSERT ON sarmaye.audit_log TO ${role}`);
        await admin.query(`GRANT USAGE ON SEQUENCE sarmaye.audit_log_id_seq TO ${role}`);
        const as = (stmt: string): Promise<unknown> => admin.query(`DO $do$ BEGIN SET LOCAL ROLE ${role}; ${stmt}; END $do$`);
        const ins = `INSERT INTO sarmaye.audit_log (correlation_id, seq, kind, symbol, timeframe, ts, input_data_hash, room_verdicts, config_version, config_fingerprint, idempotency_key, prev_hash, row_hash) VALUES ('${cid}', 0, 'ERROR', 'X', '1H', 1, 'h', '{}'::jsonb, 'v', 'f', '${cid}:0', 'p', 'r')`;
        await as(ins);
        expect(await count(cid)).toBe(1);
        expect(await fails(as(`UPDATE sarmaye.audit_log SET reason = 'x' WHERE correlation_id = '${cid}'`))).toContain("permission denied");
        expect(await fails(as(`DELETE FROM sarmaye.audit_log WHERE correlation_id = '${cid}'`))).toContain("permission denied");
        expect(await fails(as("TRUNCATE sarmaye.audit_log"))).toContain("permission denied");
        expect(await fails(as("ALTER TABLE sarmaye.audit_log DISABLE TRIGGER USER"))).toContain("must be owner");
        expect(await fails(as("SET LOCAL session_replication_role = replica"))).toContain("permission denied");
        expect(await count(cid)).toBe(1);
      } finally {
        await admin.query(`DO $do$ BEGIN ALTER TABLE sarmaye.audit_log DISABLE TRIGGER USER; DELETE FROM sarmaye.audit_log WHERE correlation_id = '${cid}'; ALTER TABLE sarmaye.audit_log ENABLE TRIGGER USER; END $do$`);
        await admin.query(`REVOKE ALL ON sarmaye.audit_log FROM ${role}`);
        await admin.query(`REVOKE ALL ON SEQUENCE sarmaye.audit_log_id_seq FROM ${role}`);
        await admin.query(`REVOKE ALL ON SCHEMA sarmaye FROM ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
    });
    it("KNOWN LIMIT: a superuser can bypass the triggers (session_replication_role=replica) but the forgery is detected by the hash chain", async () => {
      const s = makeStore(), cid = fresh();
      for (let i = 0; i < 3; i++) await s.append(ev(cid, i));
      await admin.query(`DO $do$ BEGIN SET LOCAL session_replication_role = replica; UPDATE sarmaye.audit_log SET reason = 'forged' WHERE correlation_id = '${cid}' AND seq = 2; END $do$`);
      expect((await s.read(cid))[2].reason).toBe("forged"); // the database allowed it: append-only is NOT absolute against a superuser
      expect(verifyChainOf(await s.read(cid)).ok).toBe(false); // ...but it cannot go unnoticed
    });
    it("an interrupted run is finalized INCONCLUSIVE exactly once, even when recovery runs concurrently", async () => {
      const s = makeStore(), cid = fresh();
      await s.append(ev(cid, 0));
      await s.append(ev(cid, 1));
      const outcomes = await Promise.all([1, 2, 3, 4].map(() => recoverInterrupted(s, cid, 1_800_000_009_000).catch((e: unknown) => e)));
      expect(outcomes.some((o) => o === "FINALIZED")).toBe(true);
      const rows = await s.read(cid);
      expect(rows.filter((r) => r.kind === "DECISION")).toHaveLength(1);
      expect(rows[rows.length - 1].decision).toBe("inconclusive");
      expect(rows[rows.length - 1].reason).toBe("PROCESS_INTERRUPTED");
      expect((await s.verifyChain(cid)).ok).toBe(true);
    });
  });
}
