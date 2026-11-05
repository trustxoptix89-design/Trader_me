import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../orchestrator/audit.postgres";
import { CycleSeqConflict, registerObservation, type CycleStore, type PostgresCycleStore } from "../../pipeline/cycleStore";
import { cycleKey, setupFingerprint, signalKey, type CycleEvent, type Direction, type Observation, type SetupNumbers } from "../../pipeline/signalIdentity";

export const H = 3_600_000;
export const T0 = 1_800_000_000_000 - (1_800_000_000_000 % H);
export const longSetup: SetupNumbers = { entry: 100, invalidation: 95, targets: [110, 120], atr: 2 };
export const shortSetup: SetupNumbers = { entry: 100, invalidation: 105, targets: [90, 80], atr: 2 };

export interface ObsOver { symbol?: string; direction?: Direction; setup?: SetupNumbers; candle?: number; close?: number }
export function obsOf(o: ObsOver = {}): Observation {
  const symbol = o.symbol ?? "BTCUSDT", direction = o.direction ?? "long";
  const setup = o.setup ?? (direction === "long" ? longSetup : shortSetup), candle = o.candle ?? T0;
  const id = { symbol, market: "spot" as const, direction, referenceTimeframe: "1H" };
  return { cycleKey: cycleKey(id), signalKey: signalKey({ ...id, lastClosedCandleOpenTime: candle, setup, configFingerprint: "cfg" }), direction, setup, closedCandleOpenTime: candle, lastClosedClose: o.close ?? (direction === "long" ? 101 : 99) };
}
export const freshSymbol = (): string => `C${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
export { setupFingerprint };

/** Store-level contract, run against the in-memory store AND PostgreSQL. */
export function defineCycleStoreContract(label: string, makeStore: () => CycleStore): void {
  describe(`signal cycle store contract [${label}]`, () => {
    it("full lifecycle is recorded as append-only history and the state is the fold of it", async () => {
      const store = makeStore(), sym = freshSymbol();
      const kinds: string[] = [];
      const run = async (o: ObsOver) => { const r = await registerObservation(store, obsOf({ symbol: sym, ...o })); if (r.outcome === "APPLIED") kinds.push(...r.events.map((e: CycleEvent) => e.kind)); return r; };
      expect((await run({ candle: T0 })).outcome).toBe("APPLIED");
      expect((await run({ candle: T0 })).outcome).toBe("DUPLICATE");                     // same Setup, same candle
      await run({ candle: T0 + H });                                                      // same Setup, next candle
      await run({ candle: T0 + 2 * H, setup: { ...longSetup, targets: [110, 125] } });    // changed target
      await run({ candle: T0 + 3 * H, setup: { ...longSetup, targets: [110, 125] }, close: 94 }); // closes below invalidation
      await run({ candle: T0 + 4 * H, setup: { ...longSetup, targets: [110, 125] } });    // dead Setup still produced
      await run({ candle: T0 + 5 * H, setup: { ...longSetup, entry: 101 } });             // re-formation
      expect(kinds).toEqual(["NEW_CYCLE", "CONTINUED", "NEW_VERSION", "INVALIDATED", "SUPPRESSED", "NEW_CYCLE"]);
      const h = await store.history(obsOf({ symbol: sym }).cycleKey);
      expect(h.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(h.map((e) => `${e.cycleNo}.${e.version}:${e.kind}`)).toEqual(["1.1:NEW_CYCLE", "1.1:CONTINUED", "1.2:NEW_VERSION", "1.2:INVALIDATED", "1.2:SUPPRESSED", "2.1:NEW_CYCLE"]);
      const latest = await store.latest(obsOf({ symbol: sym }).cycleKey);
      expect(latest?.seq).toBe(6);
      expect(latest?.cycleNo).toBe(2);
      expect(latest?.status).toBe("ACTIVE");
      expect(latest?.setupFingerprint).toBe(setupFingerprint({ ...longSetup, entry: 101 }));
    });

    it("a different Setup on the same candle is NOT a duplicate (new version); the identical one is", async () => {
      const store = makeStore(), sym = freshSymbol();
      await registerObservation(store, obsOf({ symbol: sym }));
      expect((await registerObservation(store, obsOf({ symbol: sym, setup: { ...longSetup, atr: 2.5 } }))).outcome).toBe("APPLIED");
      expect((await registerObservation(store, obsOf({ symbol: sym }))).outcome).toBe("DUPLICATE"); // the very first Setup+candle, even though it is no longer the latest
      expect((await store.history(obsOf({ symbol: sym }).cycleKey)).length).toBe(2);
    });

    it("8 concurrent identical registrations create exactly one event", async () => {
      const store = makeStore(), sym = freshSymbol();
      const rs = await Promise.all(Array.from({ length: 8 }, () => registerObservation(store, obsOf({ symbol: sym }))));
      expect(rs.filter((r) => r.outcome === "APPLIED").length).toBe(1);
      expect(rs.filter((r) => r.outcome === "DUPLICATE").length).toBe(7);
      expect((await store.history(obsOf({ symbol: sym }).cycleKey)).length).toBe(1);
    });

    it("4 concurrent registrations of consecutive candles leave a gap-free, consistent history (each APPLIED or STALE, never lost or doubled)", async () => {
      const store = makeStore(), sym = freshSymbol();
      await registerObservation(store, obsOf({ symbol: sym, candle: T0 }));
      const rs = await Promise.all([1, 2, 3, 4].map((i) => registerObservation(store, obsOf({ symbol: sym, candle: T0 + i * H }))));
      expect(rs.every((r) => r.outcome === "APPLIED" || r.outcome === "STALE")).toBe(true);
      const h = await store.history(obsOf({ symbol: sym }).cycleKey);
      expect(h.map((e) => e.seq)).toEqual(h.map((_, i) => i));
      expect(h.length).toBe(1 + rs.filter((r) => r.outcome === "APPLIED").length);
      const times = h.map((e) => e.closedCandleOpenTime);
      expect([...times].sort((a, b) => a - b)).toEqual(times);                         // history never goes back in time
    });

    it("an append that conflicts is all-or-nothing (two-event append with a repeated signalKey+kind stores nothing)", async () => {
      const store = makeStore(), sym = freshSymbol();
      const first = await registerObservation(store, obsOf({ symbol: sym }));
      if (first.outcome !== "APPLIED") throw new Error("setup failed");
      const dupe = { ...first.events[0] };                                             // same signalKey + kind as the stored NEW_CYCLE
      const fresh: CycleEvent = { ...first.events[0], kind: "CONTINUED", signalKey: "other-signal" };
      let threw = false;
      try { await store.append(obsOf({ symbol: sym }).cycleKey, "long", 1, [fresh, dupe]); } catch (e) { threw = e instanceof CycleSeqConflict; }
      expect(threw).toBe(true);
      expect((await store.history(obsOf({ symbol: sym }).cycleKey)).length).toBe(1);
      expect(await store.hasSignal("other-signal")).toBe(false);
    });

    it("append at a stale sequence number is refused", async () => {
      const store = makeStore(), sym = freshSymbol();
      const first = await registerObservation(store, obsOf({ symbol: sym }));
      if (first.outcome !== "APPLIED") throw new Error("setup failed");
      let threw = false;
      try { await store.append(obsOf({ symbol: sym }).cycleKey, "long", 0, [{ ...first.events[0], kind: "CONTINUED", signalKey: "x" }]); } catch (e) { threw = e instanceof CycleSeqConflict; }
      expect(threw).toBe(true);
    });

    it("cycles are isolated per symbol and per direction", async () => {
      const store = makeStore(), sym = freshSymbol();
      await registerObservation(store, obsOf({ symbol: sym, direction: "long" }));
      const r = await registerObservation(store, obsOf({ symbol: sym, direction: "short" }));
      expect(r.outcome).toBe("APPLIED");
      expect(r.outcome === "APPLIED" && r.events[0].kind).toBe("NEW_CYCLE");
      expect(r.outcome === "APPLIED" && r.state.cycleNo).toBe(1);
    });
  });
}

/** Checks that only make sense against a real database. */
export function definePostgresCycleChecks(admin: SqlExecutor, makeStore: () => PostgresCycleStore): void {
  describe("signal_cycle_events table (PostgreSQL)", () => {
    it("exists with jsonb setup_json, and rows round-trip through the store", async () => {
      const store = makeStore(), sym = freshSymbol(), o = obsOf({ symbol: sym });
      await registerObservation(store, o);
      const t = await admin.query("SELECT jsonb_typeof(setup_json) AS t FROM sarmaye.signal_cycle_events WHERE cycle_key = $1", [o.cycleKey]);
      expect(String(t[0].t)).toBe("object");
      expect((await store.history(o.cycleKey))[0].setup.targets).toEqual([110, 120]);
    });
    it("rejects invalid kind, status, direction and negative sequence (CHECK constraints)", async () => {
      const ins = (over: Record<string, unknown>): Promise<unknown> => {
        const r = { cycle_key: "k", seq: 0, cycle_no: 1, version: 1, kind: "NEW_CYCLE", signal_key: `s-${freshSymbol()}`, direction: "long", setup_fingerprint: "f", setup_json: { a: 1 }, closed_candle_open_time: 1, status_after: "ACTIVE", row_hash: "h", ...over };
        const cols = Object.keys(r);
        return admin.query(`INSERT INTO sarmaye.signal_cycle_events (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(r));
      };
      for (const bad of [{ kind: "BOGUS" }, { status_after: "DONE" }, { direction: "up" }, { seq: -1 }, { version: 0 }]) {
        let rejected = false;
        try { await ins({ ...bad, cycle_key: `ck-${freshSymbol()}` }); } catch { rejected = true; }
        expect(rejected).toBe(true);
      }
    });
    it("is append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
      const store = makeStore(), o = obsOf({ symbol: freshSymbol() });
      await registerObservation(store, o);
      for (const sql of ["UPDATE sarmaye.signal_cycle_events SET kind = 'CONTINUED' WHERE cycle_key = $1", "DELETE FROM sarmaye.signal_cycle_events WHERE cycle_key = $1", "TRUNCATE sarmaye.signal_cycle_events"]) {
        let rejected = false;
        try { await admin.query(sql, sql.startsWith("TRUNCATE") ? [] : [o.cycleKey]); } catch { rejected = true; }
        expect(rejected).toBe(true);
      }
      expect((await store.history(o.cycleKey)).length).toBe(1);
    });
  });
}

