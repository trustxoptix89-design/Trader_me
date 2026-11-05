import { describe, expect, it } from "vitest";
import { evaluateDeltaRange } from "../indicators/deltaforce.range";
import { InMemoryAuditStore } from "../orchestrator/audit";
import { runSignalPipeline } from "../orchestrator/machine";
import { checkRangeSetupIntegrity, samePriceTick } from "../pipeline/setupIntegrity";
import { baseInput, candlesBundle, rangeOf } from "./fixtures/governanceFixtures";

const shortRange = rangeOf("RANGE_SHORT"); // entry 109.5, stop 112, targets [105, 100]
const okSetup = { entry: 109.5, invalidation: 112, targets: [105, 100], atr: 1 };

describe("P4 Range Setup integrity (pure)", () => {
  it("identical Setup -> ok, ATR reported as not compared", () => {
    const r = checkRangeSetupIntegrity(okSetup, shortRange, "short");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notCompared.join(",")).toBe("atr");
  });
  it("-0 and 0 are the same number after standardization", () => {
    const r = checkRangeSetupIntegrity({ ...okSetup, targets: [105, -0] }, { ...shortRange, targets: [105, 0] }, "short");
    expect(r.ok).toBe(true);
  });
  for (const [field, over] of [["entry", { entry: 109.50000001 }], ["invalidation", { invalidation: 112.01 }], ["targets[0]", { targets: [105.5, 100] }], ["targets[1]", { targets: [105, 99] }]] as const) {
    it(`any difference in ${field} is rejected (exact match, no tolerance)`, () => {
      const r = checkRangeSetupIntegrity({ ...okSetup, ...over }, shortRange, "short");
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBe("RANGE_SETUP_MISMATCH"); expect(r.fields.join(",")).toBe(field); }
    });
  }
  it("a different number of targets is rejected", () => {
    const r = checkRangeSetupIntegrity({ ...okSetup, targets: [105] }, shortRange, "short");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.join(",")).toBe("targets.length");
  });
  it("opposite direction is rejected", () => {
    const r = checkRangeSetupIntegrity(okSetup, shortRange, "long");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RANGE_DIRECTION_MISMATCH");
  });
  for (const v of ["ABSTAIN", "RANGE_TOO_TIGHT"] as const) {
    it(`DeltaRange ${v} provides no reference -> submitted Setup rejected`, () => {
      const r = checkRangeSetupIntegrity(okSetup, rangeOf(v), "short");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("RANGE_NO_REFERENCE");
    });
  }
  it("non-finite numbers are rejected, never compared", () => {
    const r = checkRangeSetupIntegrity({ ...okSetup, entry: Number.NaN }, shortRange, "short");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SETUP_NOT_FINITE");
  });
});

describe("P4 independent-output comparison uses only a valid price step", () => {
  it("no price step -> UNKNOWN_PRICE_STEP (not comparable)", () => {
    expect(samePriceTick(100, 100, undefined)).toEqual({ comparable: false, code: "UNKNOWN_PRICE_STEP" });
    expect(samePriceTick(100, 100, 0)).toEqual({ comparable: false, code: "UNKNOWN_PRICE_STEP" });
    expect(samePriceTick(100, 100, -0.01)).toEqual({ comparable: false, code: "UNKNOWN_PRICE_STEP" });
    expect(samePriceTick(100, 100, Number.NaN)).toEqual({ comparable: false, code: "UNKNOWN_PRICE_STEP" });
  });
  it("same tick -> equal; different tick -> not equal", () => {
    expect(samePriceTick(100.01, 100.01, 0.01)).toEqual({ comparable: true, equal: true });
    expect(samePriceTick(100.01, 100.02, 0.01)).toEqual({ comparable: true, equal: false });
  });
});

describe("P4 pipeline: Range mode Setup integrity (real DeltaRange on the range fixture)", () => {
  const bundle = candlesBundle("range");
  const ref = evaluateDeltaRange(bundle["4H"], bundle["5m"]);
  it("fixture gives a tradeable DeltaRange output (precondition)", () => { expect(ref.verdict === "RANGE_SHORT" || ref.verdict === "RANGE_LONG").toBe(true); });
  const exact = { entry: ref.entry, invalidation: ref.stopLoss, targets: [...ref.targets], atr: 1 };
  const dir = ref.verdict === "RANGE_LONG" ? "long" : "short";
  it("exact DeltaRange Setup passes integrity and reaches AGENTS_RUN", async () => {
    const r = await runSignalPipeline({ ...baseInput("range", [], exact), symbol: "P4-OK", audit: new InMemoryAuditStore() });
    expect(r.mode).toBe("range");
    expect(r.direction).toBe(dir);
    expect(r.statesVisited.includes("AGENTS_RUN")).toBe(true);
    expect(r.votes[0].verdict).toBe(dir === "short" ? "bearish" : "bullish"); // Delta Force vote comes from the range trigger, not ABSTAIN
  });
  it("Setup that differs by one tick is rejected before AGENTS_RUN, audited, never approved or notified", async () => {
    let notified = 0;
    const r = await runSignalPipeline({ ...baseInput("range", [], { ...exact, entry: exact.entry + 0.01 }), symbol: "P4-BAD", audit: new InMemoryAuditStore(), notify: () => { notified++; } });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason?.startsWith("RANGE_SETUP_MISMATCH")).toBe(true);
    expect(r.statesVisited.includes("AGENTS_RUN")).toBe(false);
    expect(r.votes.length).toBe(0);
    expect(notified).toBe(0);
    const err = r.events.find((e) => e.kind === "ERROR");
    expect(err?.reason).toBe("RANGE_SETUP_MISMATCH");
    expect(JSON.stringify(err?.detail).includes("entry")).toBe(true);
  });
  it("opposite-direction Setup is rejected", async () => {
    const flipped = { entry: ref.entry, invalidation: ref.entry * (dir === "short" ? 0.9 : 1.1), targets: [ref.entry * (dir === "short" ? 1.05 : 0.95)], atr: 1 };
    const r = await runSignalPipeline({ ...baseInput("range", [], flipped), symbol: "P4-DIR", audit: new InMemoryAuditStore() });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason?.startsWith("RANGE_DIRECTION_MISMATCH")).toBe(true);
  });
});

describe("P4 Trend mode without a Setup", () => {
  it("missing Setup -> inconclusive INVALID_SETUP, no approval", async () => {
    const i = baseInput("up", []);
    const r = await runSignalPipeline({ ...i, setup: undefined as never, symbol: "P4-NOSETUP", audit: new InMemoryAuditStore() });
    expect(r.status).toBe("inconclusive");
    expect(r.haltReason?.startsWith("INVALID_SETUP")).toBe(true);
  });
});
