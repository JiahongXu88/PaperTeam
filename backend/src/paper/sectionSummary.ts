/**
 * Section Summary（M4.3.2）：PaperMap 内嵌的章节摘要状态。
 *
 * 摘要由模型生成、单独持久化、可独立重跑——摘要失败不影响 parsed 原始数据
 * （PaperMap 由确定性数据 + 可选摘要组成）。
 */

/** 摘要生成状态（pending：尚未生成；ok：已生成；failed：尝试失败可重跑） */
export type SectionSummaryStatus = "pending" | "ok" | "failed";

export interface PaperSectionSummary {
  sectionId: string;
  status: SectionSummaryStatus;
  /** 2-4 句中文摘要（status=ok 时存在） */
  summary?: string;
  /** 生成模型标签（诊断/telemetry 用） */
  model?: string;
  generatedAt?: string;
  /** 失败原因（status=failed 时存在） */
  error?: string;
  /** 源 chunks 指纹：chunk 内容变化 → 摘要视为 stale 需重生成 */
  sourceFingerprint?: string;
}

/** 摘要是否需要（重新）生成：无摘要、失败、或源指纹不匹配 */
export function summaryNeedsRefresh(
  summary: PaperSectionSummary | undefined,
  currentFingerprint: string,
): boolean {
  if (summary === undefined) {
    return true;
  }
  if (summary.status === "failed" || summary.status === "pending") {
    return true;
  }
  return summary.sourceFingerprint !== currentFingerprint;
}
