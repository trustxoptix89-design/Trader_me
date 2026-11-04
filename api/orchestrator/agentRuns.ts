import { createHash } from "node:crypto";
import type { Candle } from "@contracts/types";
import { canonical } from "./audit";
import type { SqlExecutor } from "./audit.postgres";
import { postgresJsExecutor } from "./audit.postgres";
import type { AgentVote } from "./rooms";

/**
 * Agent run records (V6 section 6 `agent_runs`, Phase C acceptance "one row per agent with input hash and timestamp").
 * Pure data layer: nothing here is called by the Scheduler, the Orchestrator or the pipeline yet (wiring is a later, separately approved step).
 * The raw candles are NOT copied into the row: input_refs_json holds the references (timeframe, count, first/last candle time)
 * and input_hash the SHA-256 of the exact numbers the agent read, so a run can be re-derived from the candles table and compared.
 */
export type RunOutcome = "OK" | "ABSTAIN" | "ERROR";
export type Tf = "4H" | "1H" | "15m" | "5m";

/** What each runnable agent reads (from the code in agents.ts / deltaAgent.ts). Verified against /agents/*.yaml by a test. */
export const AGENT_TIMEFRAMES: Record<string, readonly Tf[]> = {
  A01_STRUCTURE: ["1H"], B09_EMA_TREND: ["1H"], B10_RSI: ["1H"], B11_MACD: ["1H"], B12_BB: ["1H"], B15_STOCH_RSI: ["1H"],
  DELTA_FORCE: ["4H", "1H", "15m", "5m"],
};
export const CONFIDENCE_MEANING = "UNCALIBRATED_HEURISTIC_SCORE: not a probability of success";

export interface AgentRunRecord {
  signalId: string; agentId: string; agentVersion: string; agentGroup: string; runAt: number;
  inputHash: string; inputRefs: Record<string, { count: number; firstTime: number | null; lastTime: number | null }>; timeframes: string[];
  findings: { verdict: string | null; weight: number | null; reason: string | null; evidenceRefs: string[] };
  confidence: number; confidenceMeaning: string; missingInfo: string | null; contradictions: unknown[];
  abstained: boolean; error: string | null; validationOutcome: RunOutcome; idempotencyKey: string;
}
export interface StoredAgentRun extends AgentRunRecord { id?: number; rowHash: string }

export class AgentRunConflictError extends Error {
  constructor(message: string) { super(message); this.name = "AgentRunConflictError"; }
}

/** Deterministic, re-checkable references (V6 evidence_refs): which agent/version ran and exactly which candle ranges it read. Derived from the inputs, never invented. */
export function evidenceRefsFor(agentId: string, version: string, refs: AgentRunRecord["inputRefs"]): string[] {
  return [`agent:${agentId}@${version}`, ...Object.entries(refs).map(([tf, r]) => `candles:${tf}:${r.firstTime ?? "none"}..${r.lastTime ?? "none"}:n=${r.count}`)];
}

const sha = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
export const hashAgentRun = (r: AgentRunRecord): string => sha(r);

export function hashInputs(candles: Partial<Record<Tf, Candle[]>>, timeframes: readonly Tf[]): { inputHash: string; inputRefs: AgentRunRecord["inputRefs"] } {
  const rows: Record<string, number[][]> = {}, refs: AgentRunRecord["inputRefs"] = {};
  for (const tf of timeframes) {
    const c = candles[tf] ?? [];
    rows[tf] = c.map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume]);
    refs[tf] = { count: c.length, firstTime: c.length ? c[0].time : null, lastTime: c.length ? c[c.length - 1].time : null };
  }
  return { inputHash: sha(rows), inputRefs: refs };
}

export interface AgentFailure { agentId: string; agentGroup: string; message: string }
export interface BuildRunsInput {
  signalId: string; runAt: number; candles: Partial<Record<Tf, Candle[]>>; votes: AgentVote[]; failures?: AgentFailure[];
  /** agent_version per agentId (from /agents/*.yaml). A missing entry is recorded as "unspecified", never invented. */
  versions?: Record<string, string>;
}

/** Builds one record per vote (and per failed agent). Throws if an agent has no declared timeframes: a run without a defined input cannot be hashed honestly. */
export function buildAgentRunRecords(i: BuildRunsInput): AgentRunRecord[] {
  const version = (id: string) => i.versions?.[id] ?? "unspecified";
  const tfOf = (id: string): readonly Tf[] => {
    const t = AGENT_TIMEFRAMES[id];
    if (!t) throw new Error(`agent ${id} has no declared timeframes in AGENT_TIMEFRAMES`);
    return t;
  };
  const out: AgentRunRecord[] = [];
  for (const v of i.votes) {
    const tfs = tfOf(v.agentId), { inputHash, inputRefs } = hashInputs(i.candles, tfs), abstained = v.verdict === "abstain";
    out.push({
      signalId: i.signalId, agentId: v.agentId, agentVersion: version(v.agentId), agentGroup: v.group, runAt: i.runAt, inputHash, inputRefs, timeframes: [...tfs],
      findings: { verdict: v.verdict, weight: v.weight, reason: v.reason, evidenceRefs: evidenceRefsFor(v.agentId, version(v.agentId), inputRefs) }, confidence: abstained ? 0 : v.confidence, confidenceMeaning: CONFIDENCE_MEANING,
      missingInfo: abstained ? v.reason || "abstained without a stated reason" : null, contradictions: [], abstained, error: null,
      validationOutcome: abstained ? "ABSTAIN" : "OK", idempotencyKey: `${i.signalId}:${v.agentId}`,
    });
  }
  for (const f of i.failures ?? []) {
    const tfs = tfOf(f.agentId), { inputHash, inputRefs } = hashInputs(i.candles, tfs);
    out.push({
      signalId: i.signalId, agentId: f.agentId, agentVersion: version(f.agentId), agentGroup: f.agentGroup, runAt: i.runAt, inputHash, inputRefs, timeframes: [...tfs],
      findings: { verdict: null, weight: null, reason: null, evidenceRefs: evidenceRefsFor(f.agentId, version(f.agentId), inputRefs) }, confidence: 0, confidenceMeaning: CONFIDENCE_MEANING, missingInfo: null, contradictions: [],
      abstained: false, error: f.message, validationOutcome: "ERROR", idempotencyKey: `${i.signalId}:${f.agentId}`,
    });
  }
  return out;
}

