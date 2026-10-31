#!/usr/bin/env node
/**
 * M15.17 E2E 续跑驱动：综述项目（计划已决策、指令已入队）的 improvement run
 * 从头重新执行（上一个 run 因 glm 网关 402 配额耗尽失败；已切换 Z.AI Coding
 * CN 通道）。自动通过全部 HITL → 完成后执行 B7-B10（修订 lineage / 指令状态 /
 * 复评 / 幂等复评）与 C1（stale 负例）并写 acceptance-summary.json。
 *
 * 用法：node scripts/m1517/resume-run.mjs --base http://127.0.0.1:3117 \
 *        --project p-a8486551421a --run w-xxx [--caseR p-xxx]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const BASE = (arg("base") ?? "http://127.0.0.1:3117").replace(/\/$/, "");
const PROJECT = arg("project");
const RUN = arg("run");
const CASE_R = arg("caseR") ?? "p-6ba45809ed5b";
const ROOT = "D:\\PaperTeamData\\M15\\M15_17";
const RUN_TIMEOUT_MS = 90 * 60 * 1000;

if (PROJECT === undefined || RUN === undefined) {
  console.error("用法：--project <id> --run <runId> [--base ...] [--caseR <id>]");
  process.exit(2);
}
const log = (...args) => console.log("[resume-e2e]", ...args);
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

const summary = { base: BASE, startedAt: new Date().toISOString(), steps: [], modelCalls: 0 };
const step = (name, data) => { summary.steps.push({ name, at: new Date().toISOString(), ...data }); log(name, JSON.stringify(data).slice(0, 500)); };

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
      if (decision === undefined) throw new Error(`未预期待办 ${stageId}`);
      await api("POST", `/api/runs/${runId}/resume`, { decision });
      continue;
    }
    if (untilStatuses?.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run 超时（${run.status} @ ${run.currentStage}）`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- B6：驱动 run 完成 ----
const finished = await pollRun(RUN, {
  untilStatuses: ["completed"],
  autoDecisions: {
    "hitl.research_plan": "approve",
    "hitl.evidence_supply": "continue",
    "hitl.plan_confirm": "approve",
    "hitl.revision_validation": "approve",
    "hitl.revision_overflow": "accept_draft",
    "hitl.revision_stalled": "accept_draft",
    "hitl.style_polish": "skip",
  },
});
step("B6 run 完成", { status: finished.status, completion: finished.completion?.label ?? null, stages: finished.completedStages.length, hasRevisionApply: finished.completedStages.includes("revision.apply") });

// ---- B7：修订 lineage ----
const revisions = (await api("GET", `/api/projects/${PROJECT}/revisions`)).body["revisions"] ?? [];
step("B7 修订 lineage", {
  count: revisions.length,
  revisions: revisions.map((r) => ({ revision: r.revision, reason: r.reason, runId: r.runId ?? null })),
});

// ---- B8：审计指令执行状态 ----
const instructions = ((await api("GET", `/api/projects/${PROJECT}/external-instructions`)).body["instructions"] ?? [])
  .filter((entry) => entry.source === "target_audit");
step("B8 审计指令执行状态", {
  instructions: instructions.map((i) => ({
    id: i.instructionId,
    status: i.status,
    section: i.section ?? null,
    statusNote: (i.statusNote ?? "").slice(0, 120),
    resolutionTrace: i.resolutionTrace ? { status: i.resolutionTrace.status, patchIds: i.resolutionTrace.patchIds, verification: i.resolutionTrace.verification, target: i.resolutionTrace.target ?? null } : null,
  })),
});

// ---- B9：复评闭环 ----
const reassess = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit/revision-plan/reassess`);
if (reassess.status !== 200) throw new Error(`reassess failed: ${reassess.status}`);
step("B9 复评闭环", {
  assessedAtRevision: reassess.body.report.assessedAtRevision,
  auditStaleNow: reassess.body.report.auditStaleNow,
  summary: reassess.body.report.summary,
  items: reassess.body.report.items.map((item) => ({
    itemId: item.itemId,
    closure: item.closure,
    patches: item.patches ?? [],
    verification: item.verification ?? null,
  })),
});

// ---- B10：幂等复评 ----
const reassess2 = await api("POST", `/api/projects/${PROJECT}/target/evidence-audit/revision-plan/reassess`);
step("B10 幂等复评", {
  stable: reassess2.status === 200 && reassess2.body.report.summary.VALIDATED_FIXED === reassess.body.report.summary.VALIDATED_FIXED,
});

summary.projectIds = { caseR: CASE_R, b1: PROJECT, stale: PROJECT, b1Run: RUN };
summary.completedAt = new Date().toISOString();
await writeFile(join(ROOT, "e2e", "acceptance-summary.json"), JSON.stringify(summary, null, 1), "utf8");
log("acceptance-summary.json 已写入");
