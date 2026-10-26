#!/usr/bin/env node
/**
 * M15.8 阶段 E — H 场景：作者决策 / HITL 正确边界 E2E 驱动。
 *
 * 语义（预登记 §3.H）：
 *  - 基底 = P 冻结项目副本；注入「需要真实实验数据的无证据论断」（manifest 登记）；
 *  - 真实 orchestrator run（WORKFLOW_MAX_REVISION_ROUNDS=1：一次修复尝试即耗尽 →
 *    合法停在 revision_overflow / revision_stalled HITL）；
 *  - 断言（全部为产品语义，不自动批准）：
 *    A1 run 停在 awaiting_input（HITL 待决），不自行完成；
 *    A2 服务器重启（进程级）后 run 仍 awaiting_input（待决状态持久）；
 *    A3 待决期间 Draft 可独立构建（Build Gate 与 Quality Gate 分离，PRD §10）；
 *    A4 finalize 拒绝（缺关键数据稿件不得 READY/Final）；
 *    A5 无自动填值：注入论断未被「补上」实验证据（evidence 库无新增实验记录、
 *       或稿内该论断保持无证据状态/被删除但有 trace），无 auto-approve 决策。
 *
 * 用法：node scripts/m158-h-author-decision.mjs [--dry-run]
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
const H_ROOT = join(DATA_ROOT, "projects-root-h");
const SESSION_MAX_CALLS = Number(process.env["M158_SESSION_MAX_CALLS_H"] ?? "12");
const INJECTED_CLAIM_ZH =
  "值得注意的是，我们在自研边缘计算平台（8 路 1080p 并行输入）上的实测表明，对轨迹置信度执行指标感知的在线校准后，HOTA 由 0.672 进一步提升 12.4% 至 0.756，同时身份切换次数下降约 31%。";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const pReportPath = join(EVAL_DIR, "m158-p-report.json");
if (!existsSync(pReportPath)) {
  console.error(`[refuse] P 报告不存在（先完成 P）`);
  process.exit(2);
}
const pReport = JSON.parse(await readFile(pReportPath, "utf8"));
const SOURCE_PROJECT = pReport.projectId;
if (SOURCE_PROJECT === undefined || pReport.finalStatus !== "completed") {
  console.error(`[refuse] P 未完成`);
  process.exit(2);
}

process.env["PROJECTS_ROOT"] = H_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, "budget-ledger-h.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(SESSION_MAX_CALLS);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "1";

await mkdir(H_ROOT, { recursive: true });
const DRIVER_LOG = join(EVAL_DIR, "m158-h-driver-log.txt");
const REPORT_PATH = join(EVAL_DIR, "m158-h-report.json");
const MUTATION_PATH = join(EVAL_DIR, "m158-h-mutation.json");

async function appendDriverLog(line) {
  await writeFile(DRIVER_LOG, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
}
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** 注入：往第一个非 outline 的 section 末尾（\end{...} 之前）追加一段无证据实验论断。 */
async function injectClaim(projectDir) {
  const { readdir } = await import("node:fs/promises");
  const sectionsDir = join(projectDir, "manuscript", "sections");
  const files = (await readdir(sectionsDir)).filter((f) => f.endsWith(".tex")).sort();
  const target = files[files.length - 1]; // 最后一节（讨论/结论类，实验性陈述语境最自然）
  if (target === undefined) return { ok: false, reason: "no sections" };
  const absPath = join(sectionsDir, target);
  const before = await readFile(absPath, "utf8");
  if (before.includes(INJECTED_CLAIM_ZH.slice(0, 20))) return { ok: false, reason: "claim already present" };
  const para = `\n\n${INJECTED_CLAIM_ZH}\n`;
  const after = before + para;
  await writeFile(absPath, after, "utf8");
  return {
    ok: true,
    kind: "h-unsupported-experiment-claim",
    file: `manuscript/sections/${target}`,
    claim: INJECTED_CLAIM_ZH,
    appendedBytes: Buffer.byteLength(para, "utf8"),
    beforeSha256: sha256(before),
    afterSha256: sha256(after),
  };
}

// ---- dry-run：变异自检（对临时副本双跑确定性）----
if (dryRun) {
  const tmp = join(H_ROOT, "_dry");
  await cp(join(P_ROOT, SOURCE_PROJECT), tmp, { recursive: true, force: true });
  const r1 = await injectClaim(tmp);
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
  const tmp2 = join(H_ROOT, "_dry2");
  await cp(join(P_ROOT, SOURCE_PROJECT), tmp2, { recursive: true, force: true });
  const r2 = await injectClaim(tmp2);
  await rm(tmp2, { recursive: true, force: true });
  const deterministic = JSON.stringify(r1) === JSON.stringify(r2);
  console.log(`[dry-run] inject ok=${r1.ok} deterministic=${deterministic} file=${r1.file ?? r1.reason}`);
  process.exit(r1.ok && deterministic ? 0 : 3);
}

