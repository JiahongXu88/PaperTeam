#!/usr/bin/env node
/**
 * M15.8.4 Phase B — 定向证据补充（操作者指定 requests；产品管道核验）。
 *
 * 与 m158-p-preground.mjs 的区别：requests 不来自 claim-resolution（那些是已存在于稿件中的
 * claim），而来自操作者按 Phase A 诊断起草的 requests 文件（claim 措辞取自真实 chunk 内容的
 * 忠实概括，sourceIds 指向 fulltext-basis 源）。核验仍走完整 Grounding → Proposal →
 * Verification（quote 逐字 / metadata / semantic judge）——claim 与引文不符即被拒，不构成
 * 「操作者制造证据」。
 *
 * 用法：M1584_REQUESTS=<path> M158_TAIL_LEDGER=<p32> node scripts/m1584-preground-targeted.mjs
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
const OUT_DIR = join(DATA_ROOT, "M15_8_4", "phase-b");

process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = process.env["M158_TAIL_LEDGER"] ?? join(OUT_DIR, "..", "budget", "p32.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = process.env["M158_TAIL_MAX_CALLS"] ?? "32";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const requestsPath = process.env["M1584_REQUESTS"] ?? join(OUT_DIR, "grounding-requests.json");
const journal = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-journal.json"), "utf8"));
const projectId = journal.projectId;
await mkdir(OUT_DIR, { recursive: true });

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));

const config = loadConfig();
const researchNet = await initResearchNetwork({ settingsDir: join(config.runtimeRoot, "settings"), log: () => {} });
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8.4 targeted preground",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir, workspaceRoot: P_ROOT, runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope), roleCustomTools: () => [],
  log: () => {},
});
const projects = new ProjectStore({ root: P_ROOT });
const stack = buildServiceStack({
  runtime: adapter, projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents, stageTimeoutMs: config.stageTimeoutMs, stageMaxAttempts: config.stageMaxAttempts,
  researchFetch: researchNet.router.fetch,
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: () => {},
});

const requestFile = JSON.parse(await readFile(requestsPath, "utf8"));
const requests = requestFile.requests.map((r) => ({ claimId: r.claimId, claim: r.claim, section: r.section, sourceIds: r.sourceIds }));
console.log(`[m1584-preground] ${requests.length} 条定向采证请求（源：${[...new Set(requests.flatMap((r) => r.sourceIds))].join(",")}）`);

const before = budgetLedger.snapshot().calls;
const result = await stack.workflowServices.targetedGrounding.groundClaims(projectId, requests, {});
const after = budgetLedger.snapshot().calls;
const report = {
  schema: "m1584-preground/v1",
  at: new Date().toISOString(),
  projectId,
  requestsPath,
  requests: requests.length,
  verifiedClaims: result.verifiedClaims,
  verifiedEvidence: result.verifiedEvidence,
  unsupportedByJudge: result.unsupportedByJudge,
  judgeCallsUsed: result.judgeCallsUsed,
  outcomes: result.outcomes.map((o) => ({ claimId: o.claimId, status: o.status, evidenceIds: o.evidenceIds, reason: o.reason, attempts: o.attempts })),
  budgetCalls: after - before,
  budgetTotal: after,
};
const tmp = join(OUT_DIR, "preground-report.json.tmp");
await writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
await rename(tmp, join(OUT_DIR, "preground-report.json"));
console.log(`DONE: verified=${result.verifiedClaims}/${requests.length} evidence=${result.verifiedEvidence} judgeUnsupported=${result.unsupportedByJudge} calls=${after - before}（p32 ${after}/32）`);
process.exit(0);
