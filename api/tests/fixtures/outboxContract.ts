import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultAgents } from "../../orchestrator/agents";
import { PostgresAuditStore, type SqlExecutor } from "../../orchestrator/audit.postgres";
import { runSignalPipeline } from "../../orchestrator/machine";
import { PostgresDecisionRecorder } from "../../pipeline/decisionRecorder";
import { logChannel, PostgresDeliveryLog, PostgresOutboxStore, PROPOSED_OUTBOX_CONFIG, runOutboxOnce, type OutboxChannelHandler, type OutboxRecord, type OutboxStore } from "../../pipeline/outbox";
import { baseInput } from "./governanceFixtures";
import { faultyOn } from "./agentsRunContract";

export const rec = (signalId: string, kind: OutboxRecord["kind"] = "NEW_CYCLE", createdAt = 1000): OutboxRecord => ({ signalId, cycleKey: "c", channel: "log", kind, payload: { x: 1 }, createdAt });
const cfg = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, leaseMs: 500 };

/** Store contract, run against in-memory and PostgreSQL. */
export function defineOutboxStoreContract(label: string, make: () => OutboxStore): void {
  describe(`outbox store contract [${label}]`, () => {
    it("enqueue is unique per (signal, channel, kind)", async () => {
      const s = make(), sid = `o-${randomUUID()}`;
      expect(await s.enqueue(rec(sid))).toBe(true);
      expect(await s.enqueue(rec(sid))).toBe(false);
      expect(await s.enqueue(rec(sid, "NEW_VERSION"))).toBe(true);
      expect((await s.list(sid)).length).toBe(2);
    });
    it("success path: claim -> deliver -> SENT; nothing left to claim", async () => {
      const s = make(), sid = `o-${randomUUID()}`; await s.enqueue(rec(sid));
      const delivered: string[] = [];
      const ch: OutboxChannelHandler = { deliver: async (r) => { delivered.push(r.signalId); } };
      const r1 = await runOutboxOnce(s, { log: ch }, cfg, 2000, "w1");
      expect(r1.sent).toBeGreaterThan(0);
      expect(delivered.includes(sid)).toBe(true);
      expect((await s.list(sid))[0].status).toBe("SENT");
      const claimed = (await s.claimDue(3000, 50, "w1", 500)).filter((x) => x.signalId === sid);
      expect(claimed.length).toBe(0);
    });
    it("failure -> FAILED with backoff, not due before nextAttemptAt, then retried", async () => {
      const s = make(), sid = `o-${randomUUID()}`; await s.enqueue(rec(sid));
      const bad: OutboxChannelHandler = { deliver: async () => { throw new Error("boom"); } };
      await runOutboxOnce(s, { log: bad }, cfg, 2000, "w1");
      const a = (await s.list(sid))[0];
      expect(a.status).toBe("FAILED"); expect(a.attempts).toBe(1); expect(a.nextAttemptAt).toBe(2100); expect(a.lastError).toBe("boom");
      expect((await s.claimDue(2050, 50, "w1", 500)).some((x) => x.signalId === sid)).toBe(false);
      let ok = 0;
      await runOutboxOnce(s, { log: { deliver: async () => { ok++; } } }, cfg, 2100, "w2");
      expect(ok).toBeGreaterThan(0);
      expect((await s.list(sid))[0].status).toBe("SENT");
    });
    it("after maxAttempts the row is DEAD and never claimed again", async () => {
      const s = make(), sid = `o-${randomUUID()}`; await s.enqueue(rec(sid));
      const bad: OutboxChannelHandler = { deliver: async () => { throw new Error("boom"); } };
      let now = 2000;
      for (let i = 0; i < 3; i++) { await runOutboxOnce(s, { log: bad }, cfg, now, "w"); now += 10_000; }
      const a = (await s.list(sid))[0];
      expect(a.status).toBe("DEAD"); expect(a.attempts).toBe(3);
      expect((await s.claimDue(now + 100_000, 50, "w", 500)).some((x) => x.signalId === sid)).toBe(false);
    });
    it("a crashed worker (expired lease) is recovered and the row is delivered again (at-least-once)", async () => {
      const s = make(), sid = `o-${randomUUID()}`; await s.enqueue(rec(sid));
      const first = (await s.claimDue(2000, 50, "crashed", 500)).filter((x) => x.signalId === sid);
      expect(first.length).toBe(1); // worker 'crashed' never marks it
      expect((await s.claimDue(2200, 50, "w2", 500)).some((x) => x.signalId === sid)).toBe(false); // lease still valid
      const re = (await s.claimDue(2600, 50, "w2", 500)).filter((x) => x.signalId === sid);
      expect(re.length).toBe(1);
      expect(await s.markSent(re[0].id, "crashed", 2700)).toBe(false); // the stale worker cannot finish it
      expect(await s.markSent(re[0].id, "w2", 2700)).toBe(true);
    });
    it("two workers never claim the same row at once", async () => {
      const s = make(), sid = `o-${randomUUID()}`; await s.enqueue(rec(sid));
      const [a, b] = await Promise.all([s.claimDue(2000, 50, "wa", 500), s.claimDue(2000, 50, "wb", 500)]);
      expect([...a, ...b].filter((x) => x.signalId === sid).length).toBe(1);
    });
  });
}

export function defineDecisionAtomicChecks(db: SqlExecutor): void {
  const outbox = new PostgresOutboxStore(db);
  describe("P5 atomic DECISION + cycle + Outbox [real PostgreSQL]", () => {
    const mk = (symbol: string, recorderDb: SqlExecutor = db) => ({ ...baseInput("up", defaultAgents()), symbol, audit: new PostgresAuditStore(db), decision: { recorder: new PostgresDecisionRecorder(recorderDb) } });
    it("approved signal: DECISION + cycle + one NEW_CYCLE outbox row; worker delivers to the log; re-run adds nothing", async () => {
      const symbol = `P5-${randomUUID().slice(0, 8)}`;
      const r = await runSignalPipeline(mk(symbol));
      expect(r.status).toBe("approved");
      const rows = await outbox.list(r.signalId);
      expect(rows.map((x) => x.kind)).toEqual(["NEW_CYCLE"]);
      const w = await runOutboxOnce(outbox, { log: logChannel(new PostgresDeliveryLog(db)) }, PROPOSED_OUTBOX_CONFIG, 2e12, "w1");
      expect(w.sent).toBeGreaterThan(0);
      expect((await outbox.list(r.signalId))[0].status).toBe("SENT");
      const lines = await db.query("SELECT line FROM sarmaye.outbox_deliveries WHERE outbox_id = $1", [rows[0].id]);
      expect(lines.length).toBe(1);
      expect(String(lines[0].line).includes(r.signalId)).toBe(true);
      const again = await runSignalPipeline(mk(symbol));
      expect(again.duplicate).toBe(true);
      expect((await outbox.list(r.signalId)).length).toBe(1);
    });
    it("crash while enqueueing: the DECISION event is rolled back too", async () => {
      const symbol = `P5-${randomUUID().slice(0, 8)}`;
      const r = await runSignalPipeline(mk(symbol, faultyOn(db, /INSERT INTO sarmaye\.notification_outbox/)));
      expect(r.status).not.toBe("approved");
      expect(r.haltReason?.includes("INJECTED_FAULT")).toBe(true);
      expect(r.events.some((e) => e.kind === "DECISION" && e.decision === "approved")).toBe(false);
      expect((await outbox.list(r.signalId)).length).toBe(0);
    });
  });
}
