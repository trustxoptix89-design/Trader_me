-- Sarmaye initial schema (PostgreSQL). Idempotent: safe to re-run.
CREATE SCHEMA IF NOT EXISTS sarmaye;

DO $$ BEGIN CREATE TYPE sarmaye.exchange AS ENUM ('yahoo'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.side AS ENUM ('long','short'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.role AS ENUM ('user','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.analysis_status AS ENUM ('approved','no-entry','invalidated','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.paper_status AS ENUM ('open','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.alert_kind AS ENUM ('price-above','price-below','signal','data-outage'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sarmaye.event_level AS ENUM ('info','warn','error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sarmaye.users (
  id serial PRIMARY KEY,
  "unionId" varchar(255) NOT NULL UNIQUE,
  name varchar(255),
  email varchar(320),
  avatar text,
  role sarmaye.role NOT NULL DEFAULT 'user',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "lastSignInAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.risk_settings (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL UNIQUE,
  equity double precision NOT NULL DEFAULT 10000,
  "riskPerTradePct" double precision NOT NULL DEFAULT 0.5,
  "maxDailyLossPct" double precision NOT NULL DEFAULT 2,
  "maxDrawdownPct" double precision NOT NULL DEFAULT 10,
  "maxLeverage" double precision NOT NULL DEFAULT 3,
  "maxPortfolioRiskPct" double precision NOT NULL DEFAULT 1.5,
  "maxCorrelatedPositions" integer NOT NULL DEFAULT 1,
  "feePct" double precision NOT NULL DEFAULT 0.05,
  "slippagePct" double precision NOT NULL DEFAULT 0.02,
  "spreadPct" double precision NOT NULL DEFAULT 0.01,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.watchlist (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  symbol varchar(24) NOT NULL,
  exchange sarmaye.exchange NOT NULL DEFAULT 'yahoo',
  enabled boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_unique ON sarmaye.watchlist ("userId", symbol, exchange);

CREATE TABLE IF NOT EXISTS sarmaye.analysis_runs (
  id varchar(64) PRIMARY KEY,
  "userId" bigint,
  symbol varchar(24) NOT NULL,
  exchange sarmaye.exchange NOT NULL,
  status sarmaye.analysis_status NOT NULL,
  result jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_user_time ON sarmaye.analysis_runs ("userId", "createdAt");

CREATE TABLE IF NOT EXISTS sarmaye.backtests (
  id varchar(64) PRIMARY KEY,
  "userId" bigint NOT NULL,
  symbol varchar(24) NOT NULL,
  exchange sarmaye.exchange NOT NULL,
  interval varchar(8) NOT NULL,
  "strategyVersion" varchar(64) NOT NULL,
  result jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backtest_user_time ON sarmaye.backtests ("userId", "createdAt");

CREATE TABLE IF NOT EXISTS sarmaye.paper_trades (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  symbol varchar(24) NOT NULL,
  exchange sarmaye.exchange NOT NULL,
  side sarmaye.side NOT NULL,
  status sarmaye.paper_status NOT NULL DEFAULT 'open',
  quantity double precision NOT NULL,
  entry double precision NOT NULL,
  exit double precision,
  stop double precision NOT NULL,
  target double precision NOT NULL,
  pnl double precision,
  fees double precision NOT NULL,
  "openedAt" timestamptz NOT NULL DEFAULT now(),
  "closedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS paper_user_status ON sarmaye.paper_trades ("userId", status);

CREATE TABLE IF NOT EXISTS sarmaye.journal_entries (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  symbol varchar(24) NOT NULL,
  side sarmaye.side NOT NULL,
  entry double precision NOT NULL,
  exit double precision,
  quantity double precision NOT NULL,
  pnl double precision,
  thesis text NOT NULL,
  mistakes text,
  "tradedAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.alerts (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  symbol varchar(24) NOT NULL,
  exchange sarmaye.exchange NOT NULL,
  kind sarmaye.alert_kind NOT NULL,
  threshold double precision,
  enabled boolean NOT NULL DEFAULT true,
  "lastTriggeredAt" timestamptz,
  "lastValue" double precision,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.notifications (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  "alertId" bigint,
  kind varchar(32) NOT NULL,
  title varchar(255) NOT NULL,
  body text NOT NULL,
  "dedupeKey" varchar(255) NOT NULL UNIQUE,
  read boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.push_subscriptions (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL,
  endpoint varchar(1024) NOT NULL,
  keys jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS push_user_endpoint ON sarmaye.push_subscriptions ("userId", endpoint);

CREATE TABLE IF NOT EXISTS sarmaye.system_events (
  id serial PRIMARY KEY,
  level sarmaye.event_level NOT NULL,
  event varchar(128) NOT NULL,
  detail text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sarmaye.scheduler_state (
  id varchar(32) PRIMARY KEY,
  "lastRunAt" timestamptz,
  "lastSuccessAt" timestamptz,
  "lastError" text,
  "runCount" integer NOT NULL DEFAULT 0
);
