import type { AuditEvent, AuditStore, StoredAuditEvent } from "../orchestrator/audit";
import { PostgresAuditStore, type SqlExecutor } from "../orchestrator/audit.postgres";
import { PostgresAgentRunStore, type AgentRunRecord, type AgentRunStore } from "../orchestrator/agentRuns";

/**
 * P3 transaction boundary: the per-agent run rows and the AGENTS_RUN audit event are written together or not at all.
 * `audit` is null when the identical event already existed (a re-run); `runsInserted` counts rows that were new.
 */
export interface AtomicAgentsRunRecorder {
  record(runs: AgentRunRecord[], event: AuditEvent): Promise<{ audit: StoredAuditEvent | null; runsInserted: number }>;
}

export class TransactionUnsupportedError extends Error {
  constructor() { super("TRANSACTION_UNSUPPORTED: this SQL executor cannot run an atomic unit of work"); this.name = "TransactionUnsupportedError"; }
}

/** One database transaction over agent_runs + audit_log. Any failure (conflict, constraint, lost connection) rolls back BOTH; nothing is written non-atomically as a fallback. */
export class PostgresAgentsRunRecorder implements AtomicAgentsRunRecorder {
  constructor(private readonly db: SqlExecutor) {}
  async record(runs: AgentRunRecord[], event: AuditEvent): Promise<{ audit: StoredAuditEvent | null; runsInserted: number }> {
    const tx = this.db.transaction?.bind(this.db);
    if (!tx) throw new TransactionUnsupportedError();
    return tx(async (t) => {
      const runStore = new PostgresAgentRunStore(t), audit = new PostgresAuditStore(t);
      let runsInserted = 0;
      for (const r of runs) if (await runStore.append(r)) runsInserted++;
      return { audit: await audit.append(event), runsInserted };
    });
  }
}

/** Sequential test double for wiring tests. NOT atomic: atomicity is proven only on PostgresAgentsRunRecorder. */
export class SequentialAgentsRunRecorder implements AtomicAgentsRunRecorder {
  constructor(private readonly audit: AuditStore, private readonly runs: AgentRunStore) {}
  async record(runs: AgentRunRecord[], event: AuditEvent): Promise<{ audit: StoredAuditEvent | null; runsInserted: number }> {
    let runsInserted = 0;
    for (const r of runs) if (await this.runs.append(r)) runsInserted++;
    return { audit: await this.audit.append(event), runsInserted };
  }
}

// ---------------------------------------------------------------- reconciliation

export type ReconcileIssueKind = "AUDIT_WITHOUT_RUNS" | "RUNS_WITHOUT_AUDIT" | "KEY_MISMATCH";
export interface ReconcileIssue { signalId: string; kind: ReconcileIssueKind; missingInRuns: string[]; missingInAudit: string[] }

/** Pure comparison. `auditKeys` null = no AGENTS_RUN event tracked agent runs for this signal. */
export function compareAgentRuns(signalId: string, auditKeys: string[] | null, runKeys: string[]): ReconcileIssue | null {
  if (auditKeys === null) return runKeys.length ? { signalId, kind: "RUNS_WITHOUT_AUDIT", missingInRuns: [], missingInAudit: [...runKeys].sort() } : null;
  const a = new Set(auditKeys), r = new Set(runKeys);
  const missingInRuns = auditKeys.filter((k) => !r.has(k)).sort(), missingInAudit = runKeys.filter((k) => !a.has(k)).sort();
  if (!missingInRuns.length && !missingInAudit.length) return null;
  return { signalId, kind: r.size === 0 ? "AUDIT_WITHOUT_RUNS" : "KEY_MISMATCH", missingInRuns, missingInAudit };
}

/**
 * Compares every AGENTS_RUN audit event that declares `agentRunKeys` with the agent_runs rows of the same signal. Read-only.
 * Events written before this feature (no `agentRunKeys` in detail) are not tracked and are not reported.
 */
export async function reconcileAgentRuns(db: SqlExecutor, signalId?: string): Promise<ReconcileIssue[]> {
  const w = signalId === undefined ? "" : " AND correlation_id = $1";
  const audit = await db.query(`SELECT correlation_id, detail FROM sarmaye.audit_log WHERE kind = 'STATE_TRANSITION' AND state = 'AGENTS_RUN'${w}`, signalId === undefined ? [] : [signalId]);
  const runs = await db.query(`SELECT signal_id, idempotency_key FROM sarmaye.agent_runs${signalId === undefined ? "" : " WHERE signal_id = $1"}`, signalId === undefined ? [] : [signalId]);
  const auditBy = new Map<string, string[]>(), runsBy = new Map<string, string[]>();
  for (const r of audit) {
    const keys = (r.detail as { agentRunKeys?: unknown } | null)?.agentRunKeys;
    if (Array.isArray(keys)) auditBy.set(String(r.correlation_id), keys.map(String));
  }
  for (const r of runs) { const id = String(r.signal_id); runsBy.set(id, [...(runsBy.get(id) ?? []), String(r.idempotency_key)]); }
  const issues: ReconcileIssue[] = [];
  for (const id of new Set([...auditBy.keys(), ...runsBy.keys()])) {
    const issue = compareAgentRuns(id, auditBy.get(id) ?? null, runsBy.get(id) ?? []);
    if (issue) issues.push(issue);
  }
  return issues.sort((x, y) => x.signalId.localeCompare(y.signalId));
}
