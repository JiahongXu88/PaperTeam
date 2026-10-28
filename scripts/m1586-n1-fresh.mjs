#!/usr/bin/env node
/**
 * M15.8.6 Phase D — N1 fresh 变异特异检出（真实 fresh Reviewer；≤20 模型调用独立账本）。
 *
 * 与 M15.8 的 m158-n-negative-e2e.mjs zero-model 模式区别：本轮预登记明确禁止以
 * 零模型 replay 锚冒充 fresh 实证。本脚本在隔离副本上注入确定性数值矛盾后，
 * 走真实 orchestrator run —— review.run 由真实 Reviewer 新鲜执行，quality.gate
 * 消费新 review；断言注入缺陷被特异性检出（fact_preservation 授权账 + fresh
 * reviewer finding 指向注入数值）且 Gate FAIL、Finalize 拒绝。
 *
 * 用法：node scripts/m1586-n1-fresh.mjs [--dry-run]
 * env：M1586_N1_ROOT（隔离根，缺省 M15_8_6\phase-d\n1）
 *      M1586_N1_LEDGER（缺省 M15_8_6\budget\n1-20.json，上限 20）
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const P_SOURCE_ROOT = "D:\\PaperTeamData\\M15\\M15_8\\projects-root";
const SOURCE_PROJECT = "p-6f05e6980fda";
const N1_ROOT = process.env["M1586_N1_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8\\M15_8_6\\phase-d\\n1";
const PROJECTS_ROOT = join(N1_ROOT, "projects-root");
const LEDGER_PATH = process.env["M1586_N1_LEDGER"] ?? "D:\\PaperTeamData\\M15\\M15_8\\M15_8_6\\budget\\n1-20.json";
const MAX_CALLS = Number(process.env["M1586_N1_MAX_CALLS"] ?? "20");
const OUT_DIR = join(N1_ROOT);
const dryRun = process.argv.includes("--dry-run");

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER_PATH;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(MAX_CALLS);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "1";

await mkdir(OUT_DIR, { recursive: true });
const REPORT_PATH = join(OUT_DIR, "n1-fresh-report.json");
const MUTATION_PATH = join(OUT_DIR, "n1-fresh-mutation.json");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const log = async (line) => { await writeFile(join(OUT_DIR, "n1-fresh-driver-log.txt"), `[${new Date().toISOString()}] ${line}\n`, { flag: "a" }); };
const writeJsonAtomic = async (path, value) => {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
};

// ---- N1 变异引擎（与 m158-n-negative-e2e.mjs 同句族：真实已发表值 + 结论侧翻一位） ----
const N1_BODY_SENTENCE = "从公开基准报告看，MOT17 测试集上代表性跟踪器的 HOTA 大致为：ByteTrack 0.801、OC-SORT 0.775、StrongSORT 0.768。";
const N1_CONCLUSION_SENTENCE_FLIPPED = "综合来看，MOT17 测试集上代表性跟踪器的 HOTA 大致为：ByteTrack 0.877、OC-SORT 0.775、StrongSORT 0.768。";

async function mutateN1(projectDir) {
  const sectionsDir = join(projectDir, "manuscript", "sections");
  const files = (await readdir(sectionsDir)).filter((f) => f.endsWith(".tex")).sort();
  if (files.length < 2) return { ok: false, reason: "need >=2 sections" };
  // 明确定位：正文侧 = 指标演进/可靠性类中段节；结论侧 = conclusion.tex（排序无关）
  const conclusionFile = files.includes("conclusion.tex") ? "conclusion.tex" : files[files.length - 1];
  const bodyFile = files.includes("metric-evolution.tex")
    ? "metric-evolution.tex"
    : files[Math.floor(files.length / 2) - 1];
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
    ok: true, kind: "n1-fresh-numeric-contradiction",
    bodyFile: `manuscript/sections/${bodyFile}`,
    conclusionFile: `manuscript/sections/${conclusionFile}`,
    bodySentence: N1_BODY_SENTENCE, conclusionSentence: N1_CONCLUSION_SENTENCE_FLIPPED,
    flippedValue: "0.801 → 0.877",
    bodyBeforeSha256: sha256(bodyBefore), bodyAfterSha256: sha256(bodyAfter),
    conclusionBeforeSha256: sha256(conclBefore), conclusionAfterSha256: sha256(conclAfter),
  };
}

// ---- 副本 + 变异（dry-run：双跑确定性自检后退出） ----
const projectDir = join(PROJECTS_ROOT, SOURCE_PROJECT);
await rm(projectDir, { recursive: true, force: true });
await cp(join(P_SOURCE_ROOT, SOURCE_PROJECT), projectDir, { recursive: true });
const mutation = await mutateN1(projectDir);
if (!mutation.ok) throw new Error(`变异失败：${mutation.reason}`);
if (dryRun) {
  await rm(projectDir, { recursive: true, force: true });
  await cp(join(P_SOURCE_ROOT, SOURCE_PROJECT), projectDir, { recursive: true });
  const second = await mutateN1(projectDir);
  const deterministic = JSON.stringify(mutation) === JSON.stringify(second);
  console.log(`[dry-run] mutation ok=${mutation.ok} deterministic=${deterministic} body=${mutation.bodyFile} concl=${mutation.conclusionFile}`);
  process.exit(mutation.ok && deterministic ? 0 : 3);
}
await writeJsonAtomic(MUTATION_PATH, { schema: "m1586-n1-fresh/v1", sourceProject: SOURCE_PROJECT, mode: "fresh", ...mutation });
await log(`副本+变异就绪：${mutation.kind}（${mutation.flippedValue}）`);

// ---- 装配 ----
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
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: () => {},
});
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8.6 N1 fresh",
});
let physicalCalls = 0;
let stackRef;
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir, workspaceRoot: PROJECTS_ROOT, runTimeoutMs: config.pi.runTimeoutMs,
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
  if (result.status !== "completed") await log(`runAgent #${physicalCalls} → ${result.status}`);
  return result;
};
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const stack = buildServiceStack({
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
  projects, runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => kind === "topic_survey" ? createTopicSurveyDefinition(stack.workflowServices) : (() => { throw new Error(`只装配 topic_survey（${kind}）`); })(),
  log: () => {},
});
const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (method, path, body) => {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
};

// ---- 执行 ----
// 1) 变异以作者编辑形态入修订账（fact_preservation 授权账的确定性检出腿）
const commit = await stack.revisions.commit(SOURCE_PROJECT, "author-edit", null);
await log(`author-edit 修订 rev-${commit.revision}（created=${commit.created}）`);
// 2) 孤儿清理 + 真实 run（front HITL approve；revision HITL 不批准——停在那里）
const orphans = await request("GET", `/runs?projectId=${SOURCE_PROJECT}`);
for (const orphan of orphans.body["runs"] ?? []) {
  if (["running", "pending", "awaiting_input"].includes(orphan.status)) {
    await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
  }
}
const started = await request("POST", `/projects/${SOURCE_PROJECT}/workflows`, { kind: "topic_survey" });
if (started.status !== 202) throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
const runId = started.body.runId;
await log(`run 启动 ${runId}（WORKFLOW_MAX_REVISION_ROUNDS=1；front approve / revision 停）`);

const runStartedAt = Date.now();
let run; let stoppedAt = null;
for (;;) {
  const { body } = await request("GET", `/runs/${runId}`);
  run = body.run;
  if (run === undefined) throw new Error(`run 查询失败：${JSON.stringify(body).slice(0, 200)}`);
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId ?? "";
    if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
      stoppedAt = { stageId, payload: run.awaiting?.payload ?? {} };
      break; // 不批准：留给断言取证后 cancel
    }
    await log(`[hitl-front] ${stageId} → approve（物理 ${physicalCalls}/${MAX_CALLS}）`);
    await request("POST", `/runs/${runId}/resume`, { decision: "approve" });
    continue;
  }
  if (Date.now() - runStartedAt > 60 * 60 * 1000) throw new Error(`run 超时（${run.status} / ${run.currentStage}）`);
  if (physicalCalls > MAX_CALLS) throw new Error("budget hard stop");
  await new Promise((r) => setTimeout(r, 5_000));
}
await log(`run 停止：status=${run.status}${stoppedAt ? ` @${stoppedAt.stageId}` : ""}（物理 ${physicalCalls}/${MAX_CALLS}）`);

// 3) 取最新 gate / review 产物
const reviewsDir = join(projectDir, "reviews");
const gateFiles = (await readdir(reviewsDir))
  .filter((f) => /^quality-gate-r\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/r(\d+)/)[1]) - Number(b.match(/r(\d+)/)[1])); // 数值序：r28 > r9（字典序会误取旧轮）
const lastGatePath = gateFiles[gateFiles.length - 1];
const lastGate = lastGatePath ? JSON.parse(await readFile(join(reviewsDir, lastGatePath), "utf8")) : null;
const gateRound = lastGatePath ? Number(lastGatePath.match(/r(\d+)/)[1]) : 0;
const failedRules = ((lastGate?.gate?.rules) ?? []).filter((r) => r.status === "FAIL" || (r.status === "NOT_EVALUATED" && r.required))
  .map((r) => ({ rule: r.rule, status: r.status, detail: String(r.detail).slice(0, 300) }));
// fresh reviewer 特异检出证据：在 fact/academic review + claim 产物中找注入数值
const reviewFiles = (await readdir(reviewsDir)).filter((f) => new RegExp(`^review-r${gateRound}-(fact|academic)\\.json$`).test(f));
let reviewerHit = null;
for (const f of reviewFiles) {
  const raw = await readFile(join(reviewsDir, f), "utf8");
  if (/0\.801|0\.877|ByteTrack|OC-SORT|StrongSORT/.test(raw)) {
    const parsed = JSON.parse(raw);
    const s = JSON.stringify(parsed);
    const idx = s.search(/0\.877|0\.801/);
    reviewerHit = { file: f, context: idx >= 0 ? s.slice(Math.max(0, idx - 220), idx + 220) : "(values in file)" };
    break;
  }
}
// claim-grounding：注入数值 claim 应为 UNSUPPORTED
const cgPath = join(reviewsDir, `claim-grounding-r${gateRound}.json`);
let injectedClaimVerdict = null;
if (existsSync(cgPath)) {
  const cg = JSON.parse(await readFile(cgPath, "utf8"));
  const hit = (cg.claims ?? []).find((c) => /0\.801|0\.877|ByteTrack/.test(JSON.stringify(c)));
  if (hit) injectedClaimVerdict = { claimId: hit.claimId, verdict: hit.verdict, disclosure: hit.disclosure, claim: (hit.claim ?? "").slice(0, 200) };
}

// 4) Draft 构建可用性（产品入口；gate FAIL 时 build 仍应产出 draft——Build/Quality 分离）
const buildRes = await request("POST", `/projects/${SOURCE_PROJECT}/build`, { kind: "draft" }).catch((e) => ({ thrown: e.message }));
const buildOutcome = buildRes.thrown !== undefined ? { thrown: buildRes.thrown } : { status: buildRes.status, body: JSON.stringify(buildRes.body).slice(0, 300) };

// 5) Finalize 必须拒绝
const finalizeRes = await request("POST", `/projects/${SOURCE_PROJECT}/finalize`).catch((e) => ({ thrown: e.message }));
const finalizeOutcome = finalizeRes.thrown !== undefined ? { thrown: finalizeRes.thrown } : { status: finalizeRes.status, body: JSON.stringify(finalizeRes.body).slice(0, 300) };

// 6) 清理：cancel 待决 run
if (stoppedAt !== null) await request("POST", `/runs/${runId}/cancel`).catch(() => {});

const report = {
  schema: "m1586-n1-fresh/v1",
  mode: "fresh",
  sourceProject: SOURCE_PROJECT, projectId: SOURCE_PROJECT, runId,
  mutatedRevision: commit.revision,
  mutation,
  stoppedAtHitl: stoppedAt?.stageId ?? null,
  runFinalStatus: run.status,
  gateRound, gatePassed: lastGate?.gate?.passed ?? null,
  gateFailedRules: failedRules,
  reviewerSpecificHit: reviewerHit,
  injectedClaimGrounding: injectedClaimVerdict,
  buildAttempt: buildOutcome,
  finalizeAttempt: finalizeOutcome,
  physicalModelCalls: physicalCalls,
  budget: budgetLedger.snapshot(),
};
report.assertions = {
  gateFailed: report.gatePassed === false,
  finalizeRefused: finalizeOutcome.status !== 200 || finalizeOutcome.thrown !== undefined,
  deterministicDetection: failedRules.some((r) => /fact_preservation|unsupported_critical/.test(r.rule) || r.rule.includes("fact")),
  freshReviewerSpecificDetection: reviewerHit !== null || injectedClaimVerdict !== null,
};
await writeJsonAtomic(REPORT_PATH, report);
await log(`报告落盘 ${REPORT_PATH}；断言 ${JSON.stringify(report.assertions)}`);
console.log(`DONE n1-fresh: gatePassed=${report.gatePassed} finalizeRefused=${report.assertions.finalizeRefused} deterministic=${report.assertions.deterministicDetection} reviewerSpecific=${report.assertions.freshReviewerSpecificDetection} calls=${physicalCalls}/${MAX_CALLS}`);
server.close();
await researchNet.router.close().catch(() => {});
process.exit(report.assertions.gateFailed && report.assertions.finalizeRefused && report.assertions.deterministicDetection && report.assertions.freshReviewerSpecificDetection ? 0 : 5);
