import { createHash } from "node:crypto";

/**
 * Centralised, versioned governance parameters.
 *
 * Every number that influences a trade decision lives here, with its origin:
 *  - REFERENCE: taken from the specification PDF (section noted in `source`).
 *  - EMPIRICAL: calculated and tested on data. NO parameter is in this class yet: nothing has been backtested/calibrated,
 *               so nothing may be labelled EMPIRICAL until a measured result exists (see docs/PARAMETERS.md).
 *  - PROPOSED:  an engineering choice of this project. Temporary, always overridable, never a silent permanent rule.
 *
 * Changing any value or any spec text requires bumping GOVERNANCE_CONFIG_VERSION. The version and the value fingerprint are
 * written to every audit event, so a decision can always be traced to the exact rules that produced it.
 */
export const GOVERNANCE_CONFIG_VERSION = "2026-11-01.1";

export type ParamClass = "REFERENCE" | "EMPIRICAL" | "PROPOSED";
export interface ParamSpec { value: number; class: ParamClass; min: number; max: number; unit: string; source: string; rationale: string }

export const PARAM_SPECS = {
  dataStaleMultiple: { value: 2, class: "REFERENCE", min: 1, max: 10, unit: "x timeframe", source: "PDF Phase D, Data Room", rationale: "freshness_ms > 2 x TF halts with DATA_STALE" },
  dataMaxGapRatio: { value: 0.05, class: "REFERENCE", min: 0, max: 0.5, unit: "ratio", source: "PDF Phase D, Data Room", rationale: "gap larger than 5% of the range halts with DATA_GAP" },
  minRr: { value: 1.5, class: "REFERENCE", min: 1, max: 10, unit: "ratio", source: "PDF Phase D, Risk Room", rationale: "R:R < 1.5 halts with RISK_REJECT; also the Elite hard gate (V2 PDF)" },
  invalidationMaxAtr: { value: 3, class: "REFERENCE", min: 0.5, max: 10, unit: "x ATR", source: "PDF Phase D, Risk Room", rationale: "invalidation farther than 3 x ATR halts" },
  invalidationMinAtr: { value: 0.5, class: "REFERENCE", min: 0.05, max: 3, unit: "x ATR", source: "PDF Phase D, Risk Room", rationale: "invalidation closer than 0.5 x ATR halts" },
  liquidationMultiple: { value: 2, class: "REFERENCE", min: 1, max: 20, unit: "x invalidation distance", source: "PDF Phase D, Risk Room", rationale: "futures: liquidation distance < 2 x invalidation distance halts" },
  fundingRiskThreshold: { value: 0.0005, class: "REFERENCE", min: 0, max: 0.01, unit: "fraction per 8h", source: "PDF Phase D, Risk Room", rationale: "adverse funding above 0.05% per 8h is flagged (not a halt)" },
  minValidVotes: { value: 5, class: "REFERENCE", min: 1, max: 33, unit: "votes", source: "PDF Phase D, Approval Room", rationale: "minimum valid (non-abstain) votes; fewer is INCONCLUSIVE. PDF text is garbled by RTL extraction, read as '>= 5'" },
  dissentTrigger: { value: 0.3, class: "REFERENCE", min: 0.05, max: 0.95, unit: "weight share", source: "PDF Phase D, Approval Room + user instruction", rationale: "weighted dissent above 30% consults the Elite Council" },
  deadlockShare: { value: 0.3, class: "REFERENCE", min: 0.05, max: 0.5, unit: "weight share", source: "PDF Phase D, Approval Room", rationale: "both opposing directions at or above 30% weight: group deadlock, never approved" },
  eliteTimeoutMs: { value: 10000, class: "REFERENCE", min: 1000, max: 60000, unit: "ms", source: "V2 PDF, Elite Council", rationale: "10 s circuit breaker" },
  spotTakerFeePct: { value: 0.1, class: "REFERENCE", min: 0, max: 1, unit: "% per side", source: "PDF Phase F", rationale: "spot taker fee 0.1%" },
  futuresTakerFeePct: { value: 0.05, class: "REFERENCE", min: 0, max: 1, unit: "% per side", source: "PDF Phase F", rationale: "futures taker fee 0.05%" },
  slippagePct: { value: 0.1, class: "PROPOSED", min: 0.05, max: 0.15, unit: "% per side", source: "PDF Phase F gives the range 0.05%-0.15% by liquidity", rationale: "midpoint of the reference range; liquidity-dependent value not modelled yet" },
  approvalThreshold: { value: 0.6, class: "PROPOSED", min: 0.5, max: 1, unit: "weight share", source: "none (PDF only says 'a threshold')", rationale: "leading direction must hold 60% of valid weight; not calibrated" },
  borderlineRr: { value: 1.8, class: "PROPOSED", min: 1.5, max: 5, unit: "ratio", source: "none", rationale: "Elite fallback treats R:R within 20% above the 1.5 floor as borderline; not calibrated" },
  borderlineFreshnessRatio: { value: 0.75, class: "PROPOSED", min: 0.1, max: 1, unit: "x stale limit", source: "none", rationale: "Elite fallback treats data older than 75% of the stale limit as borderline; not calibrated" },
  deltaUltraWeight: { value: 3, class: "PROPOSED", min: 1, max: 10, unit: "weight", source: "user instruction ('e.g. weight 3')", rationale: "Delta Force ULTRA_TREND vote weight" },
  rangeVoteConfidence: { value: 0.7, class: "PROPOSED", min: 0, max: 1, unit: "confidence", source: "none", rationale: "confidence of a confirmed Range Mode trigger; informational only, does not change the decision" },
  verifierStructureLookback: { value: 60, class: "PROPOSED", min: 20, max: 500, unit: "candles", source: "none", rationale: "history the Independent Verifier searches for a confirmed swing point" },
  verifierSwingFractal: { value: 3, class: "REFERENCE", min: 2, max: 10, unit: "candles each side", source: "PDF Phase B, S/R pivot k=3", rationale: "pivot width used to find structure" },
  verifierEntryMaxAtr: { value: 1, class: "PROPOSED", min: 0.1, max: 5, unit: "x ATR", source: "none", rationale: "entry may not be farther than 1 ATR from the last close" },
  verifierMaxTargetAtr: { value: 8, class: "PROPOSED", min: 1, max: 50, unit: "x ATR", source: "none", rationale: "first target farther than 8 ATR from entry is unrealistic" },
  agentRsiBull: { value: 55, class: "PROPOSED", min: 50, max: 80, unit: "RSI", source: "none", rationale: "RSI agent votes bullish above this level; not calibrated" },
  agentRsiBear: { value: 45, class: "PROPOSED", min: 20, max: 50, unit: "RSI", source: "none", rationale: "RSI agent votes bearish below this level; not calibrated" },
  chartTouchTolerancePct: { value: 0.2, class: "REFERENCE", min: 0.01, max: 2, unit: "% of level", source: "PDF Phase B, S/R merge 0.2%", rationale: "a candle touches a level when its extreme is within 0.2%" },
  chartMinTouches: { value: 2, class: "REFERENCE", min: 1, max: 10, unit: "touches", source: "PDF Phase B/Chart Quality Room", rationale: "a claimed S/R level needs at least 2 real touches (PDF text garbled, read as '< 2 escalates')" },
  chartBosFractal: { value: 5, class: "REFERENCE", min: 2, max: 10, unit: "candles each side", source: "PDF Phase B, BOS fractal N=5", rationale: "swing width used by BOS" },
  sweepMinWickPct: { value: 0.3, class: "REFERENCE", min: 0.05, max: 3, unit: "% beyond swing", source: "PDF Phase B, liquidity sweep", rationale: "sweep wick must exceed 0.3%" },
  sweepMinVolumeRatio: { value: 1.5, class: "REFERENCE", min: 1, max: 10, unit: "x 20-candle average", source: "PDF Phase B, liquidity sweep", rationale: "a sweep needs volume above 1.5 x average" },
} as const satisfies Record<string, ParamSpec>;

