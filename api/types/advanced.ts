import { z } from "zod";

export const DeltaTrendSchema = z.object({
  verdict: z.enum(["ULTRA_TREND", "WEAK_TREND", "CONFLICT", "RANGE_DETECTED", "ABSTAIN"]),
  direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  score: z.number().min(0).max(12),
  timeframes: z.object({
    "4H": z.object({ supertrend: z.string(), adx: z.number(), emaAligned: z.boolean(), ichimokuOk: z.boolean() }),
    "1H": z.object({ supertrend: z.string(), adx: z.number(), emaAligned: z.boolean(), ichimokuOk: z.boolean() }),
    "15m": z.object({ supertrend: z.string(), adx: z.number(), emaAligned: z.boolean(), ichimokuOk: z.boolean() }),
  }),
  reasoning: z.string(),
});
export type DeltaTrendOutput = z.infer<typeof DeltaTrendSchema>;

export const DeltaRangeSchema = z.object({
  verdict: z.enum(["RANGE_SHORT", "RANGE_LONG", "RANGE_TOO_TIGHT", "ABSTAIN"]),
  boundaries: z.object({ upper: z.number(), lower: z.number(), midpoint: z.number() }),
  ltfConfirmation: z.boolean(),
  entry: z.number(),
  stopLoss: z.number(),
  targets: z.tuple([z.number(), z.number()]),
  reasoning: z.string(),
});
export type DeltaRangeOutput = z.infer<typeof DeltaRangeSchema>;

/** Input of the Elite Council. Hard safety fields are checked deterministically before any LLM call. */
export const ElitePayloadSchema = z.object({
  symbol: z.string(),
  dataStale: z.boolean(),
  rr: z.number(),
  trend: DeltaTrendSchema.optional(),
  range: DeltaRangeSchema.optional(),
});
export type ElitePayload = z.infer<typeof ElitePayloadSchema>;

/** Strict structured output of the Elite Council; anything that fails this schema becomes NO_TRADE. */
export const EliteCouncilSchema = z.object({
  action: z.enum(["LONG", "SHORT", "NO_TRADE"]),
  reasoning: z.string().max(200),
  confidence: z.number().min(0).max(1),
});
export type EliteCouncilOutput = z.infer<typeof EliteCouncilSchema>;
