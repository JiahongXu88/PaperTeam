#!/usr/bin/env node
/**
 * M15.14 Phase E2 — issue taxonomy typing（12 类扩展 + serious/meta；盲于臂输出）。
 *
 * 与 M15.13 十类的关系：拆分 overclaiming 中"创新性不足/增量"语义为独立的
 * novelty_prior_art 与 contribution_significance（本轮主指标的 TARGET 子集），
 * 其余九类逐字沿用。每族一次 judge 调用（只见问题族短摘）。
 * 产物 phase-e/issue-typing-raw.jsonl；investigator 复核后写 frozen 文件。
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
const formalFams = new Set(projectsInfo.families.filter((f) => f.role === "PRIMARY").map((f) => f.familyId));
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const includeDev = process.argv.includes("--include-dev");
const byFam = new Map();
for (const g of issueFamilies) {
  if (!formalFams.has(g.familyId) && !(includeDev || (famArg !== null && g.familyId === famArg))) continue;
  if (famArg !== null && g.familyId !== famArg) continue;
  if (!byFam.has(g.familyId)) byFam.set(g.familyId, []);
  byFam.get(g.familyId).push(g);
}

const TYPING_PROMPT_HEAD = `You are categorizing issues raised by peer reviewers of a machine-learning manuscript. You will see a list of reviewer concerns (each with an ID like A1). For each concern, decide:

1. "taxonomy": the single best category from:
   - novelty_prior_art: the claimed contribution already exists in prior work, or is incremental/minor over prior art — the reviewer questions what is actually NEW
   - contribution_significance: the contribution is unclear, too minor, poorly articulated, or the claimed advances are not well-defined contributions
   - related_work: missing or insufficient discussion/citation of relevant prior work
   - claim_evidence_gap: specific claims lacking the evidence the paper itself could have provided (broader than one missing ablation; about the support structure of the argument)
   - overclaiming: claims stronger than what results/scope justify (results-vs-claims exaggeration, overgeneralization; NOT novelty incrementality — that is novelty_prior_art)
   - method_correctness: the proposed method/derivation is wrong, unsound, ill-defined, or its validity is questioned
   - missing_key_experiments: missing or insufficient experiments/baselines/ablations/comparisons/datasets to support the claims
   - evaluation_soundness: evaluation protocol problems (metrics, splits, statistical rigor, fairness of comparison) not amounting to missing experiments
   - goal_task_misalignment: the stated research goal and the actual task/experiments/scope are misaligned
   - clarity_presentation: exposition, writing, notation, structure (NOT typos)
   - reproducibility: missing details/code/hyperparameters to reproduce
   - other: none of the above
2. "serious": true if this is a substantive academic defect a careful reviewer would consider significant for accept/reject — false for polish/preference/minor remarks.
3. "meta": true if judging this concern requires whole-paper synthesis (goal-vs-task alignment, claim-vs-evidence support structure, novelty positioning vs delivered scope) rather than a local check of one section/number.

Output ONLY one JSON object:
{"types": [{"a": <ID number>, "taxonomy": "...", "serious": true|false, "meta": true|false, "rationale": "<short reason>"}]}
Include an entry for EVERY concern.

CONCERNS:
`;

const rawPath = join(ROOT, "phase-e", "issue-typing-raw.jsonl");
const done = new Set();
if (existsSync(rawPath)) {
  for (const line of (await readFile(rawPath, "utf8")).split("\n")) {
    if (line.trim() !== "") {
      try { done.add(JSON.parse(line).familyId); } catch {}
    }
  }
}
let judgeCalls = 0;
const outLines = [];
for (const [famId, issues] of byFam) {
  if (done.has(famId)) continue;
  const concerns = issues
    .map((g, i) => `A${i + 1}: ${g.excerpts[0].slice(0, 350)}${g.excerpts.length > 1 ? ` (also raised as: ${g.excerpts[1].slice(0, 150)}…)` : ""}`)
    .join("\n");
  const prompt = TYPING_PROMPT_HEAD + concerns + "\n";
  const t0 = Date.now();
  const task = await adapter.runAgent({
    agentId: "main",
    contextScope: `m1514-typing/${famId}`,
    task: prompt,
    toolPolicy: "read_only",
    metadata: { stage: "m1514-typing", famId },
  });
  judgeCalls += 1;
  await appendFile(join(ROOT, "phase-d", "model-calls.jsonl"), JSON.stringify({ ts: new Date().toISOString(), familyId: famId, contextScope: `m1514-typing/${famId}`, armHint: "typing-judge", status: task.status, ms: Date.now() - t0, usage: task.usage ?? null, taskId: task.taskId }) + "\n", "utf8").catch(() => {});
  const raw = task.output ?? "";
  let parsed = null;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {}
  const record = { familyId: famId, issueCount: issues.length, types: parsed?.types ?? null, parseError: parsed === null ? raw.slice(0, 200) : null };
  outLines.push(record);
  console.log(`[typing] ${famId}: issues=${issues.length} typed=${record.types?.length ?? "PARSE_ERROR"}`);
}
if (outLines.length > 0) {
  await mkdir(join(ROOT, "phase-e"), { recursive: true });
  await appendFile(rawPath, outLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}
console.log(`typing judge calls: ${judgeCalls}`);
process.exit(0);
