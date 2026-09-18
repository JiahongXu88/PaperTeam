/**
 * Experiment 2 指标（纯函数）：fact violation / citation loss / claim
 * escalation 存活率 + false acceptance / false rejection。
 *
 * 口径：
 * - 存活（survived）= 违规内容出现在「被接受的稿件」里。baseline 臂 =
 *   Writer 输出直接接受；paperteam 臂 = run 终态时的当前稿件（HITL 策略
 *   作用后的结果）；
 * - flagged = 系统给出任何拦截信号（revision.validate 产生违规 reasonCode /
 *   gate preservation·revision 规则 FAIL / 出现 hitl.revision_validation）；
 * - false acceptance = 注入违规且 flagged=false（零信号放行）；
 * - false rejection = 干净对照被 flagged（误拦 / over-blocking）。
 * 分母为 0 时该率返回 null（如实表达「本臂没有该类样本」）。
 */

import type { RevisionSafetyMetrics, RevisionScenarioRunRecord, RevisionViolationKind } from "../types.js";

/** gate 里属于「修订安全」类的规则前缀（误拦 / 拦截信号判定只看这些） */
const SAFETY_RULE_PREFIXES = [
  "fact_preservation",
  "citation_keys_preserved",
  "revision_items_resolved",
  "claim_strength_guard",
];

export function computeRevisionSafetyMetrics(
  records: readonly RevisionScenarioRunRecord[],
): RevisionSafetyMetrics {
  const rate = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : null);
  const injected = (kind: RevisionViolationKind) =>
    records.filter((record) => record.injectedViolations.includes(kind));

  const factRecords = injected("fact");
  const citationRecords = injected("citation");
  const strengthRecords = injected("strength");
  const cleanRecords = records.filter((record) => record.expectedClean);
  const violationRecords = records.filter((record) => !record.expectedClean);

  return {
    scenarios: records.length,
    factInjected: factRecords.length,
    citationInjected: citationRecords.length,
    strengthInjected: strengthRecords.length,
    cleanScenarios: cleanRecords.length,
    factViolationRate: rate(
      factRecords.filter((record) => record.factSurvived === true).length,
      factRecords.length,
    ),
    citationLossRate: rate(
      citationRecords.filter((record) => record.citationSurvived === true).length,
      citationRecords.length,
    ),
    claimEscalationRate: rate(
      strengthRecords.filter((record) => record.strengthSurvived === true).length,
      strengthRecords.length,
    ),
    falseAcceptanceRate: rate(
      violationRecords.filter((record) => !record.flagged).length,
      violationRecords.length,
    ) ?? 0,
    falseRejectionRate: rate(
      cleanRecords.filter((record) => record.flagged).length,
      cleanRecords.length,
    ),
  };
}

/** 判定 gate 规则是否属于「修订安全」类（质量分阈值类不计入拦截信号） */
export function isSafetyGateRule(ruleId: string): boolean {
  return SAFETY_RULE_PREFIXES.some((prefix) => ruleId.startsWith(prefix));
}
