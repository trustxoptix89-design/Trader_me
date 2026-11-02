# Signal pipeline: state machine specification (Phase D hardening)

Source of truth: the Project PDFs (`سند ترید من.pdf` + V2). Implementation: `api/orchestrator/machine.ts`. Every statement below is enforced by
`api/tests/hardening.test.ts` (transitions, invalid-data matrix, concurrency, recovery) or `api/tests/e2e.scenarios.test.ts` (8 scenarios).

## 1. States and legal transitions

`ALLOWED_TRANSITIONS` in `machine.ts` is the single table; `transition()` throws `FORBIDDEN_TRANSITION` on anything else, and the audit log is written
only through that guard.

| From | Allowed next | Meaning of leaving |
|---|---|---|
| (start) | DETECTED | a candidate signal exists |
| DETECTED | DATA_VALIDATED, RECORDED | RECORDED = invalid setup |
| DATA_VALIDATED | INDICATORS_READY, RECORDED | RECORDED = Data Room HALT |
| INDICATORS_READY | AGENTS_RUN, RECORDED | |
| AGENTS_RUN | RECONCILED, RECORDED | |
| RECONCILED | RISK_CHECKED, RECORDED | RECORDED = Error Detection HALT or Chart Quality ESCALATE |
| RISK_CHECKED | GATED, RECORDED | RECORDED = Risk Room HALT (rejected) or ESCALATE (inconclusive) |
| GATED | RECORDED | the verdict of the Approval Room and the Independent Verifier is final here |
| RECORDED | NOTIFIED | only for an approved decision that is already persisted |
| NOTIFIED | none (terminal) | |

No state can be skipped, re-entered or left backwards. `POST_MORTEM` (after the trade outcome is known) is outside a run and NOT IMPLEMENTED.

## 2. Entry / exit conditions, rejections, escalations

| State | Entry | Exit to next state requires | Halt path |
|---|---|---|---|
| DETECTED | `runSignalPipeline` called, correlation id not yet decided | entry, invalidation, atr and every target are finite numbers and at least one target | `INVALID_SETUP` -> RECORDED, inconclusive |
| DATA_VALIDATED | setup valid | Data Room PASS on **all four** timeframes (4H, 1H, 15m, 5m): finite OHLCV, high>=low, close inside range, volume>=0, strictly increasing unique times, no future candle, fresh (<= 2 x TF), gap <= 5% | first failing timeframe's reason (`DATA_STALE`, `DATA_GAP`, `DATA_DUPLICATE`, `INVALID_OHLCV`, `INVALID_CLOCK`, ...) -> RECORDED, inconclusive |
| INDICATORS_READY | data valid | Delta Force trend evaluated (RANGE_DETECTED additionally evaluates Range Mode) | exception -> `PIPELINE_ERROR` |
| AGENTS_RUN | Delta Force vote + injected agents ran | all agents returned a vote | an agent exception -> `PIPELINE_ERROR`, inconclusive |
| RECONCILED | votes collected | Error Detection Room PASS (no contradictory indicators) and Chart Quality Room PASS | `CONTRADICTION_INDICATORS` (incl. Delta Force CONFLICT, deviation D-3), Chart Quality ESCALATE -> RECORDED, inconclusive |
| RISK_CHECKED | rooms passed | Risk Room PASS | HALT (`RISK_REJECT`, `INVALIDATION_TOO_FAR/TIGHT`, `LEVERAGE_TOO_HIGH`) -> RECORDED **rejected**; ESCALATE -> inconclusive |
| GATED | risk passed | Independent Verifier OK **and** Approval Room APPROVED | verifier VETO (absolute, overrides everything) or any non-APPROVED Approval Room result -> RECORDED, inconclusive |
| RECORDED | any terminal outcome | the DECISION event is persisted | a failing audit store -> the run returns inconclusive (`AUDIT_FAILURE`), never approved |
| NOTIFIED | approved DECISION persisted, notifier returned | n/a | notifier failure leaves the persisted approval intact and records an ERROR event |

Status mapping: Risk Room HALT -> `rejected`; every other halt, escalation, veto, error or interruption -> `inconclusive`; `approved` requires **all** of:
data valid on all timeframes, Error Detection PASS, Chart Quality PASS, Risk Room PASS, Independent Verifier OK, Approval Room APPROVED, DECISION persisted.

## 3. Error paths

- Any exception inside a run is caught: ERROR event + DECISION `inconclusive` (`PIPELINE_ERROR: <message>`). Nothing is thrown to the caller.
- Audit store unavailable at start -> `AUDIT_UNAVAILABLE`, nothing executed. Audit store failing mid-run -> `AUDIT_FAILURE`, `auditPersisted: false`, never approved, never notified.
- A decision already persisted is never contradicted by a later error in the same run.

## 4. Concurrency, duplicates, idempotency, interruption

- `correlationId` = `symbol-now-hash(setup, market, timeframe, config fingerprint)`; every event has `idempotencyKey = correlationId:seq:kind`.
- A request whose correlation id already has events is **not re-executed**: it returns the stored decision with `duplicate: true`.
- Concurrent identical requests converge: identical events carry identical keys (stored once); the single run whose DECISION write is stored is the only one allowed to notify.
- A crashed run (events but no DECISION) is finalized by `recoverInterrupted` (called automatically by the next identical request): one DECISION `inconclusive`, reason `PROCESS_INTERRUPTED`, fixed idempotency key `correlationId:INTERRUPTED`, safe to call concurrently.

## 5. Documented deviations from the PDF

| ID | Deviation | Reason |
|---|---|---|
| D-1 | PDF text is RTL-garbled in places (Approval Room minimum votes, Chart Quality touch count). Read as `>= 5` valid votes and `>= 2` touches | extraction ambiguity; both are configurable REFERENCE values (`docs/PARAMETERS.md`) |
| D-2 | Approval threshold 60%, borderline R:R 1.8, borderline freshness 75% are **not** in the PDF | PROPOSED, configurable, never calibrated (`docs/PARAMETERS.md`) |
| D-3 | Delta Force `CONFLICT` halts at RECONCILED with `CONTRADICTION_INDICATORS`. PDF V2 treats CONFLICT as an abstention that only adds dissent | fail-closed: disagreeing 4H/1H/15m must not reach an approval vote. Revisit when the Supervisory Board exists |
| D-4 | The Independent Verifier uses only the 1H candles of the run and its own ATR/swing code; the PDF's full "re-derive from raw data" is applied to entry/stop/targets/structure/fees, not to every indicator | the verifier validates the *trade*, not each of the 33 agents |
| D-5 | ESCALATE (Chart Quality, Risk Room) ends as `inconclusive` | the Supervisory Board that would receive escalations is NOT IMPLEMENTED; nothing is approved by default |
| D-6 | MACD/RSI contradiction rule and BOS-vs-EMA200 rule of the Error Detection Room are NOT IMPLEMENTED | not enough agent output exists yet |
| D-7 | Only 5 deterministic agents (+ Delta Force) exist of the PDF's 33 | NOT IMPLEMENTED, not simulated |
| D-8 | See `docs/AUDIT_LOG.md`. The pipeline persists through `AuditStore`; wiring `PostgresAuditStore` into the scheduler/routes is NOT DONE | callers must pass `audit: new PostgresAuditStore()`; default is in-memory (not durable) |
