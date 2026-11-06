// Reproduce docs/HISTORY_DEPTH.md:  npx tsx tools/history-depth/study.ts [--json]      DATA CLASS: HISTORICAL-REAL (fixtures/btcusdt_1h.json)
import { readFileSync } from "node:fs";
import { DEFAULT_STUDY, runStudy } from "../../api/pipeline/historyStudy";

const raw = JSON.parse(readFileSync(new URL("../../fixtures/btcusdt_1h.json", import.meta.url), "utf8")) as { candles: Record<string, number>[] };
const all = raw.candles.map((c) => ({ time: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume })) as never[];
const r = runStudy(all);
if (process.argv.includes("--json")) console.log(JSON.stringify(r));
else {
  console.log(`candles=${r.candles} endPositions=${r.endPositions} (e=${DEFAULT_STUDY.endFrom}..${r.candles - 1}) maxDepth=${DEFAULT_STUDY.maxDepth}`);
  console.log("indicator | minValid | stable@1e-2 | stable@1e-3 | stable@1e-4");
  for (const x of r.rows) console.log(`${x.indicator} | ${x.minValid} | ${x.stable["0.01"]} | ${x.stable["0.001"]} | ${x.stable["0.0001"]}`);
  console.log("depth: Delta Trend verdict agreement / supertrend direction agreement");
  for (const d of Object.keys(r.verdictAgreement).map(Number).filter((k) => k % 50 === 0 || k === 200)) console.log(`${d}: ${(r.verdictAgreement[d] * 100).toFixed(1)}% / ${(r.supertrendDirAgreement[d] * 100).toFixed(1)}%`);
}
