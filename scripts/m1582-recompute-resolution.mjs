#!/usr/bin/env node
/**
 * M15.8.3 零模型：以当前语料快照口径重算 claim-resolution-r{latest}（deterministic）。
 *
 * 背景：M15.8.2 的 r9 resolution 在「16 条 matrix 条目已失效 + 快照对齐」前的口径下
 * 生成——65,213 claim 被判 remove（当时 S025 不可采证）。corpus-sync 后 24/25 源可
 * 采证，resolution 应重算为 ground_existing_source 供 preground 消费。本脚本与
 * workflow revision.plan 的 buildClaimResolutionContext + computeClaimResolutions 同构
 * （同一 dist 纯函数，零模型调用），重算产物经 reviewArtifacts.saveClaimResolution
 * 落盘（同轮次刷新，generatedAt 如实更新）。
 *
 * 用法：node scripts/m1582-recompute-resolution.mjs
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");

// 零模型脚本：账本硬顶 1 = 绊线（任何模型调用即拒并暴露）
process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(DATA_ROOT, "M15_8_3", "budget", "recompute-tripwire.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const journal = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-journal.json"), "utf8"));
const projectId = journal.projectId;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));
const { computeClaimResolutions } = await import(distUrl("review", "claimResolution.js"));
const { isUnsupportedVerdict } = await import(distUrl("review", "claimGrounding.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8.3 recompute-resolution (tripwire)",
});
const researchNet = await initResearchNetwork({ settingsDir: join(config.runtimeRoot, "settings"), log: () => {} });
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
const services = stack.workflowServices;

// ---- 与 revision.plan 的 buildClaimResolutionContext 同构 ----
const { readdir } = await import("node:fs/promises");
const reviewsDir = join(P_ROOT, projectId, "reviews");
const summaries = (await readdir(reviewsDir)).filter((f) => /^review-summary-r\d+\.json$/.test(f)).sort();
const summary = JSON.parse(await readFile(join(reviewsDir, summaries[summaries.length - 1]), "utf8"));
const round = summary.round;

const claimGrounding = await services.reviewArtifacts.loadClaimGrounding(projectId, round);
if (claimGrounding === null) throw new Error(`r${round} 无 claim-grounding 产物`);

const sources = await services.sources.list(projectId);
const corpusSnapshot = await services.corpus.get(projectId).catch(() => null);
const basisRow = new Map((corpusSnapshot?.sources ?? []).map((row) => [row.sourceId, row]));
const groundableInBasis = (sourceId) => {
  if (corpusSnapshot === null) return true;
  const row = basisRow.get(sourceId);
  if (row === undefined) return false;
  return row.basisDepth === "fulltext" || (row.basisDepth === null && row.hasFulltext);
};
const chunkedSourceIds = new Set();
for (const source of sources) {
  try {
    const chunks = await services.chunkStore.readChunks(projectId, source.sourceId);
    if (chunks !== null && chunks.length > 0 && groundableInBasis(source.sourceId)) chunkedSourceIds.add(source.sourceId);
  } catch { /* 无 chunk 文件 = 不可定向采证 */ }
}
const groundability = sources.map((source) => ({
  sourceId: source.sourceId,
  ...(source.metadata.title !== undefined && source.metadata.title.trim() !== "" ? { title: source.metadata.title } : {}),
  hasChunks: chunkedSourceIds.has(source.sourceId),
  metadataOnly: source.status === "metadata_only" || source.status === "pending",
}));
// outline literatureRefs 投影（与 projectOutlineCitedSourceIds 同构）
const { literatureRefSourceIds, normalizeSectionKey } = await import(distUrl("review", "claimGrounding.js"));
const outline = await services.manuscript.loadOutline(projectId);
const sectionCitedSourceIds = {};
for (const section of outline?.sections ?? []) {
  if (section.literatureRefs !== undefined && section.literatureRefs.length > 0) {
    const ids = literatureRefSourceIds(section.literatureRefs);
    for (const key of [section.file, section.id]) {
      const normalized = key !== undefined ? normalizeSectionKey(key) : "";
      if (normalized !== "" && ids.length > 0) sectionCitedSourceIds[normalized] = ids;
    }
  }
}
const formalEvidence = (await services.evidenceSelection.selectForWriting(projectId)).formal;

const report = computeClaimResolutions(
  claimGrounding.claims.filter((entry) => isUnsupportedVerdict(entry.verdict)),
  { sources: groundability, sectionCitedSourceIds, targetedSearchBudget: 0, formalEvidence },
  { projectId, round },
);
await services.reviewArtifacts.saveClaimResolution(projectId, report);

const out = {
  schema: "m1582-recompute-resolution/v1",
  at: new Date().toISOString(),
  projectId, round,
  counts: report.counts,
  resolutions: report.resolutions.map((r) => ({ claimId: r.claimId, action: r.action, basis: r.basis, sourceIds: r.sourceIds })),
  budgetCalls: budgetLedger.snapshot().calls,
  zeroModel: budgetLedger.snapshot().calls === 0,
};
const outPath = join(DATA_ROOT, "M15_8_3", "phase-a", "recompute-resolution-report.json");
const tmp = `${outPath}.tmp`;
await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
await rename(tmp, outPath);
console.log(`recompute r${round}: ${JSON.stringify(report.counts)} zeroModel=${out.zeroModel}`);
process.exit(0);
