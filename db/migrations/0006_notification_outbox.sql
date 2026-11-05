-- P5: internal notification Outbox (log channel only). At-least-once delivery; unique (signal_id, channel, kind) prevents duplicate enqueue.
-- Rows are mutable by design (status / attempts / lease); deliveries are append-only evidence of what the log channel emitted.
CREATE TABLE IF NOT EXISTS sarmaye.notification_outbox (
  id bigserial PRIMARY KEY,
  signal_id text NOT NULL,
  cycle_key text NOT NULL,
  channel text NOT NULL,
  kind text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  locked_by text,
  locked_until bigint,
  last_error text,
  created_at bigint NOT NULL,
  sent_at bigint,
  CONSTRAINT outbox_channel_valid CHECK (channel IN ('log')),
  CONSTRAINT outbox_kind_valid CHECK (kind IN ('NEW_CYCLE','NEW_VERSION')),
  CONSTRAINT outbox_status_valid CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
  CONSTRAINT outbox_attempts_nonneg CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_identity_uq ON sarmaye.notification_outbox (signal_id, channel, kind);
CREATE INDEX IF NOT EXISTS notification_outbox_due_ix ON sarmaye.notification_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS sarmaye.outbox_deliveries (
  id bigserial PRIMARY KEY,
  outbox_id bigint NOT NULL,
  channel text NOT NULL,
  line text NOT NULL,
  delivered_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_deliveries_once_uq ON sarmaye.outbox_deliveries (outbox_id);
