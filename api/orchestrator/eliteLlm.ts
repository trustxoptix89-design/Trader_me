import type { ElitePayload } from "../types/advanced";

/**
 * Elite model call. NOT CONFIGURED on purpose: the project forbids anything that needs a real key
 * (spec non-goals), so this rejects and the Elite Council fails safe to NO_TRADE.
 * Implementations MUST honour `signal` (reject when aborted) so the 10s circuit breaker works.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub keeps the real signature
export async function callEliteLLM(payload: ElitePayload, signal: AbortSignal): Promise<unknown> {
  throw new Error("ELITE_LLM_NOT_CONFIGURED");
}
