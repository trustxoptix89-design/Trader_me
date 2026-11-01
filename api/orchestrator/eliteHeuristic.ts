import type { EliteCouncilOutput, ElitePayload } from "../types/advanced";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";

/**
 * Deterministic Elite Council fallback. No LLM, no network, no key: the same payload always gives the same answer.
 *
 * Evaluated in this order, first match wins:
 *   1. Delta Force trend verdict CONFLICT              -> NO_TRADE
 *   2. Delta Force range verdict RANGE_TOO_TIGHT       -> NO_TRADE
 *   3. Borderline data (see thresholds below)          -> NO_TRADE
 *   4. Risk Room is anything other than exactly "PASS" -> NO_TRADE
 *   5. No candidate direction from the Approval Room   -> NO_TRADE
 *   6. Delta Force gives a direction that disagrees    -> NO_TRADE
 *   7. otherwise                                       -> the candidate direction
 *
 * Thresholds (borderlineRr, borderlineFreshnessRatio) are PROPOSED parameters of the governance config, NOT values from the specification PDF.
 */
export const PASS_CONFIDENCE = 0.6;
export const NO_TRADE_CONFIDENCE = 0.9;

const noTrade = (reasoning: string): EliteCouncilOutput => ({ action: "NO_TRADE", reasoning: reasoning.slice(0, 200), confidence: NO_TRADE_CONFIDENCE });

export function eliteHeuristic(payload: ElitePayload, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): EliteCouncilOutput {
  const { borderlineRr, borderlineFreshnessRatio } = cfg.values;
  if (payload.trend?.verdict === "CONFLICT") return noTrade("Delta Force trend verdict is CONFLICT: timeframes disagree.");
  if (payload.range?.verdict === "RANGE_TOO_TIGHT") return noTrade("Delta Force range verdict is RANGE_TOO_TIGHT: range too narrow to trade.");

  if (payload.rr < borderlineRr) return noTrade(`Borderline R:R ${payload.rr.toFixed(2)} < ${borderlineRr}.`);
  if (payload.freshnessRatio !== undefined && payload.freshnessRatio > borderlineFreshnessRatio) {
    return noTrade(`Borderline data freshness (${(payload.freshnessRatio * 100).toFixed(0)}% of the stale limit).`);
  }

  if (payload.riskRoom !== "PASS") return noTrade(`Risk Room is ${payload.riskRoom ?? "unknown"}, not strictly PASS.`);
  if (!payload.proposedAction) return noTrade("No candidate direction to confirm.");

  const deltaDirection = deltaDirectionOf(payload);
  if (deltaDirection && deltaDirection !== payload.proposedAction) {
    return noTrade(`Delta Force points ${deltaDirection}, candidate is ${payload.proposedAction}.`);
  }
  return { action: payload.proposedAction, reasoning: "Risk Room PASS, data not borderline, no Delta Force conflict.", confidence: PASS_CONFIDENCE };
}

/** Direction implied by Delta Force: ULTRA_TREND direction, or the range trigger. Undefined when Delta Force has no directional view. */
function deltaDirectionOf(payload: ElitePayload): "LONG" | "SHORT" | undefined {
  const t = payload.trend;
  if (t?.verdict === "ULTRA_TREND") return t.direction === "BULLISH" ? "LONG" : t.direction === "BEARISH" ? "SHORT" : undefined;
  const r = payload.range?.verdict;
  if (r === "RANGE_LONG") return "LONG";
  if (r === "RANGE_SHORT") return "SHORT";
  return undefined;
}
