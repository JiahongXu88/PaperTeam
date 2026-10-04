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
 * M11.2.3（D-4 Revision Convergence / Regression Control）扩展：
 * - IterationScorecard 追加 unsupported（opaque 口径）与 factViolations /
 *   citationViolations——「修好 A 破坏 B」的回归以前藏在 critical 计数里
 *   看不见；MOT r1→r8 振荡（81→77）的直接观测缺口。
 * - judgeConvergence：跨轮确定性收敛策略 PROGRESS / STALLED / REGRESSED
 *   （§17）。STALLED = 连续两轮核心阻断指标（blocking / critical /
 *   opaqueUnsupported）无改善；REGRESSED = 本轮新增 critical 或 fact /
 *   citation 违规上升。消费方 = planSharedTail（NO_PROGRESS 终态）与
 *   stalled HITL payload——不使用 LLM 决定要不要继续。
 *
 * MAX_ITERATIONS 不是对比结论：由 planner 的修订预算判定（budget 耗尽 → overflow HITL）。
 * 第一轮（无上一轮可比）不判定对比结论（outcome=null，如实记录）。
 */

import type { ReviewSummary } from "./ReviewAggregator.js";
import type { QualityGateResult } from "../quality/gates.js";
import type { ClaimGroundingReport } from "./claimGrounding.js";
import type { FactPreservationSummary } from "../quality/factPreservation.js";
import type { CitationPreservationSummary } from "../quality/citationPreservation.js";

export type RevisionOutcome = "PASS" | "IMPROVED" | "CONVERGED" | "REGRESSION";

/** 自动 LaTeX 修复的每轮上限（bounded repair loop；planner 消费） */
export const MAX_AUTO_LATEX_REPAIRS = 2;

/**
 * M11.2.3：确定性收敛状态（§17）。
 * - PROGRESS：核心阻断指标（blocking / critical / opaqueUnsupported）至少一项
 *   下降且无新 critical / fact / citation 回归 → 自动循环可继续。
 * - STALLED：连续两轮核心指标无任何改善 → 停止自动循环（NO_PROGRESS）。
 * - REGRESSED：本轮新增 critical 或 fact / citation 违规上升 → 优先修新回归
 *   或停止自动循环（不再按「还有轮数」盲目继续）。
 */
export type RevisionConvergence = "PROGRESS" | "STALLED" | "REGRESSED";

/**
 * M11.3（Phase E）产品终态语义（工作流完成 / HITL / 报告的统一口径）。
 *
 * - PASS：双 Gate 通过，正常 Final / Draft 冻结；
 * - QUALITY_NOT_REACHED：论文已生成，但自动质量验收未达到目标（正常终态，
 *   不是系统崩溃——Draft PDF 可用，剩余问题如实呈现）；
 * - NO_PROGRESS：自动修订已达收敛上限，继续自动修改预计收益有限；
 * - AUTHOR_DECISION_REQUIRED：需要作者提供额外信息 / 研究判断 / 数据；
 * - SYSTEM_FAILED：守卫类规则（事实 / 引用保持、survey 契约）未满足——
 *   冻结产物不安全，属系统级失败语义。
 *
 * 判定确定性（无 LLM）：gateReasons 的守卫类前缀 → SYSTEM_FAILED；
 * 否则 STALLED 收敛 + 同轮 author_decision_required claim > 0 →
 * AUTHOR_DECISION_REQUIRED；STALLED → NO_PROGRESS；其余 → QUALITY_NOT_REACHED。
 */
export type TerminalStatusKind =
  | "PASS"
  | "QUALITY_NOT_REACHED"
  | "NO_PROGRESS"
  | "AUTHOR_DECISION_REQUIRED"
  | "SYSTEM_FAILED";

const GUARD_RULE_PREFIX =
  /^(fact_preservation|cumulative_fact_preservation|citation_preservation|survey_outline_contract|survey_citation_keys_valid|survey_synthesis_traceability)[:：]/;

export interface TerminalStatusInput {
  gatePassed: boolean;
  gateReasons: readonly string[];
  convergence: RevisionConvergence | null;
  /** 同轮 claim resolution 中 author_decision_required 的条数（0 / 缺省 = 无） */
  authorDecisionClaims?: number;
}

