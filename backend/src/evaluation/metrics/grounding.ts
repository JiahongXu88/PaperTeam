/**
 * Experiment 1 指标（纯函数）：unsupported claim rate / fabricated citation
 * rate / evidence coverage。
 *
 * 口径（与数据集 ground truth 对齐）：
 * - fabricated citation = quote 非逐字（quoteVerbatim=false）或元数据与权威
 *   记录冲突（metadataCorrect=false）——「这条引用是编的或错的」；
 * - unsupported claim = 引文真实但论断越界（claimSupported=false）；
 * - evidence coverage = 某臂证据池命中的正例 / 场景正例总数（召回）。
 * 全部比率在「分母为 0 时返回 0」的约定下保持确定性（单故障场景不除零）。
 * 聚合在 outcomes 层面（按提案数加权——大场景权重大，诚实口径）。
 */

import type { GroundingFaultClass, GroundingMetrics, GroundingProposalOutcome } from "../types.js";

export function computeGroundingMetrics(
  outcomes: readonly GroundingProposalOutcome[],
  supportableTotal: number,
): GroundingMetrics {
  const accepted = outcomes.filter((outcome) => outcome.disposition === "accepted");
  const unsupported = accepted.filter((outcome) => !outcome.claimSupported).length;
  const fabricated = accepted.filter((outcome) => !outcome.quoteVerbatim || !outcome.metadataCorrect).length;
  const coverageHits = accepted.filter((outcome) => outcome.claimSupported && outcome.faultClass === null).length;
  const dispositions: Record<string, number> = {};
  for (const outcome of outcomes) {
    dispositions[outcome.disposition] = (dispositions[outcome.disposition] ?? 0) + 1;
  }
  return {
    accepted: accepted.length,
    unsupportedClaimRate: accepted.length > 0 ? unsupported / accepted.length : 0,
    fabricatedCitationRate: accepted.length > 0 ? fabricated / accepted.length : 0,
    evidenceCoverage: supportableTotal > 0 ? Math.min(coverageHits, supportableTotal) / supportableTotal : 0,
    dispositions,
  };
}

/** 跨场景聚合（outcomes 层面：coverage 精确、比率按提案数加权） */
export function aggregateFromOutcomes(
  perScenario: readonly { outcomes: readonly GroundingProposalOutcome[]; supportableTotal: number }[],
): GroundingMetrics {
  const outcomes = perScenario.flatMap((entry) => entry.outcomes);
  const supportableTotal = perScenario.reduce((sum, entry) => sum + entry.supportableTotal, 0);
  return computeGroundingMetrics(outcomes, supportableTotal);
}

/** faultClass → ground truth 布尔三元组（数据集派生规则） */
export function groundTruthOf(faultClass: GroundingFaultClass | null): {
  claimSupported: boolean;
  quoteVerbatim: boolean;
  metadataCorrect: boolean;
} {
  switch (faultClass) {
    case null:
      return { claimSupported: true, quoteVerbatim: true, metadataCorrect: true };
    case "fabricated_quote":
      return { claimSupported: true, quoteVerbatim: false, metadataCorrect: true };
    case "unsupported_claim":
      return { claimSupported: false, quoteVerbatim: true, metadataCorrect: true };
    case "metadata_mismatch":
      return { claimSupported: true, quoteVerbatim: true, metadataCorrect: false };
  }
}
