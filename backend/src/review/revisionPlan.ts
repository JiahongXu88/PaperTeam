/**
 * Revision Plan（M4.7，D-0026：确定性产物，不新增 RevisionPlanner Agent）。
 *
 * 从「最新 ReviewSummary + Citation 报告 + Build 错误」确定性派生修订计划并落盘
 * （reviews/revision-plan-r{round}.json）。Writer 的修订以本计划为准（section-scoped），
 * 不再在执行期临时拼指令；计划与该轮 scorecard / gate 结果通过 round 关联。
 *
 * 派生规则（确定性，无 LLM）：
 * - critical / blocking finding → priority high（必改）
 * - major finding              → priority medium（必改）
 * - minor finding              → 记录但不自动修（status=skipped，避免非收敛）
 * - 引用 missing key           → kind=citation_missing，critical（只允许删除/弱化，
 *                                永远不允许凭空新造文献条目）
 * - 编译错误                    → kind=build_error（修复循环消费）
 * - 无章节归属的 gate 阻止项     → kind=gate_blocker，记录不派发（Writer 无从下手）
 */

import { createHash } from "node:crypto";

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { ReviewSummary } from "./ReviewAggregator.js";

export type RevisionPlanItemKind =
  | "review_finding"
  | "citation_missing"
  | "build_error"
  | "gate_blocker";

export type RevisionPlanItemStatus = "planned" | "skipped";

export interface RevisionPlanItem {
  /** 稳定 id（finding 指纹 / citation-missing:{key} / build-error / gate:{rule}） */
  id: string;
  kind: RevisionPlanItemKind;
  priority: "high" | "medium" | "low";
  /** 匹配修订目标的章节引用（路径 / id / 文件名；(global) 表示无章节归属） */
  section: string;
  problem: string;
  instruction: string;
  expectedOutcome: string;
  status: RevisionPlanItemStatus;
  /** 证据不足类问题：修订时只能弱化 / 删除，不允许编造 */
  needsEvidence?: boolean;
  /** skipped 的原因（记录但不派发） */
  note?: string;
}

export interface RevisionPlan {
  schemaVersion: 1;
  planId: string;
  projectId: string;
  /** 计划针对的 manuscript 修订（该轮 review 审阅的版本） */
  sourceRevision: number;
  /** 计划依据的 review 轮次 */
  reviewRound: number;
  createdAt: string;
  summary: {
    critical: number;
    major: number;
    blocking: number;
    /** 记录但不自动修的 minor 条数 */
    minorRecorded: number;
    planned: number;
    skipped: number;
  };
  items: RevisionPlanItem[];
}

/** ReviewIssue 的确定性指纹（跨轮跟踪同一问题的稳定 id） */
export function findingFingerprint(issue: Pick<ReviewIssue, "category" | "section" | "description">): string {
  const hash = createHash("sha256")
    .update(`${issue.category}|${issue.section}|${issue.description}`)
    .digest("hex")
    .slice(0, 12);
  return `f-${hash}`;
}

export interface BuildRevisionPlanInput {
  projectId: string;
  sourceRevision: number;
  reviewRound: number;
  summary: ReviewSummary;
  /** 引用核验发现的 missing key → 出现该引用的文件（确定性扫描结果） */
  citationMissing?: { key: string; files: string[] }[];
  /** 编译错误（修复循环 / 带 buildError 的修订消费） */
  buildError?: { message: string; file?: string };
  /** gate 阻止项（ruleId + detail；无章节归属的记录为 gate_blocker） */
  gateBlockers?: { rule: string; detail: string }[];
  createdAt?: string;
}

