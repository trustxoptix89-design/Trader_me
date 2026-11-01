import type { Candle } from "@contracts/types";
import type { DeltaTrendOutput } from "../types/advanced";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";

/**
 * Governance rooms. Each room is a PURE function (no I/O, no LLM): input -> { status, reason, flags }.
 * Rules follow the specification PDF, Phase D ("5 rooms"). Where the PDF text is ambiguous the choice is noted.
 */
export type RoomStatus = "PASS" | "HALT" | "ESCALATE";
export interface RoomResult {
  room: "DATA" | "ERROR_DETECTION" | "CHART_QUALITY" | "RISK";
  status: RoomStatus;
  reason: string;
  flags: string[];
  metrics: Record<string, number>;
}

export type VoteVerdict = "bullish" | "bearish" | "neutral" | "abstain";
export interface AgentVote {
  agentId: string;
  group: string;
  verdict: VoteVerdict;
  confidence: number;
  weight: number;
  reason: string;
}

const result = (room: RoomResult["room"], status: RoomStatus, reason: string, flags: string[] = [], metrics: Record<string, number> = {}): RoomResult => ({ room, status, reason, flags, metrics });

export interface DataRoomInput {
  candles: Candle[];
  timeframeMs: number;
  now: number;
  source?: string;
  primarySource?: string;
}

/**
 * Data Room: freshness_ms = now - last.open_time.
 * Invalid OHLCV (non-finite, high < low, close outside [low, high], negative volume) -> HALT(INVALID_OHLCV);
 * freshness > 2 x TF -> HALT(DATA_STALE); duplicate open_time -> HALT(DUPLICATE_DATA);
 * more than 5% of the expected candles missing -> HALT(DATA_GAP); non-primary source -> flag only.
 */
