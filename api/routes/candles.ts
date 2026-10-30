import { Hono } from "hono";
import { BlockedSourceDataError, computeFreshness, ingest, isTimeframe, isValidSymbol, type CandleStore, type IngestOptions, type IngestResult } from "../ingest/ingest";
import { createPgStore } from "../ingest/store";
import { TF_MS, type Timeframe } from "../ingest/providers";
import { log } from "../lib/logger";

/** Fixed-window per-key limiter (spec 7.6: at least 60 requests/minute per public endpoint). */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) { hits.set(key, { start: t, count: 1 }); if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k); return true; }
    h.count++;
    return h.count <= max;
  };
}

const clientKey = (header: string | undefined) => header?.split(",")[0]?.trim() || "local";

export interface CandlesDeps {
  store?: CandleStore;
  ingestFn?: (store: CandleStore, symbol: string, timeframe: Timeframe, options?: IngestOptions) => Promise<IngestResult>;
  now?: () => number;
  /** Do not hit the sources again for the same series within this window, even if the stored data is stale. */
  refreshCooldownMs?: number;
}

/** GET /api/candles?symbol=BTCUSDT&timeframe=1h&limit=200 — serves stored candles, refreshing through the cascade when the series is empty or stale. */
export function candlesRoutes(deps: CandlesDeps = {}) {
  const app = new Hono();
  const limiter = createRateLimiter(60, 60_000, deps.now);
  const now = deps.now ?? Date.now;
  const run = deps.ingestFn ?? ingest;
  const cooldown = deps.refreshCooldownMs ?? 30_000;
  const inflight = new Map<string, Promise<IngestResult>>();
  const lastAttempt = new Map<string, number>();
  let store = deps.store;

  app.get("/", async (c) => {
    if (!limiter(clientKey(c.req.header("x-forwarded-for")))) return c.json({ error: "RATE_LIMITED" }, 429);
    const symbol = (c.req.query("symbol") ?? "").toUpperCase();
    const timeframe = c.req.query("timeframe") ?? "";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 200 : Number(limitRaw);
    if (!isValidSymbol(symbol)) return c.json({ error: "INVALID_PARAMS", detail: "symbol must look like BTCUSDT" }, 400);
    if (!isTimeframe(timeframe)) return c.json({ error: "INVALID_PARAMS", detail: `timeframe must be one of ${Object.keys(TF_MS).join(", ")}` }, 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return c.json({ error: "INVALID_PARAMS", detail: "limit must be an integer 1..500" }, 400);

    store ??= createPgStore();
    const key = `${symbol}:${timeframe}`;
    let rows = await store.getCandles(symbol, timeframe, limit);
    let { stale } = computeFreshness(rows.at(-1)?.openTime ?? null, timeframe, now());
    let refreshed = false;
    let refreshError: { code: string; attempts: { source: string; httpStatus: number | null; code: string }[] } | null = null;

    if (stale && now() - (lastAttempt.get(key) ?? 0) >= cooldown) {
      lastAttempt.set(key, now());
      try {
        const pending = inflight.get(key) ?? run(store, symbol, timeframe, { now: now() });
        inflight.set(key, pending);
        try { await pending; } finally { inflight.delete(key); }
        refreshed = true;
        rows = await store.getCandles(symbol, timeframe, limit);
      } catch (error) {
        if (error instanceof BlockedSourceDataError) {
          refreshError = { code: error.code, attempts: error.attempts.map((a) => ({ source: a.source, httpStatus: a.httpStatus, code: a.code })) };
        } else {
          log.error("candles refresh failed", { symbol, timeframe, error: error instanceof Error ? error.message : String(error) });
          refreshError = { code: "INGEST_ERROR", attempts: [] };
        }
      }
    }

    if (!rows.length) return c.json({ error: refreshError?.code ?? "NO_DATA", symbol, timeframe, refresh_error: refreshError }, 503);
    const last = rows[rows.length - 1];
    const fresh = computeFreshness(last.openTime, timeframe, now());
    stale = fresh.stale;
    return c.json({
      symbol, timeframe, limit, count: rows.length,
      last_open_time: last.openTime, freshness_ms: fresh.freshnessMs, stale, source_active: last.source, refreshed, refresh_error: refreshError,
      candles: rows.map((r) => ({ open_time: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, source: r.source })),
    });
  });
  return app;
}

/** POST /api/ingest?symbol=&timeframe= — protected by CRON_SECRET (for an external scheduler, e.g. self-hosted n8n). */
export function ingestRoutes(deps: CandlesDeps = {}) {
  const app = new Hono();
  let store = deps.store;
  const run = deps.ingestFn ?? ingest;
  app.post("/", async (c) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return c.json({ error: "CRON_SECRET is not configured" }, 503);
    if (c.req.header("authorization") !== `Bearer ${secret}`) return c.json({ error: "Unauthorized" }, 401);
    const symbol = (c.req.query("symbol") ?? "BTCUSDT").toUpperCase();
    const timeframe = c.req.query("timeframe") ?? "1h";
    if (!isValidSymbol(symbol) || !isTimeframe(timeframe)) return c.json({ error: "INVALID_PARAMS" }, 400);
    store ??= createPgStore();
    try {
      return c.json(await run(store, symbol, timeframe));
    } catch (error) {
      if (error instanceof BlockedSourceDataError) return c.json({ error: error.code, attempts: error.attempts }, 503);
      throw error;
    }
  });
  return app;
}
