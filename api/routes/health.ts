import { Hono } from "hono";
import { computeFreshness, type CandleStore } from "../ingest/ingest";
import { TF_MS, type Timeframe } from "../ingest/providers";
import type { SqlExecutor } from "../orchestrator/audit.postgres";
import type { AuditRuntime } from "../orchestrator/runtime";

export interface HealthDeps {
  candleStore: CandleStore;
  /** null when no database is configured. */
  db: SqlExecutor | null;
  audit: AuditRuntime;
  symbol?: string;
  timeframe?: Timeframe;
  now?: () => number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** GET /api/health — V6 phase G fields: db_status, last_candle_at, freshness_ms, last_agent_run_at, last_signal_at, data_source_active. 200 only when the database answers. */
export function healthRoutes(deps: HealthDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const symbol = deps.symbol ?? "BTCUSDT";
  const timeframe = deps.timeframe ?? "1h";
  app.get("/", async (c) => {
    let dbStatus: "ok" | "down" | "not_configured" = "not_configured";
    let lastAgentRunAt: number | null = null;
    let lastSignalAt: number | null = null;
    if (deps.db) {
      try {
        await deps.db.query("SELECT 1");
        dbStatus = "ok";
        const a = await deps.db.query("SELECT max(ts) AS t FROM sarmaye.audit_log");
        lastAgentRunAt = num(a[0]?.t);
        const s = await deps.db.query("SELECT max(ts) AS t FROM sarmaye.audit_log WHERE kind = 'DECISION' AND decision = 'approved'");
        lastSignalAt = num(s[0]?.t);
      } catch { dbStatus = "down"; }
    }
    let lastCandleAt: number | null = null;
    let dataSource: string | null = null;
    try {
      const rows = await deps.candleStore.getCandles(symbol, timeframe, 1);
      lastCandleAt = rows.at(-1)?.openTime ?? null;
      dataSource = rows.at(-1)?.source ?? null;
    } catch { /* reported as null candle fields */ }
    const fresh = computeFreshness(lastCandleAt, timeframe, now());
    const ok = dbStatus === "ok";
    return c.json({
      ok, db_status: dbStatus, last_candle_at: lastCandleAt, freshness_ms: fresh.freshnessMs, stale: fresh.stale,
      last_agent_run_at: lastAgentRunAt, last_signal_at: lastSignalAt, data_source_active: dataSource,
      audit: { store: deps.audit.kind, durable: deps.audit.durable },
      series: { symbol, timeframe, bar_ms: TF_MS[timeframe] }, server_time: now(), real_trading_enabled: false,
    }, ok ? 200 : 503);
  });
  return app;
}
