import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditSequenceError, recoverInterrupted, type AuditEvent, type AuditStore } from "../../orchestrator/audit";
import type { SqlExecutor } from "../../orchestrator/audit.postgres";

/**
 * Contract every durable audit store must satisfy. `admin` is a privileged SQL channel used ONLY to attack the table
 * (UPDATE / DELETE / TRUNCATE, and trigger-disabled tampering) and to count rows independently of the store under test.
 */
export function defineAuditStoreContract(label: string, makeStore: () => AuditStore, admin: SqlExecutor): void {
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
