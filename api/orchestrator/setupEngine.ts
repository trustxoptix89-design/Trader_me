import { createHash } from "node:crypto";
import type { Candle } from "@contracts/types";
import { atrSeries } from "@contracts/indicators";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "./config";

/**
 * Setup Engine (architecture decision D-4, see docs/V6_TRACEABILITY.md): a deterministic, LLM-free producer of the
 * trade candidate (entry, invalidation, targets). The Risk Room only VALIDATES it, the Independent Verifier may VETO it,
 * the Elite Council only reviews. This module imports no room, verifier, agent or LLM code.
 *
 * Rule set R1 (structure only; it introduces NO new numeric threshold - every number comes from the governed config):
 *   entry        = close of the last candle                         (the Verifier requires entry within 1 ATR of it)
 *   invalidation = most recent confirmed fractal swing beyond entry on the protective side (low below for long, high above for short)
 *   targets      = confirmed opposing swings beyond entry, nearest first
 *   fractal width = cfg.verifierSwingFractal (REFERENCE, V6 S/R pivot k=3), lookback = cfg.verifierStructureLookback (PROPOSED)
 * R:R, ATR distance, fees and funding are NOT judged here: that is the Risk Room / Verifier job.
 * Anything it cannot compute from valid data yields ABSTAIN (data not usable) or NO_TRADE (data fine, no structure). Never an estimate.
 */
export type Direction = "long" | "short";
export interface SetupRequest { symbol: string; market: "spot" | "futures"; direction: Direction; candles: Candle[] }
export interface SetupTrace {
  rule: "R1_STRUCTURE_SWINGS"; inputHash: string; candlesUsed: number; lastCandleTime: number | null;
  invalidationSwingTime: number | null; targetSwingTimes: number[]; configVersion: string; configFingerprint: string;
}
export interface TradeSetup { entry: number; invalidation: number; targets: number[]; atr: number }
export type SetupResult =
  | { status: "SETUP"; direction: Direction; setup: TradeSetup; trace: SetupTrace }
  | { status: "NO_TRADE" | "ABSTAIN"; reason: string; trace: SetupTrace };

const MIN_HISTORY = 50;
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const finite = (...n: number[]) => n.every((x) => typeof x === "number" && Number.isFinite(x));

function dataProblem(c: Candle[]): string | null {
  if (!Array.isArray(c) || c.length < MIN_HISTORY) return `INSUFFICIENT_HISTORY: need ${MIN_HISTORY} candles`;
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (!k || !finite(k.time, k.open, k.high, k.low, k.close) || k.high < k.low || k.low <= 0) return `INVALID_CANDLE at index ${i}`;
    if (i > 0 && !(k.time > c[i - 1].time)) return `CANDLES_NOT_STRICTLY_ORDERED at index ${i}`;
  }
  return null;
}

interface Swing { index: number; time: number; price: number }
/** Confirmed fractal swings (k candles each side, strict), oldest first. A swing needs k later candles, so it never repaints. */
function swings(c: Candle[], kind: "low" | "high", k: number, lookback: number): Swing[] {
  const out: Swing[] = [];
  const start = Math.max(k, c.length - lookback);
  for (let i = start; i <= c.length - 1 - k; i++) {
    let ok = true;
    for (let j = 1; j <= k && ok; j++) ok = kind === "low" ? c[i].low < c[i - j].low && c[i].low < c[i + j].low : c[i].high > c[i - j].high && c[i].high > c[i + j].high;
    if (ok) out.push({ index: i, time: c[i].time, price: kind === "low" ? c[i].low : c[i].high });
  }
  return out;
}