export interface TerminalStatus {
  status: TerminalStatusKind;
  /** 用户可读语义（前端 / 报告直接消费；不暴露内部术语） */
  message: string;
}

export function classifyTerminalStatus(input: TerminalStatusInput): TerminalStatus {
  if (input.gatePassed) {
    return { status: "PASS", message: "质量验收通过，论文已冻结。" };
  }
  const guardFailed = input.gateReasons.some((reason) => GUARD_RULE_PREFIX.test(reason));
  if (guardFailed) {
    return {
      status: "SYSTEM_FAILED",
      message: "事实 / 引用守卫未满足（冻结产物不安全）——系统级失败，需要排查修订链。",
    };
  }
  if (input.convergence === "STALLED") {
    if ((input.authorDecisionClaims ?? 0) > 0) {
      return {
        status: "AUTHOR_DECISION_REQUIRED",
        message: "自动修订已停止：剩余问题需要作者提供研究判断或额外数据（语言模型改稿无法解决）。",
      };
    }
    return {
      status: "NO_PROGRESS",
      message: "自动修订已达到收敛上限，继续自动修改预计收益有限；当前稿可作为 Draft 使用。",
    };
  }
  return {
    status: "QUALITY_NOT_REACHED",
    message: "论文已生成，但自动质量验收未达到目标；Draft 可用，剩余问题见质量报告。",
  };
}

/** 一轮迭代的可比记分卡（iteration-history 的确定性内容） */
export interface IterationScorecard {
  gatePassed: boolean;
  failedRuleIds: string[];
  critical: number;
  major: number;
  blocking: number;
  academicScore: number | null;
  styleRisk: number | null;
  /** M11.2.3：opaque 口径的 UNSUPPORTED/CONTRADICTED claim 数（缺省 = 未记录，兼容旧产物） */
  unsupportedOpaque?: number;
  /** M11.2.3：透明未核验转述数（观测口径，不参与阻断判定） */
  unsupportedTransparent?: number;
  /** M11.2.3：本轮 fact preservation 违规总数（changed+removed+added+direction+formula+placeholder） */
  factViolations?: number;
  /** M11.2.3：本轮 citation preservation 违规总数（unexpectedRemoved） */
  citationViolations?: number;
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

/** fact / citation 违规容差：≤ 该值的新增视为配对噪声（token 化口径的确定性边界） */
const PRESERVATION_REGRESSION_TOLERANCE = 0;

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

