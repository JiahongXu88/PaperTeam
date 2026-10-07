/**
 * Target 参照系 → 各消费端 prompt/advisory 的纯渲染（M12 Batch 2 · A9）。
 *
 * 纪律：
 * - 纯函数、零 IO、零 LLM——输入是已生成的 profile/readiness 产物；
 * - 全部渲染块固定携带「benchmark 观测，非官方投稿要求」限定语（系统未接入
 *   官方 guideline，不冒充要求）；
 * - 数值只来自 profile 分位带（无模型生成的数字进入 prompt）；
 * - 反抄袭红线：任何块都不包含 benchmark 论文原文（profile 里本来就没有）；
 * - Planner digest 显式声明 advisory：不自动立项，修订范围由审稿意见与作者裁决。
 */

import { describeBand } from "./quantiles.js";
import type {
  TargetDimensionReadiness,
  TargetPublicationProfile,
  TargetReadinessArtifact,
  TargetVerdict,
} from "./types.js";

const BASIS_NOTE = "（来源：冻结 benchmark 语料的确定性观测，非期刊/会议官方投稿要求）";

export const TARGET_REFERENCE_HEADER = "===== 目标实证参照系（benchmark 观测，非官方投稿要求）=====";
export const TARGET_EXPECTATIONS_HEADER = "===== 目标带数值期望（benchmark 观测，非官方投稿要求）=====";

/** Feasibility prompt 参照块：profile 概要 + readiness 差距（profile 缺席 → null = prompt 不变） */
export function renderTargetReferenceBlock(
  profile: TargetPublicationProfile | null,
  readiness: TargetReadinessArtifact | null,
): string | null {
  if (profile === null) {
    return null;
  }
  const lines: string[] = [
    TARGET_REFERENCE_HEADER,
    `benchmark 语料 ${profile.n} 篇（benchmarkRevision=${profile.benchmarkRevision}）${BASIS_NOTE}。`,
  ];
  const structure = profile.dimensions.structure;
  if (structure.totalLengthWords !== undefined) {
    lines.push(`- 正文词数带：${describeBand("", structure.totalLengthWords)}`);
  }
  if (structure.abstractLengthWords !== undefined) {
    lines.push(`- 摘要词数带：${describeBand("", structure.abstractLengthWords)}`);
  }
  const experiments = profile.dimensions.experiments;
  if (experiments.tableCount !== undefined) {
    lines.push(`- 表格数带：${describeBand("", experiments.tableCount)}；含 ablation 论文比例 ${(experiments.ablationPresent ?? 0) * 100}%`);
  }
  const visuals = profile.dimensions.visuals;
  if (visuals.figureCount !== undefined) {
    lines.push(`- 图数带：${describeBand("", visuals.figureCount)}；含方法总览图论文比例 ${(visuals.methodDiagramPresent ?? 0) * 100}%`);
  }
  const literature = profile.dimensions.literature;
  if (literature.citationCount !== undefined) {
    lines.push(`- 参考文献条目数带：${describeBand("", literature.citationCount)}`);
  }
  const dimsInsufficient = (Object.keys(profile.dimensions) as Array<keyof TargetPublicationProfile["dimensions"]>)
    .filter((name) => profile.dimensions[name].availability !== "available");
  if (dimsInsufficient.length > 0) {
    lines.push(`- 数据不足维度（如实）：${dimsInsufficient.join("、")}——对应结论应按证据不足处理，不得放宽`);
  }
  if (readiness !== null) {
    lines.push(`当前稿 readiness（advisory）：${readiness.overall.verdict}——${readiness.overall.summary}`);
    const material = readiness.dimensions
      .filter((entry) => entry.verdict === "BELOW_TARGET" || entry.verdict === "PARTIALLY_MEETS_TARGET")
      .slice(0, 6);
    for (const entry of material) {
      for (const gap of entry.gaps.slice(0, 2)) {
        lines.push(`- ${gap}`);
      }
    }
  }
  return lines.join("\n");
}

