import { AuditSequenceError, GENESIS_HASH, hashEvent, normalizeEvent, verifyChainOf, type AuditEvent, type AuditStore, type ChainVerification, type StoredAuditEvent } from "./audit";

/** The only database capability the store needs: one parameterised statement returning rows. No multi-statement transaction is required (see append). */
export interface SqlExecutor { query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> }

/** Production adapter over the shared postgres.js client (same connection the migrations and the rest of the API use). Loaded lazily so importing the store needs no database driver. */
export function postgresJsExecutor(): SqlExecutor {
  return {
    query: async (text, params = []) => {
      const { getSql } = await import("../queries/connection");
      return (await getSql().unsafe(text, params as never)) as unknown as Record<string, unknown>[];
    },
  };
}

const COLUMNS = "correlation_id, seq, kind, state, symbol, timeframe, ts, input_data_hash, data_freshness_ms, data_valid, room_verdicts, risk_result, verifier_result, decision, reason, config_version, config_fingerprint, idempotency_key, detail, prev_hash, row_hash";

function rowToEvent(r: Record<string, unknown>): StoredAuditEvent {
  const maybe = <T>(v: unknown): T | null => (v === undefined ? null : (v as T));
  return {
    correlationId: String(r.correlation_id), seq: Number(r.seq), kind: r.kind as StoredAuditEvent["kind"], state: maybe<string>(r.state),
    symbol: String(r.symbol), timeframe: String(r.timeframe), timestamp: Number(r.ts), inputDataHash: String(r.input_data_hash),
    dataFreshnessMs: r.data_freshness_ms === null || r.data_freshness_ms === undefined ? null : Number(r.data_freshness_ms),
    dataValid: maybe<boolean>(r.data_valid), roomVerdicts: (r.room_verdicts ?? {}) as Record<string, unknown>,
    riskResult: maybe(r.risk_result), verifierResult: maybe(r.verifier_result), decision: maybe<string>(r.decision), reason: maybe<string>(r.reason),
    configVersion: String(r.config_version), configFingerprint: String(r.config_fingerprint), idempotencyKey: String(r.idempotency_key),
    detail: maybe(r.detail), prevHash: String(r.prev_hash), rowHash: String(r.row_hash),
  };
}

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

/**
 * Durable audit store on Postgres (table sarmaye.audit_log, migration 0003).
 * append() is a read-then-conditional-insert, safe without a transaction because:
 *  - UNIQUE(idempotency_key) + ON CONFLICT DO NOTHING makes a repeated event a no-op (exactly once, never an overwrite);
 *  - UNIQUE(correlation_id, seq) lets only one concurrent writer claim a seq; the loser re-reads and either sees its own event
 *    already stored (duplicate) or gets an AuditSequenceError;
 *  - the database triggers reject UPDATE / DELETE / TRUNCATE.
 */
export class PostgresAuditStore implements AuditStore {
  constructor(private readonly db: SqlExecutor = postgresJsExecutor()) {}

  async append(event: AuditEvent, attempt = 0): Promise<StoredAuditEvent | null> {
    const e = normalizeEvent(event);
    const dup = await this.db.query("SELECT 1 FROM sarmaye.audit_log WHERE idempotency_key = $1", [e.idempotencyKey]);
    if (dup.length) return null;
    const prev = await this.db.query("SELECT seq, row_hash FROM sarmaye.audit_log WHERE correlation_id = $1 ORDER BY seq DESC LIMIT 1", [e.correlationId]);
    const expected = prev.length ? Number(prev[0].seq) + 1 : 0;
    if (e.seq !== expected) throw new AuditSequenceError(`expected seq ${expected}, got ${e.seq}`);
    const prevHash = prev.length ? String(prev[0].row_hash) : GENESIS_HASH;
    const rowHash = hashEvent(prevHash, e);
    try {
      const rows = await this.db.query(
        `INSERT INTO sarmaye.audit_log (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19::jsonb,$20,$21)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
        [e.correlationId, e.seq, e.kind, e.state, e.symbol, e.timeframe, e.timestamp, e.inputDataHash, e.dataFreshnessMs, e.dataValid,
          JSON.stringify(e.roomVerdicts), e.riskResult === null ? null : JSON.stringify(e.riskResult), e.verifierResult === null ? null : JSON.stringify(e.verifierResult),
          e.decision, e.reason, e.configVersion, e.configFingerprint, e.idempotencyKey, e.detail === null ? null : JSON.stringify(e.detail), prevHash, rowHash],
      );
      return rows.length ? rowToEvent(rows[0]) : null;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 3) return this.append(event, attempt + 1); // a concurrent writer took this seq: re-read and decide
      throw err;
    }
  }

  async read(correlationId: string): Promise<StoredAuditEvent[]> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM sarmaye.audit_log WHERE correlation_id = $1 ORDER BY seq ASC`, [correlationId]);
    return rows.map(rowToEvent);
  }

  async verifyChain(correlationId: string): Promise<ChainVerification> { return verifyChainOf(await this.read(correlationId)); }
}
