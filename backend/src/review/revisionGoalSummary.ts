/**
 * 「本轮目标与终止」报告段（Revision Trace 第零节；纯函数、确定性、零模型）。
 *
 * 回答五个产品问题，每一项都只投影系统已有事实，不做新的判定：
 *   1. 本轮要解决什么   —— 外部（用户 / 专家）意见 + 冻结的审稿政策（发表目标只决定关注点）
 *   2. 已用可复核证据解决 / 只是 AI 建议 —— 指令状态机 handled / already_satisfied vs L2 模型意见
 *   3. 需要补实验 / 补来源 / 作者决定 —— conflict / unresolved 指令、任务层 AUTHOR_DECISION、需作者数据的意见
 *   4. 与已核验期刊投稿规范的差距 —— journal-assessment/v1 中 VIOLATED 的官方条目（带来源）；无已核验资料如实说明
 *   5. 下一步优先改什么 —— 已证实问题 → 未闭环外部意见 → 期刊阻断条目 → 按政策关注点排序的 AI 建议
 *
 * 纪律：REVISION_COMPLETE（任务层 PASS）≠ PUBLICATION_READY；不输出录用概率或「达到某分区水平」。
 */
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { JournalAssessment } from "../target/journal/assessment.js";
import type { ExternalInstruction } from "./externalInstructions.js";
import { policyDimension } from "./publicationPolicy.js";

export interface RevisionGoalSummaryInput {
  instructions: readonly ExternalInstruction[];
  review: { round: number; issues: readonly ReviewIssue[]; reviewPolicy?: Record<string, unknown> } | null;
  gate: {
    revisionTask?: { verdict: "PASS" | "FAIL" | "AUTHOR_DECISION_REQUIRED"; reasons: string[] };
    publicationReadiness?: { verdict: "READY" | "NOT_READY" | "AUTHOR_DECISION_REQUIRED" };
    l1Failures: string[];
  } | null;
  journalAssessment: Pick<JournalAssessment, "journal" | "criteria" | "manuscript" | "generatedAt"> | null;
  currentRevision: number;
}

const RESOLVED = new Set<ExternalInstruction["status"]>(["handled", "already_satisfied"]);
const NEEDS_AUTHOR = new Set<ExternalInstruction["status"]>(["conflict", "unresolved", "partially_handled"]);

