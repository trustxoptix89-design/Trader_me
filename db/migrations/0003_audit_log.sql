-- Phase D hardening: durable append-only audit_log (PDF section 6).
-- Append-only is enforced by the database itself (triggers reject UPDATE, DELETE and TRUNCATE) and every row is hash-chained
-- (prev_hash -> row_hash) per correlation_id, so a bypass by a superuser is still detectable by the application's verifyChain.
CREATE TABLE IF NOT EXISTS sarmaye.audit_log (
  id bigserial PRIMARY KEY,
  correlation_id text NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  state text,
  symbol varchar(24) NOT NULL,
  timeframe varchar(8) NOT NULL,
  ts bigint NOT NULL,
  input_data_hash text NOT NULL,
  data_freshness_ms double precision,
  data_valid boolean,
  room_verdicts jsonb NOT NULL,
  risk_result jsonb,
  verifier_result jsonb,
  decision text,
  reason text,
  config_version text NOT NULL,
  config_fingerprint text NOT NULL,
  idempotency_key text NOT NULL,
  detail jsonb,
  prev_hash text NOT NULL,
  row_hash text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_kind_valid CHECK (kind IN ('STATE_TRANSITION','ROOM_VERDICT','VERIFIER_RESULT','DECISION','ERROR')),
  CONSTRAINT audit_log_seq_nonneg CHECK (seq >= 0),
  CONSTRAINT audit_log_decision_valid CHECK (decision IS NULL OR decision IN ('approved','rejected','inconclusive'))
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_idempotency_uq ON sarmaye.audit_log (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_corr_seq_uq ON sarmaye.audit_log (correlation_id, seq);
CREATE INDEX IF NOT EXISTS audit_log_symbol_ts_idx ON sarmaye.audit_log (symbol, ts);

CREATE OR REPLACE FUNCTION sarmaye.audit_log_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'sarmaye.audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON sarmaye.audit_log;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON sarmaye.audit_log FOR EACH ROW EXECUTE FUNCTION sarmaye.audit_log_immutable();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON sarmaye.audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON sarmaye.audit_log FOR EACH STATEMENT EXECUTE FUNCTION sarmaye.audit_log_immutable();
