import type { Candle } from "@contracts/types";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";
import type { RoomResult } from "./rooms";

/** Claims about the chart that the Chart Quality Room checks against the raw candles. All optional: absent claims are not checked. */
export interface ChartClaims {
  levels?: { price: number; kind: "support" | "resistance" }[];
  /** Break of Structure markers: candle index and direction. */
  bos?: { index: number; direction: "up" | "down" }[];
  /** Liquidity sweep markers: candle index and which side was swept ("up" = highs taken). */
  sweeps?: { index: number; direction: "up" | "down" }[];
}

interface Swing { index: number; price: number }

/** Latest confirmed fractal swing (k candles each side) that was already confirmed BEFORE candle `before`. */
function swingBefore(c: Candle[], kind: "high" | "low", k: number, before: number): Swing | null {
  for (let i = Math.min(before - 1 - k, c.length - 1 - k); i >= k; i--) {
    let ok = true;
    for (let j = 1; j <= k && ok; j++) {
      if (kind === "high" ? !(c[i].high > c[i - j].high && c[i].high > c[i + j].high) : !(c[i].low < c[i - j].low && c[i].low < c[i + j].low)) ok = false;
    }
    if (ok) return { index: i, price: kind === "high" ? c[i].high : c[i].low };
  }
  return null;
}

const out = (status: RoomResult["status"], reason: string, flags: string[] = [], metrics: Record<string, number> = {}): RoomResult => ({ room: "CHART_QUALITY", status, reason, flags, metrics });

/**
 * Chart Quality Room (pure). Any failed check ESCALATEs; the machine records an ESCALATE as an INCONCLUSIVE terminal outcome
 * (the Supervisory Board that would receive the escalation is not implemented, so nothing is approved by default).
 *  - data integrity: candle times strictly increasing, last candle CLOSED (closeTime < now)
 *  - claimed support/resistance needs >= chartMinTouches real touches (within chartTouchTolerancePct, consecutive bars count once)
 *  - BOS must be confirmed by a CLOSE beyond the latest confirmed swing, on a closed candle (a wick alone escalates)
 *  - a liquidity sweep needs wick > sweepMinWickPct beyond the swing, a close back inside within 2 candles, and volume > sweepMinVolumeRatio x 20-candle average
 */
export function chartQualityRoom(candles: Candle[], claims: ChartClaims | undefined, now: number, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): RoomResult {
  const v = cfg.values;
  const problems: string[] = [];
  if (!Array.isArray(candles) || candles.length === 0) return out("ESCALATE", "CHART_DATA_MISSING");

  for (let i = 1; i < candles.length; i++) if (!(candles[i].time > candles[i - 1].time)) { problems.push(`CANDLES_NOT_MONOTONIC at ${i}`); break; }
  const last = candles[candles.length - 1];
  if (!(last.closeTime < now)) problems.push("UNCLOSED_LAST_CANDLE");

  for (const lv of claims?.levels ?? []) {
    let touches = 0, inTouch = false;
    for (const c of candles) {
      const extreme = lv.kind === "resistance" ? c.high : c.low;
      const hit = (Math.abs(extreme - lv.price) / lv.price) * 100 <= v.chartTouchTolerancePct;
      if (hit && !inTouch) touches++;
      inTouch = hit;
    }
    if (touches < v.chartMinTouches) problems.push(`SR_UNSUPPORTED: ${lv.kind} ${lv.price} has ${touches} touch(es) < ${v.chartMinTouches}`);
  }

  for (const m of claims?.bos ?? []) {
    const c = candles[m.index];
    if (!c) { problems.push(`BOS_BAD_INDEX ${m.index}`); continue; }
    if (!(c.closeTime < now)) { problems.push(`BOS_ON_UNCLOSED_CANDLE ${m.index}`); continue; }
    const s = swingBefore(candles, m.direction === "up" ? "high" : "low", v.chartBosFractal, m.index);
    if (!s) { problems.push(`BOS_NO_SWING ${m.index}`); continue; }
    const closeBeyond = m.direction === "up" ? c.close > s.price : c.close < s.price;
    const wickBeyond = m.direction === "up" ? c.high > s.price : c.low < s.price;
    if (!closeBeyond) problems.push(wickBeyond ? `BOS_ON_WICK ${m.index}` : `BOS_NOT_BROKEN ${m.index}`);
  }

  for (const m of claims?.sweeps ?? []) {
    const c = candles[m.index];
    if (!c) { problems.push(`SWEEP_BAD_INDEX ${m.index}`); continue; }
    const s = swingBefore(candles, m.direction === "up" ? "high" : "low", v.chartBosFractal, m.index);
    if (!s) { problems.push(`SWEEP_NO_SWING ${m.index}`); continue; }
    const wickPct = m.direction === "up" ? ((c.high - s.price) / s.price) * 100 : ((s.price - c.low) / s.price) * 100;
    const back = [m.index, m.index + 1].some((i) => candles[i] && (m.direction === "up" ? candles[i].close <= s.price : candles[i].close >= s.price));
    if (!(wickPct > v.sweepMinWickPct) || !back) { problems.push(`SWEEP_INVALID ${m.index}`); continue; }
    const prev = candles.slice(Math.max(0, m.index - 20), m.index);
    const avg = prev.length ? prev.reduce((a, x) => a + x.volume, 0) / prev.length : 0;
    if (!(avg > 0 && c.volume > v.sweepMinVolumeRatio * avg)) problems.push(`SWEEP_WITHOUT_VOLUME ${m.index}`);
  }

  return problems.length ? out("ESCALATE", problems.join("; "), problems.map((p) => p.split(" ")[0].replace(":", ""))) : out("PASS", "chart quality ok");
}
