-- Phase C: per-agent run records (V6 section 6, table agent_runs).
-- Deviations from the V6 column list, all forced by the current schema and documented in docs/AGENT_RUNS.md:
--  * signal_id is plain text (the pipeline signalId = audit_log.correlation_id); there is no `signals` table yet, so no FK.
--  * `group` is stored as agent_group (GROUP is a reserved SQL word).
--  * extra columns: run_at (the V6 "timestamp"), idempotency_key and row_hash (exactly-once + tamper detection).
-- Rows are immutable: the same trigger pattern as audit_log rejects UPDATE, DELETE and TRUNCATE.
CREATE TABLE IF NOT EXISTS sarmaye.agent_runs (
  id bigserial PRIMARY KEY,
  signal_id text NOT NULL,
  agent_id varchar(40) NOT NULL,
  agent_version varchar(16) NOT NULL,
  agent_group char(1) NOT NULL,
  run_at bigint NOT NULL,
  input_hash text NOT NULL,
  input_refs_json jsonb NOT NULL,
  timeframes_json jsonb NOT NULL,
  findings_json jsonb NOT NULL,
  confidence double precision NOT NULL,
  confidence_meaning text NOT NULL,
  missing_info text,
  contradictions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  abstained boolean NOT NULL,
  error text,
  validation_outcome text NOT NULL,
  idempotency_key text NOT NULL,
  row_hash text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_outcome_valid CHECK (validation_outcome IN ('OK','ABSTAIN','ERROR')),
  CONSTRAINT agent_runs_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT agent_runs_group_valid CHECK (agent_group IN ('A','B','C','D','E')),
  CONSTRAINT agent_runs_abstain_consistent CHECK (abstained = (validation_outcome = 'ABSTAIN')),
  CONSTRAINT agent_runs_error_consistent CHECK ((validation_outcome = 'ERROR') = (error IS NOT NULL)),
  CONSTRAINT agent_runs_abstain_has_reason CHECK (NOT abstained OR (missing_info IS NOT NULL AND missing_info <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_idempotency_uq ON sarmaye.agent_runs (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_signal_agent_uq ON sarmaye.agent_runs (signal_id, agent_id);

CREATE OR REPLACE FUNCTION sarmaye.agent_runs_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'sarmaye.agent_runs is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_runs_no_update_delete ON sarmaye.agent_runs;
CREATE TRIGGER agent_runs_no_update_delete BEFORE UPDATE OR DELETE ON sarmaye.agent_runs FOR EACH ROW EXECUTE FUNCTION sarmaye.agent_runs_immutable();
DROP TRIGGER IF EXISTS agent_runs_no_truncate ON sarmaye.agent_runs;
CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON sarmaye.agent_runs FOR EACH STATEMENT EXECUTE FUNCTION sarmaye.agent_runs_immutable();
