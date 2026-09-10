/**
 * 收敛判定（M4.7，D-0026；确定性代码，无 LLM）。
 *
 * 每轮 Quality Gate 后，把本轮与上一轮的结构化结果（failedRuleIds /
 * critical / major / blocking / academicScore）对比，判定：
 *   PASS        gate 通过（终止，进入 Final）
 *   IMPROVED    有实质改善（失败规则减少，或 critical/major 下降）→ 继续循环
 *   CONVERGED   无实质改善（失败规则集相同且 critical+major 未下降）→ HITL
 *   REGRESSION  明显退化（新增 critical / blocking 增加 / 学分大幅下滑）→ HITL，不盲目继续
 *
 * MAX_ITERATIONS 不是对比结论：由 planner 的修订预算判定（budget 耗尽 → overflow HITL）。
 * 第一轮（无上一轮可比）不判定对比结论（outcome=null，如实记录）。
 */

import type { ReviewSummary } from "./ReviewAggregator.js";
import type { QualityGateResult } from "../quality/gates.js";

export type RevisionOutcome = "PASS" | "IMPROVED" | "CONVERGED" | "REGRESSION";

/** 自动 LaTeX 修复的每轮上限（bounded repair loop；planner 消费） */
export const MAX_AUTO_LATEX_REPAIRS = 2;

/** 一轮迭代的可比记分卡（iteration-history 的确定性内容） */
export interface IterationScorecard {
  gatePassed: boolean;
  failedRuleIds: string[];
  critical: number;
  major: number;
  blocking: number;
  academicScore: number | null;
  styleRisk: number | null;
}

export interface IterationRecord {
  /** 本轮迭代修订到的 manuscript revision（review 审阅的版本） */
  revision: number;
  reviewRound: number;
  gateRound: number;
  /** 对比结论（首轮无上一轮 → null） */
  outcome: RevisionOutcome | null;
  /** 依据的修订计划（本轮之后的修订所用的 plan） */
  planId?: string;
  completedAt: string;
  scorecard: IterationScorecard;
}

/** academicScore 单轮大幅下滑阈值（>10 分视为退化信号之一） */
const ACADEMIC_REGRESSION_DROP = 10;

/**
 * 对比本轮与上一轮记分卡，判定收敛结论。
 * previous 来自 iteration-history（上一条记录的 scorecard），不重读旧 gate / summary 产物。
 */
export function judgeOutcome(
  current: IterationScorecard,
  previous: IterationScorecard | null,
): RevisionOutcome | null {
  if (current.gatePassed) {
    return "PASS";
  }
  if (previous === null || previous.gatePassed) {
    // 没有可比的上一轮失败记录（或上一轮已通过）：无对比结论
    return null;
  }

  // REGRESSION：新增 critical / blocking 增加 /（blocking 持平但学分大幅下滑）
  const newCritical = current.critical - previous.critical;
  const blockingDelta = current.blocking - previous.blocking;
  const academicDrop =
    current.academicScore !== null && previous.academicScore !== null
      ? previous.academicScore - current.academicScore
      : 0;
  if (newCritical > 0 || blockingDelta > 0 || (blockingDelta === 0 && academicDrop > ACADEMIC_REGRESSION_DROP)) {
    return "REGRESSION";
  }

  // CONVERGED：失败规则集完全相同，且 critical+major 没有下降
  const sameRules =
    current.failedRuleIds.length === previous.failedRuleIds.length &&
    current.failedRuleIds.every((id, index) => id === previous.failedRuleIds[index]);
  const openHeavyCurrent = current.critical + current.major;
  const openHeavyPrior = previous.critical + previous.major;
  if (sameRules && openHeavyCurrent >= openHeavyPrior) {
    return "CONVERGED";
  }

  return "IMPROVED";
}

/** gate + summary → 记分卡（failedRuleIds 确定性排序） */
export function scorecardOf(
  gate: Pick<QualityGateResult, "passed" | "rules">,
  summary: Pick<ReviewSummary, "counts" | "scores">,
): IterationScorecard {
  return {
    gatePassed: gate.passed,
    failedRuleIds: gate.rules
      .filter((rule) => !rule.passed)
      .map((rule) => rule.rule)
      .sort(),
    critical: summary.counts.critical,
    major: summary.counts.major,
    blocking: summary.counts.blocking,
    academicScore: summary.scores.academicScore,
    styleRisk: summary.scores.styleRisk,
  };
}
