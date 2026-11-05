-- P2: append-only history of Setup cycles (contract: docs/PIPELINE_CONTRACT.md §4). Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS sarmaye.signal_cycle_events (
  id bigserial PRIMARY KEY,
  cycle_key text NOT NULL,
  seq integer NOT NULL,
  cycle_no integer NOT NULL,
  version integer NOT NULL,
  kind text NOT NULL,
  signal_key text NOT NULL,
  direction text NOT NULL,
  setup_fingerprint text NOT NULL,
  setup_json jsonb NOT NULL,
  closed_candle_open_time bigint NOT NULL,
  status_after text NOT NULL,
  row_hash text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_cycle_events_kind_ck CHECK (kind IN ('NEW_CYCLE','NEW_VERSION','CONTINUED','INVALIDATED','SUPPRESSED')),
  CONSTRAINT signal_cycle_events_status_ck CHECK (status_after IN ('ACTIVE','INVALIDATED')),
  CONSTRAINT signal_cycle_events_direction_ck CHECK (direction IN ('long','short')),
  CONSTRAINT signal_cycle_events_seq_ck CHECK (seq >= 0 AND cycle_no >= 1 AND version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_cycle_events_cycle_seq_uq ON sarmaye.signal_cycle_events (cycle_key, seq);
CREATE UNIQUE INDEX IF NOT EXISTS signal_cycle_events_signal_kind_uq ON sarmaye.signal_cycle_events (signal_key, kind);

CREATE OR REPLACE FUNCTION sarmaye.signal_cycle_events_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'sarmaye.signal_cycle_events is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS signal_cycle_events_no_update_delete ON sarmaye.signal_cycle_events;
CREATE TRIGGER signal_cycle_events_no_update_delete BEFORE UPDATE OR DELETE ON sarmaye.signal_cycle_events FOR EACH ROW EXECUTE FUNCTION sarmaye.signal_cycle_events_immutable();
DROP TRIGGER IF EXISTS signal_cycle_events_no_truncate ON sarmaye.signal_cycle_events;
CREATE TRIGGER signal_cycle_events_no_truncate BEFORE TRUNCATE ON sarmaye.signal_cycle_events FOR EACH STATEMENT EXECUTE FUNCTION sarmaye.signal_cycle_events_immutable();
