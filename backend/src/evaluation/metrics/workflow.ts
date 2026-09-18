/**
 * Experiment 3 指标（纯函数）：claim correctness / citation correctness /
 * completeness / human preference。
 *
 * 口径（scripted 离线实验下度量的是「管线保障」而非生成质量，报告如实标注）：
 * - claim correctness = 输出中被引用论断可追溯到 verified evidence 的占比。
 *   plain 臂：verified evidence 恒为 0 → 0（结构性不可追溯）；paperteam 臂
 *   无语料场景同样为 0（legacy unverified 不构成正式证据——M6.6 口径，
 *   如实呈现而不是放宽）；
 * - citation correctness = 输出 \cite key 中未被判定捏造的占比（存在于该臂
 *   的合法 bibliography：plain = 场景已知真实文献；paperteam = research
 *   bibliography + 引用核验）。evidence-backed 覆盖是另一个维度，随 detail
 *   呈现不折进本指标；
 * - completeness = stage 完成率 / 章节覆盖 / 论断 needle 覆盖 / 引用覆盖
 *   四项平均（plain 臂 stage 项恒 0——单次生成没有管线）；
 * - human preference 由校准记录计算（metrics/calibration.ts），此处透传。
 */

import type { WorkflowMetrics } from "../types.js";

export interface WorkflowMetricInputs {
  /** 输出中全部 \cite key（去重） */
  citationsInOutput: string[];
  /** 其中合法（非捏造）的 key */
  validCitationKeys: string[];
  /** scenario 期望必须出现的引用 key */
  expectedCitationKeys: string[];
  /** scenario 期望 stage */
  expectedStages: string[];
  /** 实际 completed 的 stage */
  stagesCompleted: string[];
  /** 期望章节文件 */
  expectedSections: string[];
  /** 实际写出的章节文件 */
  sectionsWritten: string[];
  /** 期望论断 needle */
  expectedClaimNeedles: string[];
  /** 终稿文本（needle 覆盖检查用；plain 臂 = 单次输出） */
  outputText: string;
  /** 被引用论断中可追溯 verified evidence 的数量与论断总数（plain 臂 0/n） */
  traceableClaims: number;
  totalCitedClaims: number;
  /** 人工偏好（无记录 = null） */
  humanPreference: number | null;
}

function coverage(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) {
    return 1;
  }
  const actualSet = new Set(actual);
  return expected.filter((item) => actualSet.has(item)).length / expected.length;
}

export function computeWorkflowMetrics(input: WorkflowMetricInputs): WorkflowMetrics {
  const stageCompletion = coverage(input.expectedStages, input.stagesCompleted);
  const sectionCoverage = coverage(input.expectedSections, input.sectionsWritten);
  const citationCoverage = coverage(input.expectedCitationKeys, input.citationsInOutput);
  const claimNeedleCoverage = coverage(
    input.expectedClaimNeedles,
    input.expectedClaimNeedles.filter((needle) => input.outputText.includes(needle)),
  );
  const completeness = (stageCompletion + sectionCoverage + citationCoverage + claimNeedleCoverage) / 4;
  return {
    claimCorrectness:
      input.totalCitedClaims > 0 ? input.traceableClaims / input.totalCitedClaims : 0,
    citationCorrectness:
      input.citationsInOutput.length > 0
        ? input.validCitationKeys.length / input.citationsInOutput.length
        : 1,
    completeness,
    humanPreference: input.humanPreference,
  };
}

/** 跨场景聚合（场景均值——每个场景权重相等，任务粒度对齐） */
export function aggregateWorkflowMetrics(results: readonly { metrics: WorkflowMetrics }[]): WorkflowMetrics {
  const count = results.length;
  const mean = (pick: (metrics: WorkflowMetrics) => number) =>
    count > 0 ? results.reduce((sum, result) => sum + pick(result.metrics), 0) / count : 0;
  const preference = results
    .map((result) => result.metrics.humanPreference)
    .filter((value): value is number => value !== null);
  return {
    claimCorrectness: mean((m) => m.claimCorrectness),
    citationCorrectness: mean((m) => m.citationCorrectness),
    completeness: mean((m) => m.completeness),
    humanPreference: preference.length > 0 ? preference.reduce((sum, value) => sum + value, 0) / preference.length : null,
  };
}