export interface AgentRunStore {
  /** Stores one record. Returns null when the same (signal, agent) was already stored with identical content (exactly-once no-op). Throws AgentRunConflictError when it exists with DIFFERENT content. */
  append(r: AgentRunRecord): Promise<StoredAgentRun | null>;
  listBySignal(signalId: string): Promise<StoredAgentRun[]>;
}

/** Recomputes every row hash; a changed field (e.g. a superuser bypassing the triggers) is reported. */
export function verifyAgentRuns(rows: StoredAgentRun[]): { ok: boolean; checked: number; problem?: string } {
  for (const r of rows) {
    const { rowHash, id: _id, ...rec } = r;
    void _id;
    if (hashAgentRun(rec as AgentRunRecord) !== rowHash) return { ok: false, checked: rows.length, problem: `row hash mismatch for ${r.idempotencyKey}` };
  }
  return { ok: true, checked: rows.length };
}

const normalize = (r: AgentRunRecord): AgentRunRecord => JSON.parse(canonical(r)) as AgentRunRecord;

export class InMemoryAgentRunStore implements AgentRunStore {
  private rows: StoredAgentRun[] = [];
  async append(r: AgentRunRecord): Promise<StoredAgentRun | null> {
    const rec = normalize(r), rowHash = hashAgentRun(rec);
    const existing = this.rows.find((x) => x.idempotencyKey === rec.idempotencyKey || (x.signalId === rec.signalId && x.agentId === rec.agentId));
    if (existing) {
      if (existing.rowHash === rowHash) return null;
      throw new AgentRunConflictError(`agent run ${rec.idempotencyKey} already stored with different content`);
    }
    const stored = { ...rec, id: this.rows.length + 1, rowHash };
    this.rows.push(stored);
    return structuredClone(stored);
  }
  async listBySignal(signalId: string): Promise<StoredAgentRun[]> { return structuredClone(this.rows.filter((x) => x.signalId === signalId)); }
}

const COLUMNS = "id, signal_id, agent_id, agent_version, agent_group, run_at, input_hash, input_refs_json, timeframes_json, findings_json, confidence, confidence_meaning, missing_info, contradictions_json, abstained, error, validation_outcome, idempotency_key, row_hash";
function rowToRun(r: Record<string, unknown>): StoredAgentRun {
  return {
    id: Number(r.id), signalId: String(r.signal_id), agentId: String(r.agent_id), agentVersion: String(r.agent_version), agentGroup: String(r.agent_group).trim(), runAt: Number(r.run_at),
    inputHash: String(r.input_hash), inputRefs: r.input_refs_json as AgentRunRecord["inputRefs"], timeframes: r.timeframes_json as string[], findings: r.findings_json as AgentRunRecord["findings"],
    confidence: Number(r.confidence), confidenceMeaning: String(r.confidence_meaning), missingInfo: r.missing_info === null || r.missing_info === undefined ? null : String(r.missing_info),
    contradictions: (r.contradictions_json ?? []) as unknown[], abstained: Boolean(r.abstained), error: r.error === null || r.error === undefined ? null : String(r.error),
    validationOutcome: r.validation_outcome as RunOutcome, idempotencyKey: String(r.idempotency_key), rowHash: String(r.row_hash),
  };
}
const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

/** Durable store on sarmaye.agent_runs (migration 0004). jsonb parameters are passed as plain values (postgres.js would store a pre-stringified value as a JSON string). */
export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: SqlExecutor = postgresJsExecutor()) {}
  async append(r: AgentRunRecord): Promise<StoredAgentRun | null> {
    const rec = normalize(r), rowHash = hashAgentRun(rec);
    const params = [rec.signalId, rec.agentId, rec.agentVersion, rec.agentGroup, rec.runAt, rec.inputHash, rec.inputRefs, rec.timeframes, rec.findings, rec.confidence, rec.confidenceMeaning, rec.missingInfo, rec.contradictions, rec.abstained, rec.error, rec.validationOutcome, rec.idempotencyKey, rowHash];
    let inserted: Record<string, unknown>[] = [];
    try {
      inserted = await this.db.query(
        `INSERT INTO sarmaye.agent_runs (signal_id, agent_id, agent_version, agent_group, run_at, input_hash, input_refs_json, timeframes_json, findings_json, confidence, confidence_meaning, missing_info, contradictions_json, abstained, error, validation_outcome, idempotency_key, row_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`, params);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    if (inserted.length) return rowToRun(inserted[0]);
    const existing = await this.db.query("SELECT row_hash FROM sarmaye.agent_runs WHERE signal_id = $1 AND agent_id = $2", [rec.signalId, rec.agentId]);
    if (existing.length && String(existing[0].row_hash) === rowHash) return null;
    throw new AgentRunConflictError(`agent run ${rec.idempotencyKey} already stored with different content`);
  }
  async listBySignal(signalId: string): Promise<StoredAgentRun[]> {
    return (await this.db.query(`SELECT ${COLUMNS} FROM sarmaye.agent_runs WHERE signal_id = $1 ORDER BY id`, [signalId])).map(rowToRun);
  }
}
