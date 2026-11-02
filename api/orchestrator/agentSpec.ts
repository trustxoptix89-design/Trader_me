import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent definition files (V6 Phase C template). A deliberately tiny YAML subset is supported so no new dependency is needed:
 *   key: scalar | "quoted" | [a, b, "c"] | (block list of "- scalar" or "- {k: v, k2: "v2"}")
 * Anything else throws, so a malformed definition can never be silently half-read.
 */
export type Scalar = string;
export type SpecValue = Scalar | Scalar[] | Record<string, Scalar>[];
export type AgentSpec = Record<string, SpecValue>;

const unq = (s: string): string => { const t = s.trim(); return /^"(.*)"$/s.test(t) ? t.slice(1, -1) : t; };
function splitTop(s: string): string[] {
  const out: string[] = []; let cur = "", q = false, depth = 0;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && (ch === "[" || ch === "{")) depth++;
    if (!q && (ch === "]" || ch === "}")) depth--;
    if (ch === "," && !q && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((x) => x.trim());
}
function inlineMap(s: string): Record<string, Scalar> {
  const inner = s.trim().slice(1, -1);
  const m: Record<string, Scalar> = {};
  for (const part of splitTop(inner)) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`bad inline map entry: ${part}`);
    m[part.slice(0, i).trim()] = unq(part.slice(i + 1));
  }
  return m;
}
export function parseAgentYaml(text: string): AgentSpec {
  const spec: AgentSpec = {};
  let openKey: string | null = null;
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (/^\s+-\s/.test(raw)) {
      if (!openKey) throw new Error(`line ${n + 1}: list item without a key`);
      const item = raw.replace(/^\s+-\s/, "").trim();
      const cur = spec[openKey] as unknown[];
      cur.push(item.startsWith("{") ? inlineMap(item) : unq(item));
      continue;
    }
    if (/^\s/.test(raw)) throw new Error(`line ${n + 1}: unsupported indentation`);
    const i = raw.indexOf(":");
    if (i < 1) throw new Error(`line ${n + 1}: expected key: value`);
    const key = raw.slice(0, i).trim(), val = raw.slice(i + 1).trim();
    if (key in spec) throw new Error(`line ${n + 1}: duplicate key ${key}`);
    if (val === "") { spec[key] = [] as Scalar[]; openKey = key; continue; }
    openKey = null;
    spec[key] = val.startsWith("[") && val.endsWith("]") ? splitTop(val.slice(1, -1)).map(unq) : unq(val);
  }
  return spec;
}

const IMPLEMENTATIONS = ["deterministic", "ai_call", "stub"];
/** Validates a spec against the V6 template. Returns problems; empty = valid. */
export function validateAgentSpec(s: AgentSpec): string[] {
  const p: string[] = [];
  const str = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() !== "" ? (s[k] as string) : null);
  const arr = (k: string) => Array.isArray(s[k]);
  const id = str("id");
  if (!id || !(/^[A-E]\d{2}$/.test(id) || id === "DELTA_FORCE")) p.push("id must be A01..E33 (or DELTA_FORCE)");
  const group = str("group");
  if (!group || !/^[A-E]$/.test(group) || (id && id !== "DELTA_FORCE" && id[0] !== group)) p.push("group must be A-E and match the id");
  for (const k of ["name", "version", "mandate", "abstention_rule", "status"]) if (!str(k)) p.push(`${k} is required`);
  const impl = str("implementation");
  if (!impl || !IMPLEMENTATIONS.includes(impl)) p.push("implementation must be deterministic | ai_call | stub");
  for (const k of ["inputs", "outputs", "validation", "evidence_required", "tests"]) if (!arr(k)) p.push(`${k} must be a list`);
  if (arr("outputs") && (s.outputs as unknown[]).length === 0) p.push("outputs must not be empty");
  if (impl === "stub") {
    if (s.status !== "NOT_IMPLEMENTED") p.push("a stub must have status NOT_IMPLEMENTED");
  } else {
    if (s.status !== "IMPLEMENTED") p.push("a real agent must have status IMPLEMENTED");
    if (arr("tests") && (s.tests as unknown[]).length === 0) p.push("a real agent needs at least one test file (V6: no agent without tests)");
    if (!str("code_agent_id")) p.push("a real agent needs code_agent_id (the agentId its vote carries)");
  }
  return p;
}

export interface LoadedAgent { file: string; spec: AgentSpec; problems: string[] }
export function loadAgentSpecs(dir: string): LoadedAgent[] {
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((file) => {
    try { const spec = parseAgentYaml(readFileSync(join(dir, file), "utf8")); return { file, spec, problems: validateAgentSpec(spec) }; }
    catch (e) { return { file, spec: {}, problems: [e instanceof Error ? e.message : String(e)] }; }
  });
}