  // REGRESSION：新增 critical / blocking 增加 /（blocking 持平但学分大幅下滑）。
  // M11.2.3 设计决定：fact / citation 守卫违规上升**不并入** outcome 的
  // REGRESSION——守卫违规有确定性修复路径（fact_preserve 派发 / restore_facts），
  // 修订环应先获得一轮修复机会；「修 A 破 B」的回归信号进 scorecard /
  // scorecardDelta / judgeConvergence（REGRESSED），在报告与 stalled 判定中
  // 如实可见，但不阻断自动修复轮。
  const newCritical = current.critical - previous.critical;
  const blockingDelta = current.blocking - previous.blocking;
  const academicDrop =
    current.academicScore !== null && previous.academicScore !== null
      ? previous.academicScore - current.academicScore
      : 0;
  if (
    newCritical > 0 ||
    blockingDelta > 0 ||
    (blockingDelta === 0 && academicDrop > ACADEMIC_REGRESSION_DROP)
  ) {
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

/**
 * M11.2.3：跨轮收敛策略（§17；确定性，无 LLM）。
 * history = 历史 scorecard（旧 → 新；含本轮）。至少 3 条才可能 STALLED：
 * 最近两轮（均未 PASS）核心阻断指标（blocking / critical / unsupportedOpaque）
 * 相对各自前一轮都无改善 → STALLED。最近一轮出现 critical / fact / citation
 * 回归 → REGRESSED。否则 PROGRESS。
 */
export function judgeConvergence(
  history: readonly IterationScorecard[],
): RevisionConvergence | null {
  if (history.length < 2) {
    return null;
  }
  const current = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  if (current.gatePassed) {
    return null; // PASS 语义由 outcome 表达
  }
  const improved = (now: IterationScorecard, before: IterationScorecard): boolean =>
    now.failedRuleIds.length < before.failedRuleIds.length ||
    now.critical + now.major < before.critical + before.major ||
    now.blocking < before.blocking ||
    (now.unsupportedOpaque ?? 0) < (before.unsupportedOpaque ?? 0);
  const factRegression =
    (current.factViolations ?? 0) - (previous.factViolations ?? 0) > PRESERVATION_REGRESSION_TOLERANCE;
  const citationRegression =
    (current.citationViolations ?? 0) - (previous.citationViolations ?? 0) >
    PRESERVATION_REGRESSION_TOLERANCE;
  const criticalRegression = current.critical > previous.critical;
  if (factRegression || citationRegression || criticalRegression) {
    return "REGRESSED";
  }
  if (!improved(current, previous)) {
    // 连续两轮无改善才判 STALLED（首轮不可比时证据不足，交 judgeOutcome 的
    // 单轮 CONVERGED 口径，不提前终止自动循环）
    const beforePrevious = history[history.length - 3];
    if (beforePrevious === undefined) {
      return null;
    }
    const stalledTwoRounds = !previous.gatePassed && !improved(previous, beforePrevious);
    return stalledTwoRounds ? "STALLED" : "REGRESSED";
  }
  return "PROGRESS";
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

/**
 * M11.2.3：记分卡的收敛观测扩展（unsupported 口径 + 守卫违规数）。
 * claimGrounding / factPreservation / citationPreservation 为 null / undefined
 * 时对应字段缺省（旧产物兼容：iteration-history 的历史记录没有这些字段）。
 */
export function scorecardWithConvergenceMetrics(
  scorecard: IterationScorecard,
  claimGrounding: ClaimGroundingReport | null | undefined,
  factPreservation: FactPreservationSummary | null | undefined,
  citationPreservation: CitationPreservationSummary | null | undefined,
): IterationScorecard {
  const factViolations = (summary: FactPreservationSummary): number =>
    summary.changedFacts.length +
    summary.removedFacts.length +
    summary.addedUnsupportedFacts.length +
    summary.directionalChanges.length +
    summary.formulaChanges.length +
    summary.placeholderRegressions.length;
  return {
    ...scorecard,
    ...(claimGrounding != null
      ? {
          unsupportedOpaque: claimGrounding.opaqueUnsupportedClaims,
          unsupportedTransparent: claimGrounding.transparentUnsupportedClaims,
        }
      : {}),
    ...(factPreservation != null ? { factViolations: factViolations(factPreservation) } : {}),
    ...(citationPreservation?.ok === false
      ? { citationViolations: citationPreservation.unexpectedRemoved.length }
      : {}),
  };
}

/**
 * M11.2.3（§16 Revision Round Quality Delta）：两轮记分卡的逐项差值。
 * resolved = 消失的失败规则数；newRegressions = 新增 critical / fact /
 * citation 回归计数（修 A 破 B 的观测口径，进 stalled payload 与报告）。
 */
export function scorecardDelta(
  current: IterationScorecard,
  previous: IterationScorecard | null,
): {
  resolvedFailedRules: number;
  newFailedRules: number;
  criticalDelta: number;
  blockingDelta: number;
  unsupportedDelta: number | null;
  newRegressions: { critical: number; fact: number; citation: number };
} {
  const currentFailed = new Set(current.failedRuleIds);
  const previousFailed = new Set(previous?.failedRuleIds ?? []);
  const resolvedFailedRules = [...previousFailed].filter((id) => !currentFailed.has(id)).length;
  const newFailedRules = [...currentFailed].filter((id) => !previousFailed.has(id)).length;
  return {
    resolvedFailedRules,
    newFailedRules,
    criticalDelta: current.critical - (previous?.critical ?? 0),
    blockingDelta: current.blocking - (previous?.blocking ?? 0),
    unsupportedDelta:
      current.unsupportedOpaque !== undefined && previous?.unsupportedOpaque !== undefined
        ? current.unsupportedOpaque - previous.unsupportedOpaque
        : null,
    newRegressions: {
      critical: Math.max(0, current.critical - (previous?.critical ?? 0)),
      fact: Math.max(0, (current.factViolations ?? 0) - (previous?.factViolations ?? 0)),
      citation: Math.max(
        0,
        (current.citationViolations ?? 0) - (previous?.citationViolations ?? 0),
      ),
    },
  };
}
