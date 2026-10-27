#!/usr/bin/env node
/**
 * M15.8 阶段 E — N 场景：真实负例（同族隔离破坏）E2E 驱动。
 *
 * 语义（预登记 §3.N）：
 *  - 基底 = P 冻结通过后的项目（逐字节副本到隔离 PROJECTS_ROOT）；
 *  - N1（CE1 型）：摘要/结论侧数值 ↔ 表格唯一绑定值确定性矛盾（同量纲同指标）；
 *  - N2（CE2 型）：references.bib 重命名一个被引 key（正文 \cite 不动）；
 *  - 执行：真实 orchestrator run（topic_survey，front 幂等复用，尾部因改稿
 *    新鲜度强制重走 citation.verify → review.run → quality.gate）；
 *  - 断言：gate FAIL、Finalize 拒绝、阻断规则指向注入缺陷；逐字节变异 manifest
 *    （before/after sha256 + 精确 offset）。
 *
 * 用法：node scripts/m158-n-negative-e2e.mjs --case n1|n2 [--dry-run]
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
const N_ROOT = join(DATA_ROOT, "projects-root-negative");
const SESSION_MAX_CALLS = Number(process.env["M158_SESSION_MAX_CALLS_N"] ?? "14");

const args = process.argv.slice(2);
const caseId = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const dryRun = args.includes("--dry-run");
if (caseId !== "n1" && caseId !== "n2") {
  console.error("用法：--case n1|n2 [--dry-run]");
  process.exit(2);
}

const pReportPath = join(EVAL_DIR, "m158-p-report.json");
if (!existsSync(pReportPath)) {
  console.error(`[refuse] P 报告不存在 ${pReportPath}（先完成 P）`);
  process.exit(2);
}
const pReport = JSON.parse(await readFile(pReportPath, "utf8"));
const SOURCE_PROJECT = pReport.projectId;
// M15.8 实况：P 终态 PENDING_BUDGET（gate r6 FAIL unsupported 2 + major 2）。
// N 仍可执行：注入缺陷必须在「同族真实项目 + 生产双入口 + 真实 citation.verify +
// 真实修订存储 + FinalizeService」上被正确阻断——基线既有失败如实入账（判定看
// 注入缺陷指向的规则是否触发，而非基线清零）。模式：--model 零模型（预算耗尽后
// 的合法执行形态；reviewer 检出腿由 M15.7 mutated r2 在盘锚承担）。
const N_MODE = process.env["M158_N_MODE"] ?? "zero-model";

process.env["PROJECTS_ROOT"] = N_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, `budget-ledger-${caseId}.json`);
// zero-model：账本硬顶 1 = 绊线（任何模型调用即拒）；citation.verify 的 scholarly HTTP 不计
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

await mkdir(N_ROOT, { recursive: true });
const DRIVER_LOG = join(EVAL_DIR, `m158-${caseId}-driver-log.txt`);
const REPORT_PATH = join(EVAL_DIR, `m158-${caseId}-report.json`);
const MUTATION_PATH = join(EVAL_DIR, `m158-${caseId}-mutation.json`);

async function appendDriverLog(line) {
  await writeFile(DRIVER_LOG, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
}
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

// ---- 变异引擎（确定性；双向 sha256 manifest）----

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** N1（CE1 型，M15.5 方法论）：注入「正文 ↔ 结论」同指标数值对——真实已发表值
 *  （ByteTrack/OC-SORT/StrongSORT MOT17 HOTA 0.801/0.775/0.768，TrackEval 公开
 *  报告值），结论侧翻一位（0.801→0.877）→ 稿内数值矛盾。两次插入 + 翻转全部
 *  进 manifest；确定性 fact_preservation 检出（未经 RevisionPlan 授权的实验事实
 *  变更），数值矛盾语义由 C 族 45 run 重放锚（REMAIN_BLOCKED）+ M15.7 mutated
 *  r2（在盘，reviewer 真实检出）覆盖。 */