export type ParamKey = keyof typeof PARAM_SPECS;
export type GovernanceValues = { [K in ParamKey]: number };

export interface GovernanceConfig {
  readonly version: string;
  /** sha256 of the sorted effective values: identifies the exact rule set that produced a decision. */
  readonly fingerprint: string;
  readonly values: Readonly<GovernanceValues>;
  /** Keys whose effective value differs from the shipped default. Always recorded for audit. */
  readonly overridden: readonly ParamKey[];
}

export class GovernanceConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid governance configuration: ${problems.join("; ")}`);
    this.name = "GovernanceConfigError";
  }
}

/** Builds and validates the effective configuration. Unknown keys, non-finite numbers and out-of-range values are rejected (no silent fallback). */
export function loadGovernanceConfig(overrides: Partial<Record<string, unknown>> = {}): GovernanceConfig {
  const problems: string[] = [];
  const values = Object.fromEntries(Object.entries(PARAM_SPECS).map(([k, s]) => [k, s.value])) as GovernanceValues;
  const overridden: ParamKey[] = [];
  for (const [key, raw] of Object.entries(overrides)) {
    if (!(key in PARAM_SPECS)) { problems.push(`unknown parameter "${key}"`); continue; }
    const spec = PARAM_SPECS[key as ParamKey];
    if (typeof raw !== "number" || !Number.isFinite(raw)) { problems.push(`${key} must be a finite number`); continue; }
    if (raw < spec.min || raw > spec.max) { problems.push(`${key}=${raw} outside [${spec.min}, ${spec.max}]`); continue; }
    values[key as ParamKey] = raw;
    if (raw !== spec.value) overridden.push(key as ParamKey);
  }
  if (values.invalidationMinAtr >= values.invalidationMaxAtr) problems.push("invalidationMinAtr must be < invalidationMaxAtr");
  if (values.borderlineRr < values.minRr) problems.push("borderlineRr must be >= minRr");
  if (problems.length) throw new GovernanceConfigError(problems);
  const fingerprint = createHash("sha256").update(JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k as ParamKey]]))).digest("hex");
  return Object.freeze({ version: GOVERNANCE_CONFIG_VERSION, fingerprint, values: Object.freeze(values), overridden: Object.freeze(overridden) });
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = loadGovernanceConfig();
