#!/usr/bin/env node
/**
 * M15.11 Phase D2 — blind LLM judge alignment (runs post-freeze, post-extraction).
 *
 * Per family, per arm: one judge call pairing "Set A" (human review issue-family
 * excerpts, order-stabilized) with "Set B" (one arm's findings). The judge is not
 * told which arm produced Set B, nor that Set A is human. It outputs matched pairs
 * with rationale. Judge model = same glm-5.3 (LLM_JUDGE_PROXY limitation recorded).
 *
 * Output: phase-d/judge-raw/<famId>-<arm>.json + phase-d/issue-alignment.jsonl
 */
import { readFile, writeFile, mkdir, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const REPO = "D:\\Projects\\PaperTeam";

process.env["PROJECTS_ROOT"] = join(ROOT, "phase-c", "projects-root");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));

const config = loadConfig();
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: process.env["PROJECTS_ROOT"],
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  log: () => {},
});
let judgeCalls = 0;
const CALLS_LOG = join(ROOT, "phase-c", "model-calls.jsonl");

const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const heldOut = famArg ? manifest.families.filter((f) => f.familyId === famArg) : manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId).slice(0, 12);
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-d", "issue-families.json"), "utf8"));

const JUDGE_PROMPT_HEAD = `You are auditing two independent reviews of the same manuscript.

Set A lists concerns raised in one review pass (each with an ID like A1, A2, ...).
Set B lists issues found in another review pass (each with an ID like B1, B2, ...).

Task: for each item in Set A, decide whether Set B contains an issue that raises THE SAME underlying concern (same core problem, not merely same topic or same section). Set B may be written in a different language than Set A; match by underlying meaning regardless of language. Matching requires the same substantive criticism — e.g., "missing baseline comparisons" matches "no comparison against existing methods", but does NOT match "baseline description is unclear" unless the core complaint is also missing comparison.

Output ONLY one JSON object:
{"pairs": [{"a": <Set A item number>, "b": <Set B item number or null>, "rationale": "<one sentence why>", "confidence": "high"|"medium"|"low"}]}
Include an entry for EVERY Set A item (use "b": null when Set B has no matching issue). Do not invent Set B items.

`;

function buildPrompt(issues, findings) {
  const setA = issues
    .map((g, i) => `A${i + 1}: ${g.excerpts[0].slice(0, 350)}${g.excerpts.length > 1 ? ` (also raised as: ${g.excerpts[1].slice(0, 150)}…)` : ""}`)
    .join("\n");
  const setB = findings
    .map((f, i) => `B${i + 1}: [${f.severity}] ${String(f.message).slice(0, 300)}${f.claimText ? ` (anchor: ${String(f.claimText).slice(0, 120)})` : ""}`)
    .join("\n");
  return JUDGE_PROMPT_HEAD + `Set A:\n${setA}\n\nSet B:\n${setB}\n`;
}

async function judgeOnce(famId, armTag, issues, findings) {
  if (issues.length === 0 || findings.length === 0) return { pairs: issues.map((_, i) => ({ a: i + 1, b: null, rationale: "no findings or no issues", confidence: "high" })) };
  const prompt = buildPrompt(issues, findings);
  judgeCalls += 1;
  const t0 = Date.now();
  const task = await adapter.runAgent({
    agentId: "main",
    contextScope: `m1511-judge/${famId}-${armTag}`,
    task: prompt,
    toolPolicy: "read_only",
    metadata: { stage: "m1511-judge", famId, armTag },
  });
  await appendFile(CALLS_LOG, JSON.stringify({ ts: new Date().toISOString(), contextScope: `m1511-judge/${famId}-${armTag}`, armHint: "judge", status: task.status, ms: Date.now() - t0, usage: task.usage ?? null, taskId: task.taskId }) + "\n", "utf8").catch(() => {});
  const raw = task.output ?? "";
  // lenient JSON extraction (same as production parser tolerance)
  let parsed = null;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {}
  if (!parsed || !Array.isArray(parsed.pairs)) return { pairs: null, parseError: raw.slice(0, 200) };
  return parsed;
}

const outDir = join(ROOT, "phase-d", "judge-raw");
await mkdir(outDir, { recursive: true });
const alignLines = [];
for (const fam of heldOut) {
  const famId = fam.familyId;
  const famIssues = issueFamilies.filter((g) => g.familyId === famId);
  for (const arm of ["c0", "c1"]) {
    const armFile = join(ROOT, "phase-c", "out", famId, `${arm}.json`);
    if (!existsSync(armFile)) continue;
    const armData = JSON.parse(await readFile(armFile, "utf8"));
    const findings = arm === "c0" ? (armData.findings ?? []) : ((armData.report?.findings ?? []).map((f) => ({ ...f, severity: f.severity ?? "minor", message: f.message ?? "", claimText: f.claimText ?? "" })));
    const rawFile = join(outDir, `${famId}-${arm}.json`);
    if (existsSync(rawFile)) {
      alignLines.push(JSON.parse(await readFile(rawFile, "utf8")));
      continue;
    }
    const result = await judgeOnce(famId, arm, famIssues, findings);
    const record = { familyId: famId, arm, issueCount: famIssues.length, findingCount: findings.length, ...result };
    await writeFile(rawFile, JSON.stringify(record, null, 1), "utf8");
    alignLines.push(record);
    console.log(`[judge] ${famId} ${arm}: issues=${famIssues.length} findings=${findings.length} pairs=${result.pairs?.length ?? "PARSE_ERROR"}`);
  }
}
await writeFile(join(ROOT, "phase-d", "issue-alignment.jsonl"), alignLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
console.log(`judge calls: ${judgeCalls}`);
process.exit(0);
