import { type SqlExecutor, postgresJsExecutor } from "../orchestrator/audit.postgres";

/**
 * P5 internal notification Outbox. Only the `log` channel exists; no external channel is enabled.
 * Guarantee: AT-LEAST-ONCE delivery attempts (a crash between send and markSent re-sends). The log channel itself is idempotent per outbox id.
 * Enqueue is unique per (signalId, channel, kind). Retry/backoff numbers are PROPOSED engineering parameters, passed explicitly.
 */
export type OutboxKind = "NEW_CYCLE" | "NEW_VERSION";
export type OutboxChannel = "log";
export type OutboxStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "DEAD";
export interface OutboxRecord { signalId: string; cycleKey: string; channel: OutboxChannel; kind: OutboxKind; payload: Record<string, unknown>; createdAt: number }
export interface StoredOutbox extends OutboxRecord { id: number; status: OutboxStatus; attempts: number; nextAttemptAt: number; lockedBy: string | null; lockedUntil: number | null; lastError: string | null; sentAt: number | null }
export interface OutboxConfig { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; leaseMs: number }
/** PROPOSED (not from V6): conservative defaults; production callers should pass their own. */
export const PROPOSED_OUTBOX_CONFIG: OutboxConfig = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, leaseMs: 30_000 };
export const backoffMs = (attempts: number, c: OutboxConfig): number => Math.min(c.maxDelayMs, c.baseDelayMs * 2 ** Math.max(0, attempts - 1));

export interface OutboxStore {
  /** false = this (signal, channel, kind) already exists (no second row). */
  enqueue(r: OutboxRecord): Promise<boolean>;
  /** Claims up to `limit` due rows (PENDING/FAILED due, or SENDING with an expired lease = crashed worker), leasing them to `workerId`. */
  claimDue(now: number, limit: number, workerId: string, leaseMs: number): Promise<StoredOutbox[]>;
  markSent(id: number, workerId: string, now: number): Promise<boolean>;
  /** attempts+1; DEAD when it reaches maxAttempts, else FAILED with nextAttemptAt. */
  markFailed(id: number, workerId: string, error: string, now: number, c: OutboxConfig): Promise<StoredOutbox | null>;
  list(signalId: string): Promise<StoredOutbox[]>;
}

export class InMemoryOutboxStore implements OutboxStore {
  rows: StoredOutbox[] = [];
  async enqueue(r: OutboxRecord): Promise<boolean> {
    if (this.rows.some((x) => x.signalId === r.signalId && x.channel === r.channel && x.kind === r.kind)) return false;
    this.rows.push({ ...structuredClone(r), id: this.rows.length + 1, status: "PENDING", attempts: 0, nextAttemptAt: r.createdAt, lockedBy: null, lockedUntil: null, lastError: null, sentAt: null });
    return true;
  }
  async claimDue(now: number, limit: number, workerId: string, leaseMs: number): Promise<StoredOutbox[]> {
    const due = this.rows.filter((x) => ((x.status === "PENDING" || x.status === "FAILED") && x.nextAttemptAt <= now) || (x.status === "SENDING" && (x.lockedUntil ?? 0) <= now)).slice(0, limit);
    for (const d of due) { d.status = "SENDING"; d.lockedBy = workerId; d.lockedUntil = now + leaseMs; }
    return structuredClone(due);
  }
  async markSent(id: number, workerId: string, now: number): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== "SENDING" || r.lockedBy !== workerId) return false;
    r.status = "SENT"; r.sentAt = now; r.lockedBy = null; r.lockedUntil = null; return true;
  }
  async markFailed(id: number, workerId: string, error: string, now: number, c: OutboxConfig): Promise<StoredOutbox | null> {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== "SENDING" || r.lockedBy !== workerId) return null;
    r.attempts++; r.lastError = error.slice(0, 500); r.lockedBy = null; r.lockedUntil = null;
    if (r.attempts >= c.maxAttempts) r.status = "DEAD"; else { r.status = "FAILED"; r.nextAttemptAt = now + backoffMs(r.attempts, c); }
    return structuredClone(r);
  }
  async list(signalId: string): Promise<StoredOutbox[]> { return structuredClone(this.rows.filter((x) => x.signalId === signalId)); }
}

