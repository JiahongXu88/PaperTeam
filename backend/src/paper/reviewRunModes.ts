/**
 * M15.12 — existing_paper_review 的运行档位（run-request 选项，随 run 持久化）。
 *
 * 沿 citationSemanticMode 的注入通道（HTTP 层显式写入 request；stage 经
 * ctx.state.request 读取）。三个选项全部缺省 = 旧行为（零迁移）：
 *
 *   paperMapSummaryMode  per-section（旧：每章节一次摘要调用）
 *                        batched（M15.12 B1：多章节合并为批量调用，
 *                                摘要存储格式与指纹语义不变）
 *   globalReviewMode     off（旧：无全文级 pass）
 *                        on（M15.12 B2：review.fullpaper stage——
 *                            Goal–Method–Claim–Evidence 全局审查，2 次调用）
 *   priorityView         false（旧：报告无优先视图）
 *                        true（M15.12 B3：聚合报告附 top-K priority view；
 *                              只加视图，不改 findings 本体与 Gate 语义）
 *
 * 读取端兜底语义（重要）：字段缺失的历史 run 一律按旧行为解释——
 * 与 citationSemanticMode 的"旧 run 按 full"同理，历史 run 的 resume
 * 不因新选项出现而被降级或改道。
 */

export const PAPER_MAP_SUMMARY_MODES = ["per-section", "batched"] as const;
export type PaperMapSummaryMode = (typeof PAPER_MAP_SUMMARY_MODES)[number];

export function isPaperMapSummaryMode(value: unknown): value is PaperMapSummaryMode {
  return typeof value === "string" && (PAPER_MAP_SUMMARY_MODES as readonly string[]).includes(value);
}

/** 新 Review Run 的缺省模式（= 旧行为） */
export const DEFAULT_PAPER_MAP_SUMMARY_MODE: PaperMapSummaryMode = "per-section";

export function readPaperMapSummaryMode(
  request: Record<string, unknown> | undefined,
): PaperMapSummaryMode {
  const value = request?.["paperMapSummaryMode"];
  return isPaperMapSummaryMode(value) ? value : DEFAULT_PAPER_MAP_SUMMARY_MODE;
}

export const GLOBAL_REVIEW_MODES = ["off", "on"] as const;
export type GlobalReviewMode = (typeof GLOBAL_REVIEW_MODES)[number];

export function isGlobalReviewMode(value: unknown): value is GlobalReviewMode {
  return typeof value === "string" && (GLOBAL_REVIEW_MODES as readonly string[]).includes(value);
}

/** 新 Review Run 的缺省模式（= 旧行为：无全局 pass） */
export const DEFAULT_GLOBAL_REVIEW_MODE: GlobalReviewMode = "off";

export function readGlobalReviewMode(request: Record<string, unknown> | undefined): GlobalReviewMode {
  const value = request?.["globalReviewMode"];
  return isGlobalReviewMode(value) ? value : DEFAULT_GLOBAL_REVIEW_MODE;
}

/**
 * M15.13 A2：分节审阅调用分配模式。
 *
 *   per-section   旧行为：每个章节一次独立调用（锚定与 journal 语义不变）
 *   batched-small 小节合并批：<SECTION_BATCH_THRESHOLD_CHARS 字符的相邻（文档序）
 *                 章节合并为一次调用（每批 ≤SECTION_BATCH_MAX_SECTIONS 节、
 *                 ≤SECTION_BATCH_MAX_CHARS 字符；分组纯确定性）。批内 finding
 *                 必须给出 sectionId（provenance 硬约束，非法整条 dropped）。
 *                 大节（方法/实验/结果/结论正文）不受影响，仍逐节全文审阅。
 */
export const SECTION_REVIEW_MODES = ["per-section", "batched-small"] as const;
export type SectionReviewMode = (typeof SECTION_REVIEW_MODES)[number];

export function isSectionReviewMode(value: unknown): value is SectionReviewMode {
  return typeof value === "string" && (SECTION_REVIEW_MODES as readonly string[]).includes(value);
}

/** 新 Review Run 的缺省模式（= 旧行为） */
export const DEFAULT_SECTION_REVIEW_MODE: SectionReviewMode = "per-section";

export function readSectionReviewMode(request: Record<string, unknown> | undefined): SectionReviewMode {
  const value = request?.["sectionReviewMode"];
  return isSectionReviewMode(value) ? value : DEFAULT_SECTION_REVIEW_MODE;
}

/** batched-small：进入合并批的章节字符上限（低于此值的"小节"才可合并） */
export const SECTION_BATCH_THRESHOLD_CHARS = 2000;
/** batched-small：每批最多章节数 */
export const SECTION_BATCH_MAX_SECTIONS = 4;
/** batched-small：每批章节正文总字符上限 */
export const SECTION_BATCH_MAX_CHARS = 6000;

export function readPriorityView(request: Record<string, unknown> | undefined): boolean {
  return request?.["priorityView"] === true;
}
