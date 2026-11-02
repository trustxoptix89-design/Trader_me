# Audit log: what is guaranteed, by what, and what is not

Table `sarmaye.audit_log` (migration `db/migrations/0003_audit_log.sql`), written by `PostgresAuditStore` (`api/orchestrator/audit.postgres.ts`).
Tests: `api/tests/fixtures/auditContract.ts` (run against real PostgreSQL by `api/tests/audit.postgres.test.ts` and `api/tests/e2e.scenarios.test.ts` when `DB_PROBE=true`).

## Is it really append-only?

| Layer | Guarantee | Proven by |
|---|---|---|
| Database triggers | `UPDATE`, `DELETE` and `TRUNCATE` raise `sarmaye.audit_log is append-only` for **every** role, including the table owner and superusers | contract test "the database itself rejects UPDATE, DELETE and TRUNCATE" |
| Privileges | an application role granted only `SELECT, INSERT` gets `permission denied` for UPDATE/DELETE/TRUNCATE, cannot `ALTER TABLE ... DISABLE TRIGGER` (must be owner) and cannot set `session_replication_role` | contract test "ACCESS CONTROL" |
| Constraints | `UNIQUE(idempotency_key)` makes a repeated event a no-op; `UNIQUE(correlation_id, seq)` lets one writer claim a sequence number; CHECKs restrict `kind` and `decision` | contract tests (exactly-once, concurrent writers) |
| Hash chain | `row_hash = sha256(prev_hash + canonical(event))`; edits, silent deletions and reordering are detected by `verifyChain` | contract tests "tampering ... DETECTED", "silent deletion ... detected" |

**Not absolute.** The table owner or a superuser can `ALTER TABLE ... DISABLE TRIGGER USER` or `SET session_replication_role = replica` and then change rows (both are exercised in the tests,
the second as "KNOWN LIMIT"). The database does not prevent that; the hash chain makes it *detectable*, not impossible. Anything that can drop the table can also destroy the evidence.
Operational requirements (NOT enforced by the repository): run the application with a non-owner role that has only `SELECT, INSERT` on the table and `USAGE` on `audit_log_id_seq`;
keep migrations/owner credentials out of the running service; periodically ship the latest `row_hash` of each run to storage outside the database. Tail truncation (dropping the last events
of a run) is only detectable through the required terminal DECISION event and `recoverInterrupted`.

## Failure behaviour (tested)

- database unreachable at start -> `AUDIT_UNAVAILABLE`, nothing executed, never approved, never notified;
- a write failing mid-run (including the DECISION write) -> never approved, never notified, no partial row, and the same event can be appended later;
- client disconnect + reconnect, and server-side termination of connections -> data intact, a retry continues the same chain;
- crashed run -> finalized `inconclusive / PROCESS_INTERRUPTED` exactly once, also under concurrent recovery.
