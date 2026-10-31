#!/usr/bin/env node
/**
 * M15.17 第三轮（sourceText 锚修复后）：重审计 → 重计划 → 重决策 → 新 run → 驱动 → 复评。
 * 前置：上一 run 已结束（completed/failed 均可）；manuscript 处于其终态。
 * 用法：node scripts/m1517/attempt3.mjs --base http://127.0.0.1:3117 --project p-a8486551421a
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const BASE = (arg("base") ?? "http://127.0.0.1:3117").replace(/\/$/, "");
const PROJECT = arg("project") ?? "p-a8486551421a";
const CASE_R = arg("caseR") ?? "p-6ba45809ed5b";
const ROOT = "D:\\PaperTeamData\\M15\\M15_17";
const RUN_TIMEOUT_MS = 90 * 60 * 1000;

const log = (...args) => console.log("[attempt3]", ...args);
async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed };
}
const summary = { base: BASE, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => { summary.steps.push({ name, at: new Date().toISOString(), ...data }); log(name, JSON.stringify(data).slice(0, 500)); };

// 0) 清理被取代的旧指令与旧计划（操作者显式动作，重命名留痕）
const oldInstructions = ((await api("GET", `/api/projects/${PROJECT}/external-instructions`)).body["instructions"] ?? [])
  .filter((entry) => entry.source === "target_audit");
for (const instruction of oldInstructions) {
  const deleted = await api("DELETE", `/api/projects/${PROJECT}/external-instructions/${instruction.instructionId}`);
  if (deleted.status !== 200) throw new Error(`删除旧指令失败 ${instruction.instructionId}: ${deleted.status}`);
}
step("T0 清理被取代指令", { deleted: oldInstructions.map((i) => i.instructionId) });
const researchDir = join(ROOT, "e2e-stack", PROJECT, "research");
for (const [from, to] of [
  ["target-audit-revision-plan.json", "target-audit-revision-plan.superseded-attempt2.json"],
  ["target-audit-revision-report.json", "target-audit-revision-report.attempt2.json"],
]) {
  try { await rename(join(researchDir, from), join(researchDir, to)); } catch { /* 不存在即跳过 */ }
}

// 1) 重审计（真实模型，当前稿状态）
log("T1 重审计（真实模型）…");
let audit;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const response = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit`);
  if (response.status === 200) { audit = response.body; break; }
  if (attempt === 2) throw new Error(`重审计失败: ${response.status}`);
  await new Promise((r) => setTimeout(r, 30_000));
}
step("T1 重审计", {
  modelCalls: audit.audit.meta.telemetry.calls,
  totalMs: audit.audit.meta.telemetry.totalMs,
  gapPlan: audit.audit.artifact.gapPlan.map((g) => ({ id: g.contributionId, actionType: g.actionType })),
});

// 2) 重计划 → 核对 texAnchor → 全部批准
const planResponse = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit/revision-plan`);
if (planResponse.status !== 200) throw new Error(`计划失败: ${planResponse.status} ${JSON.stringify(planResponse.body).slice(0, 200)}`);
const plan = planResponse.body.plan.plan;
step("T2 计划生成", {
  planId: plan.planId,
  boundRevision: plan.source.manuscriptRevisionAtPlan,
  summary: plan.summary,
  items: plan.items.map((item) => ({
    itemId: item.itemId,
    classification: item.classification,
    dispatch: item.anchor.dispatchSection ?? null,
    texAnchor: (item.anchor.texAnchor ?? "").slice(0, 60),
  })),
});
const rewriteItems = plan.items.filter((item) => item.classification === "REWRITE_ELIGIBLE");
const decide = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit/revision-plan/decide`, {
  decisions: plan.items.map((item) => ({ itemId: item.itemId, decision: "approve" })),
});
if (decide.status !== 200) throw new Error(`决策失败: ${decide.status}`);
step("T3 全部批准", {
  approved: decide.body.plan.plan.summary.approved,
  instructions: decide.body.plan.instructions.map((i) => ({ id: i.instructionId, status: i.status, section: i.section ?? null })),
});

// 3) 新 run → 驱动完成
const created = await api("POST", `/api/projects/${PROJECT}/workflows`, {});
if (created.status !== 202) throw new Error(`run 创建失败: ${created.status}`);
const runId = created.body.runId;
log("T4 run 启动", runId);
async function pollRun(id, autoDecisions, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${id}`);
    const run = body["run"];
    if (run.status === "failed") throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId}）`);
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      const decision = autoDecisions[stageId];
      if (decision === undefined) throw new Error(`未预期待办 ${stageId}`);
      await api("POST", `/api/runs/${id}/resume`, { decision });
      continue;
    }
    if (run.status === "completed") return run;
    if (Date.now() > deadline) throw new Error(`run 超时（${run.status} @ ${run.currentStage}）`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const finished = await pollRun(runId, {
  "hitl.research_plan": "approve",
  "hitl.evidence_supply": "continue",
  "hitl.plan_confirm": "approve",
  "hitl.revision_validation": "approve",
  "hitl.revision_overflow": "accept_draft",
  "hitl.revision_stalled": "accept_draft",
  "hitl.style_polish": "skip",
}, RUN_TIMEOUT_MS);
step("T4 run 完成", { runId, completion: finished.completion?.label ?? null, stages: finished.completedStages.length, hasRevisionApply: finished.completedStages.includes("revision.apply") });

// 4) lineage / 指令状态 / 复评
const revisions = (await api("GET", `/api/projects/${PROJECT}/revisions`)).body["revisions"] ?? [];
step("T5 修订 lineage", { count: revisions.length, revisions: revisions.map((r) => ({ revision: r.revision, reason: r.reason })) });
const instructions = ((await api("GET", `/api/projects/${PROJECT}/external-instructions`)).body["instructions"] ?? [])
  .filter((entry) => entry.source === "target_audit");
step("T6 审计指令状态", {
  instructions: instructions.map((i) => ({
    id: i.instructionId,
    status: i.status,
    note: (i.statusNote ?? "").slice(0, 100),
    trace: i.resolutionTrace ? { status: i.resolutionTrace.status, planItemIds: i.resolutionTrace.planItemIds, patchIds: i.resolutionTrace.patchIds, verification: i.resolutionTrace.verification, target: i.resolutionTrace.target ?? null } : null,
  })),
});
const reassess = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit/revision-plan/reassess`);
if (reassess.status !== 200) throw new Error(`复评失败: ${reassess.status}`);
step("T7 复评闭环", {
  assessedAtRevision: reassess.body.report.assessedAtRevision,
  summary: reassess.body.report.summary,
  items: reassess.body.report.items.map((item) => ({ itemId: item.itemId, closure: item.closure, basis: item.basis.slice(0, 160), patches: item.patches ?? [] })),
});

summary.projectIds = { caseR: CASE_R, b1: PROJECT, stale: PROJECT, b1Run: runId };
summary.rewriteItemsAttempt3 = rewriteItems.length;
summary.completedAt = new Date().toISOString();
await writeFile(join(ROOT, "e2e", "acceptance-summary.json"), JSON.stringify(summary, null, 1), "utf8");
log("完成，acceptance-summary.json 已写入");
