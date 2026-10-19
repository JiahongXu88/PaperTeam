/**
 * M14.9.3 输入保真 / 可评分性门的契约（零模型、确定性）。
 *
 * 源证据（SourceEvidence）由**独立于转写器**的抽取器从 PDF 文本层生成：逐块文本 + 几何 + 阅读顺序、
 * 表格逐词坐标、公式区上下标 / 叠行特征、续页标记、参考文献条目、身份词。转写器的字段分类、
 * 删除与段落合并逻辑不参与源证据——否则「生成转写」与「检查转写」共用同一缺陷基准（自证循环）。
 */

import type { FidelityWord, TableCheck } from "./inputFidelityTables.js";

export const INPUT_FIDELITY_SOURCE_SCHEMA = "paperteam.input-fidelity.source/v1";
export const INPUT_FIDELITY_REPORT_SCHEMA = "paperteam.input-fidelity.report/v1";

/**
 * VALID_FOR_SCORING：已核对的科研文本保真、无未解释的重大丢失；
 * REQUIRES_HUMAN_QA：结构 / 公式 / 表格 / 顺序存在无法自动核验的疑点，不得自动给可信全篇评分；
 * INVALID_INPUT：确证正文被删 / 表格错位 / 公式严重损坏 / 参考文献错误，禁止进入评分；
 * SOURCE_INCOMPLETE：源 PDF 自身缺续页或关键部分，禁止作为完整论文评分。
 */
export type FidelityStatus = "VALID_FOR_SCORING" | "REQUIRES_HUMAN_QA" | "INVALID_INPUT" | "SOURCE_INCOMPLETE";

/** [x0, y0, x1, y1]，页面左上角原点（PyMuPDF 坐标） */
export type Box = [number, number, number, number];

/** body = 本文正文区；margin = 版边页眉页脚 / 页码（短、重复或带刊物标识）；foreign = 同页混排的其他文章 */
export type SourceZone = "body" | "margin" | "foreign";
export type SourceRole = "text" | "heading" | "caption" | "reference";

export interface SourceBlock {
  id: string;
  page: number;
  /** 独立版面阅读顺序（页 → 通栏分隔 → 左栏 → 右栏 → 自上而下） */
  order: number;
  bbox: Box;
  text: string;
  zone: SourceZone;
  role: SourceRole;
  /** 行内上下标（非引文角标），供行内结构保真核对 */
  scripts?: Array<{ text: string; kind: "sub" | "sup" }>;
}

export interface SourceTable { id: string; page: number; bbox: Box; caption?: string; words: FidelityWord[] }

export interface SourceFormula {
  id: string;
  page: number;
  bbox: Box;
  text: string;
  /** 公式编号「（3）」 */
  label: string | null;
  scripts: Array<{ text: string; kind: "sub" | "sup" }>;
  /** 同一公式区内 x 范围重叠的叠行数（分式 / 矩阵 / 分段函数） */
  stackedLines: number;
  /** Symbol 类字体的括号分段字形等（文本层无法表达结构的字形） */
  pieceGlyphs: number;
}

export interface SourceReference { number: number | null; text: string }

export interface SourceEvidence {
  schema: typeof INPUT_FIDELITY_SOURCE_SCHEMA;
  sourceSha256: string;
  extractor: { name: string; version: string; notes?: string[] };
  pageCount: number;
  /** 指向 PDF 之外页面的续页标记（「下转第 516 页」而 PDF 不含该页） */
  incompleteContinuations: string[];
  /** 版面阅读顺序是否可信（无法判定栏边界时为 false → 顺序问题只能要求人工 QA） */
  readingOrderReliable: boolean;
  readingOrderNotes?: string[];
  blocks: SourceBlock[];
  tables: SourceTable[];
  formulas: SourceFormula[];
  figures: Array<{ id: string; page: number; bbox: Box }>;
  references: SourceReference[];
  /** 需在盲化稿正文中不可见的身份词（作者姓名 / 邮箱 / 本文 DOI / 本刊名 / ISSN / CN） */
  identityTerms: string[];
}

/** 授权删除种类（闭集；开放式「删到下一个标题」不存在对应种类） */
export const AUTHORIZED_DELETION_KINDS = [
  "author", "author_bio", "affiliation", "email", "funding", "funding_inline", "submission_dates", "submission_metadata",
  "citation_format", "editorial_metadata", "journal_identity", "author_contribution", "author_orcid", "acknowledgement",
  "running_header", "page_furniture", "page_furniture_or_footnote_metadata", "foreign_article_content",
  "layout_continuation_marker", "front_matter_figure", "front_matter_non_content", "front_matter_table",
] as const;

export interface DeletionEntry {
  kind: string;
  page: number | null;
  bbox?: Box | null;
  sourceBlockIds?: string[];
  excerpt?: string;
  reason?: string;
  textSha256?: string;
}

export interface FidelityProjectionInput {
  text: string;
  deletions: DeletionEntry[];
}

export type FindingSeverity = "hard" | "soft" | "info";

export interface FidelityFinding {
  code: string;
  severity: FindingSeverity;
  detail: string;
  blockId?: string;
  page?: number;
  excerpt?: string;
}

export interface FormulaCheck {
  id: string;
  page: number;
  label: string | null;
  status: "VERIFIED" | "UNVERIFIED_MARKED" | "UNVERIFIABLE_SOURCE" | "STRUCTURE_LOST" | "GARBLED" | "MISSING";
  detail: string;
}

export interface DeletionAudit {
  kind: string;
  page: number | null;
  sourceBlockIds: string[];
  chars: number;
  textSha256: string | null;
  excerpt: string;
  verdict: "authorized" | "illegitimate" | "unanchored" | "unauthorized_kind";
  reason: string;
}

export interface InputFidelityReport {
  schema: typeof INPUT_FIDELITY_REPORT_SCHEMA;
  status: FidelityStatus;
  /** M14.9.1 兼容契约：只有 VALID_FOR_SCORING 映射为 VALID（旧字段含义不变：VALID = 可进入评分比较） */
  legacyStatus: "VALID" | "INVALID_INPUT";
  /** 全篇定量评分是否可信（false 时只允许带未审范围说明的局部只读审阅） */
  fullPaperQuantitativeScoring: boolean;
  sourceSha256: string;
  projectionSha256: string;
  reasons: string[];
  limitations: string[];
  findings: FidelityFinding[];
  metrics: {
    requiredBlocks: number;
    coveredBlocks: number;
    partialBlocks: number;
    lostBlocks: number;
    deletedBlocks: number;
    requiredCanonChars: number;
    coveredCanonChars: number;
    coverageRatio: number;
    orderAnomalies: number;
    paragraphSplices: number;
    tables: { total: number; verified: number; mismatch: number; unverified: number };
    formulas: { total: number; verified: number; unverifiedMarked: number; unverifiableSource: number; structureLost: number; garbled: number; missing: number };
    references: { source: number; lost: number; sequenceAnomalies: number };
    figures: { source: number; markers: number };
    inlineScripts: { total: number; encoded: number };
    deletions: { total: number; authorized: number; illegitimate: number; unanchored: number; unauthorizedKind: number };
  };
  deletions: DeletionAudit[];
  tables: Array<TableCheck & { id: string; page: number }>;
  formulas: FormulaCheck[];
}
