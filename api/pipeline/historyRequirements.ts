/**
 * Indicator history requirements, ESTABLISHED BY MEASUREMENT (docs/HISTORY_DEPTH.md; library historyStudy.ts; CLI tools/history-depth/study.ts).
 * DATA CLASS: HISTORICAL-REAL (fixtures/btcusdt_1h.json, 999 BTCUSDT 1h candles, 200 end positions, depths 10..600).
 * Every indicator is recursive (EMA seed, Wilder smoothing, Supertrend bands): the value at the last candle depends on how much history precedes it.
 *  - minValid: below this the value is undefined (NaN). The Delta modules enforce their own definitional minimum (MIN_VALID_CANDLES).
 *  - stable:   smallest 10-candle-grid depth from which the value stays within STABILITY_EPSILON of the full-history value for EVERY larger depth
 *              and every end position tested. STABILITY_EPSILON is a MEASUREMENT criterion, not a trading parameter; the doc lists 1e-2/1e-3/1e-4.
 * A test (historyDepth.test.ts) re-measures these numbers; if an indicator implementation changes, the test fails until the table is re-derived.
 */
export const STABILITY_EPSILON = 1e-3;
export interface IndicatorHistory { indicator: string; minValid: number; stable: number; consumers: string }

/** Keys equal the names in historyStudy.STUDY_DEFS. `stable` is the 1e-3 column of the measurement. */
export const INDICATOR_HISTORY: readonly IndicatorHistory[] = [
  { indicator: "EMA20", minValid: 20, stable: 40, consumers: "Delta Trend" },
  { indicator: "EMA50", minValid: 50, stable: 100, consumers: "Delta Trend, B09" },
  { indicator: "EMA200", minValid: 200, stable: 360, consumers: "Delta Trend" },
  { indicator: "RSI14 (contracts/rsiSeries)", minValid: 15, stable: 100, consumers: "B10" },
  { indicator: "StochRSI(14,14)", minValid: 28, stable: 120, consumers: "Delta Range (5m trigger), B15" },
  { indicator: "ATR14 (Delta calcAtr)", minValid: 15, stable: 90, consumers: "Delta Range (4H), Setup/Risk" },
  { indicator: "ADX14 (Delta calcAdx)", minValid: 1, stable: 140, consumers: "Delta Trend (ADX gates); minValid 1 = finite but meaningless, the module enforces 200" },
  { indicator: "Supertrend(10,3) value", minValid: 11, stable: 70, consumers: "Delta Trend" },
  { indicator: "Ichimoku cloud top", minValid: 78, stable: 80, consumers: "Delta Trend" },
  { indicator: "Ichimoku cloud bottom", minValid: 78, stable: 80, consumers: "Delta Trend" },
];

export type HistoryTimeframe = "4H" | "1H" | "15m" | "5m";
/** Which indicators each timeframe's consumers use (from the code: deltaforce.trend.ts / deltaforce.range.ts / agents). */
export const TIMEFRAME_INDICATORS: Record<HistoryTimeframe, readonly string[]> = {
  "4H": ["EMA20", "EMA50", "EMA200", "ADX14 (Delta calcAdx)", "Supertrend(10,3) value", "Ichimoku cloud top", "Ichimoku cloud bottom", "ATR14 (Delta calcAtr)"],
  "1H": ["EMA20", "EMA50", "EMA200", "ADX14 (Delta calcAdx)", "Supertrend(10,3) value", "Ichimoku cloud top", "Ichimoku cloud bottom", "RSI14 (contracts/rsiSeries)", "StochRSI(14,14)"],
  "15m": ["EMA20", "EMA50", "EMA200", "ADX14 (Delta calcAdx)", "Supertrend(10,3) value", "Ichimoku cloud top", "Ichimoku cloud bottom"],
  "5m": ["StochRSI(14,14)"],
};
const pick = (tf: HistoryTimeframe, key: "minValid" | "stable"): number =>
  Math.max(...TIMEFRAME_INDICATORS[tf].map((n) => (INDICATOR_HISTORY.find((i) => i.indicator === n) ?? { [key]: Number.NaN })[key] as number));
/** Required CLOSED candles for a trustworthy (stable) evaluation. A shorter history makes the pipeline ABSTAIN; it can never approve. */
export const STABLE_CLOSED_CANDLES: Record<HistoryTimeframe, number> = { "4H": pick("4H", "stable"), "1H": pick("1H", "stable"), "15m": pick("15m", "stable"), "5m": pick("5m", "stable") };
/** Definitional minimum enforced INSIDE the indicator modules (Delta Trend MIN_CANDLES 200; Delta Range 4H 35 / 5m 30). Below it a module ABSTAINs. */
export const MIN_VALID_CANDLES: Record<HistoryTimeframe, number> = { "4H": 200, "1H": 200, "15m": 200, "5m": 30 };
