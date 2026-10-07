/**
 * Review 聚合层—— 确定性代码，不是 LLM。
 *
 * 汇总 fact / academic / style 三路 review 的结构化结果：
 * - issue 去重（同 category+section+description 只保留一条）
 * - 按 severity / category 计数
 * - 汇总评分：academicScore（学术）、styleRisk（文风风险）、fact verdicts
 * 最终状态转换（是否进入 revision、是否超限）由 WorkflowOrchestrator 决定，
 * 本层只做确定性的合并与统计。
 */

import type { FactVerdict, ModeReviewResult, ReviewIssue } from "../agents/ReviewerService.js";
import type { ReviewFinding } from "./finding.js";

export interface ReviewSummary {
  generatedAt: string;
  round: number;
  /** 本轮 review 审阅的 manuscript 修订（M4.7；由 review.run stage 写入。
   *  旧产物无此字段 → 下游按「未对齐」处理，不盲信） */
  reviewedRevision?: number;
  issues: ReviewIssue[];
  counts: {
    critical: number;
    major: number;
    minor: number;
    byCategory: Record<string, number>;
    blocking: number;
  };
  scores: {
    academicScore: number | null;
    styleRisk: number | null;
    factVerdicts: Record<FactVerdict, number> | null;
  };
  /** Quality Gate 关心的问题口径 */
  openCritical: number;
  openMajor: number;
  unsupportedCriticalClaims: number;
  /**
   * M11.3（Phase D）：被确定性检测反证的 build 类 finding（review digest 视图
   * 伪影——真实稿件无该结构问题）。不计入 issues / counts（不再阻断、不派发
   * Writer），单独保留供报告 / 前端透明展示。
   */
  disconfirmedIssues?: ReviewIssue[];
  /**
   * M12.2 B5：视觉类 finding 的单列汇总（advisory 口径）。**不进**
   * counts.bySeverity / byCategory / blocking，**不参与** openCritical /
   * openMajor / academicScore / styleRisk / factVerdicts 的任何计算——视觉
   * finding 是独立一列（单列可见性），绝不稀释既有评分语义。由视觉评审
   * 调用方（workflow review stage / HTTP 层）经 summarizeVisualFindings
   * 生成后附加；旧产物无该字段照常可读。
   */
  visual?: VisualFindingsSummary;
  reportPaths: string[];
}

/** 视觉类 finding 的单列汇总（M12.2 B5；独立于既有 counts/scores 口径） */
export interface VisualFindingsSummary {
  total: number;
  bySeverity: { critical: number; major: number; minor: number; info: number };
  /** 核验状态分布（Figure ≠ Evidence：model_observation 不是自动核验证据） */
  byVerification: Record<"verified_deterministic" | "model_observation" | "needs_author_review", number>;
  /** 来源分布：deterministic-visual（确定性检查） vs vision-assisted（模型观察） */
  byOrigin: { deterministic: number; visionAssisted: number; other: number };
}

/**
 * 汇总视觉类 finding（纯函数）。只统计 category="visual" 的条目；
 * 非 visual 条目一概忽略（防御：混入的其它类目不产生计数）。
 * 既有聚合口径（aggregateReviews）零改动——本函数的产物只以 ReviewSummary.visual
 * 单列附加。
 */
export function summarizeVisualFindings(findings: ReadonlyArray<ReviewFinding>): VisualFindingsSummary {
  const summary: VisualFindingsSummary = {
    total: 0,
    bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
    byVerification: { verified_deterministic: 0, model_observation: 0, needs_author_review: 0 },
    byOrigin: { deterministic: 0, visionAssisted: 0, other: 0 },
  };
  for (const finding of findings) {
    if (finding.category !== "visual") {
      continue;
    }
    summary.total += 1;
    summary.bySeverity[finding.severity] += 1;
    if (finding.verificationStatus !== undefined) {
      summary.byVerification[finding.verificationStatus] += 1;
    }
    if (finding.source === "deterministic-visual") {
      summary.byOrigin.deterministic += 1;
    } else if (finding.source === "vision-assisted") {
      summary.byOrigin.visionAssisted += 1;
    } else {
      summary.byOrigin.other += 1;
    }
  }
  return summary;
}

export function aggregateReviews(
  results: ModeReviewResult[],
  round: number,
  reportPaths: string[] = [],
): ReviewSummary {
  const seen = new Set<string>();
  const issues: ReviewIssue[] = [];
  for (const result of results) {
    for (const issue of result.issues) {
      const key = `${issue.category}|${issue.section}|${issue.description}`;
      if (seen.has(key)) {
        continue; // 三路 review 报出完全相同的问题时去重
      }
      seen.add(key);
      issues.push(issue);
    }
  }

  const byCategory: Record<string, number> = {};
  let critical = 0;
  let major = 0;
  let minor = 0;
  let blocking = 0;
  for (const issue of issues) {
    byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
    if (issue.severity === "critical") {
      critical += 1;
    } else if (issue.severity === "major") {
      major += 1;
    } else {
      minor += 1;
    }
    if (issue.blocking) {
      blocking += 1;
    }
  }

  const academic = results.find((result) => result.mode === "academic");
  const style = results.find((result) => result.mode === "style");
  const fact = results.find((result) => result.mode === "fact");

  let factVerdicts: Record<FactVerdict, number> | null = null;
  let unsupportedCriticalClaims = 0;
  if (fact?.claims !== undefined) {
    factVerdicts = { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 };
    for (const claim of fact.claims) {
      factVerdicts[claim.verdict] += 1;
    }
    // 无支撑 / 矛盾的关键 claim（配对的 critical issue 是 hard gate 的直接依据）
    unsupportedCriticalClaims = fact.claims.filter(
      (claim) => claim.verdict === "UNSUPPORTED" || claim.verdict === "CONTRADICTED",
    ).length;
  }

  return {
    generatedAt: new Date().toISOString(),
    round,
    issues,
    counts: { critical, major, minor, byCategory, blocking },
    scores: {
      academicScore: academic?.overallScore ?? null,
      styleRisk: style?.riskScore ?? null,
      factVerdicts,
    },
    openCritical: critical,
    openMajor: major,
    unsupportedCriticalClaims,
    reportPaths,
  };
}