const COLS = "id, signal_id, cycle_key, channel, kind, payload_json, status, attempts, next_attempt_at, locked_by, locked_until, last_error, created_at, sent_at";
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const toStored = (r: Record<string, unknown>): StoredOutbox => ({
  id: Number(r.id), signalId: String(r.signal_id), cycleKey: String(r.cycle_key), channel: r.channel as OutboxChannel, kind: r.kind as OutboxKind,
  payload: (typeof r.payload_json === "string" ? JSON.parse(r.payload_json) : r.payload_json) as Record<string, unknown>, status: r.status as OutboxStatus, attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at), lockedBy: r.locked_by === null || r.locked_by === undefined ? null : String(r.locked_by), lockedUntil: num(r.locked_until),
  lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error), createdAt: Number(r.created_at), sentAt: num(r.sent_at),
});

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: SqlExecutor = postgresJsExecutor()) {}
  async enqueue(r: OutboxRecord): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO sarmaye.notification_outbox (signal_id, cycle_key, channel, kind, payload_json, next_attempt_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (signal_id, channel, kind) DO NOTHING RETURNING id`,
      [r.signalId, r.cycleKey, r.channel, r.kind, r.payload, r.createdAt]);
    return rows.length > 0;
  }
  async claimDue(now: number, limit: number, workerId: string, leaseMs: number): Promise<StoredOutbox[]> {
    const rows = await this.db.query(
      `UPDATE sarmaye.notification_outbox SET status = 'SENDING', locked_by = $3, locked_until = $1 + $4
       WHERE id IN (SELECT id FROM sarmaye.notification_outbox
                    WHERE (status IN ('PENDING','FAILED') AND next_attempt_at <= $1) OR (status = 'SENDING' AND locked_until <= $1)
                    ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLS}`, [now, limit, workerId, leaseMs]);
    return rows.map(toStored).sort((a, b) => a.id - b.id);
  }
  async markSent(id: number, workerId: string, now: number): Promise<boolean> {
    const rows = await this.db.query(`UPDATE sarmaye.notification_outbox SET status = 'SENT', sent_at = $3, locked_by = NULL, locked_until = NULL WHERE id = $1 AND status = 'SENDING' AND locked_by = $2 RETURNING id`, [id, workerId, now]);
    return rows.length > 0;
  }
  async markFailed(id: number, workerId: string, error: string, now: number, c: OutboxConfig): Promise<StoredOutbox | null> {
    const cur = await this.db.query(`SELECT attempts FROM sarmaye.notification_outbox WHERE id = $1 AND status = 'SENDING' AND locked_by = $2`, [id, workerId]);
    if (!cur.length) return null;
    const attempts = Number(cur[0].attempts) + 1, dead = attempts >= c.maxAttempts;
    const rows = await this.db.query(
      `UPDATE sarmaye.notification_outbox SET status = $3, attempts = $4, next_attempt_at = $5, last_error = $6, locked_by = NULL, locked_until = NULL WHERE id = $1 AND status = 'SENDING' AND locked_by = $2 RETURNING ${COLS}`,
      [id, workerId, dead ? "DEAD" : "FAILED", attempts, dead ? now : now + backoffMs(attempts, c), error.slice(0, 500)]);
    return rows.length ? toStored(rows[0]) : null;
  }
  async list(signalId: string): Promise<StoredOutbox[]> { return (await this.db.query(`SELECT ${COLS} FROM sarmaye.notification_outbox WHERE signal_id = $1 ORDER BY id`, [signalId])).map(toStored); }
}

// ---------------------------------------------------------------- channel + worker
export interface OutboxChannelHandler { deliver(r: StoredOutbox, now: number): Promise<void> }
/** Log channel: writes one line per outbox id; idempotent (a repeated delivery of the same id adds nothing). */
export interface DeliveryLog { write(outboxId: number, line: string, now: number): Promise<void> }
export class InMemoryDeliveryLog implements DeliveryLog {
  lines = new Map<number, string>();
  async write(id: number, line: string): Promise<void> { if (!this.lines.has(id)) this.lines.set(id, line); }
}
export class PostgresDeliveryLog implements DeliveryLog {
  constructor(private readonly db: SqlExecutor = postgresJsExecutor()) {}
  async write(id: number, line: string, now: number): Promise<void> { await this.db.query(`INSERT INTO sarmaye.outbox_deliveries (outbox_id, channel, line, delivered_at) VALUES ($1,'log',$2,$3) ON CONFLICT (outbox_id) DO NOTHING`, [id, line, now]); }
}
export const logChannel = (log: DeliveryLog): OutboxChannelHandler => ({
  deliver: (r, now) => log.write(r.id, `[${r.kind}] signal=${r.signalId} cycle=${r.cycleKey} ${JSON.stringify(r.payload)}`, now),
});

export interface WorkerResult { claimed: number; sent: number; failed: number; dead: number }
/** One worker pass: claim due rows, deliver outside any database transaction, record the outcome. */
export async function runOutboxOnce(store: OutboxStore, channels: Record<OutboxChannel, OutboxChannelHandler>, c: OutboxConfig, now: number, workerId: string, limit = 50): Promise<WorkerResult> {
  const out: WorkerResult = { claimed: 0, sent: 0, failed: 0, dead: 0 };
  for (const r of await store.claimDue(now, limit, workerId, c.leaseMs)) {
    out.claimed++;
    try { await channels[r.channel].deliver(r, now); if (await store.markSent(r.id, workerId, now)) out.sent++; }
    catch (e) { const f = await store.markFailed(r.id, workerId, e instanceof Error ? e.message : String(e), now, c); if (f?.status === "DEAD") out.dead++; else out.failed++; }
  }
  return out;
}
