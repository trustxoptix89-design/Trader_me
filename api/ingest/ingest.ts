import type { Candle } from "@contracts/types";
import { IngestHttpError, type FetchLike } from "./http";
import { DEFAULT_PROVIDERS, SYMBOL_RE, TF_MS, TIMEFRAMES, UnsupportedTimeframe, type Provider, type SourceName, type Timeframe } from "./providers";

export interface CandleRow { symbol: string; timeframe: Timeframe; openTime: number; open: number; high: number; low: number; close: number; volume: number; source: SourceName }
export interface GapRow { symbol: string; timeframe: Timeframe; fromOpenTime: number; toOpenTime: number; missingBars: number }

/** Persistence port. The Postgres adapter lives in store.ts; tests use the in-memory one. */
export interface CandleStore {
  /** Inserts rows; rows whose (symbol,timeframe,openTime) already exist are skipped. Returns how many were actually inserted. */
  insertCandles(rows: CandleRow[]): Promise<number>;
  insertGaps(rows: GapRow[]): Promise<number>;
  /** Latest `limit` candles, ascending by openTime. */
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<CandleRow[]>;
}

export interface Attempt { source: SourceName; ok: boolean; httpStatus: number | null; code: string; message: string; retried: boolean }

/** Raised when every source in the cascade failed. `attempts` carries the HTTP status of each source. */
export class BlockedSourceDataError extends Error {
  code = "BLOCKED_SOURCE_DATA" as const;
  attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    super(`BLOCKED_SOURCE_DATA: ${attempts.map((a) => `${a.source}=${a.httpStatus ?? a.code}`).join(", ")}`);
    this.name = "BlockedSourceDataError";
    this.attempts = attempts;
  }
}

export function isValidSymbol(symbol: string): boolean { return SYMBOL_RE.test(symbol); }
export function isTimeframe(value: string): value is Timeframe { return (TIMEFRAMES as readonly string[]).includes(value); }

/** Spec 6: high>=low, close within [low,high], volume>=0 (plus finite, positive prices and open within range). Returns the reason or null. */
export function validateCandle(c: Candle): string | null {
  if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) return "non-finite value";
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return "non-positive price";
  if (c.high < c.low) return "high < low";
  if (c.close < c.low || c.close > c.high) return "close outside [low, high]";
  if (c.open < c.low || c.open > c.high) return "open outside [low, high]";
  if (c.volume < 0) return "negative volume";
  return null;
}

export interface Sanitized { valid: Candle[]; rejected: { time: number; reason: string }[]; duplicates: number }

/** Validates, de-duplicates (first occurrence wins, spec 8) and sorts ascending by open time. */
export function sanitizeCandles(candles: Candle[]): Sanitized {
  const seen = new Set<number>();
  const valid: Candle[] = [];
  const rejected: Sanitized["rejected"] = [];
  let duplicates = 0;
  for (const c of candles) {
    if (seen.has(c.time)) { duplicates++; continue; }
    const reason = validateCandle(c);
    if (reason) { rejected.push({ time: c.time, reason }); continue; }
    seen.add(c.time);
    valid.push(c);
  }
  valid.sort((a, b) => a.time - b.time);
  return { valid, rejected, duplicates };
}

/** Spec 7: a gap exists when two consecutive open times are more than 1.5×timeframe apart. */
export function findGaps(candles: Candle[], symbol: string, timeframe: Timeframe): GapRow[] {
  const tf = TF_MS[timeframe];
  const gaps: GapRow[] = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > 1.5 * tf) gaps.push({ symbol, timeframe, fromOpenTime: candles[i - 1].time, toOpenTime: candles[i].time, missingBars: Math.round(delta / tf) - 1 });
  }
  return gaps;
}

/** Spec 3: freshness_ms = now − last candle open time; stale when it exceeds 2×timeframe. */
export function computeFreshness(lastOpenTime: number | null, timeframe: Timeframe, now = Date.now()): { freshnessMs: number | null; stale: boolean } {
  if (lastOpenTime === null) return { freshnessMs: null, stale: true };
  const freshnessMs = now - lastOpenTime;
  return { freshnessMs, stale: freshnessMs > 2 * TF_MS[timeframe] };
}