const N1_BODY_SENTENCE = "从公开基准报告看，MOT17 测试集上代表性跟踪器的 HOTA 大致为：ByteTrack 0.801、OC-SORT 0.775、StrongSORT 0.768。";
const N1_CONCLUSION_SENTENCE_FLIPPED = "综合来看，MOT17 测试集上代表性跟踪器的 HOTA 大致为：ByteTrack 0.877、OC-SORT 0.775、StrongSORT 0.768。";
async function mutateN1(projectDir) {
  const msDir = join(projectDir, "manuscript");
  const sectionsDir = join(msDir, "sections");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(sectionsDir)).filter((f) => f.endsWith(".tex")).sort();
  if (files.length < 2) return { ok: false, reason: "need >=2 sections" };
  const bodyFile = files[Math.floor(files.length / 2) - 1];
  const conclusionFile = files[files.length - 1];
  const bodyPath = join(sectionsDir, bodyFile);
  const conclPath = join(sectionsDir, conclusionFile);
  const bodyBefore = await readFile(bodyPath, "utf8");
  const conclBefore = await readFile(conclPath, "utf8");
  if (bodyBefore.includes("0.801") || conclBefore.includes("0.801")) return { ok: false, reason: "anchor values already present" };
  const bodyAfter = `${bodyBefore}\n\n${N1_BODY_SENTENCE}\n`;
  const conclAfter = `${conclBefore}\n\n${N1_CONCLUSION_SENTENCE_FLIPPED}\n`;
  await writeFile(bodyPath, bodyAfter, "utf8");
  await writeFile(conclPath, conclAfter, "utf8");
  return {
    ok: true,
    kind: "n1-numeric-contradiction-injection",
    bodyFile: `manuscript/sections/${bodyFile}`,
    conclusionFile: `manuscript/sections/${conclusionFile}`,
    bodySentence: N1_BODY_SENTENCE,
    conclusionSentence: N1_CONCLUSION_SENTENCE_FLIPPED,
    flippedValue: "0.801 → 0.877",
    bodyBeforeSha256: sha256(bodyBefore),
    bodyAfterSha256: sha256(bodyAfter),
    conclusionBeforeSha256: sha256(conclBefore),
    conclusionAfterSha256: sha256(conclAfter),
  };
}

/** N2：references.bib 重命名第一个被正文 \cite 的 key。 */
async function mutateN2(projectDir) {
  const msDir = join(projectDir, "manuscript");
  const { readdir } = await import("node:fs/promises");
  const bibPath = join(msDir, "references.bib");
  const sectionsDir = join(msDir, "sections");
  if (!existsSync(bibPath)) return { ok: false, reason: "references.bib missing" };
  const bib = await readFile(bibPath, "utf8");
  const cited = new Set();
  for (const f of (await readdir(sectionsDir)).filter((x) => x.endsWith(".tex"))) {
    const raw = await readFile(join(sectionsDir, f), "utf8");
    for (const m of raw.matchAll(/\\cite[tp]?\{([^}]*)\}/g)) {
      for (const key of m[1].split(",")) cited.add(key.trim());
    }
  }
  const entries = [...bib.matchAll(/@\w+\{([^,\s]+),/g)].map((m) => ({ key: m[1], index: m.index }));
  const target = entries.find((e) => cited.has(e.key));
  if (target === undefined) return { ok: false, reason: "no cited bib entry found" };
  const mutatedKey = `${target.key}x`;
  const after = bib.slice(0, target.index) + bib.slice(target.index).replace(`{${target.key},`, `{${mutatedKey},`, 1);
  if (after === bib) return { ok: false, reason: "bib mutation no-op" };
  await writeFile(bibPath, after, "utf8");
  return {
    ok: true,
    kind: "n2-citation-key-corruption",
    file: "manuscript/references.bib",
    originalKey: target.key,
    mutatedKey,
    offset: target.index,
    beforeSha256: sha256(bib),
    afterSha256: sha256(after),
  };
}

