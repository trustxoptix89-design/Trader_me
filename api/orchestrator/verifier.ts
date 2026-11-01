import type { Candle } from "@contracts/types";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";

/**
 * Independent Verifier (PDF Phase D, section 5.4): sits between the agent layer and the Approval Room with an ABSOLUTE veto.
 *
 * Independence rules enforced by construction:
 *  - It receives only raw OHLCV and the trade candidate (direction, entry, invalidation, targets). It does NOT receive agent
 *    verdicts, room results, the Risk Room's ATR, or any indicator output of the primary engine.
 *  - It imports nothing from indicators / rooms / approval. ATR and swing structure are re-derived below with its own code.
 * A VETO overrides every positive vote; INCONCLUSIVE inputs (not enough history, invalid raw data) are also a VETO.
 */
export interface VerifierCandidate {
  direction: "long" | "short";
  market: "spot" | "futures";
  entry: number;
  invalidation: number;
  targets: number[];
}
export interface VerifierResult {
  status: "OK" | "VETO";
  reasons: string[];
  metrics: { atr: number | null; risk: number | null; rewardGross: number | null; costAbs: number | null; netRr: number | null; swing: number | null };
}

const MIN_HISTORY = 50;

/** Wilder ATR(period) at the last candle, own implementation. */
function wilderAtr(c: Candle[], period = 14): number | null {
  if (c.length <= period) return null;
  const tr = (i: number): number => Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr(i);
  atr /= period;
  for (let i = period + 1; i < c.length; i++) atr = (atr * (period - 1) + tr(i)) / period;
  return atr;
}

/** Most recent confirmed fractal swing (needs `k` later candles, so it never repaints) strictly inside the lookback window. */
function lastSwing(c: Candle[], kind: "low" | "high", k: number, lookback: number, limit: number, wantBelow: boolean): number | null {
  const start = Math.max(k, c.length - lookback);
  for (let i = c.length - 1 - k; i >= start; i--) {
    let ok = true;
    for (let j = 1; j <= k && ok; j++) {
      if (kind === "low" ? !(c[i].low < c[i - j].low && c[i].low < c[i + j].low) : !(c[i].high > c[i - j].high && c[i].high > c[i + j].high)) ok = false;
    }
    if (!ok) continue;
    const price = kind === "low" ? c[i].low : c[i].high;
    if (wantBelow ? price < limit : price > limit) return price;
  }
  return null;
}

export function independentVerifier(candles: Candle[], cand: VerifierCandidate, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): VerifierResult {
  const v = cfg.values;
  const reasons: string[] = [];
  const metrics: VerifierResult["metrics"] = { atr: null, risk: null, rewardGross: null, costAbs: null, netRr: null, swing: null };
  const veto = (): VerifierResult => ({ status: "VETO", reasons, metrics });

  if (!Array.isArray(candles) || candles.length < MIN_HISTORY) { reasons.push(`INSUFFICIENT_HISTORY: need ${MIN_HISTORY} raw candles`); return veto(); }
  if (candles.some((c) => ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.high < c.low || c.close > c.high || c.close < c.low)) { reasons.push("INVALID_RAW_DATA"); return veto(); }
  const target = cand.targets[0];
  if (![cand.entry, cand.invalidation, target].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) { reasons.push("INVALID_CANDIDATE: entry/invalidation/target must be positive finite numbers"); return veto(); }

  const long = cand.direction === "long";
  if (long ? !(cand.invalidation < cand.entry && target > cand.entry) : !(cand.invalidation > cand.entry && target < cand.entry)) reasons.push("WRONG_SIDE: invalidation/target on the wrong side of entry");

  const atr = wilderAtr(candles);
  metrics.atr = atr;
  if (atr === null || !(atr > 0)) { reasons.push("ATR_UNAVAILABLE"); return veto(); }
  const last = candles[candles.length - 1];
  if (Math.abs(cand.entry - last.close) > v.verifierEntryMaxAtr * atr) reasons.push(`ENTRY_NOT_NEAR_MARKET: ${(Math.abs(cand.entry - last.close) / atr).toFixed(2)} ATR from the last close`);

  const risk = Math.abs(cand.entry - cand.invalidation);
  const reward = Math.abs(target - cand.entry);
  metrics.risk = risk;
  metrics.rewardGross = reward;
  if (risk > v.invalidationMaxAtr * atr) reasons.push(`INVALIDATION_TOO_FAR: ${(risk / atr).toFixed(2)} ATR`);
  if (risk < v.invalidationMinAtr * atr) reasons.push(`INVALIDATION_TOO_TIGHT: ${(risk / atr).toFixed(2)} ATR`);
  if (reward > v.verifierMaxTargetAtr * atr) reasons.push(`TARGET_UNREALISTIC: ${(reward / atr).toFixed(2)} ATR away`);
  for (let i = 1; i < cand.targets.length; i++) {
    if (long ? cand.targets[i] <= cand.targets[i - 1] : cand.targets[i] >= cand.targets[i - 1]) reasons.push("TARGETS_NOT_ORDERED");
  }

  // Structure: the invalidation must sit at or beyond the nearest confirmed protective swing, otherwise normal noise stops the trade out.
  const swing = long
    ? lastSwing(candles, "low", v.verifierSwingFractal, v.verifierStructureLookback, cand.entry, true)
    : lastSwing(candles, "high", v.verifierSwingFractal, v.verifierStructureLookback, cand.entry, false);
  metrics.swing = swing;
  if (swing === null) reasons.push("NO_STRUCTURE_FOUND: no confirmed protective swing in the lookback window");
  else if (long ? cand.invalidation > swing : cand.invalidation < swing) reasons.push(`INVALIDATION_INSIDE_STRUCTURE: protective swing at ${swing}`);

  // Net R:R after round-trip fees and slippage, derived independently from the candidate.
  const feePct = cand.market === "spot" ? v.spotTakerFeePct : v.futuresTakerFeePct;
  const costAbs = cand.entry * ((2 * (feePct + v.slippagePct)) / 100);
  metrics.costAbs = costAbs;
  const netRr = risk + costAbs > 0 ? (reward - costAbs) / (risk + costAbs) : 0;
  metrics.netRr = netRr;
  if (!(netRr >= v.minRr)) reasons.push(`NET_RR_TOO_LOW: ${netRr.toFixed(2)} after fees and slippage < ${v.minRr}`);

  return reasons.length ? veto() : { status: "OK", reasons: [], metrics };
}
