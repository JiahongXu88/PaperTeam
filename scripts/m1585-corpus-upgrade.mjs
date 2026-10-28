#!/usr/bin/env node
/**
 * M15.8.5 Phase D — 真实项目研究语料升级驱动（生产路径：CorpusUpgradeService）。
 *
 * 在 p-6f05e6980fda 上执行显式 / 受控升级（scoped refresh → 增量 matrix 重建 →
 * synthesis 重建 → outline 重规划），全部经产品服务栈（buildServiceStack +
 * initResearchNetwork + GlobalBudgetLedger p70），不手改任何 JSON。
 *
 * 用法：
 *   node scripts/m1585-corpus-upgrade.mjs --report-only          # 零模型盘点
 *   node scripts/m1585-corpus-upgrade.mjs --targets=S002,S003    # scoped 升级
 *   node scripts/m1585-corpus-upgrade.mjs                        # 全量升级（全部 eligible）
 *
 * env：
 *   M1585_DATA_ROOT  数据根（默认 D:\PaperTeamData\M15\M15_8\M15_8_5）
 *   M1585_LEDGER     预算账本（默认 <DATA_ROOT>\budget\p70.json；上限 70，独立新账本）
 *   M1585_P_ROOT     项目根（默认 D:\PaperTeamData\M15\M15_8\projects-root）
 *   PAPERTEAM_RESEARCH_PROXY_URL  学术网络代理（升级本身不下载；装配纪律保持）
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M1585_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8\\M15_8_5";
const P_ROOT = process.env["M1585_P_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8\\projects-root";
const EVAL_DIR = "D:\\PaperTeamData\\M15\\M15_8\\evaluation";
const PHASE_D = join(DATA_ROOT, "phase-d");
const LEDGER_PATH = process.env["M1585_LEDGER"] ?? join(DATA_ROOT, "budget", "p70.json");
const MAX_CALLS = Number(process.env["M1585_MAX_CALLS"] ?? "70");

process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER_PATH;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(MAX_CALLS);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const targetsArg = args.find((arg) => arg.startsWith("--targets="));
const targetSourceIds = targetsArg !== undefined ? targetsArg.slice("--targets=".length).split(",").map((s) => s.trim()).filter((s) => s !== "") : undefined;

await mkdir(PHASE_D, { recursive: true });
await mkdir(dirname(LEDGER_PATH), { recursive: true });

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

const config = loadConfig();
const researchNet = await initResearchNetwork({ settingsDir: join(config.runtimeRoot, "settings"), log: () => {} });
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8.5 P corpus upgrade + writing continuation (user-authorized 70)",
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
const services = stack.workflowServices;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
async function shaFile(p) {
  try { return sha256(await readFile(p)); } catch { return null; }
}
async function stableFingerprint(value) {
  const { fingerprintJson } = await import(distUrl("util", "hash.js"));
  return fingerprintJson(value);
}
const writeReport = async (name, payload) => {
  const tmp = join(PHASE_D, `${name}.json.tmp`);
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, join(PHASE_D, `${name}.json`));
};

// ---- 升级前事实（零模型）----
const projDir = join(P_ROOT, projectId);
const beforeFacts = {
  at: new Date().toISOString(),
  ledger: budgetLedger.snapshot(),
  evidenceSha: await shaFile(join(projDir, "evidence", "evidence.jsonl")),
  gateR16Sha: await shaFile(join(projDir, "reviews", "quality-gate-r16.json")),
  drafts: {
    "art-draft-rev14.pdf": await shaFile(join(projDir, "artifacts", "art-draft-rev14.pdf")),
  },
  manuscriptOutlineSha: await shaFile(join(projDir, "manuscript", "outline.json")),
};
const availabilityBefore = await services.corpusUpgrade.availability(projectId);
console.log("[m1585] availability before:", JSON.stringify(availabilityBefore.summary));
console.log("[m1585] downstream:", JSON.stringify(availabilityBefore.downstream));
await writeReport("availability-before", { beforeFacts, availability: availabilityBefore });
if (reportOnly) {
  console.log("[m1585] --report-only：零模型盘点完成，未执行升级");
  process.exit(0);
}

// ---- 执行升级（生产服务；模型调用走 p70 账本）----
const callsBefore = budgetLedger.snapshot().calls;
const t0 = Date.now();
const outcome = await services.corpusUpgrade.upgrade(projectId, {
  ...(targetSourceIds !== undefined ? { sourceIds: targetSourceIds } : {}),
});
const elapsedMs = Date.now() - t0;
const callsAfter = budgetLedger.snapshot().calls;
console.log(`[m1585] upgrade done in ${(elapsedMs / 1000).toFixed(0)}s；modelCalls=${callsAfter - callsBefore}（p70 ${callsAfter}/${MAX_CALLS}）`);
console.log(`[m1585] basis after: fulltext=${outcome.after.fulltextBasis} abstract=${outcome.after.abstractBasis} stillEligible=[${outcome.after.stillEligible.join(",")}] failed=[${outcome.after.failedRebuilds.join(",")}]`);
await writeReport("upgrade-outcome", { ...outcome, elapsedMs, modelCalls: callsAfter - callsBefore, ledger: budgetLedger.snapshot() });

// ---- 升级后零模型核验（Phase D 验收口径）----
const matrix = await services.survey.getMatrix(projectId);
const synthesis = await services.synthesis.getSynthesis(projectId);
const snapshot = await services.corpus.get(projectId);
const outline = await services.manuscript.loadOutline(projectId);
const availabilityAfter = await services.corpusUpgrade.availability(projectId);
const matrixFp = await stableFingerprint(matrix);

const perSource = [];
const target = new Set(targetSourceIds ?? availabilityBefore.sources.filter((row) => row.upgradeEligible).map((row) => row.sourceId));
for (const entry of matrix.entries) {
  perSource.push({
    sourceId: entry.sourceId,
    interpretationDepth: entry.interpretationDepth,
    anchorCount: (entry.anchors ?? []).length,
    anchorChunkIds: (entry.anchors ?? []).flatMap((a) => a.chunkIds ?? []),
    issues: (entry.issues ?? []).map((i) => i.code),
    inTarget: target.has(entry.sourceId),
    hasStrength: entry.strength !== undefined,
    hasLimitation: entry.limitation !== undefined,
    keyFindings: (entry.keyFindings ?? []).length,
    updatedAt: entry.updatedAt,
  });
}
const verify = {
  at: new Date().toISOString(),
  snapshot: { revision: snapshot.revision, fingerprint: snapshot.fingerprint, counts: snapshot.counts, updatedAt: snapshot.updatedAt },
  matrix: { entries: matrix.entries.length, fingerprint: matrixFp, byDepth: matrix.entries.reduce((acc, e) => { acc[e.interpretationDepth] = (acc[e.interpretationDepth] ?? 0) + 1; return acc; }, {}), perSource },
  synthesis: { matrixFingerprint: synthesis.matrixFingerprint, matchesMatrix: synthesis.matrixFingerprint === matrixFp, items: synthesis.items.length, updatedAt: synthesis.updatedAt },
  outline: {
    sections: (outline?.sections ?? []).map((s) => ({ file: s.file, synthesisRefs: (s.synthesisRefs ?? []).length, literatureRefs: (s.literatureRefs ?? []).length })),
    totalSynthesisRefs: (outline?.sections ?? []).reduce((a, s) => a + (s.synthesisRefs ?? []).length, 0),
  },
  // 不可触碰面：证据库 / 旧 gate / Draft 原样
  integrity: {
    evidenceSha: await shaFile(join(projDir, "evidence", "evidence.jsonl")),
    evidenceUntouched: await shaFile(join(projDir, "evidence", "evidence.jsonl")) === beforeFacts.evidenceSha,
    gateR16Sha: await shaFile(join(projDir, "reviews", "quality-gate-r16.json")),
    gateR16Untouched: await shaFile(join(projDir, "reviews", "quality-gate-r16.json")) === beforeFacts.gateR16Sha,
    draftRev14Untouched: await shaFile(join(projDir, "artifacts", "art-draft-rev14.pdf")) === beforeFacts.drafts["art-draft-rev14.pdf"],
    manuscriptSectionsTouched: false, // 升级不改稿——写作层留给后续 run
  },
  availabilityAfter,
  ledger: budgetLedger.snapshot(),
};
// anchors 真实性抽验：目标条目每个 chunkId 可回取且属主正确
// （注意：chunkAccess 在 stack 顶层而非 workflowServices——错误引用会把
// 全部锚点误计为解析失败）
let anchorIssues = 0;
for (const entry of matrix.entries.filter((e) => target.has(e.sourceId))) {
  for (const anchor of entry.anchors ?? []) {
    for (const chunkId of anchor.chunkIds ?? []) {
      try {
        const resolved = await stack.chunkAccess.resolve(projectId, chunkId);
        if (resolved.chunk.sourceId !== entry.sourceId) { anchorIssues += 1; }
      } catch {
        anchorIssues += 1;
      }
    }
  }
}
verify.anchorResolutionIssues = anchorIssues;
await writeReport("upgrade-verify", verify);
console.log(`[m1585] verify: snapshot rev=${verify.snapshot.revision} fulltextBasis=${verify.snapshot.counts.fulltextBasis}/${verify.snapshot.counts.total}; synthesis matches matrix=${verify.synthesis.matchesMatrix}; anchorIssues=${anchorIssues}; evidenceUntouched=${verify.integrity.evidenceUntouched}`);
process.exit(0);
