#!/usr/bin/env node
/**
 * M15.17 Phase E — 真实用户路径验收驱动（真实 backend + 真实模型 + 真实 HTTP）。
 *
 * 前置：backend 以 PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true 启动（脚本只消费
 * HTTP，不注入 / 不绕过服务）。产物落 D:\PaperTeamData\M15\M15_17\e2e\。
 *
 * 场景（任务书 Phase E 验收门）：
 *   A. case-R（中文研究论文 PDF，review_only）：审计 → 计划（全部需实验 →
 *      Author Decision）→ 决策 → 不产生任何修改 → 复评（负例 5：零伪改动）
 *   B. b1（中文综述 PDF，goal=improvement）：导入 → run 暂停在 research_plan
 *      （重建可编辑稿 + baseline 修订）→ 审计 → 计划 → 作者批准 → 恢复 run →
 *      真实修订执行（守卫链）→ 复评闭环（G3）
 *   C. 负例 1（stale）：审计后换稿 → 生成/决策 409 阻断
 *   D. 负例 6（幂等）：decide 重试不重复建指令；reassess 可重复
 *
 * 用法：node scripts/m1517/e2e-acceptance.mjs [--base http://127.0.0.1:3117]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = "D:\\PaperTeamData\\M15\\M15_17";
const OUT = join(ROOT, "e2e");
const M159_GUIDELINES = "D:\\PaperTeamData\\M15\\M15_9\\phase-c\\guideline-artifacts";
const SAMPLES = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples";

const baseArg = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:3117";
const BASE = baseArg.replace(/\/$/, "");
const SKIP_A = process.argv.includes("--skip-a");
// 断点续跑：--resume-b <projectId> <runId>（综述项目已导入且 run 已暂停在 research_plan）
const resumeBIndex = process.argv.indexOf("--resume-b");
const RESUME_B = resumeBIndex !== -1 ? { project: process.argv[resumeBIndex + 1], run: process.argv[resumeBIndex + 2] } : null;
const RUN_TIMEOUT_MS = 90 * 60 * 1000; // 综述全流程（真实模型）上限 90 分钟
const MODEL_CALL_BUDGET = 120;

const log = (...args) => console.log("[e2e]", ...args);

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

async function uploadJson(method, path, pdfPath, extra = {}) {
  const content = await readFile(pdfPath);
  return api(method, path, {
    fileName: pdfPath.split(/[\\/]/).pop(),
    contentBase64: content.toString("base64"),
    ...extra,
  });
}

const summary = { base: BASE, startedAt: new Date().toISOString(), steps: [], modelCalls: 0 };
const step = (name, data) => {
  summary.steps.push({ name, at: new Date().toISOString(), ...data });
  log(name, JSON.stringify(data).slice(0, 400));
};
const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
};
// CJIG 官方指南工件（复用 M15.9 冻结产物；顶层加载供 A/B/C 共用）
const cjig = JSON.parse(await readFile(join(M159_GUIDELINES, "cjig.json"), "utf8"));
const countCalls = (meta) => {
  summary.modelCalls += meta?.telemetry?.calls ?? 0;
  if (summary.modelCalls > MODEL_CALL_BUDGET) {
    throw new Error(`模型调用预算耗尽（${summary.modelCalls} > ${MODEL_CALL_BUDGET}）——如实停止`);
  }
};

async function pollRun(runId, { untilStatuses, targetStage, autoDecisions = {}, timeoutMs = RUN_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body["run"];
    if (run.status === "failed") {
      throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`);
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (targetStage !== undefined && stageId === targetStage) return run;
      const decision = autoDecisions[stageId];
      if (decision === undefined) {
        throw new Error(`等待 ${targetStage ?? untilStatuses?.join("|")} 时遇到未预期待办 ${stageId}`);
      }
      await api("POST", `/api/runs/${runId}/resume`, { decision });
      continue;
    }
    if (untilStatuses?.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run 超时（当前 ${run.status} @ ${run.currentStage}）`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- A. case-R：全部需实验 → Author Decision，零修改 ----------
//（--skip-a：A 已在早前轮次通过时跳过复跑，节省模型预算）

let caseRProject = SKIP_A ? "p-6ba45809ed5b" : null;
const caseRPath = join(SAMPLES, "case-R.pdf"); // 顶层（C 场景复用）
if (!SKIP_A) {
const caseR = await uploadJson("POST", "/api/projects/import-paper", caseRPath, {
  format: "pdf",
  title: "M15.17 E2E case-R（CJIG·只读）",
  researchField: "scene text detection",
  documentType: "journal_article",
  targetVenue: "中国图象图形学报",
  workflowKind: "existing_paper_review",
});
assert(caseR.status === 201, `import case-R failed: ${caseR.status}`);
caseRProject = caseR.body.project.id;
step("A1 import case-R（review_only）", { projectId: caseRProject });

const putGuidelineR = await api("PUT", `/api/projects/${caseRProject}/target/guideline`, { guideline: cjig });
assert(putGuidelineR.status === 200, "PUT guideline (case-R) failed");
step("A2 freeze CJIG guideline", { venueId: putGuidelineR.body.guideline.venueId });

log("A3 证据审计（真实模型 3+ 次调用）…");
const auditRStarted = Date.now();
const auditR = await api("POST", `/api/projects/${caseRProject}/target/evidence-audit`);
assert(auditR.status === 200, `evidence-audit failed: ${auditR.status} ${JSON.stringify(auditR.body).slice(0, 300)}`);
const auditRArtifact = auditR.body.audit.artifact;
countCalls(auditR.body.audit.meta);
step("A3 case-R 证据审计", {
  modelCalls: auditR.body.audit.meta.telemetry.calls,
  totalMs: auditR.body.audit.meta.telemetry.totalMs,
  poolSize: auditRArtifact.priorWork.poolSize,
  gapPlan: auditRArtifact.gapPlan.map((g) => ({ id: g.contributionId, actionType: g.actionType })),
  guards: auditRArtifact.guards,
});

const planR = await api("POST", `/api/projects/${caseRProject}/target/evidence-audit/revision-plan`);
assert(planR.status === 200, `plan (case-R) failed: ${planR.status}`);
const planRItems = planR.body.plan.plan.items;
step("A4 case-R 计划生成（零模型）", {
  planId: planR.body.plan.plan.planId,
  summary: planR.body.plan.plan.summary,
  items: planRItems.map((item) => ({ itemId: item.itemId, classification: item.classification, projection: item.anchor.projection.status })),
});
// 只读项目纪律：可改写项（如有）必须 UNMAPPABLE，不猜位置
for (const item of planRItems) {
  if (item.sourceActionType === "can_rewrite_from_existing_evidence" && item.anchor.anchorVerified) {
    assert(
      item.classification === "UNMAPPABLE_TARGET" || item.classification === "NEEDS_TARGETED_EVIDENCE" || item.classification === "EVIDENCE_INSUFFICIENT",
      `只读项目的 can_rewrite 项 ${item.itemId} 不得判 REWRITE_ELIGIBLE（得 ${item.classification}）`,
    );
  }
  if (item.sourceActionType === "requires_real_experiment_or_author_input") {
    assert(item.classification === "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT", `需实验项 ${item.itemId} 分类必须为 NEEDS_REAL_EXPERIMENT（得 ${item.classification}）`);
  }
}

const decideR = await api("POST", `/api/projects/${caseRProject}/target/evidence-audit/revision-plan/decide`, {
  decisions: planRItems.map((item) => ({ itemId: item.itemId, decision: "approve" })),
});
assert(decideR.status === 200, `decide (case-R) failed: ${decideR.status}`);
const decideRPlan = decideR.body.plan.plan;
const instructionsR = decideR.body.plan.instructions;
step("A5 case-R 全部批准 → 作者裁决指令（不派发）", {
  approved: decideRPlan.summary.approved,
  instructions: instructionsR.map((i) => ({ id: i.instructionId, status: i.status })),
});
assert(instructionsR.length === planRItems.length, "批准数与指令数一致");
for (const instruction of instructionsR) {
  assert(instruction.status === "pending", "作者裁决指令保持 pending（进入待裁决队列）");
}

// 幂等重试（负例 6）：同批决策再提交 → 不重复建指令
const decideRAgain = await api("POST", `/api/projects/${caseRProject}/target/evidence-audit/revision-plan/decide`, {
  decisions: planRItems.map((item) => ({ itemId: item.itemId, decision: "approve" })),
});
assert(decideRAgain.status === 200, "幂等 decide 重试失败");
assert(decideRAgain.body.plan.instructions.length === instructionsR.length, "幂等重试不得新增指令");
step("A6 幂等重试", { instructions: decideRAgain.body.plan.instructions.length, unchanged: true });

const reassessR = await api("POST", `/api/projects/${caseRProject}/target/evidence-audit/revision-plan/reassess`);
assert(reassessR.status === 200, `reassess (case-R) failed: ${reassessR.status}`);
step("A7 case-R 复评（负例 5：零伪改动）", {
  summary: reassessR.body.report.summary,
  items: reassessR.body.report.items.map((item) => ({ itemId: item.itemId, closure: item.closure })),
});
assert(reassessR.body.report.summary.VALIDATED_FIXED === 0, "只读项目不得出现任何 VALIDATED_FIXED");
for (const item of reassessR.body.report.items) {
  assert(item.closure === "NEEDS_AUTHOR_DECISION", `case-R 全部条目应为待作者决策（${item.itemId} 得 ${item.closure}）`);
}
} // if (!SKIP_A)

// ---------- B. 综述：审计 → 计划 → 批准 → 真实修订执行 → 复评 ----------
// 样本说明：b1（作者中文综述 PDF）与 CJIG 已刊综述 PDF 的解析产物均为近无结构
//（正文并入单一节 / Whole Document），确定性重建（PaperReconstructor 需 ≥3 个
// 有效正文节）fail-closed——如实记录为 B0 负例；按任务书改用有真实来源的其他
// 可编辑综述样本：arXiv 2609.08265「Tracking-by-detection in Multi-object
// Tracking: Survey and Experiments」（KAIST，开放获取，39 个 TOC 节）。

let b1Project = null;
let b1Run = null;
if (RESUME_B !== null) {
  b1Project = RESUME_B.project;
  b1Run = RESUME_B.run;
  const state = (await api("GET", `/api/runs/${b1Run}`)).body["run"];
  assert(state.status === "awaiting_input" && state.awaiting?.stageId === "hitl.research_plan", `断点续跑要求 run 暂停在 research_plan（得 ${state.status} @ ${state.awaiting?.stageId ?? state.currentStage}）`);
  step("B2R 断点续跑（复用已暂停 run）", { projectId: b1Project, runId: b1Run, stage: state.awaiting?.stageId });
} else {
// B0：b1 不可重建（负例，零模型调用——import.parse 在任何模型调用前失败）
const b1Path = join(SAMPLES, "b1-original.pdf");
const b1Probe = await uploadJson("POST", "/api/projects/import-paper", b1Path, {
  format: "pdf",
  title: "M15.17 E2E b1（结构探测）",
  documentType: "survey",
  targetVenue: "中国图象图形学报",
  workflowKind: "existing_paper_improvement",
});
assert(b1Probe.status === 201, "b1 导入（探测）失败");
const b1ProbeRun = await api("POST", `/api/projects/${b1Probe.body.project.id}/workflows`, {});
assert(b1ProbeRun.status === 202, "b1 探测 run 创建失败");
let b1ProbeFailure = null;
try {
  await pollRun(b1ProbeRun.body.runId, { untilStatuses: ["completed"], timeoutMs: 10 * 60 * 1000, autoDecisions: {
    "hitl.research_plan": "approve", "hitl.evidence_supply": "continue", "hitl.plan_confirm": "approve",
  } });
} catch (error) {
  b1ProbeFailure = String(error.message ?? error);
}
assert(b1ProbeFailure !== null && b1ProbeFailure.includes("IMPORT_VALIDATION"), `b1 应在重建处 fail-closed（得：${b1ProbeFailure}）`);
await api("POST", `/api/projects/${b1Probe.body.project.id}/archive`, {});
step("B0 b1 结构探测（不可重建，如实记录）", {
  projectId: b1Probe.body.project.id,
  failure: b1ProbeFailure.slice(0, 160),
  note: "b1/CJIG 综述 PDF 解析为近无结构（正文并入单节）→ 重建需 ≥3 正文节 fail-closed；改用 arXiv 2609.08265 真实综述完成可编辑闭环",
});

const surveyPath = join(ROOT, "e2e", "mot-tbd-survey-2609.08265.pdf");
const survey = await uploadJson("POST", "/api/projects/import-paper", surveyPath, {
  format: "pdf",
  title: "M15.17 E2E MOT TBD Survey（CJIG·改进）",
  researchField: "multiple object tracking",
  documentType: "survey",
  targetVenue: "中国图象图形学报",
  workflowKind: "existing_paper_improvement",
});
assert(survey.status === 201, `import survey failed: ${survey.status}`);
b1Project = survey.body.project.id;
step("B1 import MOT survey（goal=improvement）", { projectId: b1Project, source: "arXiv:2609.08265" });

const putGuidelineB = await api("PUT", `/api/projects/${b1Project}/target/guideline`, { guideline: cjig });
assert(putGuidelineB.status === 200, "PUT guideline (b1) failed");

const runCreated = await api("POST", `/api/projects/${b1Project}/workflows`, {});
assert(runCreated.status === 202, `create run failed: ${runCreated.status}`);
b1Run = runCreated.body.runId;
log("B2 run 启动 → 等待 hitl.research_plan 暂停（import.parse 重建 + review.run baseline；真实模型）…");
const paused = await pollRun(b1Run, {
  targetStage: "hitl.research_plan",
  timeoutMs: RUN_TIMEOUT_MS,
});
const revisionsResponse = await api("GET", `/api/projects/${b1Project}/revisions`);
const revisionAtPause = (revisionsResponse.body["revisions"] ?? []).length;
assert(revisionAtPause >= 1, "暂停时应有 baseline 修订");
step("B2 run 暂停在 hitl.research_plan", { runId: b1Run, revisionAtPause, stagesDone: paused.completedStages.length });
} // if (RESUME_B === null)

let revisionAtPause = 0;
{
  const revisionsResponse = await api("GET", `/api/projects/${b1Project}/revisions`);
  revisionAtPause = (revisionsResponse.body["revisions"] ?? []).length;
}

// 审计调用带一次重试（外部解析端点偶发 Headers Timeout）
async function auditWithRetry(projectId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await api("POST", `/api/projects/${projectId}/target/evidence-audit`);
      if (response.status === 200) return response;
      throw new Error(`evidence-audit ${response.status}: ${JSON.stringify(response.body).slice(0, 200)}`);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        log(`审计失败（${String(error.message ?? error).slice(0, 120)}），30s 后重试一次…`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  }
  throw lastError;
}

log("B3 综述证据审计（真实模型）…");
const auditB = await auditWithRetry(b1Project);
assert(auditB.status === 200, `evidence-audit (b1) failed: ${auditB.status} ${JSON.stringify(auditB.body).slice(0, 300)}`);
const auditBArtifact = auditB.body.audit.artifact;
countCalls(auditB.body.audit.meta);
step("B3 b1 证据审计", {
  modelCalls: auditB.body.audit.meta.telemetry.calls,
  totalMs: auditB.body.audit.meta.telemetry.totalMs,
  gapPlan: auditBArtifact.gapPlan.map((g) => ({ id: g.contributionId, actionType: g.actionType })),
  guards: auditBArtifact.guards,
});

const planB = await api("POST", `/api/projects/${b1Project}/target/evidence-audit/revision-plan`);
assert(planB.status === 200, `plan (b1) failed: ${planB.status}`);
const planBArtifact = planB.body.plan.plan;
step("B4 b1 计划生成", {
  planId: planBArtifact.planId,
  boundRevision: planBArtifact.source.manuscriptRevisionAtPlan,
  summary: planBArtifact.summary,
  items: planBArtifact.items.map((item) => ({
    itemId: item.itemId,
    classification: item.classification,
    projection: item.anchor.projection.status,
    file: item.anchor.projection.file ?? null,
    priorWork: item.priorWork.length,
  })),
});
const rewriteItems = planBArtifact.items.filter((item) => item.classification === "REWRITE_ELIGIBLE");
log(`B4 可改写项 ${rewriteItems.length}/${planBArtifact.items.length}`);

const decideB = await api("POST", `/api/projects/${b1Project}/target/evidence-audit/revision-plan/decide`, {
  decisions: planBArtifact.items.map((item) => ({ itemId: item.itemId, decision: "approve" })),
});
assert(decideB.status === 200, `decide (b1) failed: ${decideB.status}`);
const decideBPlan = decideB.body.plan.plan;
const instructionsB = decideB.body.plan.instructions;
const rewriteInstructionIds = new Set(
  decideBPlan.items.filter((item) => item.classification === "REWRITE_ELIGIBLE").map((item) => item.instructionId),
);
step("B5 b1 全部批准", {
  approved: decideBPlan.summary.approved,
  rewriteInstructions: [...rewriteInstructionIds],
  allInstructions: instructionsB.map((i) => ({ id: i.instructionId, status: i.status, section: i.section ?? null })),
});

log("B6 恢复 run → plan.improvement → plan_confirm → revision.apply（真实模型，可能 30-60 分钟）…");
await api("POST", `/api/runs/${b1Run}/resume`, { decision: "approve" });
const finished = await pollRun(b1Run, {
  untilStatuses: ["completed"],
  autoDecisions: {
    "hitl.evidence_supply": "continue",
    "hitl.plan_confirm": "approve",
    // 复核阻断时的作者裁决（needs_review/rejected 条目）：E2E 代理作者批准放行
    //（守卫已拦截的内容不会因此恢复；该决策本身进 run 事件留痕）
    "hitl.revision_validation": "approve",
    "hitl.revision_overflow": "accept_draft",
    "hitl.revision_stalled": "accept_draft",
    "hitl.style_polish": "skip",
  },
  timeoutMs: RUN_TIMEOUT_MS,
});
step("B6 run 完成", {
  status: finished.status,
  completion: finished.completion?.label ?? null,
  stages: finished.completedStages.length,
});

const revisionsAfter = await api("GET", `/api/projects/${b1Project}/revisions`);
const revisionList = revisionsAfter.body["revisions"] ?? [];
step("B7 修订 lineage", {
  revisionAtPause,
  revisionsAfter: revisionList.length,
  reasons: revisionList.slice(revisionAtPause).map((r) => ({ revision: r.revision, reason: r.reason, runId: r.runId ?? null })),
});

const instructionsAfter = (await api("GET", `/api/projects/${b1Project}/external-instructions`)).body["instructions"];
const auditInstructionsAfter = instructionsAfter.filter((entry) => entry.source === "target_audit");
step("B8 审计指令执行状态", {
  instructions: auditInstructionsAfter.map((i) => ({
    id: i.instructionId,
    status: i.status,
    statusNote: (i.statusNote ?? "").slice(0, 100),
    isRewrite: rewriteInstructionIds.has(i.instructionId),
    resolutionTrace: i.resolutionTrace
      ? { status: i.resolutionTrace.status, patchIds: i.resolutionTrace.patchIds, verification: i.resolutionTrace.verification }
      : null,
  })),
});

const reassessB = await api("POST", `/api/projects/${b1Project}/target/evidence-audit/revision-plan/reassess`);
assert(reassessB.status === 200, `reassess (b1) failed: ${reassessB.status}`);
step("B9 b1 复评闭环", {
  assessedAtRevision: reassessB.body.report.assessedAtRevision,
  auditStaleNow: reassessB.body.report.auditStaleNow,
  summary: reassessB.body.report.summary,
  items: reassessB.body.report.items.map((item) => ({
    itemId: item.itemId,
    closure: item.closure,
    patches: item.patches ?? [],
    verification: item.verification ?? null,
  })),
});

// 幂等复评（负例 6）：再次 reassess 不误关联 / 不丢 lineage
const reassessB2 = await api("POST", `/api/projects/${b1Project}/target/evidence-audit/revision-plan/reassess`);
assert(reassessB2.status === 200, "reassess 重跑失败");
assert(reassessB2.body.report.summary.VALIDATED_FIXED === reassessB.body.report.summary.VALIDATED_FIXED, "幂等复评结果稳定");
step("B10 幂等复评", { stable: true });

// ---------- C. 负例 1：stale 阻断（换稿 → 生成/决策 409） ----------

const staleProject = (await uploadJson("POST", "/api/projects/import-paper", caseRPath, {
  format: "pdf",
  title: "M15.17 E2E stale（CJIG）",
  documentType: "journal_article",
  workflowKind: "existing_paper_review",
})).body.project.id;
await api("PUT", `/api/projects/${staleProject}/target/guideline`, { guideline: cjig });
const staleAudit = await api("POST", `/api/projects/${staleProject}/target/evidence-audit`);
assert(staleAudit.status === 200, "stale 项目审计失败");
countCalls(staleAudit.body.audit.meta);
const stalePlan = await api("POST", `/api/projects/${staleProject}/target/evidence-audit/revision-plan`);
assert(stalePlan.status === 200, "stale 项目计划生成失败");
// 换稿（b1 覆盖上传）→ 指纹变化
const replaced = await uploadJson("POST", `/api/projects/${staleProject}/paper/pdf`, b1Path);
assert(replaced.status === 200 || replaced.status === 201, `换稿失败: ${replaced.status}`);
const staleAuditView = await api("GET", `/api/projects/${staleProject}/target/evidence-audit`);
assert(staleAuditView.body.audit.stale === true, "换稿后审计必须 stale");
const staleRegen = await api("POST", `/api/projects/${staleProject}/target/evidence-audit/revision-plan`);
assert(staleRegen.status === 409, `陈旧审计重新生成必须 409（得 ${staleRegen.status}）`);
const staleDecide = await api("POST", `/api/projects/${staleProject}/target/evidence-audit/revision-plan/decide`, {
  decisions: [{ itemId: stalePlan.body.plan.plan.items[0].itemId, decision: "approve" }],
});
assert(staleDecide.status === 409, `陈旧计划决策必须 409（得 ${staleDecide.status}）`);
step("C1 负例 stale（换稿 → 409 阻断）", {
  auditStale: staleAuditView.body.audit.stale,
  regenStatus: staleRegen.status,
  decideStatus: staleDecide.status,
  errorCodes: [staleRegen.body.error?.code, staleDecide.body.error?.code],
});

// ---------- 收尾 ----------

summary.completedAt = new Date().toISOString();
summary.projectIds = { caseR: caseRProject, b1: b1Project, stale: staleProject, b1Run };
summary.modelCallBudget = MODEL_CALL_BUDGET;
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "acceptance-summary.json"), JSON.stringify(summary, null, 1), "utf8");
log(`完成。模型调用合计 ${summary.modelCalls}/${MODEL_CALL_BUDGET}。摘要已写入 ${join(OUT, "acceptance-summary.json")}`);
