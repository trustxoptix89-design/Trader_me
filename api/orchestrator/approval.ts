import type { EliteCouncilOutput } from "../types/advanced";
import type { AgentVote } from "./rooms";

export interface ApprovalConfig {
  /** Fewer valid (non-abstain) votes than this -> INCONCLUSIVE. */
  minValidVotes: number;
  /** Weighted dissent share strictly above this triggers the Elite Council. */
  dissentTrigger: number;
  /** Both opposing directions at or above this weight share -> hard group deadlock (never approved). */
  deadlockShare: number;
  /** Leading direction must hold at least this weight share. Project choice, not a PDF value. */
  approvalThreshold: number;
}
export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = { minValidVotes: 5, dissentTrigger: 0.3, deadlockShare: 0.3, approvalThreshold: 0.6 };

export interface ApprovalTally {
  validVotes: number;
  totalWeight: number;
  shares: { bullish: number; bearish: number; neutral: number };
  leading: "bullish" | "bearish" | null;
  /** (total valid weight - leading weight) / total valid weight; neutral votes count as dissent. */
  dissentRatio: number;
  deadlock: boolean;
}

/** Weighted tally. Abstentions are ignored. No simple majority: every vote counts by its weight. */
export function tallyVotes(votes: AgentVote[], cfg: ApprovalConfig = DEFAULT_APPROVAL_CONFIG): ApprovalTally {
  const valid = votes.filter((v) => v.verdict !== "abstain" && v.weight > 0);
  const w = { bullish: 0, bearish: 0, neutral: 0 };
  for (const v of valid) w[v.verdict as "bullish" | "bearish" | "neutral"] += v.weight;
  const total = w.bullish + w.bearish + w.neutral;
  const share = (x: number): number => (total > 0 ? x / total : 0);
  const shares = { bullish: share(w.bullish), bearish: share(w.bearish), neutral: share(w.neutral) };
  const leading = w.bullish > w.bearish ? "bullish" : w.bearish > w.bullish ? "bearish" : null;
  const leadW = leading ? w[leading] : 0;
  return {
    validVotes: valid.length,
    totalWeight: total,
    shares,
    leading,
    dissentRatio: total > 0 ? (total - leadW) / total : 1,
    deadlock: shares.bullish >= cfg.deadlockShare && shares.bearish >= cfg.deadlockShare,
  };
}

export type ApprovalStatus = "APPROVED" | "INCONCLUSIVE";
export interface ApprovalDecision {
  status: ApprovalStatus;
  haltReason?: string;
  tally: ApprovalTally;
  eliteTriggered: boolean;
  elite?: EliteCouncilOutput;
}

export interface ApprovalContext {
  /** Direction of the proposed trade setup (from entry vs target). The leading vote must agree with it. */
  setupDirection: "bullish" | "bearish";
  /** Called only when dissent > cfg.dissentTrigger. Receives the candidate action and the dissent ratio. */
  consultElite: (candidate: "LONG" | "SHORT", dissentRatio: number) => Promise<EliteCouncilOutput>;
}

/**
 * Approval Room (weighted vote, no majority rule). Order of checks:
 *  1. fewer than minValidVotes valid votes            -> INCONCLUSIVE(INSUFFICIENT_VOTES)
 *  2. no leading direction (tie)                      -> INCONCLUSIVE(NO_CONSENSUS)
 *  3. leading direction != setup direction            -> INCONCLUSIVE(DIRECTION_MISMATCH)
 *  4. dissent > 30%: Elite Council is consulted
 *       Elite NO_TRADE                                -> INCONCLUSIVE(ELITE_NO_TRADE)
 *       hard deadlock (both sides >= 30%)             -> INCONCLUSIVE(GROUP_DEADLOCK), Elite can never override it
 *       Elite direction != leading direction          -> INCONCLUSIVE(ELITE_DISAGREES)
 *  5. leading share < approvalThreshold               -> INCONCLUSIVE(BELOW_THRESHOLD)
 *  6. otherwise                                       -> APPROVED
 * The Risk/Data/Error rooms are checked by the state machine before this room runs.
 */
export async function approvalRoom(votes: AgentVote[], ctx: ApprovalContext, cfg: ApprovalConfig = DEFAULT_APPROVAL_CONFIG): Promise<ApprovalDecision> {
  const tally = tallyVotes(votes, cfg);
  const out = (status: ApprovalStatus, haltReason?: string, extra: Partial<ApprovalDecision> = {}): ApprovalDecision => ({ status, haltReason, tally, eliteTriggered: false, ...extra });

  if (tally.validVotes < cfg.minValidVotes) return out("INCONCLUSIVE", "INSUFFICIENT_VOTES");
  if (!tally.leading) return out("INCONCLUSIVE", "NO_CONSENSUS");
  if (tally.leading !== ctx.setupDirection) return out("INCONCLUSIVE", "DIRECTION_MISMATCH");

  let elite: EliteCouncilOutput | undefined;
  const eliteTriggered = tally.dissentRatio > cfg.dissentTrigger;
  if (eliteTriggered) {
    const candidate = tally.leading === "bullish" ? "LONG" : "SHORT";
    elite = await ctx.consultElite(candidate, tally.dissentRatio);
    if (elite.action === "NO_TRADE") return out("INCONCLUSIVE", "ELITE_NO_TRADE", { eliteTriggered, elite });
    if (tally.deadlock) return out("INCONCLUSIVE", "GROUP_DEADLOCK", { eliteTriggered, elite });
    if (elite.action !== candidate) return out("INCONCLUSIVE", "ELITE_DISAGREES", { eliteTriggered, elite });
  }
  if (tally.shares[tally.leading] < cfg.approvalThreshold) return out("INCONCLUSIVE", "BELOW_THRESHOLD", { eliteTriggered, elite });
  return out("APPROVED", undefined, { eliteTriggered, elite });
}
