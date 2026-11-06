// P1 — Candle Adapter (pure part). Contract: docs/PIPELINE_CONTRACT.md §1-§3.
// Turns stored candle rows into the per-timeframe arrays the pipeline consumes, admitting ONLY closed, finalized,
// trustworthy candles. Pure: imports nothing but types, so it is testable without a database.
import type { Candle } from "@contracts/types";
import { STABLE_CLOSED_CANDLES } from "./historyRequirements";

export const PIPELINE_TIMEFRAMES = ["4H", "1H", "15m", "5m"] as const;
export type PipelineTimeframe = (typeof PIPELINE_TIMEFRAMES)[number];

export const TF_MS: Record<PipelineTimeframe, number> = { "4H": 14_400_000, "1H": 3_600_000, "15m": 900_000, "5m": 300_000 };
/** Pipeline timeframe name -> `candles.timeframe` value written by ingest. */
export const DB_TIMEFRAME: Record<PipelineTimeframe, string> = { "4H": "4h", "1H": "1h", "15m": "15m", "5m": "5m" };

/**
 * Required CLOSED candles per timeframe = the STABLE depth measured in docs/HISTORY_DEPTH.md (historyRequirements.ts).
 * The indicator modules enforce only their definitional minimum (MIN_VALID_CANDLES); between that and this value the recursive indicators
 * (EMA200 above all) are still seed-dependent, so the pipeline input is refused (ABSTAIN) rather than evaluated.
 */
export const MIN_CLOSED_CANDLES: Record<PipelineTimeframe, number> = STABLE_CLOSED_CANDLES;
/** Rows read beyond the minimum: exactly the one candle that may still be forming. More only if measured on real data. */
export const READ_MARGIN = 1;

/** A candle row as stored; `ingestedAt` (ms) is when the row was captured. */
export interface StoredCandle { time: number; open: number; high: number; low: number; close: number; volume: number; ingestedAt: number }

export type ExclusionReason =
  | "MISALIGNED_TIMESTAMP" | "NOT_CLOSED" | "UNFINALIZED_SNAPSHOT" | "CLOCK_INCONSISTENT" | "INVALID_VALUE" | "DUPLICATE_TIME";
export interface Exclusion { time: number; reason: ExclusionReason }

const finite = (...v: number[]): boolean => v.every((x) => Number.isFinite(x));

/** Applies C1-C6 of the contract. Output is ascending by time; excluded rows are reported, never silently dropped. */
export function classifyCandles(rows: readonly StoredCandle[], timeframe: PipelineTimeframe, now: number): { closed: Candle[]; excluded: Exclusion[] } {
  const tf = TF_MS[timeframe];
  const excluded: Exclusion[] = [];
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.time, (counts.get(r.time) ?? 0) + 1);
  const closed: Candle[] = [];
  for (const r of [...rows].sort((a, b) => a.time - b.time)) {
    const out = (reason: ExclusionReason): void => { excluded.push({ time: r.time, reason }); };
    if (!Number.isSafeInteger(r.time) || r.time % tf !== 0) { out("MISALIGNED_TIMESTAMP"); continue; }                         // C1
    if (!finite(r.open, r.high, r.low, r.close, r.volume) || r.high < r.low || r.close < r.low || r.close > r.high || r.volume < 0 || r.open < r.low || r.open > r.high) { out("INVALID_VALUE"); continue; } // C5
    if ((counts.get(r.time) ?? 0) > 1) { out("DUPLICATE_TIME"); continue; }                                                  // C6 (all copies are untrusted)
    if (!Number.isFinite(now) || !Number.isFinite(r.ingestedAt) || r.ingestedAt > now) { out("CLOCK_INCONSISTENT"); continue; } // C4
    if (r.time + tf > now) { out("NOT_CLOSED"); continue; }                                                                   // C2
    if (r.ingestedAt < r.time + tf) { out("UNFINALIZED_SNAPSHOT"); continue; }                                                // C3
    closed.push({ time: r.time, closeTime: r.time + tf - 1, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  return { closed, excluded };
}

export interface TimeframeReport {
  timeframe: PipelineTimeframe;
  rowsRead: number;
  closedCount: number;
  required: number;
  sufficient: boolean;
  lastClosedTime: number | null;
  excluded: Exclusion[];
}
export interface PipelineCandles {
  status: "READY" | "ABSTAIN";
  /** Present for every timeframe; empty arrays when ABSTAIN so a caller can never run on partial data by accident. */
  candles: Record<PipelineTimeframe, Candle[]>;
  reports: Record<PipelineTimeframe, TimeframeReport>;
  reason?: string;
}

/** Builds the pipeline input from rows read per timeframe. ABSTAIN (with a reason, empty arrays) if any timeframe is short. */
export function buildPipelineCandles(rowsByTimeframe: Partial<Record<PipelineTimeframe, readonly StoredCandle[]>>, now: number): PipelineCandles {
  const candles = { "4H": [], "1H": [], "15m": [], "5m": [] } as Record<PipelineTimeframe, Candle[]>;
  const reports = {} as Record<PipelineTimeframe, TimeframeReport>;
  const short: string[] = [];
  for (const tf of PIPELINE_TIMEFRAMES) {
    const rows = rowsByTimeframe[tf] ?? [];
    const { closed, excluded } = classifyCandles(rows, tf, now);
    const required = MIN_CLOSED_CANDLES[tf];
    const sufficient = closed.length >= required;
    reports[tf] = { timeframe: tf, rowsRead: rows.length, closedCount: closed.length, required, sufficient, lastClosedTime: closed.length ? closed[closed.length - 1].time : null, excluded };
    candles[tf] = closed;
    if (!sufficient) short.push(`${tf}: ${closed.length}/${required} closed candles`);
  }
  if (short.length) {
    for (const tf of PIPELINE_TIMEFRAMES) candles[tf] = [];
    return { status: "ABSTAIN", candles, reports, reason: `INSUFFICIENT_CLOSED_CANDLES (${short.join("; ")})` };
  }
  return { status: "READY", candles, reports };
}

/** Loader contract: the newest `limit` rows of one series, any order. Implemented over Postgres in candleReader.ts. */
export type LoadRows = (symbol: string, dbTimeframe: string, limit: number) => Promise<StoredCandle[]>;

/** Reads (required + READ_MARGIN) rows per timeframe and builds the pipeline input. Never reads more than the computed need. */
export async function readPipelineCandles(symbol: string, now: number, loadRows: LoadRows): Promise<PipelineCandles> {
  const rows: Partial<Record<PipelineTimeframe, StoredCandle[]>> = {};
  for (const tf of PIPELINE_TIMEFRAMES) rows[tf] = await loadRows(symbol, DB_TIMEFRAME[tf], MIN_CLOSED_CANDLES[tf] + READ_MARGIN);
  return buildPipelineCandles(rows, now);
}
