import type { DeltaRangeOutput, DeltaTrendOutput } from "../types/advanced";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";
import type { AgentVote } from "./rooms";

export const DELTA_AGENT_ID = "DELTA_FORCE";

/**
 * Turns Delta Force output into an Approval Room vote.
 *  - ULTRA_TREND                     -> directional vote with weight 3 (high-weight agent), confidence score/12
 *  - RANGE_DETECTED                  -> routed to Range Mode (never ABSTAIN): RANGE_SHORT / RANGE_LONG vote with weight 1;
 *                                       RANGE_TOO_TIGHT / ABSTAIN from Range Mode abstain
 *  - CONFLICT                        -> neutral vote (counts as dissent, carries the conflict to the Elite Council)
 *  - WEAK_TREND / ABSTAIN            -> abstain
 * `range` must be supplied when the trend verdict is RANGE_DETECTED; if it is missing the vote abstains with that reason.
 */
export function deltaForceVote(trend: DeltaTrendOutput, range?: DeltaRangeOutput, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): AgentVote {
  const DELTA_ULTRA_WEIGHT = cfg.values.deltaUltraWeight;
  const RANGE_VOTE_CONFIDENCE = cfg.values.rangeVoteConfidence;
  const base = { agentId: DELTA_AGENT_ID, group: "B" };
  switch (trend.verdict) {
    case "ULTRA_TREND":
      return { ...base, verdict: trend.direction === "BULLISH" ? "bullish" : trend.direction === "BEARISH" ? "bearish" : "abstain", confidence: trend.score / 12, weight: DELTA_ULTRA_WEIGHT, reason: trend.reasoning };
    case "RANGE_DETECTED": {
      if (!range) return { ...base, verdict: "abstain", confidence: 0, weight: 1, reason: "RANGE_DETECTED but Range Mode was not evaluated." };
      if (range.verdict === "RANGE_SHORT") return { ...base, verdict: "bearish", confidence: RANGE_VOTE_CONFIDENCE, weight: 1, reason: `Range Mode: ${range.reasoning}` };
      if (range.verdict === "RANGE_LONG") return { ...base, verdict: "bullish", confidence: RANGE_VOTE_CONFIDENCE, weight: 1, reason: `Range Mode: ${range.reasoning}` };
      return { ...base, verdict: "abstain", confidence: 0, weight: 1, reason: `Range Mode ${range.verdict}: ${range.reasoning}` };
    }
    case "CONFLICT":
      return { ...base, verdict: "neutral", confidence: 0, weight: 1, reason: trend.reasoning };
    default:
      return { ...base, verdict: "abstain", confidence: 0, weight: 1, reason: trend.reasoning };
  }
}
