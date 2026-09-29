/**
 * M10.1 Document & Data Ingestion：统一解析数据模型。
 *
 * 目标：PDF（成熟 Document Parser）与 CSV/XLSX（结构化表格）产出同一种
 * 中间结构——ParsedDocument，后续 FullText / Evidence / RAG 不再针对文件
 * 类型各写一套逻辑。Provenance 是核心：系统能回答「这个事实来自哪个文件、
 * 哪一页 / 哪个 sheet、哪一行、哪一列」。
 *
 * 分层（与 paper/PdfParser.ts 的 seam 纪律一致）：
 * - DocumentParser（seam 接口）：文件 → DocumentExtraction（parser 中立的
 *   块序列；DoclingAdapter / CSV / XLSX / legacy 文本层都实现它）；
 * - ParsedDocument（存储模型）：DocumentExtraction + 存储元数据（sourceId /
 *   contentHash / counts / 降级审计），落盘 sources/parsed/<id>.document.json。
 *
 * 语义边界（不触碰既有不变量）：
 * - ParsedDocument ≠ Evidence：解析产物只是原料，user_confirmed 证据必须
 *   经用户显式确认（records → evidence 通道），verified 仍只有三段核验
 *   管道一个入口；
 * - bbox / section / figure 资产是 parser 能提供就保留（optional），
 *   不伪造。
 */

import type { SourceItem } from "../sources/SourceStore.js";

/** 块类型（M10.1 最小集 + M10.1.1 文本/代码/Notebook 扩展） */
export type ParsedBlockType =
  | "text" // 正文文本（含标题 / 列表 / 题注；md/tex 段落同型）
  | "table" // 表格（PDF 内嵌表格：headers + 行列网格）
  | "figure" // 图片（检测 + 登记 + 可选资产；不理解内容——M10.2）
  | "formula" // 公式（parser 提供时保存 LaTeX / 文本）
  | "structured_record" // 结构化数据（CSV/XLSX 行；M10.1.1 起 JSON/YAML 叶子路径同型）
  | "code" // 源码（CodeTextAsset：行窗口块，语言 + 行 provenance）
  | "output"; // Notebook 文本类输出（stream / execute_result / error；静态提取）

/** 文本块的细类（检索分组 / 展示用；parser 提供时填） */
export type TextKind = "paragraph" | "title" | "section_header" | "list_item" | "caption";

/** 页面坐标（parser 原生坐标系原样保留；Docling 为页面左下原点、0-100 归一） */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Provenance：块级回溯锚点。所有字段 optional-except-fileName——parser
 * 能提供就保留，不能就缺省，绝不伪造页码 / 坐标。
 */
export interface ParsedProvenance {
  /** 存储文件名（sources/papers/ 下，含 sourceId 前缀） */
  fileName: string;
  /** 1-based 页码（PDF parser 提供时） */
  page?: number;
  /** 所属章节标题（parser / TOC 提供时） */
  section?: string;
  /** sheet 名（XLSX；CSV 无 sheet） */
  sheet?: string;
  /**
   * 1-based 物理行号（含表头行：表头 = 1，首条数据 = 2——与 Excel 行号
   * 一致，用户可直接在表格软件里对上）。M10.1.1 起 YAML 叶子路径复用
   * 该字段携带所在行（1-based 文件行）；JSON 无行号（JSON.parse 不带
   * 位置）——缺省不伪造。
   */
  row?: number;
  /** 列（表头名；查无表头时缺省） */
  column?: string;
  /** 页面坐标（Docling 等版面感知 parser 提供时） */
  bbox?: BBox;
  /** parser 原始块 id（docling self_ref 等；审计用） */
  parserBlockId?: string;
  /**
   * 1-based 起始行（文本 / 代码 / LaTeX：文件物理行；Notebook cell：
   * cell 内相对行——首行 = 1）。M10.1.1。
   */
  lineStart?: number;
  /** 1-based 结束行（含端点） */
  lineEnd?: number;
  /** 结构化路径（JSON `$.training.epochs` / YAML 同型；M10.1.1） */
  jsonPath?: string;
  /** Notebook cell 序号（0-based，与 nbformat cells 数组下标一致；M10.1.1） */
  cellIndex?: number;
  /** Notebook cell id（nbformat 4.4+ 存在时保留） */
  cellId?: string;
  /** Notebook output 序号（cell.outputs 数组下标，0-based；M10.1.1） */
  outputIndex?: number;
}

interface ParsedBlockBase {
  /** 文档内稳定块 id（B0001…，按文档顺序；同输入重算一致） */
  blockId: string;
  type: ParsedBlockType;
  provenance: ParsedProvenance;
  /** 内容触达防御上限被截断（不静默；M10.1.1） */
  truncated?: boolean;
}

