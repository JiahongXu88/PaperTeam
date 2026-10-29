#!/usr/bin/env node
/**
 * M15.12 Phase E2 — issue taxonomy typing（judge 辅助 + 冻结输出）。
 *
 * 预注册 §4.2/§6：serious/meta 判定不再用 regex 直接定真值。
 * 每族一次 judge 调用：只见问题族短摘（不见任何臂输出），按冻结 taxonomy 分类：
 *   method_correctness / missing_key_experiments / overclaiming / related_work /
 *   evaluation_soundness / goal_task_misalignment / claim_evidence_gap /
 *   clarity_presentation / reproducibility / other
 * 并判 serious（方法正确性/关键实验缺失/过度声称/重要相关工作类实质缺陷）与
 * meta（整稿级 goal-task/claim-evidence/overclaiming-vs-scope 判断）。
 *
 * 产物 phase-e/issue-typing-raw.jsonl（judge 原始判定）。
 * investigator 复核后手工修正写入 phase-e/issue-typing-frozen.json（含 corrections
 * 计数）——该文件冻结后才能运行 judge-alignment（typing 盲于臂输出）。
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1512_ROOT ? resolve(process.env.M1512_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_12");
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

const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const byFam = new Map();
for (const g of issueFamilies) {
  if (famArg !== null && g.familyId !== famArg) continue;
  if (!byFam.has(g.familyId)) byFam.set(g.familyId, []);
  byFam.get(g.familyId).push(g);
}

const TYPING_PROMPT_HEAD = `You are categorizing issues raised by peer reviewers of a machine-learning manuscript. You will see a list of reviewer concerns (each with an ID like A1). For each concern, decide:

1. "taxonomy": the single best category from:
   - method_correctness: the proposed method/derivation is wrong, unsound, ill-defined, or its validity is questioned
   - missing_key_experiments: missing or insufficient experiments/baselines/ablations/comparisons/datasets to support the claims
   - overclaiming: claims stronger than what results/scope justify; trivial or incremental novelty framed as significant
   - related_work: missing or insufficient discussion/citation of relevant prior work
   - evaluation_soundness: evaluation protocol problems (metrics, splits, statistical rigor, fairness of comparison) not amounting to missing experiments
   - goal_task_misalignment: the stated research goal and the actual task/experiments/scope are misaligned; the paper does not do what it sets out to do
   - claim_evidence_gap: specific claims lacking the evidence the paper itself could have provided (broader than one missing ablation; about the support structure of the argument)
   - clarity_presentation: exposition, writing, notation, structure (NOT typos)
   - reproducibility: missing details/code/hyperparameters to reproduce
   - other: none of the above
2. "serious": true if this is a substantive academic defect a careful reviewer would consider significant for accept/reject (method correctness, missing key experiments, overclaiming, important related-work omission, fundamental misalignment) — false for polish/preference/minor remarks.
3. "meta": true if judging this concern requires whole-paper synthesis (goal-vs-task alignment, claim-vs-evidence support structure, overclaiming vs delivered scope) rather than a local check of one section/number.

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
    contextScope: `m1512-typing/${famId}`,
    task: prompt,
    toolPolicy: "read_only",
    metadata: { stage: "m1512-typing", famId },
  });
  judgeCalls += 1;
  await appendFile(join(ROOT, "phase-d", "model-calls.jsonl"), JSON.stringify({ ts: new Date().toISOString(), familyId: famId, contextScope: `m1512-typing/${famId}`, armHint: "typing-judge", status: task.status, ms: Date.now() - t0, usage: task.usage ?? null, taskId: task.taskId }) + "\n", "utf8").catch(() => {});
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