// ---- dry-run：只执行变异引擎自检（对临时副本），不装配服务 ----
if (dryRun) {
  const tmpDir = join(N_ROOT, "_dry");
  await cp(join(P_ROOT, SOURCE_PROJECT), tmpDir, { recursive: true, force: true });
  const result = caseId === "n1" ? await mutateN1(tmpDir) : await mutateN2(tmpDir);
  const cp2 = join(N_ROOT, "_dry2");
  await cp(join(P_ROOT, SOURCE_PROJECT), cp2, { recursive: true, force: true });
  const result2 = caseId === "n1" ? await mutateN1(cp2) : await mutateN2(cp2);
  const deterministic = JSON.stringify(result) === JSON.stringify(result2);
  console.log(`[dry-run] ${caseId} mutation ok=${result.ok} deterministic=${deterministic} detail=${JSON.stringify(result).slice(0, 220)}`);
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
  await rm(cp2, { recursive: true, force: true });
  process.exit(result.ok && deterministic ? 0 : 3);
}

// ---- 装配（同 P；topic_survey）----

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const { createTopicSurveyDefinition } = await import(distUrl("workflow", "definitions.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));



const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));
const config = loadConfig();
// M15.8.1：Research 代理装配（与生产 index.ts 同一 helper；env > network.json > 直连）
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: (m) => console.log(m),
});
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: `M15.8 ${caseId}`,
});
let physicalCalls = 0;
let stackRef;
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: N_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: (role, pid) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(...createScholarlyTools(stackRef.citationIntegrity.scholarlyResolver, stackRef.discovery, role === "researcher" ? pid : undefined));
    }
    if (stackRef !== undefined && pid !== undefined && (role === "researcher" || role === "writer" || role === "reviewer")) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, pid));
    }
    if (stackRef !== undefined && pid !== undefined) {
      tools.push(...evidenceToolsForRole(role, { chunkAccess: stackRef.chunkAccess, grounding: stackRef.evidenceGrounding, evidence: stackRef.evidence }, pid));
    }
    return tools;
  },
  log: () => {},
});
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const result = await originalRunAgent(...callArgs);
  if (result.status !== "completed") await appendDriverLog(`runAgent #${physicalCalls} → ${result.status}`);
  return result;
};
const projects = new ProjectStore({ root: N_ROOT });
const stack = buildServiceStack({
  // M15.8.1：学术出口统一经 ResearchFetchRouter（防直连漏线复发）
  researchFetch: researchNet.router.fetch,
  runtime: adapter, projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents, stageTimeoutMs: config.stageTimeoutMs, stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: (m) => console.log(m),
});
stackRef = stack;
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") throw new Error(`本脚本只装配 topic_survey（收到 ${kind}）`);
    return createTopicSurveyDefinition(stack.workflowServices);
  },
  log: () => {},
});
const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
}

// ---- 执行（zero-model：生产服务 + 双入口，0 模型调用；账本硬顶 1 为绊线）----

const projectDir = join(N_ROOT, SOURCE_PROJECT);
// 隔离副本必须从 P 冻结源全新复制（上一 case 的修订账残留会触发 REVISION_RECOVERY_REQUIRED）
const { rm } = await import("node:fs/promises");
await rm(projectDir, { recursive: true, force: true });
await cp(join(P_ROOT, SOURCE_PROJECT), projectDir, { recursive: true });
await appendDriverLog(`副本就绪 ${SOURCE_PROJECT}（隔离 root ${N_ROOT}）`);
const mutation = caseId === "n1" ? await mutateN1(projectDir) : await mutateN2(projectDir);
if (!mutation.ok) throw new Error(`变异失败：${mutation.reason}`);
await writeJsonAtomic(MUTATION_PATH, { schema: "m158-mutation/v1", caseId, sourceProject: SOURCE_PROJECT, mode: N_MODE, ...mutation });
const mutationDigest = mutation.beforeSha256 !== undefined
  ? { beforeSha256: mutation.beforeSha256.slice(0, 12), afterSha256: mutation.afterSha256.slice(0, 12) }
  : { bodyBeforeSha256: mutation.bodyBeforeSha256.slice(0, 12), conclusionAfterSha256: mutation.conclusionAfterSha256.slice(0, 12) };
await appendDriverLog(`变异落盘 ${mutation.kind}：${JSON.stringify({ kind: mutation.kind, ...mutationDigest })}`);

// 孤儿 run 清理（finalize 互斥）
const orphans = await request("GET", `/runs?projectId=${SOURCE_PROJECT}`);
for (const orphan of orphans.body["runs"] ?? []) {
  if (["running", "pending", "awaiting_input"].includes(orphan.status)) {
    await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
  }
}

