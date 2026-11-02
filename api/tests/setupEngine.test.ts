import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { DEFAULT_GOVERNANCE_CONFIG } from "../orchestrator/config";
import { buildSetup, validateSetupResult } from "../orchestrator/setupEngine";
import { independentVerifier } from "../orchestrator/verifier";
import { riskRoom } from "../orchestrator/rooms";
import { trendSeries } from "./fixtures/advancedFixtures";
import { trimToPullbackEntry, zigzagTrend } from "./fixtures/scenarioFixtures";

const real = (JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/btcusdt_1h.json", import.meta.url)), "utf8")) as { candles: Candle[] }).candles;
const H = 3_600_000;
const up = trimToPullbackEntry(zigzagTrend(300, H, 100, 1, { drift: 0.001, amp: 0.008, period: 12 }), "long");
const down = trimToPullbackEntry(zigzagTrend(300, H, 100, -1, { drift: 0.001, amp: 0.008, period: 12 }), "short");
const req = (direction: "long" | "short", candles: Candle[]) => ({ symbol: "BTCUSDT", market: "spot" as const, direction, candles });

describe("Setup Engine R1 (deterministic, structure only)", () => {
  it("long: entry = last close, invalidation = confirmed swing low below, targets ascending above; schema valid", () => {
    const r = buildSetup(req("long", up));
    expect(r.status).toBe("SETUP");
    if (r.status !== "SETUP") return;
    expect(r.setup.entry).toBe(up[up.length - 1].close);
    expect(r.setup.invalidation).toBeLessThan(r.setup.entry);
    expect(r.setup.targets[0]).toBeGreaterThan(r.setup.entry);
    expect(validateSetupResult(r)).toEqual([]);
    // traceability: the swing bar used for the stop really holds that low
    const bar = up.find((k) => k.time === r.trace.invalidationSwingTime);
    expect(bar?.low).toBe(r.setup.invalidation);
  });
  it("short mirrors long", () => {
    const r = buildSetup(req("short", down));
    expect(r.status).toBe("SETUP");
    if (r.status !== "SETUP") return;
    expect(r.setup.invalidation).toBeGreaterThan(r.setup.entry);
    expect(r.setup.targets[0]).toBeLessThan(r.setup.entry);
    expect(validateSetupResult(r)).toEqual([]);
  });
  it("real BTCUSDT 1h candles: any SETUP is schema-valid and traceable; otherwise NO_TRADE with a reason, never numbers", () => {
    for (const end of [300, 450, 600, 750, 900, 999]) {
      for (const d of ["long", "short"] as const) {
        const r = buildSetup(req(d, real.slice(0, end)));
        expect(validateSetupResult(r)).toEqual([]);
        if (r.status === "SETUP") expect(real.some((k) => k.time === r.trace.invalidationSwingTime)).toBe(true);
        else expect("setup" in r).toBe(false);
      }
    }
  });
  it("is deterministic: same input -> identical output and input hash", () => {
    expect(JSON.stringify(buildSetup(req("long", up)))).toBe(JSON.stringify(buildSetup(req("long", up))));
  });
  it("ABSTAIN on insufficient history, invalid candles, unordered time, bad direction", () => {
    expect(buildSetup(req("long", up.slice(-20))).status).toBe("ABSTAIN");
    const bad = up.map((k) => ({ ...k })); bad[10] = { ...bad[10], close: Number.NaN };
    expect(buildSetup(req("long", bad)).status).toBe("ABSTAIN");
    const unordered = up.map((k) => ({ ...k })); unordered[20] = { ...unordered[20], time: unordered[5].time };
    expect(buildSetup(req("long", unordered)).status).toBe("ABSTAIN");
    const inverted = up.map((k) => ({ ...k })); inverted[30] = { ...inverted[30], high: 1, low: 2 };
    expect(buildSetup(req("long", inverted)).status).toBe("ABSTAIN");
    const badDir = buildSetup({ ...req("long", up), direction: "sideways" as never });
    expect(badDir.status).toBe("ABSTAIN");
    expect("reason" in badDir && badDir.reason).toBe("INVALID_DIRECTION");
  });
  it("NO_TRADE (no invented numbers) when the series has no pullback structure", () => {
    const r = buildSetup(req("long", trendSeries(120, H, 100, 1)));
    expect(r.status).toBe("NO_TRADE");
    expect("setup" in r).toBe(false);
  });
  it("uses only governed parameters: fractal width comes from the config", () => {
    const r1 = buildSetup(req("long", up));
    const wide = { ...DEFAULT_GOVERNANCE_CONFIG, values: { ...DEFAULT_GOVERNANCE_CONFIG.values, verifierSwingFractal: 10 }, fingerprint: "x".repeat(64) };
    const r2 = buildSetup(req("long", up), wide);
    expect(r2.trace.configFingerprint).not.toBe(r1.trace.configFingerprint);
  });
  it("downstream gates stay independent: Risk Room and Verifier judge the engine output, they do not produce it", () => {
    const r = buildSetup(req("long", up));
    if (r.status !== "SETUP") throw new Error("expected SETUP");
    const room = riskRoom({ direction: "long", market: "spot", ...r.setup });
    expect(["PASS", "HALT", "ESCALATE"]).toContain(room.status);
    const v = independentVerifier(up, { direction: "long", market: "spot", entry: r.setup.entry, invalidation: r.setup.invalidation, targets: r.setup.targets });
    expect(["OK", "VETO"]).toContain(v.status);
  });
  it("engine imports no room/verifier/agent/LLM module", () => {
    const src = readFileSync(fileURLToPath(new URL("../orchestrator/setupEngine.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1].split(/[/:]/).pop()!.replace(".ts", ""));
    expect(imports.sort()).toEqual(["config", "crypto", "indicators", "types"]);
  });
});

describe("validateSetupResult schema", () => {
  const ok = buildSetup(req("long", up));
  it("accepts the engine output", () => expect(validateSetupResult(ok)).toEqual([]));
  it("rejects wrong geometry, non-finite numbers, missing trace, setup on NO_TRADE", () => {
    if (ok.status !== "SETUP") throw new Error("expected SETUP");
    expect(validateSetupResult({ ...ok, setup: { ...ok.setup, invalidation: ok.setup.entry + 1 } }).length).toBeGreaterThan(0);
    expect(validateSetupResult({ ...ok, setup: { ...ok.setup, targets: [Number.NaN] } }).length).toBeGreaterThan(0);
    expect(validateSetupResult({ ...ok, trace: undefined }).length).toBeGreaterThan(0);
    expect(validateSetupResult({ status: "NO_TRADE", reason: "x", setup: ok.setup, trace: ok.trace }).length).toBeGreaterThan(0);
    expect(validateSetupResult({ ...ok, setup: { ...ok.setup, targets: [ok.setup.entry + 2, ok.setup.entry + 1] } }).length).toBeGreaterThan(0);
    expect(validateSetupResult(null)).toEqual(["not an object"]);
    expect(validateSetupResult({ status: "MAYBE", trace: ok.trace }).length).toBeGreaterThan(0);
  });
});
