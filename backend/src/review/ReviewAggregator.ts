/**
 * Review 聚合层（M3.2）—— 确定性代码，不是 LLM。
 *
 * 汇总 fact / academic / style 三路 review 的结构化结果：
 * - issue 去重（同 category+section+description 只保留一条）
 * - 按 severity / category 计数
 * - 汇总评分：academicScore（学术）、styleRisk（文风风险）、fact verdicts
 * 最终状态转换（是否进入 revision、是否超限）由 WorkflowOrchestrator 决定，
 * 本层只做确定性的合并与统计。
 */

import type { FactVerdict, ModeReviewResult, ReviewIssue } from "../agents/ReviewerService.js";

export interface ReviewSummary {
  generatedAt: string;
  round: number;
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
  reportPaths: string[];
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