/** Reviewer academic 模式数值期望块（如「目标带论文正文 8000–12000 词、5–9 图…」） */
export function renderTargetExpectationsBlock(profile: TargetPublicationProfile | null): string | null {
  if (profile === null) {
    return null;
  }
  const lines: string[] = [
    TARGET_EXPECTATIONS_HEADER,
    `目标带（benchmark 语料 ${profile.n} 篇的观测带，非官方投稿要求）：`,
  ];
  const structure = profile.dimensions.structure;
  if (structure.totalLengthWords !== undefined) {
    lines.push(`- 正文 ${bandText(structure.totalLengthWords)} 词`);
  }
  if (structure.abstractLengthWords !== undefined) {
    lines.push(`- 摘要 ${bandText(structure.abstractLengthWords)} 词`);
  }
  const visuals = profile.dimensions.visuals;
  const experiments = profile.dimensions.experiments;
  if (visuals.figureCount !== undefined || experiments.tableCount !== undefined) {
    const parts: string[] = [];
    if (visuals.figureCount !== undefined) {
      parts.push(`${bandText(visuals.figureCount)} 图`);
    }
    if (experiments.tableCount !== undefined) {
      parts.push(`${bandText(experiments.tableCount)} 表`);
    }
    lines.push(`- 视觉材料：${parts.join(" + ")}`);
  }
  if (literatureBand(profile) !== null) {
    lines.push(`- 参考文献 ${bandText(literatureBand(profile)!)} 条`);
  }
  lines.push("评审时以此分位带为「目标带论文通常怎么写」的参照锚点；越带是距离信号（如实验材料规模明显低于 p25），按 academic 维度如实评价，不视为事实错误。");
  return lines.join("\n");
}

function bandText(band: { p25: number; p75: number }): string {
  return `${band.p25}–${band.p75}`;
}

function literatureBand(profile: TargetPublicationProfile): { p25: number; p75: number } | null {
  return profile.dimensions.literature.citationCount ?? null;
}

/** Planner digest（existing_paper_improvement 作者可选上下文；不自动立项） */
export function renderPlannerTargetDigest(readiness: TargetReadinessArtifact | null): string | undefined {
  if (readiness === null) {
    return undefined;
  }
  const lines: string[] = [
    `当前稿与目标带的距离（advisory——benchmark 观测，非官方投稿要求；评审意见与作者裁决仍主导修订范围，以下差距不自动立项，仅在作者明确选择追赶目标带时参考）：`,
    `总判决：${readiness.overall.verdict}（${readiness.overall.summary}）`,
  ];
  for (const entry of readiness.dimensions) {
    if (entry.verdict === "INSUFFICIENT_EVIDENCE") {
      lines.push(`- [${entry.dimension}] 证据不足（${entry.evidenceBasis}）`);
      continue;
    }
    for (const gap of entry.gaps) {
      lines.push(`- ${gap}`);
    }
    if (entry.gaps.length === 0) {
      lines.push(`- [${entry.dimension}] ${entry.verdict}（无显式差距项）`);
    }
  }
  return lines.join("\n");
}

/** Quality Gate 的 advisory 投影（零阻断：不进任何 rule，不参与判定） */
export interface TargetReadinessGateAdvisory {
  verdict: TargetVerdict;
  benchmarkRevision: number;
  evaluatedAt: string;
  summary: string;
  dimensions: Array<{ dimension: string; verdict: TargetVerdict; confidence: string; gaps: number }>;
}

export function readinessGateAdvisory(readiness: TargetReadinessArtifact | null): TargetReadinessGateAdvisory | undefined {
  if (readiness === null) {
    return undefined;
  }
  return {
    verdict: readiness.overall.verdict,
    benchmarkRevision: readiness.benchmarkRevision,
    evaluatedAt: readiness.evaluatedAt,
    summary: readiness.overall.summary,
    dimensions: readiness.dimensions.map((entry: TargetDimensionReadiness) => ({
      dimension: entry.dimension,
      verdict: entry.verdict,
      confidence: entry.confidence,
      gaps: entry.gaps.length,
    })),
  };
}
