# Sarmaye (سرمایه) — Persian crypto market-intelligence platform

Independent analysis platform (spot + futures context). No exchange account, no exchange API key, no order placement.
**No win rate, profit or signal accuracy is promised anywhere in this project**; any win rate shown later must be a measured backtest/outcome value.

## Run

```bash
npm ci
npm test        # vitest run (api/**/*.test.ts)
npm run lint
npm run check   # tsc -b
npm run build
```

## Component status

Labels follow the specification contract: NOT STARTED / IN PROGRESS / IMPLEMENTED / TESTED / VERIFIED / BLOCKED.
The evidence for TESTED is the GitHub Actions run of the commit; this table is not updated by hand per run.

| Component | Status | Notes |
|---|---|---|
| Indicators: RSI, EMA, ATR, MACD, VWAP (`contracts/indicators.ts`) | IMPLEMENTED | golden test: `api/tests/golden.test.ts` |
| Indicators: ADX Wilder, StochRSI, Ichimoku, Supertrend (`api/indicators/deltaforce.trend.ts`) | IMPLEMENTED | ADX and StochRSI covered by the golden test |
| Bollinger Bands (`contracts/indicators.ts`, configurable period / multiplier) | IMPLEMENTED | golden test vs pandas (±0.01%) in `api/tests/golden.test.ts`; unit tests in `api/tests/hardening.test.ts` |
| Legacy `adxSeries` (`contracts/indicators.ts`) | IMPLEMENTED, deviates | averages DX instead of Wilder smoothing; differs from TA-Lib by 0.7–6.1 ADX points on the golden points. Delta Force uses the Wilder `calcAdx`, which matches |
| Delta Force trend / range | IMPLEMENTED | `api/tests/advanced.test.ts` |
| Elite Council (10s circuit breaker, strict schema, deterministic fallback, no LLM) | IMPLEMENTED | `api/orchestrator/elite*.ts` |
| Data / Error Detection / Risk rooms, Approval Room, 8-state machine | IMPLEMENTED | `api/orchestrator/*`, `api/tests/governance.test.ts` |
| Chart Quality Room (`api/orchestrator/chartQuality.ts`) | IMPLEMENTED | S/R touches, BOS on closed candle close, sweep volume, data integrity; `api/tests/hardening.test.ts` |
| Independent Verifier with absolute veto (`api/orchestrator/verifier.ts`) | IMPLEMENTED | own ATR/structure/fees maths; veto overrides approval; `api/tests/hardening.test.ts` |
| Governance parameters (`api/orchestrator/config.ts`) | IMPLEMENTED | versioned, classified REFERENCE / EMPIRICAL / PROPOSED (no EMPIRICAL yet); `docs/PARAMETERS.md` |
| 33-agent council (PDF) | IN PROGRESS | 5 deterministic agents + Delta Force exist (`api/orchestrator/agents.ts`), 28 NOT STARTED; legacy 20-role review in `api/engines/council.ts` exists |
| Append-only audit log (`db/migrations/0003_audit_log.sql`, `api/orchestrator/audit*.ts`) | IMPLEMENTED | hash-chained, idempotent, DB triggers reject UPDATE/DELETE/TRUNCATE; Postgres tests run in CI (`DB_PROBE`). Not yet wired into the scheduler/routes |
| End-to-end scenarios (8) | IMPLEMENTED | `api/tests/e2e.scenarios.test.ts` (in-memory always, Postgres when `DB_PROBE=true`) |

## 3-point golden matching table (Phase B)

Reference: TA-Lib 0.8.3 (RSI, EMA, MACD, ATR, ADX) and the pandas formulas documented in `fixtures/golden_values.json` (VWAP, StochRSI) on
999 real BTCUSDT 1h candles (`fixtures/btcusdt_1h.json`, source: Binance public data). Three of the four stored reference points are shown;
`api/tests/golden.test.ts` asserts all four. A value outside tolerance is a bug, not an approximation.