export interface CascadeOptions { providers?: Provider[]; fetchImpl?: FetchLike }
export interface CascadeResult { source: SourceName; httpStatus: number; rawSample: unknown; fetched: number; sanitized: Sanitized; attempts: Attempt[] }

/**
 * Tries the sources in order. Any HTTP failure (403/429/451/5xx…) moves on to the next source immediately;
 * a network error (no response) is retried once on the same source first (spec 4). A source that answers
 * but yields zero valid candles counts as failed. If every source fails the call throws BLOCKED_SOURCE_DATA.
 */
export async function runCascade(symbol: string, timeframe: Timeframe, limit = 200, options: CascadeOptions = {}): Promise<CascadeResult> {
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const attempts: Attempt[] = [];
  for (const provider of providers) {
    let retried = false;
    for (let round = 0; round < 2; round++) {
      try {
        const result = await provider.fetch(symbol, timeframe, limit, options.fetchImpl);
        const sanitized = sanitizeCandles(result.candles);
        if (!sanitized.valid.length) {
          attempts.push({ source: provider.name, ok: false, httpStatus: result.httpStatus, code: "NO_VALID_CANDLES", message: `${result.candles.length} rows, ${sanitized.rejected.length} rejected`, retried });
          break;
        }
        attempts.push({ source: provider.name, ok: true, httpStatus: result.httpStatus, code: "OK", message: `${sanitized.valid.length} valid candles`, retried });
        return { source: provider.name, httpStatus: result.httpStatus, rawSample: result.rawSample, fetched: result.candles.length, sanitized, attempts };
      } catch (error) {
        if (error instanceof UnsupportedTimeframe) {
          attempts.push({ source: provider.name, ok: false, httpStatus: null, code: "UNSUPPORTED_TIMEFRAME", message: error.message, retried });
          break;
        }
        const status = error instanceof IngestHttpError ? error.status : null;
        if (status === null && round === 0) { retried = true; continue; }
        attempts.push({ source: provider.name, ok: false, httpStatus: status, code: status === null ? "NETWORK_ERROR" : `HTTP_${status}`, message: error instanceof Error ? error.message : String(error), retried });
        break;
      }
    }
  }
  throw new BlockedSourceDataError(attempts);
}

export interface IngestResult {
  symbol: string; timeframe: Timeframe; source: SourceName; httpStatus: number; rawSample: unknown;
  fetched: number; valid: number; rejected: number; rejectedSample: { time: number; reason: string }[]; duplicatesInPayload: number;
  inserted: number; alreadyStored: number; gaps: GapRow[]; gapsInserted: number;
  lastOpenTime: number; freshnessMs: number | null; stale: boolean; attempts: Attempt[];
}

export interface IngestOptions extends CascadeOptions { limit?: number; now?: number }

/** One ingestion: cascade → validate → dedupe → idempotent insert → gap records. Re-running never adds duplicate rows. */
export async function ingest(store: CandleStore, symbol: string, timeframe: Timeframe, options: IngestOptions = {}): Promise<IngestResult> {
  if (!isValidSymbol(symbol)) throw new Error(`invalid symbol: ${symbol}`);
  if (!isTimeframe(timeframe)) throw new Error(`invalid timeframe: ${timeframe}`);
  const limit = Math.min(200, Math.max(1, options.limit ?? 200));
  const cascade = await runCascade(symbol, timeframe, limit, options);
  const { valid, rejected, duplicates } = cascade.sanitized;
  const rows: CandleRow[] = valid.map((c) => ({ symbol, timeframe, openTime: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, source: cascade.source }));
  const inserted = await store.insertCandles(rows);
  const gaps = findGaps(valid, symbol, timeframe);
  const gapsInserted = gaps.length ? await store.insertGaps(gaps) : 0;
  const lastOpenTime = valid[valid.length - 1].time;
  const { freshnessMs, stale } = computeFreshness(lastOpenTime, timeframe, options.now);
  return {
    symbol, timeframe, source: cascade.source, httpStatus: cascade.httpStatus, rawSample: cascade.rawSample,
    fetched: cascade.fetched, valid: valid.length, rejected: rejected.length, rejectedSample: rejected.slice(0, 5), duplicatesInPayload: duplicates,
    inserted, alreadyStored: rows.length - inserted, gaps, gapsInserted, lastOpenTime, freshnessMs, stale, attempts: cascade.attempts,
  };
}
