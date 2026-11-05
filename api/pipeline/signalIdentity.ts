// P2 — Signal identity and Setup cycle (pure, deterministic). Contract: docs/PIPELINE_CONTRACT.md §4.
// signalKey identifies ONE evaluation event; cycleKey identifies a continuing Setup; the cycle logic decides what a new
// observation of the same Setup means (duplicate / continuation / new version / invalidation / new cycle). No clock, no randomness.
import { createHash } from "node:crypto";
import { canonical } from "../orchestrator/audit";

export const IDENTITY_CONTRACT_VERSION = 1;
export type Direction = "long" | "short";
export type MarketKind = "spot" | "futures";

export interface SetupNumbers { entry: number; invalidation: number; targets: number[]; atr: number }
export class IdentityError extends Error { constructor(m: string) { super(m); this.name = "IdentityError"; } }

const sha = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");

/** Number standardization = JSON canonical form (-0 -> 0, key order fixed); non-finite numbers are refused, never silently mapped. */
function assertSetup(s: SetupNumbers): void {
  const nums = [s?.entry, s?.invalidation, s?.atr, ...(Array.isArray(s?.targets) ? s.targets : [Number.NaN])];
  if (!nums.length || !nums.every((n) => typeof n === "number" && Number.isFinite(n))) throw new IdentityError("setup contains a missing or non-finite number");
  if (s.targets.length === 0) throw new IdentityError("setup has no targets");
}
export const setupFingerprint = (s: SetupNumbers): string => { assertSetup(s); return sha({ entry: s.entry, invalidation: s.invalidation, targets: s.targets, atr: s.atr }); };

export interface CycleIdentityInput { symbol: string; market: MarketKind; direction: Direction; referenceTimeframe: string }
export const cycleKey = (i: CycleIdentityInput): string => sha({ v: IDENTITY_CONTRACT_VERSION, symbol: i.symbol, market: i.market, direction: i.direction, referenceTimeframe: i.referenceTimeframe });

export interface SignalIdentityInput extends CycleIdentityInput { lastClosedCandleOpenTime: number; setup: SetupNumbers; configFingerprint: string }
export function signalKey(i: SignalIdentityInput): string {
  if (!Number.isSafeInteger(i.lastClosedCandleOpenTime)) throw new IdentityError("lastClosedCandleOpenTime must be an integer (ms)");
  return sha({ v: IDENTITY_CONTRACT_VERSION, symbol: i.symbol, market: i.market, direction: i.direction, referenceTimeframe: i.referenceTimeframe, lastClosedCandleOpenTime: i.lastClosedCandleOpenTime, setup: setupFingerprint(i.setup), config: i.configFingerprint });
}
/** Short, stable id used as the pipeline's signal/correlation id (160 bits of the key). */
export const signalIdFromKey = (key: string): string => `sig-${key.slice(0, 40)}`;

// ---------------------------------------------------------------- cycle

export type CycleStatus = "ACTIVE" | "INVALIDATED";
export type CycleEventKind = "NEW_CYCLE" | "NEW_VERSION" | "CONTINUED" | "INVALIDATED" | "SUPPRESSED";
/** Kinds that represent something new for a human/outbox. CONTINUED and SUPPRESSED never notify. */
export const NOTIFIABLE_KINDS: readonly CycleEventKind[] = ["NEW_CYCLE", "NEW_VERSION"];

export interface CycleState {
  cycleKey: string;
  seq: number;                     // number of events stored for this cycleKey (next event seq = seq)
  cycleNo: number;                 // 1-based, per cycleKey
  version: number;                 // 1-based, per cycle
  status: CycleStatus;
  direction: Direction;
  setupFingerprint: string;
  setup: SetupNumbers;
  lastClosedCandleOpenTime: number;
  lastSignalKey: string;
}
export interface Observation {
  cycleKey: string;
  signalKey: string;
  direction: Direction;
  setup: SetupNumbers;
  closedCandleOpenTime: number;
  /** Close of the last closed reference-timeframe candle (used only for the invalidation test). */
  lastClosedClose: number;
}
export interface CycleEvent {
  kind: CycleEventKind;
  cycleNo: number;
  version: number;
  statusAfter: CycleStatus;
  signalKey: string;
  setupFingerprint: string;
  setup: SetupNumbers;
  closedCandleOpenTime: number;
}
export type CycleDecision =
  | { outcome: "DUPLICATE" }
  | { outcome: "STALE"; reason: string }
  | { outcome: "APPLIED"; events: CycleEvent[] };

/** Invalidation (contract §4.4): a closed reference-timeframe candle that closes strictly beyond the active Setup's invalidation, against its direction. */
export const isInvalidated = (s: CycleState, lastClosedClose: number): boolean => s.status === "ACTIVE" && (s.direction === "long" ? lastClosedClose < s.setup.invalidation : lastClosedClose > s.setup.invalidation);

export function decideCycle(prev: CycleState | null, obs: Observation): CycleDecision {
  const fp = setupFingerprint(obs.setup);
  if (prev) {
    if (prev.lastSignalKey === obs.signalKey) return { outcome: "DUPLICATE" };
    if (obs.closedCandleOpenTime < prev.lastClosedCandleOpenTime) return { outcome: "STALE", reason: "observation is older than the last processed closed candle" };
  }
  const ev = (kind: CycleEventKind, cycleNo: number, version: number, statusAfter: CycleStatus, setup: SetupNumbers, setupFp: string): CycleEvent =>
    ({ kind, cycleNo, version, statusAfter, signalKey: obs.signalKey, setupFingerprint: setupFp, setup, closedCandleOpenTime: obs.closedCandleOpenTime });
  if (!prev) return { outcome: "APPLIED", events: [ev("NEW_CYCLE", 1, 1, "ACTIVE", obs.setup, fp)] };

  const events: CycleEvent[] = [];
  let status = prev.status;
  if (isInvalidated(prev, obs.lastClosedClose)) {
    events.push(ev("INVALIDATED", prev.cycleNo, prev.version, "INVALIDATED", prev.setup, prev.setupFingerprint));
    status = "INVALIDATED";
  }
  if (status === "ACTIVE") {
    events.push(fp === prev.setupFingerprint ? ev("CONTINUED", prev.cycleNo, prev.version, "ACTIVE", prev.setup, prev.setupFingerprint) : ev("NEW_VERSION", prev.cycleNo, prev.version + 1, "ACTIVE", obs.setup, fp));
  } else if (fp !== prev.setupFingerprint) {
    events.push(ev("NEW_CYCLE", prev.cycleNo + 1, 1, "ACTIVE", obs.setup, fp));          // re-formation after invalidation
  } else if (!events.length) {
    events.push(ev("SUPPRESSED", prev.cycleNo, prev.version, "INVALIDATED", prev.setup, prev.setupFingerprint)); // the dead Setup is still produced
  }
  return { outcome: "APPLIED", events };
}

/** Folds applied events into the next state (used by every store so state is always derivable from history). */
export function applyEvents(prev: CycleState | null, cycleKeyValue: string, direction: Direction, events: CycleEvent[]): CycleState {
  let s = prev;
  for (const e of events) {
    s = { cycleKey: cycleKeyValue, seq: (s?.seq ?? 0) + 1, cycleNo: e.cycleNo, version: e.version, status: e.statusAfter, direction, setupFingerprint: e.setupFingerprint, setup: e.setup, lastClosedCandleOpenTime: e.closedCandleOpenTime, lastSignalKey: e.signalKey };
  }
  return s as CycleState;
}