export interface ParsedTextBlock extends ParsedBlockBase {
  type: "text";
  text: string;
  textKind?: TextKind;
}

/** PDF 内嵌表格（结构化网格保留；M10.1 不做表格语义理解） */
export interface ParsedTableBlock extends ParsedBlockBase {
  type: "table";
  /** 题注（"Table 1: ..."；parser 提供时） */
  caption?: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

/** 图片块：检测 + 登记（页码 / bbox / 可选抽取资产）；内容理解属 M10.2 */
export interface ParsedFigureBlock extends ParsedBlockBase {
  type: "figure";
  caption?: string;
  /** 抽取出的图片资产文件名（sources/figures/<sourceId>/ 下） */
  assetName?: string;
  /** 像素宽（header 可读时；图片登记 / Notebook 图片输出；M10.1.1） */
  width?: number;
  /** 像素高 */
  height?: number;
  /**
   * 图片类内容存在但未落资产（超上限 / 解码失败）——事实不丢失，
   * M10.2 视觉解析可据此回捞。M10.1.1。
   */
  visualOutputPresent?: boolean;
}

export interface ParsedFormulaBlock extends ParsedBlockBase {
  type: "formula";
  /** parser 提供的 LaTeX（docling formula enrichment） */
  latex?: string;
  /** 原始文本形态（无 LaTeX 时保留） */
  text?: string;
}

/** CSV/XLSX 数据行：一行 = 一条可确认记录（cells 携带列级 provenance） */
export interface ParsedRecordCell {
  /**
   * 列字母（A / B / … AA；CSV/XLSX 均可确定）。JSON / YAML 投影单值
   * 记录无列概念——缺省（header 即完整路径）。M10.1.1 起可选。
   */
  letter?: string;
  /** 表头名（首行；空表头降级为列字母；JSON/YAML = 完整结构化路径） */
  header: string;
  value: string;
}

export interface ParsedRecordBlock extends ParsedBlockBase {
  type: "structured_record";
  cells: ParsedRecordCell[];
}

/** 源码块（CodeTextAsset：行窗口；不截断单行，语言 + 行 provenance） */
export interface ParsedCodeBlock extends ParsedBlockBase {
  type: "code";
  /** 语言标签（扩展名推断：python / cpp / typescript …） */
  language: string;
  /** 逐字源码（CRLF 归一为 LF；行完整性保留） */
  text: string;
  /** Notebook code cell 的执行计数（存在时记录；静态字段，不代表执行过） */
  executionCount?: number;
}

/** Notebook 文本类输出（静态提取；不执行任何代码） */
export interface ParsedOutputBlock extends ParsedBlockBase {
  type: "output";
  outputKind: "stream" | "execute_result" | "display_data" | "error" | "other";
  /** stdout / stderr（stream 输出） */
  stream?: string;
  /**
   * 输出文本（stream 文本 / text/plain / error traceback）。
   * outputKind="other" 时为类型登记标记（如 `[unsupported output data: text/html]`）。
   */
  text: string;
}

export type ParsedBlock =
  | ParsedTextBlock
  | ParsedTableBlock
  | ParsedFigureBlock
  | ParsedFormulaBlock
  | ParsedRecordBlock
  | ParsedCodeBlock
  | ParsedOutputBlock;

/** 表格数据的 sheet 概览 */
export interface ParsedSheetSummary {
  name: string;
  /** 数据行数（不含表头） */
  rowCount: number;
  columnCount: number;
  headers?: string[];
}

/**
 * ParsedDocument（存储模型，schemaVersion 1）。
 *
 * parseMode / degradedFrom 是降级显式化的关键：
 * - structured：结构化 parser 全量输出（docling / csv / xlsx）；
 * - text_only：docling 不可用等原因显式降级到文本层（表格 / 图 / 版面
 *   结构不可用）——调用方必须能知道发生过降级，绝不伪装成完整解析。
 */
/** 资产大类（M10.1.1：PDF / 表格 → 常见科研工程资产全覆盖） */
export type ParsedDocumentKind =
  | "pdf"
  | "tabular" // csv / xlsx
  | "text" // txt
  | "markdown"
  | "latex"
  | "json"
  | "yaml"
  | "code"
  | "notebook"
  | "image";

export interface ParsedDocument {
  schemaVersion: 1;
  sourceId: string;
  /** 用户可见文件名（originalName 优先） */
  fileName: string;
  storedFileName: string;
  kind: ParsedDocumentKind;
  mimeType: string;
  parser: { id: string; version?: string };
  parseMode: "structured" | "text_only";
  /** ok：解析完成；partial：部分可用（如实降级 / 截断）；failed：不可用 */
  status: "ok" | "partial" | "failed";
  pageCount?: number;
  sheets?: ParsedSheetSummary[];
  blocks: ParsedBlock[];
  counts: Record<ParsedBlockType, number>;
  /** 降级审计：从哪个 parser、因何降级 */
  degradedFrom?: { parser: string; reason: string };
  /** 解析器与截断说明（诊断用，短） */
  notes: string[];
  /** 原始文件 sha256（ freshness 判据：与 SourceItem.contentHash 一致才可用） */
  contentHash: string;
  parsedAt: string;
}

/** 全部块类型（counts 归一 / 存量产物补键用；顺序即文档模型声明序） */
export const PARSED_BLOCK_TYPES: readonly ParsedBlockType[] = [
  "text",
  "table",
  "figure",
  "formula",
  "structured_record",
  "code",
  "output",
];

/** counts 归一：补齐缺失键（schema 演进后老产物读取防线；不覆盖已有值） */
export function normalizeCounts(counts: Partial<Record<ParsedBlockType, number>> | undefined): Record<ParsedBlockType, number> {
  const out = emptyCounts();
  if (counts !== undefined) {
    for (const type of PARSED_BLOCK_TYPES) {
      const value = counts[type];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        out[type] = value;
      }
    }
  }
  return out;
}