// 1) 变异以作者编辑形态入修订账（产品自身 RevisionStore；快照级审计）
const commit = await stack.revisions.commit(SOURCE_PROJECT, "author-edit", null);
await appendDriverLog(`修订提交 rev-${commit.revision}（created=${commit.created}）`);

// 2) 真实 citation.verify（确定性，0 LLM；scholarly 元数据 HTTP）
const citationReport = await stack.citation.verify(SOURCE_PROJECT);
await appendDriverLog(`citation.verify：${JSON.stringify(citationReport.summary)}`);

// 3) 生产双入口 gate 重评（consume 新 citation 报告 + 修订快照 + r6 review summary）
const gateRes = await request("POST", `/projects/${SOURCE_PROJECT}/quality-gate`);
if (gateRes.status !== 200) throw new Error(`quality-gate 重评失败：${gateRes.status} ${JSON.stringify(gateRes.body).slice(0, 300)}`);
const gate = gateRes.body.gate ?? gateRes.body;
await appendDriverLog(`gate 重评 passed=${gate.passed}`);

// 4) Finalize 必须拒绝
const finalizeRes = await request("POST", `/projects/${SOURCE_PROJECT}/finalize`).catch((e) => ({ thrown: e.message }));
const finalizeRejected = finalizeRes.thrown !== undefined ? { thrown: finalizeRes.thrown } : { status: finalizeRes.status, body: finalizeRes.body };

// ---- 断言 ----
const fs = await import("node:fs/promises");
const gateFiles = (await fs.readdir(join(projectDir, "reviews"))).filter((f) => /^quality-gate-r\d+\.json$/.test(f)).sort();
const lastGate = gateFiles.length > 0 ? JSON.parse(await readFile(join(projectDir, "reviews", gateFiles[gateFiles.length - 1]), "utf8")) : null;
const failedRules = (gate.rules ?? lastGate?.gate?.rules ?? []).filter((r) => r.status === "FAIL" || (r.status === "NOT_EVALUATED" && r.required)).map((r) => ({ rule: r.rule, status: r.status, detail: String(r.detail).slice(0, 300) }));
const report = {
  schema: `m158-${caseId}-report/v2`,
  caseId,
  mode: N_MODE,
  sourceProject: SOURCE_PROJECT,
  projectId: SOURCE_PROJECT,
  mutatedRevision: commit.revision,
  physicalModelCalls: physicalCalls,
  budget: budgetLedger.snapshot(),
  mutation,
  gateRound: gateFiles.length > 0 ? Number(gateFiles[gateFiles.length - 1].match(/r(\d+)/)?.[1] ?? 0) : 0,
  gatePassed: gate.passed ?? null,
  gateFailedRules: failedRules,
  citationSummary: citationReport.summary,
  finalizeAttempt: finalizeRejected,
};
report.assertions = {
  gateFailed: report.gatePassed === false,
  finalizeRefused: finalizeRejected.status !== 200 || finalizeRejected.thrown !== undefined,
  mutationTargetsRule: caseId === "n2"
    ? (failedRules.some((r) => r.rule === "citation_structure_valid" && /missing=[1-9]/.test(r.detail)) || (citationReport.summary?.missingKeys ?? 0) >= 1)
    : failedRules.some((r) => r.rule === "fact_preservation" || r.rule === "unsupported_critical_claims_zero" || r.rule.includes("fact")),
  zeroModel: physicalCalls === 0,
};
await writeJsonAtomic(REPORT_PATH, report);
await appendDriverLog(`报告落盘 ${REPORT_PATH}；断言 ${JSON.stringify(report.assertions)}`);
console.log(`DONE ${caseId}: gatePassed=${report.gatePassed} finalizeRefused=${report.assertions.finalizeRefused} targeted=${report.assertions.mutationTargetsRule} zeroModel=${report.assertions.zeroModel}`);
server.close();
process.exit(report.assertions.gateFailed && report.assertions.finalizeRefused && report.assertions.mutationTargetsRule ? 0 : 5);