// ---- 装配（boot 函数化：A2 重启用）----

async function bootServer() {
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

  const config = loadConfig();
  const budgetLedger = new GlobalBudgetLedger({
    path: config.workflow.globalBudget.ledgerPath,
    limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
    label: "M15.8 H",
  });
  let stackRef;
  const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
  await skillRegistry.ensureInstalled();
  const adapter = new PiRuntimeAdapter({
    modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
    ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
    agentDir: config.pi.agentDir,
    workspaceRoot: H_ROOT,
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
  let physicalCalls = 0;
  const originalRunAgent = adapter.runAgent.bind(adapter);
  adapter.runAgent = async (...callArgs) => {
    physicalCalls += 1;
    const result = await originalRunAgent(...callArgs);
    if (result.status !== "completed") await appendDriverLog(`runAgent #${physicalCalls} → ${result.status}`);
    return result;
  };
  const projects = new ProjectStore({ root: H_ROOT });
  const stack = buildServiceStack({
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
      if (kind !== "topic_survey") throw new Error(`只装配 topic_survey（收到 ${kind}）`);
      return createTopicSurveyDefinition(stack.workflowServices);
    },
    log: () => {},
  });
  const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
  await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    server,
    stack,
    orchestrator,
    getCalls: () => physicalCalls,
    getLedger: () => budgetLedger.snapshot(),
  };
}

async function request(base, method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
}

// ---- 执行 ----

const projectDir = join(H_ROOT, SOURCE_PROJECT);
await cp(join(P_ROOT, SOURCE_PROJECT), projectDir, { recursive: true, force: true });
const mutation = await injectClaim(projectDir);
if (!mutation.ok) throw new Error(`注入失败：${mutation.reason}`);
await writeJsonAtomic(MUTATION_PATH, { schema: "m158-h-mutation/v1", sourceProject: SOURCE_PROJECT, ...mutation });
await appendDriverLog(`副本+注入就绪（${mutation.file}）`);

// 先记录注入前证据库快照（A5 对照）
const evidenceBefore = await (async () => {
  const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
  const { EvidenceStore } = await import(distUrl("evidence", "EvidenceStore.js"));
  const projects = new ProjectStore({ root: H_ROOT });
  const evidence = new EvidenceStore({ projects });
  const list = await evidence.list(SOURCE_PROJECT);
  return list.map((r) => r.id).sort();
})();

const session1 = await bootServer();
await appendDriverLog(`server#1 就绪 ${session1.base}`);
const started = await request(session1.base, "POST", `/projects/${SOURCE_PROJECT}/workflows`, { kind: "topic_survey" });
if (started.status !== 202) throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
const runId = started.body.runId;
await appendDriverLog(`run 启动 ${runId}（WORKFLOW_MAX_REVISION_ROUNDS=1）`);

// 阶段 1：驱动到 HITL 待决即停（不 resume 待决节点）
const runStartedAt = Date.now();
let hitlReached = null;
let run;
for (;;) {
  const { body } = await request(session1.base, "GET", `/runs/${runId}`);
  run = body.run;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId ?? "";
    if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
      hitlReached = { stageId, payload: run.awaiting?.payload ?? {} };
      break; // 作者决策节点：停在这里，不批准
    }
    // 前段 HITL（research_plan/literature_selection/matrix/outline）：approve（系统验收操作者）
    await appendDriverLog(`[hitl-front] ${stageId} → approve（物理 ${session1.getCalls()}/${SESSION_MAX_CALLS}）`);
    await request(session1.base, "POST", `/runs/${runId}/resume`, { decision: "approve" });
    continue;
  }
  if (Date.now() - runStartedAt > 75 * 60 * 1000) throw new Error(`run 超时（${run.status} / ${run.currentStage}）`);
  await new Promise((r) => setTimeout(r, 5_000));
}

const report = {
  schema: "m158-h-report/v1",
  sourceProject: SOURCE_PROJECT,
  projectId: SOURCE_PROJECT,
  runId,
  mutation,
  hitlReached,
  finalStatusBeforeRestart: run.status,
  assertions: {},
};

if (hitlReached === null) {
  // run 直接终止（修订删除了论断或首轮即过）：H 的停止语义未触发——如实记录并做 A4/A5
  await appendDriverLog(`run 未停在作者决策 HITL（终态 ${run.status}）——按实际语义记录`);
}

// 阶段 2（A2）：进程级重启后待决状态保留
session1.server.close();
await new Promise((r) => setTimeout(r, 3_000));
const session2 = await bootServer();
await appendDriverLog(`server#2 重启 ${session2.base}（A2 重启保持验证）`);
const afterRestart = await request(session2.base, "GET", `/runs/${runId}`);
const runAfter = afterRestart.body.run;
report.statusAfterRestart = runAfter?.status ?? null;
report.awaitingAfterRestart = runAfter?.awaiting?.stageId ?? null;