export function emptyCounts(): Record<ParsedBlockType, number> {
  return { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0 };
}

/** 文档解析产物是否仍然对应当前 Source 内容（无 hash 的老条目视为不可信） */
export function isDocumentFresh(document: ParsedDocument, item: SourceItem): boolean {
  if (item.contentHash === undefined) {
    return false;
  }
  return document.contentHash === item.contentHash;
}

// ---- DocumentParser seam（M10.1B）----

/**
 * 结构化文档解析器接口：业务层不感知 docling / exceljs 存在。
 * 实现：DoclingParser（PDF 生产 adapter）、CsvParser、XlsxParser、
 * LegacyPdfTextParser（降级链第二级）。
 */
export interface DocumentParser {
  readonly id: string;
  /**
   * 解析文件（绝对路径）。不可用抛 DocumentParserUnavailableError；
   * 内容失败抛 DocumentParseFailedError（均不抛裸系统异常）。
   */
  parseFile(
    absolutePath: string,
    options?: DocumentParseOptions,
  ): Promise<DocumentExtraction>;
}

export interface DocumentParseOptions {
  /** 图片资产输出目录（提供时 parser 抽取图片文件到该目录） */
  figuresDir?: string;
  /** 请求公式识别（parser 支持时；docling 需额外模型，默认关） */
  formulas?: boolean;
  signal?: AbortSignal;
}

/**
 * parser 中立的解析输出（seam 契约；未来换 MinerU 只换 adapter，
 * 业务层与存储层不变）。mode 由 parser 自报能力边界。
 */
export interface DocumentExtraction {
  parser: { id: string; version?: string };
  /** structured：结构化块；text_only：仅文本层（降级） */
  mode: "structured" | "text_only";
  /** 解析器自报的可用性（缺省视为完整） */
  quality: "full" | "partial";
  /** 实际内容 MIME（内容签名判定；缺省按 kind 表缺省值；M10.1.1） */
  mimeType?: string;
  pageCount?: number;
  sheets?: ParsedSheetSummary[];
  blocks: ExtractionBlock[];
  notes: string[];
}

export type ExtractionBlock = ParsedBlock;

/** 文档级防御上限（超大文件不无限展开；截断进 notes 如实报告） */
export const INGESTION_LIMITS = {
  /** 块总数 */
  maxBlocks: 20_000,
  /** 单表格行数（PDF 内嵌表格） */
  maxTableRows: 500,
  /** 表格数据总行数（CSV/XLSX，含表头） */
  maxTabularRows: 20_000,
  /** 单 cell 字符 */
  maxCellChars: 2_000,
  /** 文本块字符 */
  maxTextChars: 20_000,
  /** 抽取图片资产数 */
  maxFigures: 200,
  /** notes 条数 */
  maxNotes: 20,
  /** ---- M10.1.1 文本 / 代码 / Notebook / 结构化投影 ---- */
  /** 单文本资产最大读取字符（>20MB 文本截断读取，不整读进内存） */
  maxTextAssetChars: 2_000_000,
  /** 单代码块最大行数（行窗口；超出在行边界硬切） */
  maxCodeBlockLines: 50,
  /** 单 Notebook 输出文本字符（stream / text/plain / traceback） */
  maxOutputChars: 20_000,
  /** Notebook 图片输出：单张解码字节上限（超出登记 visualOutputPresent 不落资产） */
  maxNotebookImageBytes: 8 * 1024 * 1024,
  /** Notebook 图片输出：每 notebook 落资产数上限 */
  maxNotebookImages: 50,
  /** JSON/YAML 投影：最大遍历深度（超出按叶子渲染） */
  maxProjectionDepth: 12,
} as const;
