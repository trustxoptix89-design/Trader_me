import { InMemoryAuditStore, type AuditStore } from "./audit";
import { PostgresAuditStore, postgresJsExecutor, type SqlExecutor } from "./audit.postgres";

export interface AuditRuntime {
  store: AuditStore;
  kind: "postgres" | "memory";
  /** false => events vanish on restart; the health endpoint must say so. */
  durable: boolean;
}

/**
 * Picks the audit store for the running process. Postgres whenever a database is configured (or an executor is injected);
 * otherwise the in-memory store, explicitly flagged non-durable. Never silently pretends to be durable.
 */
export function createAuditRuntime(opts: { databaseUrl?: string; executor?: SqlExecutor } = {}): AuditRuntime {
  if (opts.executor) return { store: new PostgresAuditStore(opts.executor), kind: "postgres", durable: true };
  if (opts.databaseUrl) return { store: new PostgresAuditStore(postgresJsExecutor()), kind: "postgres", durable: true };
  return { store: new InMemoryAuditStore(), kind: "memory", durable: false };
}

let shared: AuditRuntime | null = null;
/** Process-wide singleton used by the scheduler/routes so every run shares one audit trail. */
export function getAuditRuntime(): AuditRuntime {
  shared ??= createAuditRuntime({ databaseUrl: process.env.DATABASE_URL });
  return shared;
}
export function resetAuditRuntimeForTests(): void { shared = null; }