export function buildSetup(req: SetupRequest, cfg: GovernanceConfig = DEFAULT_GOVERNANCE_CONFIG): SetupResult {
  const c = req.candles;
  const trace: SetupTrace = {
    rule: "R1_STRUCTURE_SWINGS", inputHash: sha(Array.isArray(c) ? c.map((k) => [k?.time, k?.open, k?.high, k?.low, k?.close]) : null),
    candlesUsed: Array.isArray(c) ? c.length : 0, lastCandleTime: Array.isArray(c) && c.length ? c[c.length - 1]?.time ?? null : null,
    invalidationSwingTime: null, targetSwingTimes: [], configVersion: cfg.version, configFingerprint: cfg.fingerprint,
  };
  if (req.direction !== "long" && req.direction !== "short") return { status: "ABSTAIN", reason: "INVALID_DIRECTION", trace };
  const problem = dataProblem(c);
  if (problem) return { status: "ABSTAIN", reason: problem, trace };
  const atr = atrSeries(c, 14).at(-1);
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return { status: "ABSTAIN", reason: "ATR_UNAVAILABLE", trace };

  const entry = c[c.length - 1].close;
  const k = cfg.values.verifierSwingFractal, lookback = cfg.values.verifierStructureLookback;
  const long = req.direction === "long";
  const protective = swings(c, long ? "low" : "high", k, lookback).filter((s) => (long ? s.price < entry : s.price > entry));
  const stop = protective.at(-1);
  if (!stop) return { status: "NO_TRADE", reason: "NO_PROTECTIVE_STRUCTURE: no confirmed swing beyond entry", trace };
  const opposing = swings(c, long ? "high" : "low", k, lookback).filter((s) => (long ? s.price > entry : s.price < entry))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  if (!opposing.length) return { status: "NO_TRADE", reason: "NO_TARGET_STRUCTURE: no confirmed opposing swing beyond entry", trace: { ...trace, invalidationSwingTime: stop.time } };
  const targets = [...new Set(opposing.map((s) => s.price))];
  return {
    status: "SETUP", direction: req.direction, setup: { entry, invalidation: stop.price, targets, atr },
    trace: { ...trace, invalidationSwingTime: stop.time, targetSwingTimes: opposing.map((s) => s.time) },
  };
}

/** Schema check for a SetupResult (also usable on untrusted/serialised input). Returns the list of problems; empty = valid. */
export function validateSetupResult(x: unknown): string[] {
  const p: string[] = [];
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return ["not an object"];
  const t = o.trace as Record<string, unknown> | undefined;
  if (!t || t.rule !== "R1_STRUCTURE_SWINGS" || typeof t.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(t.inputHash) || typeof t.configFingerprint !== "string" || typeof t.configVersion !== "string") p.push("trace missing or malformed");
  if (o.status === "NO_TRADE" || o.status === "ABSTAIN") {
    if (typeof o.reason !== "string" || !o.reason) p.push("reason required");
    if ("setup" in o) p.push(`${String(o.status)} must not carry a setup`);
    return p;
  }
  if (o.status !== "SETUP") return [...p, "status must be SETUP | NO_TRADE | ABSTAIN"];
  if (o.direction !== "long" && o.direction !== "short") p.push("direction must be long|short");
  const s = o.setup as Partial<TradeSetup> | undefined;
  if (!s || !finite(s.entry as number, s.invalidation as number, s.atr as number) || !Array.isArray(s.targets) || s.targets.length === 0 || !s.targets.every((v) => finite(v))) return [...p, "setup numbers must be finite with at least one target"];
  if ((s.atr as number) <= 0 || (s.entry as number) <= 0) p.push("entry and atr must be positive");
  const e = s.entry as number, i = s.invalidation as number, tg = s.targets as number[];
  if (o.direction === "long" && !(i < e && tg.every((v, n) => v > e && (n === 0 || v > tg[n - 1])))) p.push("long requires invalidation < entry < ascending targets");
  if (o.direction === "short" && !(i > e && tg.every((v, n) => v < e && (n === 0 || v < tg[n - 1])))) p.push("short requires invalidation > entry > descending targets");
  if (t && (!Array.isArray(t.targetSwingTimes) || t.invalidationSwingTime === null)) p.push("trace must reference the swing points used");
  return p;
}