/** 确定性派生修订计划（纯函数：同输入同输出，可测试） */
export function buildRevisionPlan(input: BuildRevisionPlanInput): RevisionPlan {
  const items: RevisionPlanItem[] = [];

  for (const issue of input.summary.issues) {
    const blocking = issue.blocking;
    const severity = issue.severity;
    if (severity === "critical" || blocking) {
      items.push(findingItem(issue, "high", "planned"));
    } else if (severity === "major") {
      items.push(findingItem(issue, "medium", "planned"));
    } else {
      // minor：记录但不自动修（D-0026：避免小问题来回改导致不收敛）
      items.push(
        withNote(findingItem(issue, "low", "skipped"), "minor：已记录，不进入自动修订"),
      );
    }
  }

  for (const missing of input.citationMissing ?? []) {
    for (const file of missing.files.length > 0 ? missing.files : ["(unknown)"]) {
      items.push({
        id: `citation-missing:${missing.key}:${file}`,
        kind: "citation_missing",
        priority: "high",
        section: file,
        problem: `引用 \\cite{${missing.key}} 在 references.bib 中不存在`,
        instruction: "删除该引用，或改为只基于现有文献的表述；禁止新造参考文献条目",
        expectedOutcome: `章节 ${file} 不再引用缺失 key ${missing.key}`,
        status: "planned",
      });
    }
  }

  if (input.buildError !== undefined) {
    items.push({
      id: "build-error:latest",
      kind: "build_error",
      priority: "high",
      section: input.buildError.file ?? "(global)",
      problem: `LaTeX 编译失败：${input.buildError.message.slice(0, 300)}`,
      instruction: "修复编译错误（语法 / 未定义命令 / 环境配对），不改变论述内容",
      expectedOutcome: "main.tex 可通过 latexmk/xelatex 编译并产出 PDF",
      status: "planned",
      ...(input.buildError.file !== undefined ? {} : { note: "错误未定位到具体文件，按全局处理" }),
    });
  }

  for (const blocker of input.gateBlockers ?? []) {
    items.push({
      id: `gate:${blocker.rule}`,
      kind: "gate_blocker",
      priority: "high",
      section: "(global)",
      problem: `${blocker.rule}: ${blocker.detail}`.slice(0, 300),
      instruction: "（无直接章节修改路径；由对应 finding 条目或人工处理）",
      expectedOutcome: "该 gate 规则转为通过",
      status: "skipped",
      note: "gate 阻止项无章节归属，不派发给 Writer",
    });
  }

  // 确定性排序：priority（high → medium → low）→ id（稳定 tie-break）
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  items.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.id.localeCompare(b.id));

  const planned = items.filter((item) => item.status === "planned").length;
  return {
    schemaVersion: 1,
    planId: `plan-r${input.reviewRound}-rev${input.sourceRevision}`,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    reviewRound: input.reviewRound,
    createdAt: input.createdAt ?? new Date().toISOString(),
    summary: {
      critical: input.summary.counts.critical,
      major: input.summary.counts.major,
      blocking: input.summary.counts.blocking,
      minorRecorded: input.summary.counts.minor,
      planned,
      skipped: items.length - planned,
    },
    items,
  };
}

function findingItem(
  issue: ReviewIssue,
  priority: "high" | "medium" | "low",
  status: RevisionPlanItemStatus,
): RevisionPlanItem {
  return {
    id: findingFingerprint(issue),
    kind: "review_finding",
    priority,
    section: issue.section || "(unknown)",
    problem: issue.description,
    instruction: issue.suggestedAction ?? defaultInstruction(issue),
    expectedOutcome:
      issue.severity === "critical" || issue.blocking
        ? "该 critical/blocking 问题在复审中不再出现"
        : "该 major 问题在复审中不再出现",
    status,
    ...(needsEvidence(issue) ? { needsEvidence: true } : {}),
  };
}

function withNote(item: RevisionPlanItem, note: string): RevisionPlanItem {
  return { ...item, note };
}

function needsEvidence(issue: ReviewIssue): boolean {
  return issue.category.toLowerCase().includes("evidence") || issue.category.toLowerCase().includes("fact");
}

function defaultInstruction(issue: ReviewIssue): string {
  if (needsEvidence(issue)) {
    return "基于现有 Evidence 修正论述；证据不足的论断弱化或删除（不允许编造）";
  }
  if (issue.category === "citation") {
    return "修正引用问题；只允许引用 references.bib 中的现有 key";
  }
  return "针对问题修改本章节论述，保持与其余章节一致";
}
