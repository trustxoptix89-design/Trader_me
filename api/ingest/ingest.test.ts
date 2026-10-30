import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@contracts/types";
import { BlockedSourceDataError, computeFreshness, findGaps, ingest, runCascade, sanitizeCandles, validateCandle } from "./ingest";
import { binance, coingecko, cryptocompare, TF_MS, UnsupportedTimeframe, yahoo, type Provider, type ProviderResult } from "./providers";
import { createMemoryStore } from "./store";
import { IngestHttpError } from "./http";
import { candlesRoutes, createRateLimiter, ingestRoutes } from "../routes/candles";

const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H);
const candle = (i: number, over: Partial<Candle> = {}): Candle => ({ time: T0 + i * H, closeTime: T0 + (i + 1) * H - 1, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 10, ...over });
const series = (n: number) => Array.from({ length: n }, (_, i) => candle(i));
const ok = (name: Provider["name"], candles: Candle[], status = 200): Provider => ({ name, fetch: async (): Promise<ProviderResult> => ({ candles, httpStatus: status, rawSample: { raw: name } }) });
const fail = (name: Provider["name"], status: number | null): Provider => ({ name, fetch: async () => { throw new IngestHttpError(name, status, status === null ? "network error: boom" : `HTTP ${status}`); } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("validation (spec 6)", () => {
  it("accepts a sane candle", () => expect(validateCandle(candle(0))).toBeNull());
  it("rejects high < low", () => expect(validateCandle(candle(0, { high: 90, low: 95 }))).toBe("high < low"));
  it("rejects close outside [low, high]", () => expect(validateCandle(candle(0, { close: 200 }))).toBe("close outside [low, high]"));
  it("rejects negative volume but accepts zero volume", () => {
    expect(validateCandle(candle(0, { volume: -1 }))).toBe("negative volume");
    expect(validateCandle(candle(0, { volume: 0 }))).toBeNull();
  });
  it("rejects NaN and non-positive prices", () => {
    expect(validateCandle(candle(0, { open: NaN }))).toBe("non-finite value");
    expect(validateCandle(candle(0, { open: 0, low: 0 }))).toBe("non-positive price");
  });
  it("sanitize: drops invalid rows, de-duplicates by open time (first wins) and sorts ascending", () => {
    const dup = candle(1, { close: 101 });
    const r = sanitizeCandles([candle(2), candle(1), dup, candle(0, { high: 1 })]);
    expect(r.valid.map((c) => c.time)).toEqual([T0 + H, T0 + 2 * H]);
    expect(r.valid[0].close).toBe(103);
    expect(r.duplicates).toBe(1);
    expect(r.rejected).toEqual([{ time: T0, reason: "high < low" }]);
  });
});

describe("gap detection (spec 7)", () => {
  it("records a gap only when two opens are more than 1.5×timeframe apart", () => {
    const c = [candle(0), candle(1), candle(4), candle(5)];
    expect(findGaps(c, "BTCUSDT", "1h")).toEqual([{ symbol: "BTCUSDT", timeframe: "1h", fromOpenTime: T0 + H, toOpenTime: T0 + 4 * H, missingBars: 2 }]);
    expect(findGaps(series(5), "BTCUSDT", "1h")).toEqual([]);
    expect(findGaps([candle(0), candle(1, { time: T0 + 1.5 * H })], "BTCUSDT", "1h")).toEqual([]);
  });
});

describe("freshness (spec 3)", () => {
  it("freshness_ms = now − last open; stale only above 2×timeframe", () => {
    expect(computeFreshness(T0, "1h", T0 + 2 * H)).toEqual({ freshnessMs: 2 * H, stale: false });
    expect(computeFreshness(T0, "1h", T0 + 2 * H + 1)).toEqual({ freshnessMs: 2 * H + 1, stale: true });
    expect(computeFreshness(null, "1h").stale).toBe(true);
  });
});

describe("cascade (spec 4, 5)", () => {
  it("uses the first source when it succeeds and does not call the others", async () => {
    const second = vi.fn();
    const r = await runCascade("BTCUSDT", "1h", 200, { providers: [ok("coingecko", series(5)), { name: "cryptocompare", fetch: second }] });
    expect(r.source).toBe("coingecko");
    expect(second).not.toHaveBeenCalled();
  });
  it("moves to the next source on 403 and on 429 without retrying", async () => {
    const f403 = vi.fn(async () => { throw new IngestHttpError("coingecko", 403, "HTTP 403"); });
    const f429 = vi.fn(async () => { throw new IngestHttpError("cryptocompare", 429, "HTTP 429"); });
    const r = await runCascade("BTCUSDT", "1h", 200, { providers: [{ name: "coingecko", fetch: f403 }, { name: "cryptocompare", fetch: f429 }, ok("binance", series(3))] });
    expect(r.source).toBe("binance");
    expect(f403).toHaveBeenCalledTimes(1);
    expect(f429).toHaveBeenCalledTimes(1);
    expect(r.attempts.map((a) => [a.source, a.httpStatus, a.code])).toEqual([["coingecko", 403, "HTTP_403"], ["cryptocompare", 429, "HTTP_429"], ["binance", 200, "OK"]]);
  });
  it("retries a network error exactly once on the same source, then succeeds", async () => {
    let calls = 0;
    const flaky: Provider = { name: "coingecko", fetch: async () => { if (++calls === 1) throw new IngestHttpError("coingecko", null, "network error"); return { candles: series(3), httpStatus: 200, rawSample: null }; } };
    const r = await runCascade("BTCUSDT", "1h", 200, { providers: [flaky, ok("yahoo", series(3))] });
    expect(calls).toBe(2);
    expect(r.source).toBe("coingecko");
    expect(r.attempts[0].retried).toBe(true);
  });
  it("a persistent network error is retried once and then the next source is used", async () => {
    let calls = 0;
    const dead: Provider = { name: "coingecko", fetch: async () => { calls++; throw new IngestHttpError("coingecko", null, "network error"); } };
    const r = await runCascade("BTCUSDT", "1h", 200, { providers: [dead, ok("cryptocompare", series(3))] });
    expect(calls).toBe(2);
    expect(r.source).toBe("cryptocompare");
  });
  it("skips a source that has no such timeframe, and a source that returns only invalid candles", async () => {
    const unsupported: Provider = { name: "coingecko", fetch: async () => { throw new UnsupportedTimeframe("coingecko", "15m"); } };
    const r = await runCascade("BTCUSDT", "15m", 200, { providers: [unsupported, ok("cryptocompare", [candle(0, { high: 1 })]), ok("binance", series(2))] });
    expect(r.source).toBe("binance");
    expect(r.attempts.map((a) => a.code)).toEqual(["UNSUPPORTED_TIMEFRAME", "NO_VALID_CANDLES", "OK"]);
  });
  it("throws BLOCKED_SOURCE_DATA carrying each source's HTTP code when every source fails", async () => {
    const p = [fail("coingecko", 429), fail("cryptocompare", 403), fail("binance", 451), fail("yahoo", 500)];
    const err = await runCascade("BTCUSDT", "1h", 200, { providers: p }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedSourceDataError);
    expect(err.code).toBe("BLOCKED_SOURCE_DATA");
    expect(err.attempts.map((a: { httpStatus: number }) => a.httpStatus)).toEqual([429, 403, 451, 500]);
  });
});

describe("ingest (spec 2, 6, 7, 8)", () => {
  it("stores valid candles, is idempotent on re-run, and never inserts duplicates", async () => {
    const store = createMemoryStore();
    const opts = { providers: [ok("coingecko", series(10))], now: T0 + 10 * H };
    const first = await ingest(store, "BTCUSDT", "1h", opts);
    expect(first).toMatchObject({ source: "coingecko", valid: 10, inserted: 10, alreadyStored: 0 });
    const second = await ingest(store, "BTCUSDT", "1h", opts);
    expect(second).toMatchObject({ inserted: 0, alreadyStored: 10 });
    expect(store.rows).toHaveLength(10);
  });
  it("inserts only the new candle when the series moves forward", async () => {
    const store = createMemoryStore();
    await ingest(store, "BTCUSDT", "1h", { providers: [ok("binance", series(10))] });
    const r = await ingest(store, "BTCUSDT", "1h", { providers: [ok("binance", series(11))] });
    expect(r.inserted).toBe(1);
    expect(store.rows).toHaveLength(11);
  });
  it("ignores duplicate candles inside one payload and reports rejected rows", async () => {
    const store = createMemoryStore();
    const r = await ingest(store, "BTCUSDT", "1h", { providers: [ok("yahoo", [...series(5), candle(2), candle(6, { high: 1 })])] });
    expect(r).toMatchObject({ valid: 5, duplicatesInPayload: 1, rejected: 1, inserted: 5 });
    expect(r.rejectedSample[0].reason).toBe("high < low");
  });
  it("persists gap records and flags stale data", async () => {
    const store = createMemoryStore();
    const r = await ingest(store, "BTCUSDT", "1h", { providers: [ok("coingecko", [candle(0), candle(1), candle(5)])], now: T0 + 5 * H + 3 * H });
    expect(r.gapsInserted).toBe(1);
    expect(store.gaps[0]).toMatchObject({ fromOpenTime: T0 + H, toOpenTime: T0 + 5 * H, missingBars: 3 });
    expect(r.stale).toBe(true);
    expect(r.freshnessMs).toBe(3 * H);
  });
  it("caps the request at 200 candles and rejects bad symbols/timeframes before any request", async () => {
    const seen: number[] = [];
    const p: Provider = { name: "binance", fetch: async (_s, _t, limit) => { seen.push(limit); return { candles: series(3), httpStatus: 200, rawSample: null }; } };
    await ingest(createMemoryStore(), "BTCUSDT", "1h", { providers: [p], limit: 9999 });
    expect(seen).toEqual([200]);
    await expect(ingest(createMemoryStore(), "BTC-USDT", "1h", { providers: [p] })).rejects.toThrow("invalid symbol");
    await expect(ingest(createMemoryStore(), "BTCUSDT", "2h" as never, { providers: [p] })).rejects.toThrow("invalid timeframe");
    expect(seen).toHaveLength(1);
  });
});

describe("providers parse real response shapes (mocked fetch)", () => {
  it("binance: klines rows → candles, ≤ limit, raw sample kept", async () => {
    const rows = [[T0, "100", "110", "90", "105", "12.5", T0 + H - 1], [T0 + H, "105", "112", "101", "110", "8", T0 + 2 * H - 1]];
    const fetchImpl = vi.fn(async () => json(rows)) as unknown as typeof fetch;
    const r = await binance.fetch("BTCUSDT", "1h", 200, fetchImpl);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200");
    expect(r.candles[0]).toMatchObject({ time: T0, open: 100, high: 110, low: 90, close: 105, volume: 12.5 });
    expect(r.rawSample).toEqual(rows[0]);
  });
  it("binance: falls back to the data-only mirror when the main host answers 451, and reports both when both fail", async () => {
    const urls: string[] = [];
    const f1 = (async (u: string) => { urls.push(u); return u.includes("api.binance.com") ? json({}, 451) : json([[T0, "1", "2", "1", "2", "3", 0]]); }) as unknown as typeof fetch;
    expect((await binance.fetch("BTCUSDT", "1h", 10, f1)).candles).toHaveLength(1);
    expect(urls.map((u) => new URL(u).hostname)).toEqual(["api.binance.com", "data-api.binance.vision"]);
    const f2 = (async () => json({}, 451)) as unknown as typeof fetch;
    const err = await binance.fetch("BTCUSDT", "1h", 10, f2).catch((e) => e);
    expect(err).toBeInstanceOf(IngestHttpError);
    expect(err.status).toBe(451);
  });
  it("cryptocompare: maps histohour rows; HTTP-200 rate-limit body becomes a 429", async () => {
    const rows = [{ time: T0 / 1000, high: 110, low: 90, open: 100, volumefrom: 7, volumeto: 700, close: 105 }];
    const good = (async () => json({ Response: "Success", Data: { Data: rows } })) as unknown as typeof fetch;
    const r = await cryptocompare.fetch("BTCUSDT", "1h", 200, good);
    expect(r.candles[0]).toMatchObject({ time: T0, open: 100, close: 105, volume: 7 });
    const limited = (async () => json({ Response: "Error", Message: "You are over your rate limit" })) as unknown as typeof fetch;
    const err = await cryptocompare.fetch("BTCUSDT", "1h", 200, limited).catch((e) => e);
    expect(err.status).toBe(429);
  });
  it("coingecko: end-timestamps become open times; 1h is built from 30m; unsupported timeframes are skipped", async () => {
    const half = TF_MS["30m"];
    const rows = [0, 1, 2, 3].map((i) => [T0 + (i + 1) * half, 100, 110, 90, 100 + i]);
    const fetchImpl = (async () => json(rows)) as unknown as typeof fetch;
    const r30 = await coingecko.fetch("BTCUSDT", "30m", 200, fetchImpl);
    expect(r30.candles.map((c) => c.time)).toEqual([T0, T0 + half, T0 + 2 * half, T0 + 3 * half]);
    expect(r30.candles[0].volume).toBe(0);
    const r1h = await coingecko.fetch("BTCUSDT", "1h", 200, fetchImpl);
    expect(r1h.candles.map((c) => c.time)).toEqual([T0, T0 + H]);
    expect(r1h.candles[0]).toMatchObject({ open: 100, close: 101 });
    await expect(coingecko.fetch("BTCUSDT", "15m", 200, fetchImpl)).rejects.toBeInstanceOf(UnsupportedTimeframe);
  });
  it("yahoo: parses a chart payload and reports an invalid payload as an error", async () => {
    const chart = { chart: { result: [{ timestamp: [T0 / 1000, T0 / 1000 + 3600], indicators: { quote: [{ open: [1, 2], high: [3, 4], low: [0.5, 1], close: [2, 3], volume: [5, null] }] } }], error: null } };
    const r = await yahoo.fetch("BTCUSDT", "1h", 200, (async () => json(chart)) as unknown as typeof fetch);
    expect(r.candles).toHaveLength(2);
    expect(r.rawSample).toMatchObject({ timestamp: T0 / 1000, open: 1 });
    await expect(yahoo.fetch("BTCUSDT", "1h", 200, (async () => json({ chart: { result: null, error: { description: "No data found" } } })) as unknown as typeof fetch)).rejects.toThrow("No data found");
  });
  it("http layer: a thrown fetch is a null-status network error; non-2xx keeps its status", async () => {
    const net = await binance.fetch("BTCUSDT", "1h", 5, (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch).catch((e) => e);
    expect(net).toBeInstanceOf(IngestHttpError);
    expect(net.status).toBeNull();
    const r429 = await cryptocompare.fetch("BTCUSDT", "1h", 5, (async () => json({}, 429)) as unknown as typeof fetch).catch((e) => e);
    expect(r429.status).toBe(429);
  });
});

describe("GET /api/candles and POST /api/ingest", () => {
  const BASE = T0 + 10 * H;
  const mk = async (rows = 10, now = BASE) => {
    const store = createMemoryStore();
    if (rows) await store.insertCandles(series(rows).map((c) => ({ symbol: "BTCUSDT", timeframe: "1h" as const, openTime: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, source: "coingecko" as const })));
    return { store, now };
  };

  it("serves stored candles with freshness fields and stale:false when fresh", async () => {
    const { store } = await mk(10);
    const ingestFn = vi.fn();
    const app = candlesRoutes({ store, ingestFn, now: () => T0 + 9 * H + 600_000 });
    const res = await app.request("/?symbol=BTCUSDT&timeframe=1h&limit=200");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ symbol: "BTCUSDT", timeframe: "1h", count: 10, stale: false, freshness_ms: 600_000, source_active: "coingecko", refreshed: false });
    expect(body.candles[0]).toMatchObject({ open_time: T0, open: 100 });
    expect(ingestFn).not.toHaveBeenCalled();
  });
  it("returns stale:true when the last candle is older than 2×timeframe and the refresh is blocked", async () => {
    const { store } = await mk(10);
    const ingestFn = vi.fn(async () => { throw new BlockedSourceDataError([{ source: "coingecko", ok: false, httpStatus: 429, code: "HTTP_429", message: "", retried: false }]); });
    const app = candlesRoutes({ store, ingestFn: ingestFn as never, now: () => T0 + 9 * H + 2 * H + 1 });
    const body = await (await app.request("/?symbol=BTCUSDT&timeframe=1h")).json();
    expect(body.stale).toBe(true);
    expect(body.refresh_error).toEqual({ code: "BLOCKED_SOURCE_DATA", attempts: [{ source: "coingecko", httpStatus: 429, code: "HTTP_429" }] });
    expect(body.count).toBe(10);
  });
  it("ingests on demand when the series is empty, then serves it", async () => {
    const { store } = await mk(0);
    const ingestFn = vi.fn(async (s: typeof store) => { await s.insertCandles(series(3).map((c) => ({ symbol: "BTCUSDT", timeframe: "1h" as const, openTime: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: 1, source: "binance" as const }))); return {} as never; });
    const app = candlesRoutes({ store, ingestFn: ingestFn as never, now: () => T0 + 3 * H });
    const body = await (await app.request("/?symbol=BTCUSDT&timeframe=1h")).json();
    expect(ingestFn).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ count: 3, refreshed: true, source_active: "binance" });
  });
  it("answers 503 BLOCKED_SOURCE_DATA with per-source codes when empty and every source fails", async () => {
    const { store } = await mk(0);
    const attempts = [{ source: "coingecko", ok: false, httpStatus: 429, code: "HTTP_429", message: "", retried: false }, { source: "yahoo", ok: false, httpStatus: 500, code: "HTTP_500", message: "", retried: false }] as never;
    const app = candlesRoutes({ store, ingestFn: (async () => { throw new BlockedSourceDataError(attempts); }) as never });
    const res = await app.request("/?symbol=BTCUSDT&timeframe=1h");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("BLOCKED_SOURCE_DATA");
  });
  it("validates query parameters (400) and rate-limits per client (429)", async () => {
    const { store } = await mk(0);
    const app = candlesRoutes({ store, ingestFn: vi.fn() as never });
    for (const q of ["symbol=BTC&timeframe=1h", "symbol=BTCUSDT&timeframe=2h", "symbol=BTCUSDT&timeframe=1h&limit=0", "symbol=BTCUSDT&timeframe=1h&limit=501", "symbol=BTCUSDT&timeframe=1h&limit=abc", "timeframe=1h"]) {
      expect((await app.request(`/?${q}`)).status, q).toBe(400);
    }
    const limit = createRateLimiter(3, 60_000, () => 0);
    expect([1, 2, 3, 4].map(() => limit("ip"))).toEqual([true, true, true, false]);
    expect(createRateLimiter(1, 1000, (() => { let t = 0; return () => (t += 2000); })())("x")).toBe(true);
  });
  it("POST /api/ingest requires the CRON_SECRET bearer token", async () => {
    const prev = process.env.CRON_SECRET;
    const ingestFn = vi.fn(async () => ({ source: "coingecko" }) as never);
    const app = ingestRoutes({ store: createMemoryStore(), ingestFn });
    delete process.env.CRON_SECRET;
    expect((await app.request("/", { method: "POST" })).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-value";
    expect((await app.request("/", { method: "POST" })).status).toBe(401);
    expect((await app.request("/?symbol=BTCUSDT&timeframe=1h", { method: "POST", headers: { authorization: "Bearer s3cret-value" } })).status).toBe(200);
    expect((await app.request("/?symbol=bad&timeframe=1h", { method: "POST", headers: { authorization: "Bearer s3cret-value" } })).status).toBe(400);
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  });
});
