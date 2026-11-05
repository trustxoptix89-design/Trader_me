// Internal CLI (no HTTP endpoint, no Scheduler): npx tsx api/pipeline/cli.ts --symbol BTCUSDT [--market spot]
import { defaultAgents } from "../orchestrator/agents";
import { PostgresAuditStore, postgresJsExecutor } from "../orchestrator/audit.postgres";
import { closeDb } from "../queries/connection";
import { PostgresAgentsRunRecorder } from "./agentsRunRecorder";
import { pgLoadRows } from "./candleReader";
import { PostgresDecisionRecorder } from "./decisionRecorder";
import { runSymbolOnce } from "./runner";

const arg = (name: string, dflt?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const symbol = arg("symbol"), market = (arg("market", "spot") ?? "spot") as "spot" | "futures";
if (!symbol) { console.error("usage: cli.ts --symbol BTCUSDT [--market spot]"); process.exit(2); }
const db = postgresJsExecutor();
const out = await runSymbolOnce({
  loadRows: pgLoadRows, audit: new PostgresAuditStore(db), agents: defaultAgents(), now: () => Date.now(),
  agentRuns: { recorder: new PostgresAgentsRunRecorder(db) }, decision: { recorder: new PostgresDecisionRecorder(db) },
}, { symbol, market });
console.log(JSON.stringify(out.kind === "PIPELINE" ? { kind: out.kind, signalId: out.result.signalId, status: out.result.status, haltReason: out.result.haltReason ?? null, states: out.result.statesVisited } : out));
await closeDb();
