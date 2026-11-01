import { createHash } from "node:crypto";

/**
 * Append-only audit log (PDF section 6: audit_log is append-only, no delete, corrections are new records).
 * Records ACTUAL events (state transitions, room verdicts, verifier result, final decision, errors), not "one row per state":
 * the number of rows per run depends on the path taken. Every event of one run shares a correlationId, carries a contiguous
 * seq and is chained to the previous one by a SHA-256 hash, so tampering or a missing record is detectable by verifyChain.
 */
export type AuditKind = "STATE_TRANSITION" | "ROOM_VERDICT" | "VERIFIER_RESULT" | "DECISION" | "ERROR";

export interface AuditEvent {
  correlationId: string;
  seq: number;
  kind: AuditKind;
  state: string | null;
  symbol: string;
  timeframe: string;
  timestamp: number;
  inputDataHash: string;
  dataFreshnessMs: number | null;
  dataValid: boolean | null;
  roomVerdicts: Record<string, unknown>;
  riskResult: unknown | null;
  verifierResult: unknown | null;
  decision: string | null;
  reason: string | null;
  configVersion: string;
  configFingerprint: string;
  idempotencyKey: string;
  detail: unknown;
}
export interface StoredAuditEvent extends AuditEvent { prevHash: string; rowHash: string }
export interface ChainVerification { ok: boolean; events: number; problem?: string }

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: sorted keys, undefined dropped, non-finite numbers become null. Used for hashing and for what is stored. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (v === undefined || typeof v === "function") return null;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}
/** What is stored: the canonical (JSON round-tripped) form, identical in every store implementation. */
export const normalizeEvent = (e: AuditEvent): AuditEvent => JSON.parse(canonical(e)) as AuditEvent;
export const hashEvent = (prevHash: string, e: AuditEvent): string => createHash("sha256").update(`${prevHash}\n${canonical(e)}`).digest("hex");

export class AuditSequenceError extends Error {
  constructor(message: string) { super(message); this.name = "AuditSequenceError"; }
}

export interface AuditStore {
  /** Appends one event. Returns null when an event with the same idempotencyKey already exists (exactly-once; nothing is overwritten). */
  append(event: AuditEvent): Promise<StoredAuditEvent | null>;
  read(correlationId: string): Promise<StoredAuditEvent[]>;
  verifyChain(correlationId: string): Promise<ChainVerification>;
}

export function verifyChainOf(events: StoredAuditEvent[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const { prevHash, rowHash, ...event } = events[i];
    if (event.seq !== i) return { ok: false, events: events.length, problem: `seq gap at position ${i} (found ${event.seq})` };
    if (prevHash !== prev) return { ok: false, events: events.length, problem: `broken link at seq ${i}` };
    if (hashEvent(prev, event as AuditEvent) !== rowHash) return { ok: false, events: events.length, problem: `content hash mismatch at seq ${i}` };
    prev = rowHash;
  }
  return { ok: true, events: events.length };
}

/** In-process store with the same contract as the Postgres store: used by unit tests and when no database is configured. NOT durable. */
export class InMemoryAuditStore implements AuditStore {
  private readonly rows = new Map<string, StoredAuditEvent[]>();
  private readonly keys = new Set<string>();

  async append(event: AuditEvent): Promise<StoredAuditEvent | null> {
    if (this.keys.has(event.idempotencyKey)) return null;
    const list = this.rows.get(event.correlationId) ?? [];
    if (event.seq !== list.length) throw new AuditSequenceError(`expected seq ${list.length}, got ${event.seq}`);
    const e = normalizeEvent(event);
    const prevHash = list.length ? list[list.length - 1].rowHash : GENESIS_HASH;
    const stored: StoredAuditEvent = { ...e, prevHash, rowHash: hashEvent(prevHash, e) };
    list.push(Object.freeze(stored) as StoredAuditEvent);
    this.rows.set(event.correlationId, list);
    this.keys.add(event.idempotencyKey);
    return stored;
  }
  async read(correlationId: string): Promise<StoredAuditEvent[]> {
    return (this.rows.get(correlationId) ?? []).map((r) => JSON.parse(JSON.stringify(r)) as StoredAuditEvent);
  }
  async verifyChain(correlationId: string): Promise<ChainVerification> { return verifyChainOf(await this.read(correlationId)); }
}

/**
 * Crash recovery: if a run left events but no DECISION (the process died), append exactly one terminal INCONCLUSIVE decision.
 * Safe to call repeatedly and concurrently (idempotent through the fixed idempotency key).
 */
export async function recoverInterrupted(store: AuditStore, correlationId: string, now: number): Promise<"NOTHING" | "COMPLETE" | "FINALIZED"> {
  const events = await store.read(correlationId);
  if (events.length === 0) return "NOTHING";
  if (events.some((e) => e.kind === "DECISION")) return "COMPLETE";
  const last = events[events.length - 1];
  const { prevHash: _p, rowHash: _r, ...base } = last;
  void _p; void _r;
  await store.append({
    ...base, seq: last.seq + 1, kind: "DECISION", state: "RECORDED", timestamp: now, decision: "inconclusive", reason: "PROCESS_INTERRUPTED",
    idempotencyKey: `${correlationId}:INTERRUPTED`, detail: { recoveredAfterSeq: last.seq },
  }).catch((e: unknown) => { if (!(e instanceof AuditSequenceError)) throw e; });
  return "FINALIZED";
}
