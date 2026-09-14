/**
 * Style Polish 策略与计划（M5.4，D-0031）。
 *
 * 既有语义不破坏：buildRevisionPlan 中 critical → planned、major → planned、minor
 * → skipped（D-0026）。风格问题通常是 minor，因此默认不会进入自动修订。本模块
 * 不改这条规则，而是增加「用户显式选择的语言润色目标」：
 *
 *   suggest_only（默认）  Style Reviewer 只给建议；minor 继续不进入 revision plan
 *   apply_once            用户明确选择应用语言润色：只有被选中的 style minor finding
 *                         生成 style revision plan item（revisionReason=style_polish），
 *                         默认最多一轮，不自动循环
 *
 * 严重度不做 hack（不把 style finding 人为升级成 major）；派发理由由
 * revisionReason / stylePolicy 显式携带。Quick Review（existing_paper_review）
 * 不消费本模块——它 100% 只读。
 */

import { createHash } from "node:crypto";

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { ReviewSummary } from "./ReviewAggregator.js";
import { findingFingerprint, type RevisionPlan, type RevisionPlanItem } from "./revisionPlan.js";

export const STYLE_POLICIES = ["suggest_only", "apply_once"] as const;
export type StylePolicy = (typeof STYLE_POLICIES)[number];
export const DEFAULT_STYLE_POLICY: StylePolicy = "suggest_only";

export function isStylePolicy(value: unknown): value is StylePolicy {
  return typeof value === "string" && (STYLE_POLICIES as readonly string[]).includes(value);
}

/** run.request 中的 stylePolicy（缺省 / 非法 → suggest_only；旧 run 同） */
export function readStylePolicy(request: Record<string, unknown> | undefined): StylePolicy {
  const value = request?.["stylePolicy"];
  return isStylePolicy(value) ? value : DEFAULT_STYLE_POLICY;
}

/** style finding 的稳定 id（与 revision plan 的 finding 指纹同源） */
export function styleFindingId(issue: Pick<ReviewIssue, "category" | "section" | "description">): string {
  return findingFingerprint(issue);
}

/** 可进入语言润色的 finding：style 类、minor 级、有可定位 section */
export function isPolishableStyleIssue(issue: ReviewIssue): boolean {
  return (
    issue.category === "style" &&
    issue.severity === "minor" &&
    issue.blocking !== true &&
    issue.section.trim() !== "" &&
    issue.section.trim() !== "(unknown)"
  );
}

/** Style finding 视图（HITL payload / UI 展示；不含 AI 概率类字段） */
export interface StyleFindingView {
  id: string;
  section: string;
  issue: string;
  reason?: string;
  proposedAction?: string;
  severity: ReviewIssue["severity"];
}

export function listStyleFindings(summary: Pick<ReviewSummary, "issues">): StyleFindingView[] {
  return summary.issues.filter(isPolishableStyleIssue).map((issue) => ({
    id: styleFindingId(issue),
    section: issue.section,
    issue: issue.description,
    ...(issue.reason !== undefined ? { reason: issue.reason } : {}),
    ...(issue.suggestedAction !== undefined ? { proposedAction: issue.suggestedAction } : {}),
    severity: issue.severity,
  }));
}

export interface BuildStylePolishPlanInput {
  projectId: string;
  sourceRevision: number;
  reviewRound: number;
  summary: Pick<ReviewSummary, "issues">;
  /** 用户选中的 finding id（缺省 = 全部可润色 style finding） */
  selectedFindingIds?: readonly string[];
  createdAt?: string;
}

/**
 * 确定性派生 style polish 计划（纯函数）：只含被选中的 style minor finding，
 * 全部 status=planned、priority=low、revisionReason=style_polish；不含任何
 * quality 类条目（quality 修订走 buildRevisionPlan）。
 */
export function buildStylePolishPlan(input: BuildStylePolishPlanInput): RevisionPlan {
  const selected = input.selectedFindingIds !== undefined ? new Set(input.selectedFindingIds) : undefined;
  const items: RevisionPlanItem[] = [];
  const seen = new Set<string>();
  let candidates = 0;
  for (const issue of input.summary.issues) {
    if (!isPolishableStyleIssue(issue)) {
      continue;
    }
    candidates += 1;
    const id = styleFindingId(issue);
    if (seen.has(id) || (selected !== undefined && !selected.has(id))) {
      continue;
    }
    seen.add(id);
    items.push({
      id,
      kind: "review_finding",
      priority: "low",
      section: issue.section.trim(),
      problem: issue.reason !== undefined ? `${issue.description}（原因：${issue.reason}）` : issue.description,
      instruction:
        issue.suggestedAction ??
        "只调整该处表达（去空泛 / 去重复 / 去机械排比 / 去翻译腔），不改任何事实、数字、引用、公式、术语与结论强度",
      expectedOutcome: "该处表达更清晰自然；事实、数字、引用、公式、术语、否定与比较方向、结论强度均不变",
      status: "planned",
      revisionReason: "style_polish",
    });
  }
  items.sort((a, b) => a.section.localeCompare(b.section) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    planId: `style-plan-r${input.reviewRound}-rev${input.sourceRevision}`,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    reviewRound: input.reviewRound,
    createdAt: input.createdAt ?? new Date().toISOString(),
    revisionReason: "style_polish",
    stylePolicy: "apply_once",
    summary: {
      critical: 0,
      major: 0,
      blocking: 0,
      minorRecorded: candidates,
      planned: items.length,
      skipped: Math.max(0, candidates - items.length),
    },
    items,
  };
}

/** Style polish 一轮的落盘结果（reviews/style-polish-r{round}.json；UI 展示） */
export interface StylePolishResult {
  schemaVersion: 1;
  planId: string;
  projectId: string;
  reviewRound: number;
  /** 润色所基于的 manuscript 修订 */
  sourceRevision: number;
  /** applied：已产生新修订；failed：invariant 未通过，原稿保留；noop：无可派发条目 */
  status: "applied" | "failed" | "noop";
  /** 新修订号（applied 时） */
  revision?: number;
  /** 选中的 finding id */
  selectedFindingIds: string[];
  /** 逐章节 invariant 结果 */
  sections: Array<{
    section: string;
    itemIds: string[];
    invariantOk: boolean;
    violations: Array<{ rule: string; detail: string }>;
  }>;
  completedAt: string;
  /** 结果指纹（审计） */
  fingerprint: string;
}

export function fingerprintStylePolish(result: Omit<StylePolishResult, "fingerprint">): string {
  return createHash("sha256")
    .update(JSON.stringify({ planId: result.planId, status: result.status, revision: result.revision ?? null, sections: result.sections }))
    .digest("hex")
    .slice(0, 16);
}
