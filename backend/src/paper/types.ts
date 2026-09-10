/**
 * PDF Review 领域模型：解析产物与 PaperMap 的类型冻结。
 *
 * 设计约束：
 * - 全部字段 JSON 可序列化（无 Date / Buffer / 类实例），可直接落盘与过 HTTP；
 * - 所有 Review 输入以 chunk / page / section 为 provenance 单位，
 *   禁止「整篇全文塞进一个 Agent Session」的长会话模式（docs/DECISIONS.md M4.3）；
 * - 不引入 Pi 内部类型——Runtime 层只消费这里的纯数据结构；
 * - 解析层（pymupdf）细节被封在 PdfParser adapter 后面，这里只保留
 *   与解析器无关的稳定字段（bbox 等坐标信息第一版不进领域模型）。
 */

import type { PaperSectionSummary } from "./sectionSummary.js";

/** 解析器运行信息（PaperDocument.parse） */
export interface PaperParseInfo {
  /** 解析器标识（如 "pymupdf"） */
  parserId: string;
  /** 解析器版本（pymupdf 版本号） */
  parserVersion?: string;
  parsedAt: string;
  durationMs: number;
  pageCount: number;
  /** 文本层质量（good：全文可靠；partial：部分页可疑；poor：文本不可依赖） */
  extractionQuality: "good" | "partial" | "poor";
  notes?: string[];
}

/** 单页文本（reading order，多栏由解析器负责重排） */
export interface PaperPage {
  pageId: string;
  /** 1-based 页码 */
  pageNumber: number;
  text: string;
  charCount: number;
}

/** 章节区间（来源优先级：PDF outline(TOC) > 标题正则 > 整档兜底） */
export interface PaperSection {
  sectionId: string;
  title: string;
  /** 层级（TOC 深度或标题编号推断；1 = 一级章节） */
  level: number;
  pageStart: number;
  pageEnd: number;
  charCount: number;
  source: "toc" | "heading-pattern" | "whole-document";
}

/** Review 的最小输入单位：带页码 provenance 的文本块 */
export interface PaperChunk {
  chunkId: string;
  /** 文档顺序序号（1 起，单调递增） */
  sequence: number;
  pageStart: number;
  pageEnd: number;
  sectionId: string;
  text: string;
  charCount: number;
}

/**
 * PaperMap：长文档 Review 的导航图。
 * Agent 不重新阅读整篇 PDF——按 section 取 Map 摘要 + 目标 section chunks。
 */
export interface PaperMapSection {
  sectionId: string;
  title: string;
  level: number;
  pageStart: number;
  pageEnd: number;
  chunkCount: number;
  charCount: number;
  /** 章节摘要（模型生成，单独可重跑；失败不影响 parsed 数据） */
  summary?: PaperSectionSummary;
}

export interface PaperMap {
  schemaVersion: 1;
  documentTitle?: string;
  abstract?: string;
  pageCount: number;
  sections: PaperMapSection[];
  referencesIndex?: {
    referenceCount: number;
    calloutCount: number;
    unresolvedCallouts: number;
  };
  generatedAt: string;
  /** 解析产物指纹（document.json + chunks 的 sha256）：变化 → Map/summary 标记 stale */
  sourceFingerprint: string;
}

/** 解析后的完整论文文档（持久化于项目 workspace paper/parsed/） */
export interface PaperDocument {
  schemaVersion: 1;
  projectId: string;
  /** 项目内最终 PDF 的逻辑 id（第一版单文档：固定 "paper-1"） */
  documentId: string;
  title?: string;
  /** 解析器提取的论文摘要原文（M4.8 重建用；部分版式无摘要 → 缺省） */
  abstract?: string;
  originalFileName: string;
  bytes: number;
  /** source/paper.pdf 内容指纹（重复上传判定依据） */
  sha256: string;
  parse: PaperParseInfo;
  pages: PaperPage[];
  sections: PaperSection[];
  chunks: PaperChunk[];
  abstractSectionId?: string;
  referencesSectionId?: string;
  ingestedAt: string;
}

// ---- 防御性读取守卫（从磁盘 JSON 重载时校验；损坏数据返回 null 而非抛异常） ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray<T>(
  record: Record<string, unknown>,
  field: string,
  guard: (item: unknown) => T | undefined,
): T[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(guard).filter((item): item is T => item !== undefined);
  return items.length === value.length ? items : undefined;
}

export function isPaperPage(value: unknown): PaperPage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pageNumber = readNumber(value, "pageNumber");
  const text = typeof value["text"] === "string" ? (value["text"] as string) : undefined;
  const pageId = readString(value, "pageId");
  if (pageId === undefined || pageNumber === undefined || text === undefined) {
    return undefined;
  }
  return {
    pageId,
    pageNumber,
    text,
    charCount: readNumber(value, "charCount") ?? text.length,
  };
}

export function isPaperSection(value: unknown): PaperSection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sectionId = readString(value, "sectionId");
  const title = readString(value, "title");
  const pageStart = readNumber(value, "pageStart");
  const pageEnd = readNumber(value, "pageEnd");
  const level = readNumber(value, "level");
  const source = readString(value, "source");
  if (
    sectionId === undefined ||
    title === undefined ||
    pageStart === undefined ||
    pageEnd === undefined ||
    level === undefined ||
    (source !== "toc" && source !== "heading-pattern" && source !== "whole-document")
  ) {
    return undefined;
  }
  return {
    sectionId,
    title,
    level,
    pageStart,
    pageEnd,
    charCount: readNumber(value, "charCount") ?? 0,
    source,
  };
}