| Indicator | Tolerance | Point (UTC, index) | TA-Lib / pandas reference | Ours | abs diff |
|---|---|---|---|---|---|
| RSI(14) | ±0.5 | 2026-10-08 14:00 (#453) | 42.2849994 | 42.2849994 | 7.1e-15 |
| RSI(14) | ±0.5 | 2026-10-22 16:00 (#791) | 26.1322623 | 26.1322623 | 1.4e-14 |
| RSI(14) | ±0.5 | 2026-10-25 15:00 (#862) | 50.1903066 | 50.1903066 | 1.4e-14 |
| EMA(20) | ±0.01% | 2026-10-08 14:00 (#453) | 82927.4384 | 82927.4384 | 2.9e-11 |
| EMA(20) | ±0.01% | 2026-10-22 16:00 (#791) | 82390.9008 | 82390.9008 | 2.9e-11 |
| EMA(20) | ±0.01% | 2026-10-25 15:00 (#862) | 80583.528 | 80583.528 | 0.0e+0 |
| EMA(50) | ±0.01% | 2026-10-08 14:00 (#453) | 83673.1358 | 83673.1358 | 1.2e-10 |
| EMA(50) | ±0.01% | 2026-10-22 16:00 (#791) | 82738.6508 | 82738.6508 | 5.8e-11 |
| EMA(50) | ±0.01% | 2026-10-25 15:00 (#862) | 80852.7005 | 80852.7005 | 8.7e-11 |
| EMA(200) | ±0.01% | 2026-10-08 14:00 (#453) | 84485.6469 | 84485.6469 | 4.2e-10 |
| EMA(200) | ±0.01% | 2026-10-22 16:00 (#791) | 82547.4184 | 82547.4184 | 2.9e-10 |
| EMA(200) | ±0.01% | 2026-10-25 15:00 (#862) | 81731.2403 | 81731.2403 | 3.1e-10 |
| MACD(12,26,9) line | ±0.1% | 2026-10-08 14:00 (#453) | -373.024888 | -373.024888 | 1.5e-11 |
| MACD(12,26,9) line | ±0.1% | 2026-10-22 16:00 (#791) | -530.672081 | -530.672081 | 1.5e-11 |
| MACD(12,26,9) line | ±0.1% | 2026-10-25 15:00 (#862) | -70.3675469 | -70.3675469 | 1.5e-11 |
| ATR(14) | ±0.5% | 2026-10-08 14:00 (#453) | 466.76202 | 466.76202 | 0.0e+0 |
| ATR(14) | ±0.5% | 2026-10-22 16:00 (#791) | 447.72006 | 447.72006 | 5.7e-14 |
| ATR(14) | ±0.5% | 2026-10-25 15:00 (#862) | 288.360428 | 288.360428 | 5.7e-14 |
| VWAP (daily, UTC) | ±0.1% | 2026-10-08 14:00 (#453) | 82709.5205 | 82709.5205 | 0.0e+0 |
| VWAP (daily, UTC) | ±0.1% | 2026-10-22 16:00 (#791) | 82342.6429 | 82342.6429 | 0.0e+0 |
| VWAP (daily, UTC) | ±0.1% | 2026-10-25 15:00 (#862) | 80613.652 | 80613.652 | 0.0e+0 |
| ADX(14) Wilder | ±0.5 (project) | 2026-10-08 14:00 (#453) | 48.2536991 | 48.2536991 | 4.3e-13 |
| ADX(14) Wilder | ±0.5 (project) | 2026-10-22 16:00 (#791) | 43.4887197 | 43.4887197 | 1.4e-14 |
| ADX(14) Wilder | ±0.5 (project) | 2026-10-25 15:00 (#862) | 32.4243391 | 32.4243391 | 1.4e-14 |
| StochRSI %K | ±0.5 (project) | 2026-10-08 14:00 (#453) | 92.1388751 | 92.1388751 | 8.5e-14 |
| StochRSI %K | ±0.5 (project) | 2026-10-22 16:00 (#791) | 0 | 0 | 0.0e+0 |
| StochRSI %K | ±0.5 (project) | 2026-10-25 15:00 (#862) | 73.5598176 | 73.5598176 | 1.4e-13 |

Tolerance values without "(project)" come from the specification. ADX and StochRSI have no specified tolerance; ±0.5 is a project choice.
Bollinger(20, 2) uses the population standard deviation (pandas `rolling(20).std(ddof=0)`); its three bands are asserted at the same four points by `api/tests/golden.test.ts`.

## Governance pipeline (Phase D)

`api/orchestrator/machine.ts` runs `DETECTED → DATA_VALIDATED → INDICATORS_READY → AGENTS_RUN → RECONCILED → RISK_CHECKED → GATED → RECORDED → NOTIFIED`.
Any HALT jumps to `RECORDED` (rejected for a Risk Room halt, inconclusive otherwise).

- Delta Force is an agent: `ULTRA_TREND` votes with weight 3, every other verdict with weight 1.
- `RANGE_DETECTED` is routed to Range Mode (`RANGE_SHORT` / `RANGE_LONG` vote, otherwise abstain), never to a plain ABSTAIN.
- Approval Room: weighted vote (no simple majority). Weighted dissent above 30% consults the Elite Council.
- Elite Council fallback (no LLM, no key): NO_TRADE on Delta Force `CONFLICT`, `RANGE_TOO_TIGHT`, borderline data (R:R < 1.8 or data older than 75% of the stale limit), or Risk Room not strictly `PASS`. It can never override a hard group deadlock (both directions at or above 30% weight).
- Thresholds that are project choices and not specification values: borderline R:R 1.8, borderline freshness 75%, approval threshold 60%, range-vote confidence 0.7.

## Hardening (audit of commit a84b868)

State machine: `docs/STATE_MACHINE.md`. Parameters: `docs/PARAMETERS.md`. Deviations from the PDF are listed in section 5 of the state-machine document.