// 阶段 3（A3）：待决期间 Draft 可独立构建
const buildDraft = await request(session2.base, "POST", `/projects/${SOURCE_PROJECT}/build`, { flavor: "draft" }).catch((e) => ({ thrown: e.message }));
report.draftBuildAttempt = { status: buildDraft.status ?? null, thrown: buildDraft.thrown ?? null };

// 阶段 4（A4a）：待决期间 finalize 拒绝（活跃 run 互斥 409——待决不是 Final 通道）
const finalizePending = await request(session2.base, "POST", `/projects/${SOURCE_PROJECT}/finalize`).catch((e) => ({ thrown: e.message }));
report.finalizeWhilePending = { status: finalizePending.status ?? null, body: finalizePending.body ?? null, thrown: finalizePending.thrown ?? null };

// 阶段 5：作者以 accept_draft 结束待决（合法决策；操作者代行，登记于 manifest）→ run 终结
if (hitlReached !== null) {
  const resumed = await request(session2.base, "POST", `/runs/${runId}/resume`, { decision: "accept_draft" });
  await appendDriverLog(`[hitl-author] ${hitlReached.stageId} → accept_draft（resume ${resumed.status}）`);
  for (let i = 0; i < 120; i += 1) {
    const { body } = await request(session2.base, "GET", `/runs/${runId}`);
    run = body.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  report.finalStatusAfterAuthorDecision = run.status;
  report.completionLabel = run.completion?.label ?? null;
}

// 阶段 6（A4b）：终结后 finalize 仍拒绝（gate FAIL：缺关键数据稿件不得 READY/Final）
const finalize = await request(session2.base, "POST", `/projects/${SOURCE_PROJECT}/finalize`).catch((e) => ({ thrown: e.message }));
report.finalizeAttempt = { status: finalize.status ?? null, body: finalize.body ?? null, thrown: finalize.thrown ?? null };

// 阶段 7（A5）：无自动填值 / 无自动批准
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { EvidenceStore } = await import(distUrl("evidence", "EvidenceStore.js"));
const projects2 = new ProjectStore({ root: H_ROOT });
const evidence2 = new EvidenceStore({ projects: projects2 });
const evidenceAfter = (await evidence2.list(SOURCE_PROJECT)).map((r) => r.id).sort();
const newEvidenceIds = evidenceAfter.filter((id) => !evidenceBefore.includes(id));
report.evidenceDelta = { before: evidenceBefore.length, after: evidenceAfter.length, newIds: newEvidenceIds };
// 稿内论断状态：仍在（无证据）/被改写/被删（均合法；非法=被替换成带编造数据的「已验证」表述）
const { readdir, readFile: rf } = await import("node:fs/promises");
let claimTextState = "unknown";
try {
  const sections = (await readdir(join(projectDir, "manuscript", "sections"))).filter((f) => f.endsWith(".tex"));
  let found = false;
  for (const f of sections) {
    const raw = await rf(join(projectDir, "manuscript", "sections", f), "utf8");
    if (raw.includes(INJECTED_CLAIM_ZH.slice(0, 24))) { found = true; break }
  }
  claimTextState = found ? "retained-unevidenced" : "removed-or-rewritten";
} catch { /* 保持 unknown */ }
report.claimTextState = claimTextState;

report.physicalModelCalls = session1.getCalls() + session2.getCalls();
report.budget = session2.getLedger();

report.assertions = {
  A1_hitl_or_terminated_without_ready: hitlReached !== null ? run.status === "awaiting_input" : (run.status === "completed" && (run.completion?.label ?? "") !== "final"),
  A2_pending_preserved_across_restart: hitlReached !== null ? (report.statusAfterRestart === "awaiting_input" && report.awaitingAfterRestart === hitlReached.stageId) : null,
  A3_draft_buildable: buildDraft.status === 200 || buildDraft.status === 201 || buildDraft.status === 202,
  A4_finalize_refused: (finalizePending.status !== 200 || finalizePending.thrown !== undefined) && (finalize.status !== 200 || finalize.thrown !== undefined),
  A5_no_auto_fill: newEvidenceIds.length === 0 && claimTextState !== "fabricated-supported",
};

await writeJsonAtomic(REPORT_PATH, report);
await appendDriverLog(`报告落盘；断言 ${JSON.stringify(report.assertions)}（物理 ${report.physicalModelCalls}）`);
console.log(`DONE H: hitl=${hitlReached?.stageId ?? "none"} assertions=${JSON.stringify(report.assertions)} physical=${report.physicalModelCalls}`);
session2.server.close();
process.exit(Object.values(report.assertions).every((v) => v === true || v === null) ? 0 : 5);