export function isPaperChunk(value: unknown): PaperChunk | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const chunkId = readString(value, "chunkId");
  const sequence = readNumber(value, "sequence");
  const pageStart = readNumber(value, "pageStart");
  const pageEnd = readNumber(value, "pageEnd");
  const sectionId = readString(value, "sectionId");
  const text = typeof value["text"] === "string" ? (value["text"] as string) : undefined;
  if (
    chunkId === undefined ||
    sequence === undefined ||
    pageStart === undefined ||
    pageEnd === undefined ||
    sectionId === undefined ||
    text === undefined
  ) {
    return undefined;
  }
  return {
    chunkId,
    sequence,
    pageStart,
    pageEnd,
    sectionId,
    text,
    charCount: readNumber(value, "charCount") ?? text.length,
  };
}

/** PaperDocument 防御性读取：关键结构缺失返回 null（调用方决定重建 / 报错） */
export function readPaperDocument(value: unknown): PaperDocument | null {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    return null;
  }
  const projectId = readString(value, "projectId");
  const abstract = readString(value, "abstract");
  const documentId = readString(value, "documentId");
  const originalFileName = readString(value, "originalFileName");
  const sha256 = readString(value, "sha256");
  const ingestedAt = readString(value, "ingestedAt");
  const parse = isRecord(value["parse"])
    ? {
        parserId: readString(value["parse"], "parserId") ?? "unknown",
        ...(readString(value["parse"], "parserVersion") !== undefined
          ? { parserVersion: readString(value["parse"], "parserVersion") }
          : {}),
        parsedAt: readString(value["parse"], "parsedAt") ?? "",
        durationMs: readNumber(value["parse"], "durationMs") ?? 0,
        pageCount: readNumber(value["parse"], "pageCount") ?? 0,
        extractionQuality:
          value["parse"]["extractionQuality"] === "good" ||
          value["parse"]["extractionQuality"] === "partial" ||
          value["parse"]["extractionQuality"] === "poor"
            ? (value["parse"]["extractionQuality"] as PaperParseInfo["extractionQuality"])
            : "partial",
      }
    : undefined;
  const pages = readArray(value, "pages", isPaperPage);
  const sections = readArray(value, "sections", isPaperSection);
  const chunks = readArray(value, "chunks", isPaperChunk);
  if (
    projectId === undefined ||
    documentId === undefined ||
    originalFileName === undefined ||
    sha256 === undefined ||
    ingestedAt === undefined ||
    parse === undefined ||
    pages === undefined ||
    pages.length === 0 ||
    sections === undefined ||
    sections.length === 0 ||
    chunks === undefined ||
    chunks.length === 0
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    projectId,
    ...(abstract !== undefined ? { abstract } : {}),
    documentId,
    ...(readString(value, "title") !== undefined ? { title: readString(value, "title") } : {}),
    originalFileName,
    bytes: readNumber(value, "bytes") ?? 0,
    sha256,
    parse,
    pages,
    sections,
    chunks,
    ...(readString(value, "abstractSectionId") !== undefined
      ? { abstractSectionId: readString(value, "abstractSectionId") }
      : {}),
    ...(readString(value, "referencesSectionId") !== undefined
      ? { referencesSectionId: readString(value, "referencesSectionId") }
      : {}),
    ingestedAt,
  };
}

/** PaperMap 防御性读取 */
export function readPaperMap(value: unknown): PaperMap | null {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    return null;
  }
  const sections = value["sections"];
  const generatedAt = readString(value, "generatedAt");
  const sourceFingerprint = readString(value, "sourceFingerprint");
  const pageCount = readNumber(value, "pageCount");
  if (
    !Array.isArray(sections) ||
    generatedAt === undefined ||
    sourceFingerprint === undefined ||
    pageCount === undefined
  ) {
    return null;
  }
  const mapSections: PaperMapSection[] = [];
  for (const section of sections) {
    if (!isRecord(section)) {
      return null;
    }
    const sectionId = readString(section, "sectionId");
    const title = readString(section, "title");
    const pageStart = readNumber(section, "pageStart");
    const pageEnd = readNumber(section, "pageEnd");
    const level = readNumber(section, "level");
    const chunkCount = readNumber(section, "chunkCount");
    const charCount = readNumber(section, "charCount");
    if (
      sectionId === undefined ||
      title === undefined ||
      pageStart === undefined ||
      pageEnd === undefined ||
      level === undefined ||
      chunkCount === undefined ||
      charCount === undefined
    ) {
      return null;
    }
    mapSections.push({
      sectionId,
      title,
      level,
      pageStart,
      pageEnd,
      chunkCount,
      charCount,
      ...(isRecord(section["summary"])
        ? { summary: section["summary"] as unknown as PaperMapSection["summary"] }
        : {}),
    });
  }
  const referencesIndex = isRecord(value["referencesIndex"])
    ? {
        referenceCount: readNumber(value["referencesIndex"], "referenceCount") ?? 0,
        calloutCount: readNumber(value["referencesIndex"], "calloutCount") ?? 0,
        unresolvedCallouts: readNumber(value["referencesIndex"], "unresolvedCallouts") ?? 0,
      }
    : undefined;
  return {
    schemaVersion: 1,
    ...(readString(value, "documentTitle") !== undefined
      ? { documentTitle: readString(value, "documentTitle") }
      : {}),
    ...(readString(value, "abstract") !== undefined
      ? { abstract: readString(value, "abstract") }
      : {}),
    pageCount,
    sections: mapSections,
    ...(referencesIndex !== undefined ? { referencesIndex } : {}),
    generatedAt,
    sourceFingerprint,
  };
}
