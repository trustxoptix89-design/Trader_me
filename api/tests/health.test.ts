import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../orchestrator/audit.postgres";
import { createAuditRuntime } from "../orchestrator/runtime";
import { healthRoutes } from "../routes/health";
import { createMemoryStore } from "../ingest/store";

const NOW = 1_800_000_000_000;
const fakeDb = (fail = false): SqlExecutor => ({
  async query(text) {
    if (fail) throw new Error("connection refused");
    if (text.includes("kind = 'DECISION'")) return [{ t: String(NOW - 1000) }];
    if (text.includes("max(ts)")) return [{ t: String(NOW - 500) }];
    return [{ "?column?": 1 }];
  },
});

describe("GET /api/health (in-memory fakes)", () => {
  const candleStore = createMemoryStore();
  it("200 with V6 fields when the database answers", async () => {
    await candleStore.insertCandles([{ symbol: "BTCUSDT", timeframe: "1h", openTime: NOW - 3_600_000, open: 1, high: 2, low: 1, close: 2, volume: 1, source: "binance" }]);
    const app = healthRoutes({ candleStore, db: fakeDb(), audit: createAuditRuntime({ executor: fakeDb() }), now: () => NOW });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const b = await res.json() as Record<string, unknown>;
    expect(b).toMatchObject({ ok: true, db_status: "ok", last_candle_at: NOW - 3_600_000, freshness_ms: 3_600_000, stale: false, data_source_active: "binance", last_agent_run_at: NOW - 500, last_signal_at: NOW - 1000, real_trading_enabled: false });
    expect(b.audit).toEqual({ store: "postgres", durable: true });
  });
  it("503 and db_status=down when the database errors", async () => {
    const app = healthRoutes({ candleStore, db: fakeDb(true), audit: createAuditRuntime({}), now: () => NOW });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db_status: "down", audit: { store: "memory", durable: false } });
  });
  it("no database -> not_configured, 503, null signal fields", async () => {
    const app = healthRoutes({ candleStore: createMemoryStore(), db: null, audit: createAuditRuntime({}), now: () => NOW });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ db_status: "not_configured", last_candle_at: null, freshness_ms: null, stale: true, last_agent_run_at: null, last_signal_at: null });
  });
});
