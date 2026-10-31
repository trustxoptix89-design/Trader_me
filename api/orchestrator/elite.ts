import { EliteCouncilSchema, type EliteCouncilOutput, type ElitePayload } from "../types/advanced";
import { callEliteLLM } from "./eliteLlm";

export async function evaluateEliteCouncil(payload: ElitePayload): Promise<EliteCouncilOutput> {
  // 1. Hard Enforce Safety (Fail Fast)
  if (payload.dataStale || payload.rr < 1.5) {
    return { action: "NO_TRADE", reasoning: "Hard safety limit violated.", confidence: 1.0 };
  }
  // 2. Call Elite Model with 10s Timeout (Circuit Breaker)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await callEliteLLM(payload, controller.signal);
    clearTimeout(timeoutId);
    return EliteCouncilSchema.parse(response);
  } catch {
    // Fail-safe: If timeout or parse error, DO NOT TRADE.
    return { action: "NO_TRADE", reasoning: "Elite Council timeout or schema failure. Fail-safe triggered.", confidence: 0.0 };
  }
}