function clip(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isAiSuggestion(issue: ReviewIssue): boolean {
  if (issue.deterministicDisconfirmed === true) return false;
  return issue.origin === "whole_paper_synthesis" || (issue.category === "academic" && issue.blocking !== true);
}

function needsAuthorData(issue: ReviewIssue): boolean {
  const verification = (issue as { verification?: string }).verification;
  return verification === "EXTERNAL_DATA_REQUIRED" || /补(充)?实验|新实验|additional experiment|new experiment/i.test(`${issue.suggestedAction ?? ""}`);
}

export function buildRevisionGoalSummaryLines(input: RevisionGoalSummaryInput): string[] {
  const lines: string[] = ["## 零、本轮目标与终止（发表目标只决定审稿关注点）", ""];
  const policy = input.review?.reviewPolicy ?? null;
  const target = (policy?.["target"] ?? null) as Record<string, unknown> | null;
  const tierFact = (policy?.["tierFact"] ?? null) as Record<string, unknown> | null;
  const focus = Array.isArray(policy?.["focus"]) ? (policy?.["focus"] as Array<{ id: string; label: string }>) : [];

  // 1. 本轮要解决什么
  lines.push("### 1. 本轮要解决什么");
  const external = input.instructions;
  lines.push(external.length > 0
    ? `- 用户 / 专家修改意见 ${external.length} 条（优先于发表目标：目标层级不会覆盖或降低这些意见的闭环要求）。`
    : "- 本轮没有用户 / 专家修改意见；修订范围来自已批准的改进计划。");
  if (policy === null) {
    lines.push("- 审稿政策：通用学术审稿（本轮运行未冻结发表目标政策，或为升级前创建的运行）。");
  } else {
    const tier = typeof target?.["tierLabel"] === "string" ? target["tierLabel"] : null;
    const journal = (policy["targetJournal"] as { displayName?: string } | null)?.displayName ?? (typeof target?.["customJournalName"] === "string" ? target["customJournalName"] : null);
    lines.push(`- 审稿政策：${String(policy["policyVersion"])}（hash ${String(policy["policyHash"])}，运行开始时冻结）；稿件类型 ${String(policy["articleType"])}。`);
    lines.push(`- 发表目标：${[tier, journal].filter((part) => part !== null).join(" · ") || "未设置"}${tierFact !== null && typeof tierFact["note"] === "string" ? `（${tierFact["note"]}）` : ""}。`);
    if (focus.length > 0) lines.push(`- 审稿关注点（按优先级）：${focus.map((dim) => dim.label).join("、")}。`);
  }
  lines.push("");

  // 2. 已解决（可复核） vs AI 建议
  lines.push("### 2. 哪些已通过可复核证据解决，哪些只是 AI 建议");
  const resolved = external.filter((instruction) => RESOLVED.has(instruction.status));
  lines.push(`- 外部意见已闭环（系统派发并逐条核实 / 导入登记已落实）：${resolved.length}/${external.length}。`);
  const task = input.gate?.revisionTask;
  if (task !== undefined) {
    lines.push(`- 任务层判定：${task.verdict === "PASS" ? "REVISION_TASK_COMPLETE（本轮修订任务完成）" : task.verdict === "AUTHOR_DECISION_REQUIRED" ? "需要作者决定" : "未完成"}。` +
      ` 这只说明本轮修订任务的状态，不代表稿件已达到投稿就绪或任何分区 / 期刊水平` +
      `${input.gate?.publicationReadiness !== undefined ? `（投稿就绪层独立判定：${input.gate.publicationReadiness.verdict}）` : ""}。`);
  } else {
    lines.push("- 任务层判定：本工作流不产生分层任务判定（见 Quality Gate 报告）。");
  }
  const issues = input.review?.issues ?? [];
  const ai = issues.filter(isAiSuggestion);
  lines.push(`- AI 学术审稿建议（L2，未经核验，不构成硬性阻断）：${ai.length} 条${input.review !== null ? `（review r${input.review.round}）` : ""}。`);
  const l1 = input.gate?.l1Failures ?? [];
  lines.push(`- 已证实问题（L1 确定性 / 复算 / 元数据核验）：${l1.length === 0 ? "0" : `${l1.length}（${l1.slice(0, 4).map((item) => clip(item, 60)).join("；")}）`}。`);
  lines.push("");

  // 3. 需要补实验 / 补来源 / 作者决定
  lines.push("### 3. 需要补实验、补来源或作者决定");
  const author = external.filter((instruction) => NEEDS_AUTHOR.has(instruction.status));
  const dataIssues = ai.filter(needsAuthorData);
  if (author.length === 0 && dataIssues.length === 0 && task?.verdict !== "AUTHOR_DECISION_REQUIRED") {
    lines.push("- 无（系统未登记需要作者提供数据或裁决的事项）。");
  } else {
    for (const instruction of author.slice(0, 8)) {
      lines.push(`- 意见 ${instruction.instructionId}（${instruction.status}）：${clip(instruction.text)}${instruction.statusNote !== undefined ? ` —— ${clip(instruction.statusNote, 60)}` : ""}`);
    }
    for (const issue of dataIssues.slice(0, 6)) {
      lines.push(`- 需作者数据 / 新实验（系统不会虚构结果）：${clip(issue.description)}`);
    }
    if (task?.verdict === "AUTHOR_DECISION_REQUIRED") {
      lines.push(`- 任务层要求作者裁决：${task.reasons.slice(0, 3).map((reason) => clip(reason, 70)).join("；") || "见 Quality Gate 报告"}`);
    }
  }
  lines.push("");

  // 4. 期刊投稿规范差距
  lines.push("### 4. 与已核验期刊投稿规范的差距");
  const assessment = input.journalAssessment;
  if (assessment === null) {
    lines.push("- 尚未生成目标期刊评估（项目「目标期刊」页可运行；零模型）。");
  } else if (!assessment.journal.verification.trusted || assessment.journal.journalId === null) {
    lines.push(`- ${assessment.journal.displayName}：期刊资料未核实（${assessment.journal.verification.status}）——不生成投稿规范条目，也不推断任何格式要求。`);
  } else {
    const stale = assessment.manuscript.revision !== null && assessment.manuscript.revision !== input.currentRevision;
    const violated = assessment.criteria.filter((criterion) => criterion.status === "VIOLATED");
    const notEvaluated = assessment.criteria.filter((criterion) => criterion.status === "NOT_EVALUATED").length;
    lines.push(`- ${assessment.journal.displayName}（规则版本 ${assessment.journal.rulesVersion ?? "?"}，评估于 rev-${assessment.manuscript.revision ?? "?"}${stale ? `；当前稿为 rev-${input.currentRevision}，该评估已过期，需重新评估` : ""}）：不符合 ${violated.length} 条，未能评估 ${notEvaluated} 条。`);
    for (const criterion of violated.slice(0, 8)) {
      lines.push(`  - ${criterion.blocking ? "【官方明确要求】" : "【官方建议】"}${criterion.title}：${clip(criterion.observed, 60)}（来源 ${criterion.sourceUrl}）`);
    }
  }
  lines.push("- 合规条目只来自期刊官方页面原句；合规满足不推导学术水准合格，AI 学术建议也不会变成官方硬门。");
  lines.push("");

  // 5. 下一步优先改什么
  lines.push("### 5. 下一步值得优先改什么");
  const next: string[] = [];
  for (const item of l1.slice(0, 3)) next.push(`[已证实] ${clip(item, 80)}`);
  for (const instruction of external.filter((entry) => !RESOLVED.has(entry.status)).slice(0, 3)) next.push(`[外部意见 ${instruction.instructionId}] ${clip(instruction.text, 80)}`);
  if (assessment !== null && assessment.journal.verification.trusted) {
    for (const criterion of assessment.criteria.filter((entry) => entry.status === "VIOLATED" && entry.blocking).slice(0, 2)) next.push(`[期刊官方要求] ${criterion.title}`);
  }
  const order = new Map(focus.map((dim, index) => [dim.id, index]));
  const rankedAi = [...ai].sort((a, b) => {
    const ra = a.policyDimension !== undefined ? (order.get(a.policyDimension) ?? 99) : 99;
    const rb = b.policyDimension !== undefined ? (order.get(b.policyDimension) ?? 99) : 99;
    if (ra !== rb) return ra - rb;
    return (a.severity === "major" ? 0 : 1) - (b.severity === "major" ? 0 : 1);
  });
  for (const issue of rankedAi.slice(0, 4)) {
    const dim = issue.policyDimension !== undefined ? policyDimension(issue.policyDimension)?.label : undefined;
    next.push(`[AI 建议${dim !== undefined ? ` · ${dim}` : ""}] ${clip(issue.description, 80)}`);
  }
  if (next.length === 0) lines.push("- 当前没有登记的待办项。");
  else next.slice(0, 10).forEach((entry, index) => lines.push(`${index + 1}. ${entry}`));
  lines.push("");
  // 与 revision.plan 同一条件：只有冻结政策 active 的 run 才延后整稿 AI 建议（inactive / 旧 run 仍按既有规则派发 major）
  if (policy?.["active"] === true) lines.push("> 新一轮审稿产生的非阻断学术建议进入「下一轮可选改进清单」，不会自动追加为本轮必修项；新出现的已证实事实 / 引用回归仍按确定性守卫硬阻断。");
  lines.push("> 本报告不预测录用，也不证明稿件达到某分区 / 期刊的学术水平。");
  lines.push("");
  return lines;
}
