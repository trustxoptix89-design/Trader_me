import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/types";
import { defaultAgents } from "../orchestrator/agents";
import { loadAgentSpecs, parseAgentYaml, validateAgentSpec } from "../orchestrator/agentSpec";
import type { AgentContext } from "../orchestrator/machine";

const root = fileURLToPath(new URL("../../", import.meta.url));
const real = (JSON.parse(readFileSync(`${root}fixtures/btcusdt_1h.json`, "utf8")) as { candles: Candle[] }).candles;
const ctxOf = (c: Candle[]): AgentContext => ({ candles: { "4H": [], "1H": c, "15m": [], "5m": [] }, trend: {} as never });
const specs = loadAgentSpecs(`${root}agents`);
const real_ = specs.filter((s) => s.spec.implementation !== "stub");

describe("agent YAML parser (V6 Phase C template subset)", () => {
  it("parses scalars, quoted strings, inline lists and block lists of inline maps", () => {
    const s = parseAgentYaml('id: A01\nname: "Market Structure"\ninputs: [ohlcv, "timeframe"]\noutputs:\n  - {key: verdict, type: "enum[a,b]"}\n  - {key: confidence, type: float}\n# c\nvalidation: []\n');
    expect(s.id).toBe("A01");
    expect(s.name).toBe("Market Structure");
    expect(s.inputs).toEqual(["ohlcv", "timeframe"]);
    expect(s.outputs).toEqual([{ key: "verdict", type: "enum[a,b]" }, { key: "confidence", type: "float" }]);
    expect(s.validation).toEqual([]);
  });
  it("rejects duplicate keys, orphan list items, bad indentation and lines without a colon", () => {
    const throws = (src: string) => { try { parseAgentYaml(src); return false; } catch { return true; } };
    expect(throws("id: A\nid: B")).toBe(true);
    expect(throws("  - x")).toBe(true);
    expect(throws("a: 1\n  b: 2")).toBe(true);
    expect(throws("nokey")).toBe(true);
  });
});

describe("agent definitions in /agents (V6 33-agent council)", () => {
  it("every file parses and satisfies the template", () => {
    for (const s of specs) expect(s.problems).toEqual([]);
  });
  it("the 33 numbered slots A01..E33 each exist exactly once, in the V6 group ranges", () => {
    const ids = specs.map((s) => s.spec.id as string).filter((i) => i !== "DELTA_FORCE").sort();
    const expected = [[1, 8, "A"], [9, 16, "B"], [17, 23, "C"], [24, 28, "D"], [29, 33, "E"]].flatMap(([a, b, g]) => Array.from({ length: (b as number) - (a as number) + 1 }, (_, k) => `${g}${String((a as number) + k).padStart(2, "0")}`)).sort();
    expect(ids).toEqual(expected);
    expect(ids.length).toBe(33);
  });
  it("honest count: 7 real agents (6 numbered slots + Delta Force), 27 explicit NOT_IMPLEMENTED stubs", () => {
    expect(real_.length).toBe(7);
    expect(specs.filter((s) => s.spec.implementation === "stub").length).toBe(27);
    expect(specs.filter((s) => s.spec.implementation === "stub").every((s) => s.spec.status === "NOT_IMPLEMENTED")).toBe(true);
  });
  it("the template validator rejects incomplete real agents", () => {
    const good = real_[0].spec;
    expect(validateAgentSpec({ ...good, abstention_rule: "" }).length).toBeGreaterThan(0);
    expect(validateAgentSpec({ ...good, tests: [] }).length).toBeGreaterThan(0);
    expect(validateAgentSpec({ ...good, implementation: "magic" }).length).toBeGreaterThan(0);
    expect(validateAgentSpec({ ...good, group: "B", id: "A01" }).length).toBeGreaterThan(0);
    expect(validateAgentSpec({ ...good, status: "NOT_IMPLEMENTED" }).length).toBeGreaterThan(0);
  });
  it("every test file a real agent names exists", () => {
    for (const s of real_) for (const t of s.spec.tests as string[]) expect(existsSync(`${root}${t}`)).toBe(true);
  });
});

describe("implemented agents run on REAL BTCUSDT 1h candles and abstain with a reason on thin input", () => {
  const votes = defaultAgents().map((a) => a(ctxOf(real)));
  const thin = defaultAgents().map((a) => a(ctxOf(real.slice(0, 5))));
  const runnable = real_.filter((s) => s.spec.code_agent_id !== "DELTA_FORCE");
  it("the code runtime and the YAML registry list the same runnable agents", () => {
    expect(votes.map((v) => v.agentId).sort()).toEqual(runnable.map((s) => s.spec.code_agent_id as string).sort());
  });
  it("each agent returns a valid (non-abstain) verdict on real data", () => {
    for (const v of votes) {
      expect(["bullish", "bearish", "neutral"]).toContain(v.verdict);
      expect(v.confidence).toBeGreaterThan(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
      expect(v.reason.length).toBeGreaterThan(0);
    }
  });
  it("each agent abstains with a reason and zero confidence on incomplete input", () => {
    for (const v of thin) { expect(v.verdict).toBe("abstain"); expect(v.confidence).toBe(0); expect(v.reason.length).toBeGreaterThan(0); }
  });
  it("is deterministic and group codes match the YAML group", () => {
    const again = defaultAgents().map((a) => a(ctxOf(real)));
    expect(JSON.stringify(again)).toBe(JSON.stringify(votes));
    for (const v of votes) expect(runnable.find((s) => s.spec.code_agent_id === v.agentId)?.spec.group).toBe(v.group);
  });
  it("stubs never vote", () => {
    const stubIds = specs.filter((s) => s.spec.implementation === "stub").map((s) => s.spec.id as string);
    for (const v of votes) expect(stubIds.some((i) => v.agentId.startsWith(i))).toBe(false);
  });
});
