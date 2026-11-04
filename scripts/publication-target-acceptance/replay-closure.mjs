#!/usr/bin/env node
/**
 * 发表目标验收 · 修订终止语义回放（零模型）：把 W-B 真实模型产出的 review summary 原样交给生产 buildRevisionPlan /
 * buildRevisionGoalSummaryLines，叠加脚本化的外部意见（用户必需意见 + 需作者新数据的意见），核对：
 * 必需意见 mandatory 且不被降级；整稿 AI 建议（active 政策）skipped；无目标（inactive）时与旧 run 相同；
 * 缺数据意见进入作者裁决；报告区分 REVISION_TASK_COMPLETE 与投稿就绪、无录用措辞。结果写 ROOT\analysis\closure-replay.json。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT, dist, readJson } from "./lib.mjs";

const { buildRevisionPlan } = await import(dist("review/revisionPlan.js"));
const { buildRevisionGoalSummaryLines } = await import(dist("review/revisionGoalSummary.js"));
const { buildReviewPolicySnapshot, reviewPolicySummary } = await import(dist("review/publicationPolicy.js"));

const W = join(ROOT, "workflow", "2410.21665v1__live__B", "artifacts");
const summary = readJson(join(W, "review-summary-r1.json"));
const now = "2026-11-04T00:00:00.000Z";
const external = [
  { instructionId: "EI-USER-1", source: "user", text: "Please state explicitly in the abstract that all experiments use Stable Diffusion v1-4 only.", status: "pending", createdAt: now, updatedAt: now },
  { instructionId: "EI-REV-2", source: "reviewer", reviewerLabel: "Reviewer 2", text: "Report IoU of BE masks against ground-truth local memorization masks.", status: "unresolved", statusNote: "AUTHOR_DECISION_REQUIRED: 需要作者提供新的标注数据与实验结果，系统不虚构", createdAt: now, updatedAt: now },
];
const plan = (defer) => buildRevisionPlan({ projectId: summary.projectId ?? "p", sourceRevision: 1, reviewRound: summary.round, summary, externalInstructions: external, ...(defer ? { deferWholePaperAdvisory: true } : {}) });
const active = plan(true);
const legacy = plan(false);
const pick = (p) => ({
  external: p.items.filter((i) => i.kind === "external_instruction").map((i) => ({ id: i.id, priority: i.priority, status: i.status, actionType: i.actionType })),
  wholePaper: p.items.filter((i) => i.kind === "review_finding" && /整稿 AI 学术建议/.test(i.note ?? "")).length,
  reviewFindingPlanned: p.items.filter((i) => i.kind === "review_finding" && i.status === "planned").length,
  planned: p.items.filter((i) => i.status === "planned").length,
  skipped: p.items.filter((i) => i.status === "skipped").length,
});
const inactiveSnapshot = buildReviewPolicySnapshot({ workflowKind: "idea_to_paper", documentType: "research_article", documentTypeKind: "idea_to_paper", target: null, profile: null, now: new Date(now) });
const report = (policySummary) => buildRevisionGoalSummaryLines({
  instructions: external,
  review: { round: summary.round, issues: summary.issues, ...(policySummary !== undefined ? { reviewPolicy: policySummary } : {}) },
  gate: { revisionTask: { verdict: "PASS", reasons: [] }, publicationReadiness: { verdict: "NOT_READY" }, l1Failures: [] },
  journalAssessment: null,
  currentRevision: 1,
}).join("\n");
const activeReport = report(summary.reviewPolicy);
const inactiveReport = report(reviewPolicySummary(inactiveSnapshot));
const out = {
  activePolicy: pick(active),
  legacyNoDefer: pick(legacy),
  reportActive: {
    mentionsOptionalList: activeReport.includes("下一轮可选改进清单"),
    taskCompleteNotReady: activeReport.includes("REVISION_TASK_COMPLETE") && activeReport.includes("NOT_READY"),
    authorDataSection: activeReport.includes("系统不会虚构结果"),
    externalPriority: activeReport.includes("优先于发表目标"),
    forbidden: /录用概率\s*[:：]|已达到.{0,6}(分区|期刊)|达标/.test(activeReport),
  },
  reportInactive: { mentionsOptionalList: inactiveReport.includes("下一轮可选改进清单") },
  activeReportText: activeReport,
};
await writeFile(join(ROOT, "analysis", "closure-replay.json"), JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify({ ...out, activeReportText: undefined }, null, 1));
