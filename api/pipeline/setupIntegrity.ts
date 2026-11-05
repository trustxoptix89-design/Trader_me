import type { DeltaRangeOutput } from "../types/advanced";

/**
 * P4 Setup integrity (docs/PIPELINE_CONTRACT.md section 5).
 * Range mode: the DeltaRange output is the ONLY Setup reference. The submitted Setup must equal it exactly
 * (entry, invalidation = stopLoss, targets in order, direction) after number standardization (-0 -> 0). No tolerance is invented.
 * ATR is not part of the DeltaRange output, so it is not compared (reported as `notCompared`).
 * Trend mode has no approved Setup algorithm (R1 not approved): the submitted Setup is only structurally validated by the caller path.
 */
export interface SubmittedSetup { entry: number; invalidation: number; targets: readonly number[]; atr?: number }

export type IntegrityCode = "RANGE_NO_REFERENCE" | "RANGE_DIRECTION_MISMATCH" | "RANGE_SETUP_MISMATCH" | "SETUP_NOT_FINITE";
export type IntegrityResult =
  | { ok: true; reference: "DELTA_RANGE"; notCompared: string[] }
  | { ok: false; code: IntegrityCode; reason: string; fields: string[] };

const std = (n: number): number => (n === 0 ? 0 : n);
const finite = (...n: unknown[]): boolean => n.every((x) => typeof x === "number" && Number.isFinite(x));

export function checkRangeSetupIntegrity(setup: SubmittedSetup, range: DeltaRangeOutput, direction: "long" | "short" | undefined): IntegrityResult {
  if (range.verdict !== "RANGE_LONG" && range.verdict !== "RANGE_SHORT") {
    return { ok: false, code: "RANGE_NO_REFERENCE", reason: `RANGE_NO_REFERENCE: DeltaRange verdict ${range.verdict} provides no Setup; a submitted Setup cannot be validated`, fields: [] };
  }
  if (!finite(setup.entry, setup.invalidation, ...(setup.targets ?? [])) || !finite(range.entry, range.stopLoss, ...range.targets)) {
    return { ok: false, code: "SETUP_NOT_FINITE", reason: "SETUP_NOT_FINITE: a Setup or DeltaRange number is missing or not finite", fields: [] };
  }
  const refDir = range.verdict === "RANGE_LONG" ? "long" : "short";
  if (direction !== refDir) return { ok: false, code: "RANGE_DIRECTION_MISMATCH", reason: `RANGE_DIRECTION_MISMATCH: DeltaRange says ${refDir}, submitted Setup says ${direction ?? "unknown"}`, fields: ["direction"] };
  const bad: string[] = [];
  if (std(setup.entry) !== std(range.entry)) bad.push("entry");
  if (std(setup.invalidation) !== std(range.stopLoss)) bad.push("invalidation");
  if (setup.targets.length !== range.targets.length) bad.push("targets.length");
  else range.targets.forEach((t, i) => { if (std(setup.targets[i]) !== std(t)) bad.push(`targets[${i}]`); });
  if (bad.length) return { ok: false, code: "RANGE_SETUP_MISMATCH", reason: `RANGE_SETUP_MISMATCH: submitted Setup differs from DeltaRange in ${bad.join(", ")}`, fields: bad };
  return { ok: true, reference: "DELTA_RANGE", notCompared: ["atr"] };
}

export type PriceStepComparison = { comparable: true; equal: boolean } | { comparable: false; code: "UNKNOWN_PRICE_STEP" };
/**
 * Comparison of two INDEPENDENT outputs: only by the instrument's valid price step (both prices land on the same tick).
 * Without a valid step the outputs are not comparable (UNKNOWN_PRICE_STEP); no fixed tolerance is ever assumed.
 */
export function samePriceTick(a: number, b: number, priceStep: number | undefined): PriceStepComparison {
  if (typeof priceStep !== "number" || !Number.isFinite(priceStep) || priceStep <= 0 || !finite(a, b)) return { comparable: false, code: "UNKNOWN_PRICE_STEP" };
  return { comparable: true, equal: Math.round(a / priceStep) === Math.round(b / priceStep) };
}
