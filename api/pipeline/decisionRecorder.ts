import type { AuditEvent, StoredAuditEvent } from "../orchestrator/audit";
import { PostgresAuditStore, type SqlExecutor } from "../orchestrator/audit.postgres";
import { CycleSeqConflict, InMemoryCycleStore, PostgresCycleStore, registerObservation, type CycleStore } from "./cycleStore";
import { InMemoryOutboxStore, PostgresOutboxStore, type OutboxStore } from "./outbox";
import { NOTIFIABLE_KINDS, type Observation } from "./signalIdentity";
import { TransactionUnsupportedError } from "./agentsRunRecorder";
import type { AuditStore } from "../orchestrator/audit";

/**
 * P5 transaction boundary: DECISION audit event + cycle events + Outbox row commit together (Postgres) or not at all.
 * Only an APPROVED decision with an identity observation registers a cycle; only NEW_CYCLE / NEW_VERSION enqueue a `log` notification.
 * Sending happens later in the worker, never inside this transaction.
 */
export interface DecisionRecordResult { audit: StoredAuditEvent | null; cycle: string; enqueued: string[] }
export interface AtomicDecisionRecorder {
  record(event: AuditEvent, ctx: { approved: boolean; observation: Observation | null; now: number }): Promise<DecisionRecordResult>;
}

async function apply(audit: AuditStore, cycles: CycleStore, outbox: OutboxStore, event: AuditEvent, ctx: { approved: boolean; observation: Observation | null; now: number }): Promise<DecisionRecordResult> {
  const stored = await audit.append(event);
  if (stored === null) return { audit: null, cycle: "DUPLICATE_DECISION", enqueued: [] }; // identical decision already stored: nothing else to do
  if (!ctx.approved || !ctx.observation) return { audit: stored, cycle: "NOT_REGISTERED", enqueued: [] };
  const reg = await registerObservation(cycles, ctx.observation);
  if (reg.outcome !== "APPLIED") return { audit: stored, cycle: reg.outcome, enqueued: [] };
  const enqueued: string[] = [];
  for (const e of reg.events) {
    if (!NOTIFIABLE_KINDS.includes(e.kind)) continue;
    const kind = e.kind as "NEW_CYCLE" | "NEW_VERSION";
    const ok = await outbox.enqueue({ signalId: event.correlationId, cycleKey: ctx.observation.cycleKey, channel: "log", kind, payload: { cycleNo: e.cycleNo, version: e.version, direction: ctx.observation.direction, setup: e.setup }, createdAt: ctx.now });
    if (ok) enqueued.push(kind);
  }
  return { audit: stored, cycle: reg.events.map((e) => e.kind).join("+"), enqueued };
}

export class PostgresDecisionRecorder implements AtomicDecisionRecorder {
  constructor(private readonly db: SqlExecutor, private readonly attempts = 3) {}
  async record(event: AuditEvent, ctx: { approved: boolean; observation: Observation | null; now: number }): Promise<DecisionRecordResult> {
    const tx = this.db.transaction?.bind(this.db);
    if (!tx) throw new TransactionUnsupportedError();
    for (let i = 0; ; i++) {
      try { return await tx((t) => apply(new PostgresAuditStore(t), new PostgresCycleStore(t), new PostgresOutboxStore(t), event, ctx)); }
      catch (e) { if (!(e instanceof CycleSeqConflict) || i + 1 >= this.attempts) throw e; } // a concurrent writer won the cycle seq: whole unit rolled back, retry it
    }
  }
}

/** Sequential test double (NOT atomic). */
export class SequentialDecisionRecorder implements AtomicDecisionRecorder {
  constructor(readonly audit: AuditStore, readonly cycles: CycleStore = new InMemoryCycleStore(), readonly outbox: OutboxStore = new InMemoryOutboxStore()) {}
  record(event: AuditEvent, ctx: { approved: boolean; observation: Observation | null; now: number }): Promise<DecisionRecordResult> { return apply(this.audit, this.cycles, this.outbox, event, ctx); }
}
