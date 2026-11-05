// P2 — append-only history of Setup cycles. State is the fold of the history (never updated in place).
import { createHash } from "node:crypto";
import { canonical } from "../orchestrator/audit";
import { postgresJsExecutor, type SqlExecutor } from "../orchestrator/audit.postgres";
import { applyEvents, decideCycle, type CycleEvent, type CycleEventKind, type CycleState, type Direction, type Observation, type SetupNumbers } from "./signalIdentity";

export class CycleSeqConflict extends Error { constructor(m: string) { super(m); this.name = "CycleSeqConflict"; } }
export interface StoredCycleEvent extends CycleEvent { cycleKey: string; seq: number; direction: Direction; rowHash: string }

export interface CycleStore {
  latest(cycleKey: string): Promise<CycleState | null>;
  /** Appends events at `seq = expectedSeq, expectedSeq+1, ...` atomically. Throws CycleSeqConflict if another writer got there first or a signalKey+kind repeats. */
  append(cycleKey: string, direction: Direction, expectedSeq: number, events: CycleEvent[]): Promise<void>;
  history(cycleKey: string): Promise<StoredCycleEvent[]>;
  /** True if any event for this signalKey was ever stored (duplicate detection independent of ordering). */
  hasSignal(signalKey: string): Promise<boolean>;
}

const rowHashOf = (cycleKey: string, seq: number, direction: Direction, e: CycleEvent): string => createHash("sha256").update(canonical({ cycleKey, seq, direction, e })).digest("hex");

export class InMemoryCycleStore implements CycleStore {
  private readonly byCycle = new Map<string, StoredCycleEvent[]>();
  private readonly signalKinds = new Set<string>();
  async latest(cycleKey: string): Promise<CycleState | null> {
    const list = this.byCycle.get(cycleKey);
    if (!list?.length) return null;
    const e = list[list.length - 1];
    return { cycleKey, seq: list.length, cycleNo: e.cycleNo, version: e.version, status: e.statusAfter, direction: e.direction, setupFingerprint: e.setupFingerprint, setup: e.setup, lastClosedCandleOpenTime: e.closedCandleOpenTime, lastSignalKey: e.signalKey };
  }
  async append(cycleKey: string, direction: Direction, expectedSeq: number, events: CycleEvent[]): Promise<void> {
    const list = this.byCycle.get(cycleKey) ?? [];
    if (list.length !== expectedSeq) throw new CycleSeqConflict(`expected seq ${list.length}, got ${expectedSeq}`);
    for (const e of events) if (this.signalKinds.has(`${e.signalKey}:${e.kind}`)) throw new CycleSeqConflict(`${e.kind} for ${e.signalKey} already recorded`);
    events.forEach((e, i) => { list.push({ ...JSON.parse(canonical(e)) as CycleEvent, cycleKey, seq: expectedSeq + i, direction, rowHash: rowHashOf(cycleKey, expectedSeq + i, direction, e) }); this.signalKinds.add(`${e.signalKey}:${e.kind}`); });
    this.byCycle.set(cycleKey, list);
  }
  async history(cycleKey: string): Promise<StoredCycleEvent[]> { return [...(this.byCycle.get(cycleKey) ?? [])]; }
  async hasSignal(signalKey: string): Promise<boolean> { for (const k of this.signalKinds) if (k.startsWith(`${signalKey}:`)) return true; return false; }
}

const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
const COLS = "cycle_key, seq, cycle_no, version, kind, signal_key, direction, setup_fingerprint, setup_json, closed_candle_open_time, status_after, row_hash";
const toStored = (r: Record<string, unknown>): StoredCycleEvent => ({
  cycleKey: String(r.cycle_key), seq: Number(r.seq), cycleNo: Number(r.cycle_no), version: Number(r.version), kind: r.kind as CycleEventKind, signalKey: String(r.signal_key),
  direction: r.direction as Direction, setupFingerprint: String(r.setup_fingerprint), setup: (typeof r.setup_json === "string" ? JSON.parse(r.setup_json) : r.setup_json) as SetupNumbers,
  closedCandleOpenTime: Number(r.closed_candle_open_time), statusAfter: r.status_after as CycleState["status"], rowHash: String(r.row_hash),
});

