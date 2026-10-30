#!/usr/bin/env node
/**
 * M15.14 Phase E3 — 盲态对齐 judge（每族每臂一次调用；M15.11/13 prompt 逐字沿用）。
 * 臂 = a0 / a1 / a2（+ a2np 若输出存在，消融臂）。
 * 前置：issue-typing-frozen.json 已存在（typing 先冻结，盲于臂输出）。
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
process.env["PROJECTS_ROOT"] = join(ROOT, "phase-d", "projects-root");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";

if (!existsSync(join(ROOT, "phase-e", "issue-typing-frozen.json"))) {
  throw new Error("issue-typing-frozen.json 不存在：先完成 typing 冻结（预注册顺序红线）");
}

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

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const heldOut = famArg
  ? projectsInfo.families.filter((f) => f.familyId === famArg)
  : projectsInfo.families.filter((f) => f.role === "PRIMARY");
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));

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
  const t0 = Date.now();
  const task = await adapter.runAgent({
    agentId: "main",
    contextScope: `m1514-judge/${famId}-${armTag}`,
    task: prompt,
    toolPolicy: "read_only",
    metadata: { stage: "m1514-judge", famId, armTag },
  });
  await appendFile(join(ROOT, "phase-d", "model-calls.jsonl"), JSON.stringify({ ts: new Date().toISOString(), familyId: famId, contextScope: `m1514-judge/${famId}-${armTag}`, armHint: "judge", status: task.status, ms: Date.now() - t0, usage: task.usage ?? null, taskId: task.taskId }) + "\n", "utf8").catch(() => {});
  const raw = task.output ?? "";
  let parsed = null;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {}
  if (!parsed || !Array.isArray(parsed.pairs)) return { pairs: null, parseError: raw.slice(0, 200) };
  return parsed;
}

const outDir = join(ROOT, "phase-e", "judge-raw");
await mkdir(outDir, { recursive: true });
const alignLines = [];
for (const fam of heldOut) {
  const famId = fam.familyId;
  const famIssues = issueFamilies.filter((g) => g.familyId === famId);
  for (const arm of ["a0", "a1", "a2", "a2np"]) {
    const armFile = join(ROOT, "phase-d", "out", famId, `${arm}.json`);
    if (!existsSync(armFile)) continue;
    const armData = JSON.parse(await readFile(armFile, "utf8"));
    const findings = (armData.findings ?? []).map((f) => ({ ...f, severity: f.severity ?? "minor", message: f.message ?? "", claimText: f.claimText ?? "" }));
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
await writeFile(join(ROOT, "phase-e", "issue-alignment.jsonl"), alignLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
console.log(`alignment records: ${alignLines.length}`);
process.exit(0);
