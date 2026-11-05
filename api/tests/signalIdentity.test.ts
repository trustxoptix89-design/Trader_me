import { describe, expect, it } from "vitest";
import { InMemoryCycleStore } from "../pipeline/cycleStore";
import {
  cycleKey, decideCycle, IdentityError, isInvalidated, NOTIFIABLE_KINDS, setupFingerprint, signalIdFromKey, signalKey,
  type CycleState, type SignalIdentityInput,
} from "../pipeline/signalIdentity";
import { defineCycleStoreContract, H, longSetup, obsOf, shortSetup, T0 } from "./fixtures/cycleContract";

const base: SignalIdentityInput = { symbol: "BTCUSDT", market: "spot", direction: "long", referenceTimeframe: "1H", lastClosedCandleOpenTime: T0, setup: longSetup, configFingerprint: "cfg" };

describe("signal identity (SYNTHETIC inputs, deterministic)", () => {
  it("same inputs -> same key; the key has no clock input", () => {
    expect(signalKey(base)).toBe(signalKey({ ...base }));
    expect(signalKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(signalIdFromKey(signalKey(base))).toMatch(/^sig-[0-9a-f]{40}$/);
  });
  it("every identity component changes the key", () => {
    const k = signalKey(base);
    const variants: SignalIdentityInput[] = [
      { ...base, symbol: "ETHUSDT" }, { ...base, market: "futures" }, { ...base, direction: "short" }, { ...base, referenceTimeframe: "4H" },
      { ...base, lastClosedCandleOpenTime: T0 + H }, { ...base, configFingerprint: "cfg2" },
      { ...base, setup: { ...longSetup, entry: 100.01 } }, { ...base, setup: { ...longSetup, invalidation: 94 } },
      { ...base, setup: { ...longSetup, targets: [110, 121] } }, { ...base, setup: { ...longSetup, targets: [110] } }, { ...base, setup: { ...longSetup, atr: 2.1 } },
    ];
    const keys = new Set([k, ...variants.map(signalKey)]);
    expect(keys.size).toBe(variants.length + 1);
  });
  it("-0 and 0 are the same number; non-finite or empty setups are refused, never silently keyed", () => {
    expect(setupFingerprint({ ...longSetup, entry: -0 })).toBe(setupFingerprint({ ...longSetup, entry: 0 }));
    for (const bad of [{ ...longSetup, entry: Number.NaN }, { ...longSetup, atr: Number.POSITIVE_INFINITY }, { ...longSetup, targets: [] }, { ...longSetup, targets: [110, Number.NaN] }]) {
      let threw = false;
      try { setupFingerprint(bad); } catch (e) { threw = e instanceof IdentityError; }
      expect(threw).toBe(true);
    }
    let threw = false;
    try { signalKey({ ...base, lastClosedCandleOpenTime: 1.5 }); } catch (e) { threw = e instanceof IdentityError; }
    expect(threw).toBe(true);
  });
  it("cycleKey ignores candle time and setup numbers but not symbol, market, direction or timeframe", () => {
    const id = { symbol: "BTCUSDT", market: "spot" as const, direction: "long" as const, referenceTimeframe: "1H" };
    expect(cycleKey(id)).toBe(cycleKey({ ...id }));
    expect(new Set([cycleKey(id), cycleKey({ ...id, symbol: "X" }), cycleKey({ ...id, market: "futures" }), cycleKey({ ...id, direction: "short" }), cycleKey({ ...id, referenceTimeframe: "4H" })]).size).toBe(5);
  });
});

describe("Setup cycle decision (pure)", () => {
  const stateOf = (o = obsOf()): CycleState => {
    const d = decideCycle(null, o);
    if (d.outcome !== "APPLIED") throw new Error("expected APPLIED");
    const e = d.events[0];
    return { cycleKey: o.cycleKey, seq: 1, cycleNo: e.cycleNo, version: e.version, status: e.statusAfter, direction: o.direction, setupFingerprint: e.setupFingerprint, setup: e.setup, lastClosedCandleOpenTime: o.closedCandleOpenTime, lastSignalKey: o.signalKey };
  };
  const kinds = (p: CycleState | null, o: ReturnType<typeof obsOf>): string[] => { const d = decideCycle(p, o); return d.outcome === "APPLIED" ? d.events.map((e) => e.kind) : [d.outcome]; };

  it("first observation opens cycle 1 version 1", () => {
    const d = decideCycle(null, obsOf());
    expect(d.outcome === "APPLIED" && d.events.map((e) => `${e.kind}:${e.cycleNo}.${e.version}`)).toEqual(["NEW_CYCLE:1.1"]);
  });
  it("same signalKey -> DUPLICATE; older candle -> STALE", () => {
    expect(kinds(stateOf(), obsOf())).toEqual(["DUPLICATE"]);
    expect(kinds(stateOf(obsOf({ candle: T0 + 2 * H })), obsOf({ candle: T0 + H, setup: { ...longSetup, atr: 3 } }))).toEqual(["STALE"]);
  });
  it("unchanged Setup on a later candle continues the same cycle and version", () => {
    expect(kinds(stateOf(), obsOf({ candle: T0 + H }))).toEqual(["CONTINUED"]);
  });
  it("any change to entry, invalidation, targets or atr makes a new version (same cycle)", () => {
    for (const s of [{ ...longSetup, entry: 100.5 }, { ...longSetup, invalidation: 94.5 }, { ...longSetup, targets: [111, 120] }, { ...longSetup, targets: [110, 120, 130] }, { ...longSetup, atr: 2.2 }]) {
      const d = decideCycle(stateOf(), obsOf({ candle: T0 + H, setup: s }));
      expect(d.outcome === "APPLIED" && d.events.map((e) => `${e.kind}:${e.cycleNo}.${e.version}`)).toEqual(["NEW_VERSION:1.2"]);
    }
  });
  it("invalidation is a strict close beyond the level, against the direction (long: below, short: above); equality does not invalidate", () => {
    const long = stateOf(), short = stateOf(obsOf({ direction: "short" }));
    expect(isInvalidated(long, 95)).toBe(false);
    expect(isInvalidated(long, 94.99)).toBe(true);
    expect(isInvalidated(short, 105)).toBe(false);
    expect(isInvalidated(short, 105.01)).toBe(true);
    expect(isInvalidated({ ...long, status: "INVALIDATED" }, 1)).toBe(false);
  });
  it("breach with the same Setup still produced: only INVALIDATED; afterwards the dead Setup is SUPPRESSED", () => {
    const p = stateOf();
    expect(kinds(p, obsOf({ candle: T0 + H, close: 94 }))).toEqual(["INVALIDATED"]);
    const dead: CycleState = { ...p, status: "INVALIDATED", lastClosedCandleOpenTime: T0 + H };
    expect(kinds(dead, obsOf({ candle: T0 + 2 * H }))).toEqual(["SUPPRESSED"]);
  });
  it("re-formation after invalidation (different Setup) opens a NEW cycle; breach and a new Setup in one observation yields INVALIDATED then NEW_CYCLE", () => {
    const dead: CycleState = { ...stateOf(), status: "INVALIDATED" };
    const d1 = decideCycle(dead, obsOf({ candle: T0 + 2 * H, setup: { ...longSetup, entry: 101 } }));
    expect(d1.outcome === "APPLIED" && d1.events.map((e) => `${e.kind}:${e.cycleNo}.${e.version}`)).toEqual(["NEW_CYCLE:2.1"]);
    const d2 = decideCycle(stateOf(), obsOf({ candle: T0 + H, close: 94, setup: { ...longSetup, entry: 99 } }));
    expect(d2.outcome === "APPLIED" && d2.events.map((e) => `${e.kind}:${e.cycleNo}.${e.version}`)).toEqual(["INVALIDATED:1.1", "NEW_CYCLE:2.1"]);
  });
  it("short direction mirrors the invalidation rule", () => {
    const p = stateOf(obsOf({ direction: "short" }));
    expect(kinds(p, obsOf({ direction: "short", candle: T0 + H, close: 106, setup: shortSetup }))).toEqual(["INVALIDATED"]);
    expect(kinds(p, obsOf({ direction: "short", candle: T0 + H, close: 104, setup: shortSetup }))).toEqual(["CONTINUED"]);
  });
  it("only NEW_CYCLE and NEW_VERSION are notifiable", () => {
    expect([...NOTIFIABLE_KINDS]).toEqual(["NEW_CYCLE", "NEW_VERSION"]);
  });
});

defineCycleStoreContract("in-memory", () => new InMemoryCycleStore());
