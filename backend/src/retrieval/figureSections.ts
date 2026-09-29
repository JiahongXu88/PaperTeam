/**
 * FigureAnalysis → 检索 sections 投影（M10.2 §12）。
 *
 * 把**已完成且新鲜**的 Vision 分析变成可检索文本：description /
 * observations / candidateFacts 进入 chunk → lexical / dense 管线；搜索结果
 * 经 sectionTitle / page / chunk 文本内回溯锚（[figure B0003 · page 7 ·
 * fig-001.png]）保留视觉 provenance——「哪张图显示 MOTA 随 threshold 变化」
 * 能命中具体 figure，而不是无来源的模型生成文本。
 *
 * 注意：无分析的 figure 块仍不进检索（M10.1 行为不变）；本投影只消费
 * status=completed 的分析（failed / skipped 不产生检索文本）。
 */

import type { FigureAnalysis } from "../vision/types.js";
import type { ResolvedSection } from "./chunking.js";

/** 分析 provenance → 人读定位标记（chunk 文本内回溯锚） */
function figureAnchorOf(analysis: FigureAnalysis): string {
  const where: string[] = [`figure ${analysis.figureBlockId}`];
  if (analysis.provenance.page !== undefined) {
    where.push(`page ${analysis.provenance.page}`);
  }
  if (analysis.provenance.cellIndex !== undefined) {
    where.push(`Cell ${analysis.provenance.cellIndex}${analysis.provenance.outputIndex !== undefined ? ` output ${analysis.provenance.outputIndex}` : ""}`);
  }
  if (analysis.provenance.assetName !== undefined) {
    where.push(analysis.provenance.assetName);
  }
  return where.join(" · ");
}

/** 分析 → 可检索单元文本（caption + 结构化理解 + 候选事实） */
export function renderFigureAnalysis(analysis: FigureAnalysis): string {
  const lines: string[] = [];
  if (analysis.provenance.caption !== undefined && analysis.provenance.caption.trim() !== "") {
    lines.push(analysis.provenance.caption.trim());
  }
  if (analysis.description !== undefined && analysis.description !== "") {
    lines.push(analysis.description);
  }
  if (analysis.observations.length > 0) {
    lines.push("Observations:");
    lines.push(...analysis.observations.map((line) => `- ${line}`));
  }
  if (analysis.candidateFacts.length > 0) {
    lines.push("Candidate facts:");
    for (const fact of analysis.candidateFacts) {
      const value = fact.value !== undefined ? `; value: ${fact.value}` : "";
      lines.push(`- ${fact.claim}${value} (confidence: ${fact.confidence})`);
    }
  }
  if (analysis.warnings.length > 0) {
    lines.push("Warnings:", ...analysis.warnings.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

/** 节标题：题注优先，其次资产名，兜底 blockId */
export function figureSectionTitle(analysis: FigureAnalysis): string {
  const caption = analysis.provenance.caption?.trim();
  if (caption !== undefined && caption !== "") {
    return `Figure: ${caption.length > 80 ? `${caption.slice(0, 80)}…` : caption}`;
  }
  if (analysis.provenance.assetName !== undefined) {
    return `Figure: ${analysis.provenance.assetName}`;
  }
  return `Figure ${analysis.figureBlockId}`;
}

/**
 * 已完成分析 → sections（追加在既有文档 sections 之后；sectionId 从
 * startIndex 续编号，保证同 source 内唯一稳定）。
 */
export function figureAnalysisSections(analyses: readonly FigureAnalysis[], startIndex = 0): ResolvedSection[] {
  const sections: ResolvedSection[] = [];
  for (const analysis of analyses) {
    if (analysis.status !== "completed") {
      continue;
    }
    const text = renderFigureAnalysis(analysis);
    if (text.trim() === "") {
      continue;
    }
    sections.push({
      sectionId: `SEC${String(startIndex + sections.length + 1).padStart(2, "0")}`,
      title: figureSectionTitle(analysis),
      level: 1,
      units: [
        {
          text: `[${figureAnchorOf(analysis)}${analysis.model !== undefined ? ` · vision ${analysis.model}` : ""}]\n${text}`,
          ...(analysis.provenance.page !== undefined ? { page: analysis.provenance.page } : {}),
        },
      ],
    });
  }
  return sections;
}
