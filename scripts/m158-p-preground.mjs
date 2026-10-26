#!/usr/bin/env node
/**
 * M15.8 受控 Repair（§5.D Evidence gap）—— 续跑前定向采证（pre-grounding）。
 *
 * 语义：与 workflow 的 evidence.ground_claims stage 完全同构——读最新
 * claim-resolution-r{round}.json 的 ground_existing_source 条目，调用同一
 * targetedGrounding.groundClaims 服务（judge + provenance 全走产品管道），
 * 产出的 verified evidence 落库后续跑 review 直接可见。区别仅在执行时点
 * （run 外、由操作者触发，§5.D 明示允许）；模型调用计入 tail 账本。
 *
 * 用法：node scripts/m158-p-preground.mjs
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");

process.env["PROJECTS_ROOT"] = P_ROOT;
// 计入 tail 账本（Dev #1：tail 72 会话总授权内）
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = process.env["M158_TAIL_LEDGER"] ?? join(EVAL_DIR, "budget-ledger-p-tail.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = process.env["M158_TAIL_MAX_CALLS"] ?? "72";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const journal = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-journal.json"), "utf8"));
const projectId = journal.projectId;
await mkdir(EVAL_DIR, { recursive: true });
const REPORT_PATH = join(EVAL_DIR, "m158-p-preground-report.json");

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8 preground",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: P_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: () => [], // judge 直接消费 prompt 内 chunkText（与 workflow stage 同形）
  log: () => {},
});
const projects = new ProjectStore({ root: P_ROOT });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: (m) => console.log(m),
});

// ---- 与 evidence.ground_claims stage 同构 ----
const services = stack.workflowServices;
const summary = await (async () => {
  // latestReviewSummary 等价：读 reviews 目录最大轮次 summary
  const { readdir } = await import("node:fs/promises");
  const reviewsDir = join(P_ROOT, projectId, "reviews");
  const summaries = (await readdir(reviewsDir)).filter((f) => /^review-summary-r\d+\.json$/.test(f)).sort();
  if (summaries.length === 0) throw new Error("无 review summary");
  return JSON.parse(await readFile(join(reviewsDir, summaries[summaries.length - 1]), "utf8"));
})();
const round = summary.round;
const resolution = await services.reviewArtifacts.loadClaimResolution(projectId, round);
if (resolution === null) {
  console.log(`[preground] r${round} 无 claim-resolution 产物（无可采证条目）`);
  process.exit(0);
}
const requests = resolution.resolutions
  .filter((entry) => entry.action === "ground_existing_source" && Array.isArray(entry.sourceIds) && entry.sourceIds.length > 0)
  .map((entry) => ({ claimId: entry.claimId, claim: entry.claim, section: entry.section, sourceIds: entry.sourceIds }));
console.log(`[preground] round=${round} 待采证 ${requests.length} 条（claim-resolution 全条目 ${resolution.resolutions.length}）`);
if (requests.length === 0) process.exit(0);

const before = budgetLedger.snapshot().calls;
const result = await services.targetedGrounding.groundClaims(projectId, requests, {});
const after = budgetLedger.snapshot().calls;
const report = {
  schema: "m158-preground/v1",
  projectId,
  round,
  requests: requests.length,
  verifiedClaims: result.verifiedClaims,
  verifiedEvidence: result.verifiedEvidence,
  unsupportedByJudge: result.unsupportedByJudge,
  outcomes: result.outcomes.map((o) => ({ claimId: o.claimId, status: o.status, evidenceIds: o.evidenceIds, reason: o.reason })),
  budgetCalls: after - before,
  budgetTotal: after,
};
const tmp = `${REPORT_PATH}.tmp`;
await writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
await rename(tmp, REPORT_PATH);
console.log(`DONE preground: verified=${result.verifiedClaims}/${requests.length} evidence=${result.verifiedEvidence} judgeUnsupported=${result.unsupportedByJudge} calls=${after - before}（tail ${after}/72）`);
process.exit(0);