export function dataRoom(input: DataRoomInput, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): RoomResult {
  const { candles, timeframeMs, now } = input;
  if (!Array.isArray(candles) || candles.length === 0) return result("DATA", "HALT", "DATA_MISSING: no candles");
  const bad = candles.findIndex((c) => ![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.high < c.low || c.close > c.high || c.close < c.low || c.volume < 0);
  if (bad >= 0) return result("DATA", "HALT", `INVALID_OHLCV at index ${bad}`);
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  const freshnessMs = now - last;
  const freshnessRatio = freshnessMs / (cfg.values.dataStaleMultiple * timeframeMs);
  const unique = new Set(candles.map((c) => c.time)).size;
  const duplicates = candles.length - unique;
  const expected = Math.round((last - first) / timeframeMs) + 1;
  const missingRatio = expected > 0 ? Math.max(0, expected - unique) / expected : 0;
  const metrics = { freshnessMs, freshnessRatio, duplicates, missingRatio };

  if (!Number.isFinite(now) || freshnessMs < 0) return result("DATA", "HALT", "INVALID_CLOCK: last candle is in the future", [], metrics);
  if (freshnessMs > cfg.values.dataStaleMultiple * timeframeMs) return result("DATA", "HALT", "DATA_STALE", [], metrics);
  if (duplicates > 0) return result("DATA", "HALT", "DUPLICATE_DATA", [], metrics);
  if (missingRatio > cfg.values.dataMaxGapRatio) return result("DATA", "HALT", "DATA_GAP", [], metrics);
  const flags = input.source && input.primarySource && input.source !== input.primarySource ? ["FALLBACK_SOURCE"] : [];
  return result("DATA", "PASS", "data ok", flags, metrics);
}

/**
 * Error Detection Room (subset the system has inputs for):
 *  - last candle volume = 0 -> HALT(SUSPICIOUS_DATA)
 *  - Delta Force trend verdict CONFLICT (timeframes disagree) -> HALT(CONTRADICTION_INDICATORS). HARDENING DEVIATION D-3:
 *    the V2 PDF treats CONFLICT as an abstention; here conflicting indicators may never reach approval.
 *  - agents of the SAME group disagree (bullish vs bearish) in 2 or more groups -> HALT(CONTRADICTION_AGENT)
 * The PDF text for the last rule is garbled by right-to-left extraction ("<=2 groups"); ">= 2 groups" is the reading used here.
 * Not implemented: MACD/RSI opposite direction in 2 of 3 timeframes, BOS up with close below EMA200 (ESCALATE).
 */
export function errorDetectionRoom(votes: AgentVote[], lastCandle?: Candle, trend?: DeltaTrendOutput): RoomResult {
  if (lastCandle && lastCandle.volume === 0) return result("ERROR_DETECTION", "HALT", "SUSPICIOUS_DATA: last candle volume is 0");
  if (trend?.verdict === "CONFLICT") return result("ERROR_DETECTION", "HALT", "CONTRADICTION_INDICATORS: Delta Force timeframes conflict");
  const byGroup = new Map<string, Set<VoteVerdict>>();
  for (const v of votes) {
    if (v.verdict !== "bullish" && v.verdict !== "bearish") continue;
    const set = byGroup.get(v.group) ?? new Set<VoteVerdict>();
    set.add(v.verdict);
    byGroup.set(v.group, set);
  }
  const contradictory = [...byGroup.entries()].filter(([, s]) => s.has("bullish") && s.has("bearish")).map(([g]) => g);
  const metrics = { contradictoryGroups: contradictory.length };
  if (contradictory.length >= 2) return result("ERROR_DETECTION", "HALT", `CONTRADICTION_AGENT: ${contradictory.join(",")}`, [], metrics);
  return result("ERROR_DETECTION", "PASS", "no contradiction", [], metrics);
}

export interface RiskRoomInput {
  direction: "long" | "short";
  market: "spot" | "futures";
  entry: number;
  invalidation: number;
  targets: number[];
  atr: number;
  /** Futures only: distance from entry to the liquidation price. */
  liquidationDistance?: number;
  /** Futures only: funding rate per 8h as a fraction (0.0005 = 0.05%). */
  fundingRate?: number;
}

/**
 * Risk Room (thresholds from the governance config; defaults are the PDF values):
 *  R:R < 1.5 -> HALT(RISK_REJECT); invalidation distance > 3 x ATR -> HALT(INVALIDATION_TOO_FAR);
 *  < 0.5 x ATR -> HALT(INVALIDATION_TOO_TIGHT); futures with liquidation distance < 2 x invalidation distance
 *  -> HALT(LEVERAGE_TOO_HIGH); adverse funding > 0.05% per 8h -> flag(FUNDING_RISK) only.
 * Additions of this project: wrong-side geometry -> HALT(RISK_REJECT); futures without a liquidation distance -> ESCALATE.
 */
export function riskRoom(i: RiskRoomInput, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): RoomResult {
  const v = cfg.values;
  const risk = Math.abs(i.entry - i.invalidation);
  const target = i.targets[0];
  const sideOk = target !== undefined && (i.direction === "long" ? i.invalidation < i.entry && target > i.entry : i.invalidation > i.entry && target < i.entry);
  if (!sideOk || risk === 0 || !Number.isFinite(risk) || !(i.atr > 0)) return result("RISK", "HALT", "RISK_REJECT: invalid entry/invalidation/target geometry or ATR");
  const rr = Math.abs(target - i.entry) / risk;
  const metrics = { rr, risk, atrMultiple: risk / i.atr };

  if (rr < v.minRr) return result("RISK", "HALT", "RISK_REJECT", [], metrics);
  if (risk > v.invalidationMaxAtr * i.atr) return result("RISK", "HALT", "INVALIDATION_TOO_FAR", [], metrics);
  if (risk < v.invalidationMinAtr * i.atr) return result("RISK", "HALT", "INVALIDATION_TOO_TIGHT", [], metrics);

  const flags: string[] = [];
  if (i.market === "futures") {
    if (i.liquidationDistance === undefined) return result("RISK", "ESCALATE", "LIQUIDATION_DISTANCE_MISSING", [], metrics);
    if (i.liquidationDistance < v.liquidationMultiple * risk) return result("RISK", "HALT", "LEVERAGE_TOO_HIGH", [], metrics);
    const f = i.fundingRate ?? 0;
    if ((i.direction === "long" && f > v.fundingRiskThreshold) || (i.direction === "short" && f < -v.fundingRiskThreshold)) flags.push("FUNDING_RISK");
  }
  return result("RISK", "PASS", "risk ok", flags, metrics);
}
