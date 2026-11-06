import { adxSeries, atrSeries, emaSeries, rsiSeries } from "@contracts/indicators";
import type { Candle } from "@contracts/types";
import { calcAdx, calcAtr, calcEma, calcIchimoku, calcStochRsi, calcSupertrend, evaluateDeltaTrend } from "../indicators/deltaforce.trend";

/**
 * History-depth study (library). Published numbers: DATA CLASS HISTORICAL-REAL (fixtures/btcusdt_1h.json), see docs/HISTORY_DEPTH.md.
 * Every indicator used by the pipeline is recursive (EMA seed, Wilder smoothing, Supertrend bands), so the value at the LAST candle depends on how
 * much older history exists. Method: for every end position e in [endFrom, N-1] the reference is the indicator on candles[0..e] (full history); for
 * every depth d on a `step`-candle grid the value is the indicator on the LAST d candles ending at e.
 * Error: relative |a-b|/|b| for price-level values, |a-b|/100 for 0-100 oscillators. stable(eps) = smallest grid depth d whose max error is <= eps
 * for d AND for every larger depth up to maxDepth. eps is a MEASUREMENT criterion, not a trading parameter.
 */
interface Def { name: string; scale: "rel" | "pct"; value: (c: Candle[]) => number }
const last = <T>(a: readonly T[]): T => a[a.length - 1];
const hi = (c: Candle[]): number[] => c.map((x) => x.high), lo = (c: Candle[]): number[] => c.map((x) => x.low), cl = (c: Candle[]): number[] => c.map((x) => x.close);
const num = (v: number | null | undefined): number => (typeof v === "number" ? v : Number.NaN);

export const STUDY_DEFS: readonly Def[] = [
  { name: "EMA20", scale: "rel", value: (c) => last(calcEma(cl(c), 20)) },
  { name: "EMA50", scale: "rel", value: (c) => last(calcEma(cl(c), 50)) },
  { name: "EMA200", scale: "rel", value: (c) => last(calcEma(cl(c), 200)) },
  { name: "EMA200 (contracts/emaSeries)", scale: "rel", value: (c) => num(last(emaSeries(cl(c), 200))) },
  { name: "RSI14 (contracts/rsiSeries)", scale: "pct", value: (c) => num(last(rsiSeries(cl(c), 14))) },
  { name: "StochRSI(14,14)", scale: "pct", value: (c) => last(calcStochRsi(cl(c), 14, 14)) },
  { name: "ATR14 (Delta calcAtr)", scale: "rel", value: (c) => last(calcAtr(c, 14)) },
  { name: "ATR14 (contracts/atrSeries)", scale: "rel", value: (c) => num(last(atrSeries(c, 14))) },
  { name: "ADX14 (Delta calcAdx)", scale: "pct", value: (c) => last(calcAdx(hi(c), lo(c), cl(c), 14)) },
  { name: "ADX14 (contracts/adxSeries)", scale: "pct", value: (c) => num(last(adxSeries(c, 14))) },
  { name: "Supertrend(10,3) value", scale: "rel", value: (c) => last(calcSupertrend(c, 10, 3).value) },
  { name: "Ichimoku cloud top", scale: "rel", value: (c) => calcIchimoku(hi(c), lo(c), cl(c)).cloudTop },
  { name: "Ichimoku cloud bottom", scale: "rel", value: (c) => calcIchimoku(hi(c), lo(c), cl(c)).cloudBottom },
];

export interface StudyOptions { maxDepth: number; endFrom: number; step: number; eps: readonly number[] }
export const DEFAULT_STUDY: StudyOptions = { maxDepth: 600, endFrom: 799, step: 10, eps: [1e-2, 1e-3, 1e-4] };
export interface StudyRow { indicator: string; minValid: number; maxErrByDepth: Record<number, number>; stable: Record<string, number | null> }
export interface StudyResult { candles: number; endPositions: number; rows: StudyRow[]; verdictAgreement: Record<number, number>; supertrendDirAgreement: Record<number, number> }

const err = (a: number, b: number, scale: "rel" | "pct"): number => (!Number.isFinite(a) || !Number.isFinite(b) ? Number.POSITIVE_INFINITY : scale === "pct" ? Math.abs(a - b) / 100 : Math.abs(a - b) / Math.abs(b));

export function runStudy(all: Candle[], o: StudyOptions = DEFAULT_STUDY, defs: readonly Def[] = STUDY_DEFS, withVerdict = true): StudyResult {
  const N = all.length, ends: number[] = []; for (let e = o.endFrom; e < N; e++) ends.push(e);
  const rows: StudyRow[] = defs.map((def) => {
    const refs = ends.map((e) => def.value(all.slice(0, e + 1)));
    let minValid = Number.NaN;
    for (let d = 1; d <= o.maxDepth && Number.isNaN(minValid); d++) if (ends.every((e) => Number.isFinite(def.value(all.slice(e + 1 - d, e + 1))))) minValid = d;
    const maxErr: Record<number, number> = {};
    for (let d = Math.max(o.step, Math.ceil((Number.isFinite(minValid) ? minValid : o.step) / o.step) * o.step); d <= o.maxDepth; d += o.step) {
      let m = 0; ends.forEach((e, i) => { m = Math.max(m, err(def.value(all.slice(e + 1 - d, e + 1)), refs[i], def.scale)); }); maxErr[d] = m;
    }
    const depths = Object.keys(maxErr).map(Number).sort((a, b) => a - b), stable: Record<string, number | null> = {};
    for (const eps of o.eps) { let s: number | null = null; for (let i = depths.length - 1; i >= 0; i--) { if (maxErr[depths[i]] <= eps) s = depths[i]; else break; } stable[String(eps)] = s; }
    return { indicator: def.name, minValid, maxErrByDepth: maxErr, stable };
  });
  const verdictAgreement: Record<number, number> = {}, supertrendDirAgreement: Record<number, number> = {};
  if (withVerdict) {
    // The 1H real series is reused as every timeframe stand-in: this tests COUNT stability of the verdict, it is not a multi-timeframe market test.
    const refV = ends.map((e) => { const w = all.slice(0, e + 1); return evaluateDeltaTrend(w, w, w).verdict; });
    const refD = ends.map((e) => last(calcSupertrend(all.slice(0, e + 1), 10, 3).bullish));
    for (let d = 200; d <= o.maxDepth; d += o.step) {
      let okV = 0, okD = 0;
      ends.forEach((e, i) => { const w = all.slice(e + 1 - d, e + 1); if (evaluateDeltaTrend(w, w, w).verdict === refV[i]) okV++; if (last(calcSupertrend(w, 10, 3).bullish) === refD[i]) okD++; });
      verdictAgreement[d] = okV / ends.length; supertrendDirAgreement[d] = okD / ends.length;
    }
  }
  return { candles: N, endPositions: ends.length, rows, verdictAgreement, supertrendDirAgreement };
}
