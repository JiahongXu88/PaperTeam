#!/usr/bin/env node
/**
 * M15.12 错误恢复 — fullpaper critique 解析失败重跑（deviation v3）。
 *
 * 仅对 critiqueParseFailed=true 的族：用与原始运行完全相同的输入（同 section findings、
 * 同 PaperMap）与同一指令重跑 fullpaper pass（≤2 次尝试）；成功则回填 c2.json/workflow.json。
 * 不看任何对齐结果（predictions 冻结前执行）；调用计入物理账（review/fullpaper/* scope）。
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = process.env.M1512_ROOT ? resolve(process.env.M1512_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_12");
const OUT_DIR = join(ROOT, "phase-d", "out");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const LEDGER = join(ROOT, "phase-d", "budget-ledger.json");
const famId = process.argv[2];
if (!famId) throw new Error("用法：repair-fullpaper.mjs <famId>");

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "600";

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { FullPaperReviewService } = await import(distUrl("paper", "FullPaperReviewService.js"));
const { PaperStore } = await import(distUrl("paper", "PaperStore.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({ path: LEDGER, limits: { maxCalls: 600, maxTokens: 0 }, label: "M15.12 arms" });
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
let physicalCalls = 0;
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  log: () => {},
});
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const t0 = Date.now();
  const scopeHint = callArgs[0]?.contextScope ?? "";
  const result = await originalRunAgent(...callArgs);
  await appendFile(join(ROOT, "phase-d", "model-calls.jsonl"), JSON.stringify({ ts: new Date().toISOString(), callIndex: physicalCalls, familyId: famId, contextScope: scopeHint, armHint: scopeHint.startsWith("review/fullpaper/") ? "c2-fullpaper" : "other", status: result.status, ms: Date.now() - t0, usage: result.usage ?? null, taskId: result.taskId, note: "deviation-v3-repair" }) + "\n", "utf8").catch(() => {});
  return result;
};

const famDir = join(OUT_DIR, famId);
const workflow = JSON.parse(await readFile(join(famDir, "workflow.json"), "utf8"));
const fp = workflow.stageResults?.["review.fullpaper"];
if (!fp) throw new Error(`${famId} 无 review.fullpaper stage 结果`);
if (fp["critiqueParseFailed"] !== true && (fp["findings"] ?? []).length > 0) {
  console.log(`${famId}: 无需修复（critiqueParseFailed=${fp["critiqueParseFailed"]}, findings=${(fp["findings"] ?? []).length}）`);
  process.exit(0);
}
const meta = JSON.parse(await readFile(join(famDir, "meta.json"), "utf8"));
const projectId = meta.projectId;
const sections = workflow.stageResults?.["review.sections"] ?? {};
const sectionFindings = Array.isArray(sections["findings"]) ? sections["findings"] : [];

const projects = new ProjectStore({ root: PROJECTS_ROOT });
const store = new PaperStore(projects);
const service = new FullPaperReviewService({ store, runtime: adapter, reviewerAgentId: config.agents.reviewer });

let outcome = null;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  console.log(`${famId}: fullpaper repair attempt ${attempt}`);
  outcome = await service.reviewFullPaper({ projectId, runId: `repair-${famId}-${attempt}`, sectionFindings });
  if (!outcome.critiqueParseFailed && outcome.findings.length >= 0 && !outcome.extractParseFailed) break;
  if (attempt === 2) break;
}
console.log(JSON.stringify({ calls: physicalCalls, findings: outcome.findings.length, extractParseFailed: outcome.extractParseFailed, critiqueParseFailed: outcome.critiqueParseFailed, dropped: outcome.dropped }, null, 1));

// 回填 c2.json 与 workflow.json（c1opt 不受影响；note 标注 repair）
const c2 = JSON.parse(await readFile(join(famDir, "c2.json"), "utf8"));
const c1 = JSON.parse(await readFile(join(famDir, "c1opt.json"), "utf8"));
const newFpTelemetry = { ...outcome.telemetry, calls: outcome.telemetry.calls, note: `deviation-v3 repair (physical calls this repair: ${physicalCalls})` };
c2.fullpaperTelemetry = newFpTelemetry;
c2.fullpaperCoverage = outcome.coverage;
c2.fullpaperDropped = outcome.dropped;
c2.findings = [...c1.findings, ...outcome.findings];
c2.findingsTotal = c2.findings.length;
c2.repair = { deviation: "v3", at: new Date().toISOString(), reason: "critique parse failure in original run; same-input retry" };
await writeFile(join(famDir, "c2.json"), JSON.stringify(c2, null, 1), "utf8");
workflow.stageResults["review.fullpaper"] = {
  findings: outcome.findings,
  findingsTotal: outcome.findings.length,
  dropped: outcome.dropped,
  extractParseFailed: outcome.extractParseFailed,
  critiqueParseFailed: outcome.critiqueParseFailed,
  modelTelemetry: newFpTelemetry,
  coverage: outcome.coverage,
  repair: c2.repair,
};
await writeFile(join(famDir, "workflow.json"), JSON.stringify(workflow, null, 1), "utf8");
console.log(`${famId}: repair done; physical calls ${physicalCalls}`);
process.exit(0);
