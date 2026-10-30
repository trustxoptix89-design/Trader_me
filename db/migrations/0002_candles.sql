-- Phase A: candles + gap log. Idempotent: safe to re-run.
-- UNIQUE(symbol, timeframe, open_time) is also the lookup index (symbol, timeframe, open_time), so no second index is needed.
CREATE TABLE IF NOT EXISTS sarmaye.candles (
  id serial PRIMARY KEY,
  symbol varchar(24) NOT NULL,
  timeframe varchar(8) NOT NULL,
  open_time bigint NOT NULL,
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  volume double precision NOT NULL,
  source varchar(24) NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candles_ohlcv_valid CHECK (high >= low AND close >= low AND close <= high AND volume >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS candles_symbol_tf_open_time_uq ON sarmaye.candles (symbol, timeframe, open_time);

CREATE TABLE IF NOT EXISTS sarmaye.candle_gaps (
  id serial PRIMARY KEY,
  symbol varchar(24) NOT NULL,
  timeframe varchar(8) NOT NULL,
  from_open_time bigint NOT NULL,
  to_open_time bigint NOT NULL,
  missing_bars integer NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS candle_gaps_uq ON sarmaye.candle_gaps (symbol, timeframe, from_open_time, to_open_time);
