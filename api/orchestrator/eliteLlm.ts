import type { ElitePayload } from "../types/advanced";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";
import { eliteHeuristic } from "./eliteHeuristic";

/**
 * Elite model call. The project forbids anything that needs a real key (spec non-goals), so this is a
 * deterministic heuristic (eliteHeuristic), not a language model. It keeps the async + AbortSignal contract so a
 * real model can replace it later without touching evaluateEliteCouncil; the 10s circuit breaker still applies.
 */
export async function callEliteLLM(payload: ElitePayload, signal: AbortSignal, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): Promise<unknown> {
  if (signal.aborted) throw new Error("ELITE_ABORTED");
  return eliteHeuristic(payload, cfg);
}