export class PostgresCycleStore implements CycleStore {
  constructor(private readonly db: SqlExecutor = postgresJsExecutor()) {}
  async latest(cycleKey: string): Promise<CycleState | null> {
    const rows = await this.db.query(`SELECT ${COLS} FROM sarmaye.signal_cycle_events WHERE cycle_key = $1 ORDER BY seq DESC LIMIT 1`, [cycleKey]);
    if (!rows.length) return null;
    const e = toStored(rows[0]);
    return { cycleKey, seq: e.seq + 1, cycleNo: e.cycleNo, version: e.version, status: e.statusAfter, direction: e.direction, setupFingerprint: e.setupFingerprint, setup: e.setup, lastClosedCandleOpenTime: e.closedCandleOpenTime, lastSignalKey: e.signalKey };
  }
  async append(cycleKey: string, direction: Direction, expectedSeq: number, events: CycleEvent[]): Promise<void> {
    if (!events.length) return;
    const params: unknown[] = [];
    const tuples = events.map((e, i) => {
      const seq = expectedSeq + i, base = params.length;
      params.push(cycleKey, seq, e.cycleNo, e.version, e.kind, e.signalKey, direction, e.setupFingerprint, JSON.parse(canonical(e.setup)), e.closedCandleOpenTime, e.statusAfter, rowHashOf(cycleKey, seq, direction, e));
      return `(${Array.from({ length: 12 }, (_, k) => `$${base + k + 1}`).join(",")})`;
    });
    try {
      // One INSERT statement = atomic: either every event of the observation is stored or none.
      await this.db.query(`INSERT INTO sarmaye.signal_cycle_events (${COLS}) VALUES ${tuples.join(",")}`, params);
    } catch (e) {
      if (isUnique(e)) throw new CycleSeqConflict("concurrent append or repeated signalKey+kind");
      throw e;
    }
  }
  async history(cycleKey: string): Promise<StoredCycleEvent[]> {
    return (await this.db.query(`SELECT ${COLS} FROM sarmaye.signal_cycle_events WHERE cycle_key = $1 ORDER BY seq`, [cycleKey])).map(toStored);
  }
  async hasSignal(signalKey: string): Promise<boolean> {
    return (await this.db.query("SELECT 1 FROM sarmaye.signal_cycle_events WHERE signal_key = $1 LIMIT 1", [signalKey])).length > 0;
  }
}

export type RegisterResult =
  | { outcome: "DUPLICATE" }
  | { outcome: "STALE"; reason: string }
  | { outcome: "APPLIED"; events: CycleEvent[]; state: CycleState };

/** Engineering bound on optimistic-concurrency retries (not a domain rule). */
const MAX_ATTEMPTS = 5;

/** Reads the cycle, decides deterministically, appends. Safe under concurrent callers: the loser re-reads and re-decides (usually DUPLICATE). */
export async function registerObservation(store: CycleStore, obs: Observation): Promise<RegisterResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await store.hasSignal(obs.signalKey)) return { outcome: "DUPLICATE" };
    const prev = await store.latest(obs.cycleKey);
    const d = decideCycle(prev, obs);
    if (d.outcome !== "APPLIED") return d;
    try {
      await store.append(obs.cycleKey, obs.direction, prev?.seq ?? 0, d.events);
      return { outcome: "APPLIED", events: d.events, state: applyEvents(prev, obs.cycleKey, obs.direction, d.events) };
    } catch (e) {
      if (!(e instanceof CycleSeqConflict)) throw e;
    }
  }
  throw new CycleSeqConflict(`could not register observation after ${MAX_ATTEMPTS} attempts`);
}
