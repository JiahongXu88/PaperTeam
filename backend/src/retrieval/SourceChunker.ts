/**
 * SourceChunker：正式 Source → SourceChunk[]（M6.4 chunk 管线 IO 编排）。
 *
 * 合法输入边界（指令冻结）：只有「已入库且有真实全文」的 Source 进入 chunk：
 * - 结构化解析产物（M10.1/M10.1.1，documentProvider 注入；freshness 已判）
 *   优先：PDF=docling 块投影（阅读顺序 + 页码 + 表格文本）、CSV/XLSX=行级
 *   记录投影（[sheet row N] 标记）、JSON/YAML=路径投影（[$.path] 标记）、
 *   TXT/MD/LaTeX=段落块（section + 行 provenance）、源码=行窗口块、
 *   Notebook=cell 分节投影；产物缺失 / text_only 降级 / failed 时走
 *   下方既有路径（pymupdf / builtin / 纯文本），行为不变；
 * - PDF：pymupdf（paper 域同一工具链：blocks 带页码 + TOC 章节）优先；
 *   工具链不可用时回退 builtin 文本层（无页码、整档单节——如实降级）；
 * - text / markdown（含 csv 无产物时）：文件即全文（markdown 标题 → 章节；
 *   无页码）；latex 无产物时同法按整档文本；
 * - xlsx / json / yaml / code / notebook：无结构化产物不可索引（结构化
 *   通道见 POST /sources/:id/ingest；上传即自动内联触发）；
 * - metadata_only（doi/arxiv/url/metadata）/ bibtex / image：full_text_unavailable
 *   skip——**绝不把 abstract/snippet 偷偷当全文索引**。
 *
 * 单 Source 失败不污染整库：结构化 outcome（reason + 短 note，不含全文）。
 */

import { readFile } from "node:fs/promises";

import { PdfParserUnavailableError } from "../errors.js";
import type { PdfParser } from "../paper/PdfParser.js";
import { deriveDocumentStructure } from "../paper/sectionChunking.js";
import { extractPdfText } from "../sources/PdfAnalyzer.js";
import type { SourceItem } from "../sources/SourceStore.js";
import { assetKindOfFileName, type SourceAssetKind } from "../ingestion/parserRegistry.js";
import {
  codeSectionsFromDocument,
  notebookSectionsFromDocument,
  sectionsFromDocument,
  tabularSectionsFromDocument,
} from "../ingestion/documentSections.js";
import type { ParsedDocument } from "../ingestion/types.js";
import {
  buildSourceChunks,
  splitParagraphs,
  type ChunkBuildOptions,
  type ResolvedSection,
} from "./chunking.js";
import type { ChunkParserKind, SourceChunk, SourceChunkOutcome } from "./types.js";

/** builtin 文本层的最小可索引门槛（低于此长度视为无可用全文） */
const BUILTIN_MIN_TEXT_CHARS = 200;

export interface SourceChunkerOptions {
  /** PDF 结构化解析器（paper 域 PyMuPdfParser；缺省 = PDF 走 builtin 回退） */
  parser?: PdfParser;
  chunkOptions?: ChunkBuildOptions;
  /**
   * M10.1 结构化解析产物供给（IngestionService.getDocument：含 freshness
   * 判据，不新鲜返回 null）。提供且为 structured 模式时优先于 pymupdf /
   * builtin 路径（表格 / 阅读顺序 / 页码 provenance 更完整）。
   */
  documentProvider?: (projectId: string, item: SourceItem) => Promise<ParsedDocument | null>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface SourceChunkResult {
  outcome: SourceChunkOutcome;
  chunks: SourceChunk[];
  sectionTitles: Map<string, string>;
}

export class SourceChunker {
  private readonly parser?: PdfParser;
  private readonly documentProvider?: (projectId: string, item: SourceItem) => Promise<ParsedDocument | null>;
  private readonly chunkOptions: ChunkBuildOptions;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: SourceChunkerOptions = {}) {
    this.parser = options.parser;
    this.documentProvider = options.documentProvider;
    this.chunkOptions = options.chunkOptions ?? {
      targetTokens: 400,
      maxTokens: 600,
      overlapTokens: 60,
    };
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /**
   * 生成单个 Source 的 chunks（确定性；失败 → skipped outcome，不抛异常，
   * 巨量全文不进 note/log）。
   */
  async chunkSource(projectId: string, item: SourceItem, filePath: string): Promise<SourceChunkResult> {
    if (item.fileName === undefined) {
      return skipped(item.sourceId, "full_text_unavailable", "metadata-only 条目（无原始文件）");
    }
    const kind = assetKindOfFileName(item.fileName);
    if (kind === "image") {
      return skipped(
        item.sourceId,
        "full_text_unavailable",
        "图片条目无文本层（资产登记见 ingestion；视觉解析属 M10.2）",
      );
    }
    // M10.1/M10.1.1：结构化解析产物优先。只消费 structured 模式 + 非 failed
    // 产物；text_only 降级产物交给下方既有 pymupdf / builtin 路径（质量
    // 相同，路径已验证）。
    const document = await this.loadStructuredDocument(projectId, item);
    if (document !== null) {
      const fromDocument = sectionsFromAssetDocument(document, kind);
      if (fromDocument !== null && fromDocument.sections.length > 0) {
        return this.build(projectId, item.sourceId, fromDocument.sections, fromDocument.parser);
      }
    }
    switch (kind) {
      case "pdf":
        return this.chunkPdf(projectId, item, filePath);
      case "markdown":
        return this.chunkPlainTextFile(projectId, item, filePath, "markdown");
      case "text":
      case "csv":
        return this.chunkPlainTextFile(projectId, item, filePath, "text");
      case "latex":
        // 无产物兜底：整档文本（source text 原样；主路径是结构化产物）
        return this.chunkPlainTextFile(projectId, item, filePath, "latex");
      case "xlsx":
        // 二进制格式没有可读文本层；无结构化产物时不可索引（先触发 ingest）
        return skipped(
          item.sourceId,
          "full_text_unavailable",
          "XLSX 无结构化解析产物（结构化记录通道见 POST /sources/:id/ingest）",
        );
      case "json":
      case "yaml":
        return skipped(
          item.sourceId,
          "full_text_unavailable",
          `${kind.toUpperCase()} 无结构化解析产物（路径投影通道见 POST /sources/:id/ingest）`,
        );
      case "code":
        return skipped(
          item.sourceId,
          "full_text_unavailable",
          "源码无结构化解析产物（行窗口通道见 POST /sources/:id/ingest）",
        );
      case "notebook":
        return skipped(
          item.sourceId,
          "full_text_unavailable",
          "Notebook 无结构化解析产物（cell 投影通道见 POST /sources/:id/ingest）",
        );
      default:
        if (item.fileName.toLowerCase().endsWith(".bib")) {
          return skipped(item.sourceId, "full_text_unavailable", "BibTeX 条目集不是单篇全文");
        }
        return skipped(item.sourceId, "full_text_unavailable", `条目 ${item.fileName} 类型无全文`);
    }
  }

  /** 读取可消费的结构化解析产物（structured 模式 + status != failed） */
  private async loadStructuredDocument(
    projectId: string,
    item: SourceItem,
  ): Promise<ParsedDocument | null> {
    if (this.documentProvider === undefined) {
      return null;
    }
    try {
      const document = await this.documentProvider(projectId, item);
      if (document === null || document.parseMode !== "structured" || document.status === "failed") {
        return null;
      }
      return document;
    } catch (error) {
      this.log(
        `[retrieval] 结构化解析产物读取失败（${item.sourceId}，走既有路径）：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async chunkPdf(
    projectId: string,
    item: SourceItem,
    filePath: string,
  ): Promise<SourceChunkResult> {
    if (this.parser !== undefined) {
      try {
        const extraction = await this.parser.parseFile(filePath);
        const { sections: paperSections, blocks } = deriveDocumentStructure(extraction);
        // blocks 保持文档顺序；按 section 分组保留节内顺序与页码 provenance
        const grouped = new Map<string, Array<{ text: string; page: number }>>();
        for (const block of blocks) {
          const list = grouped.get(block.sectionId) ?? [];
          list.push({ text: block.text, page: block.page });
          grouped.set(block.sectionId, list);
        }
        const sections: ResolvedSection[] = [];
        for (const section of paperSections) {
          const units = grouped.get(section.sectionId);
          if (units === undefined || units.length === 0) {
            continue;
          }
          sections.push({
            sectionId: section.sectionId,
            title: section.title,
            level: section.level,
            units,
          });
        }
        if (sections.length === 0) {
          return skipped(item.sourceId, "empty_content", "PDF 解析成功但未提取到文本块");
        }
        return this.build(projectId, item.sourceId, sections, "pymupdf");
      } catch (error) {
        // 工具链不可用 → builtin 回退；单文件解析失败 → parse_failed（如实）
        if (error instanceof PdfParserUnavailableError) {
          this.log(
            `[retrieval] pymupdf 不可用，PDF ${item.sourceId} 走 builtin 文本层回退：${error.message}`,
          );
          return this.chunkPdfBuiltin(projectId, item, filePath);
        }
        const message = error instanceof Error ? error.message : String(error);
        return skipped(item.sourceId, "parse_failed", `PDF 解析失败：${message.slice(0, 200)}`);
      }
    }
    return this.chunkPdfBuiltin(projectId, item, filePath);
  }

  /** builtin 文本层回退：无页码、整档单节（Layer 1 质量边界如实降级） */
  private async chunkPdfBuiltin(
    projectId: string,
    item: SourceItem,
    filePath: string,
  ): Promise<SourceChunkResult> {
    let text: string;
    try {
      const buffer = await readFile(filePath);
      text = extractPdfText(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return skipped(item.sourceId, "parse_failed", `PDF 文本层读取失败：${message.slice(0, 200)}`);
    }
    if (text.trim().length < BUILTIN_MIN_TEXT_CHARS) {
      return skipped(
        item.sourceId,
        "full_text_unavailable",
        "PDF 文本层过薄（可能为扫描件 / 子集字体），无可用全文",
      );
    }
    return this.build(
      projectId,
      item.sourceId,
      [
        {
          sectionId: "SEC01",
          title: "Whole Document",
          level: 1,
          units: splitParagraphs(text).map((paragraph) => ({ text: paragraph })),
        },
      ],
      "builtin-pdf-text",
    );
  }

  private async chunkPlainTextFile(
    projectId: string,
    item: SourceItem,
    filePath: string,
    kind: "markdown" | "text" | "latex",
  ): Promise<SourceChunkResult> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return skipped(item.sourceId, "parse_failed", `文件读取失败：${message.slice(0, 200)}`);
    }
    if (raw.trim() === "") {
      return skipped(item.sourceId, "empty_content", "文件内容为空");
    }
    const sections = kind === "markdown" ? markdownSections(raw) : wholeDocumentSections(raw);
    if (sections.length === 0) {
      return skipped(item.sourceId, "empty_content", "未提取到非空段落");
    }
    return this.build(projectId, item.sourceId, sections, kind);
  }

  private build(
    projectId: string,
    sourceId: string,
    sections: ResolvedSection[],
    parser: ChunkParserKind,
  ): SourceChunkResult {
    const { chunks, sectionTitles } = buildSourceChunks({
      projectId,
      sourceId,
      sections,
      options: this.chunkOptions,
      now: this.now,
    });
    if (chunks.length === 0) {
      return {
        outcome: { sourceId, status: "skipped", chunkCount: 0, reason: "empty_content", note: "全部章节为空" },
        chunks: [],
        sectionTitles,
      };
    }
    return {
      outcome: { sourceId, status: "indexed", chunkCount: chunks.length, parser },
      chunks,
      sectionTitles,
    };
  }
}

/** markdown 标题（#{1,6}）→ 章节；首标题前内容归入 Preamble */
export function markdownSections(raw: string): ResolvedSection[] {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ title: string; level: number; lines: string[] }> = [];
  let current: { title: string; level: number; lines: string[] } | null = null;
  const preamble: string[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      if (current !== null) {
        sections.push(current);
      }
      current = { title: match[2] ?? "", level: (match[1] ?? "#").length, lines: [] };
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current !== null) {
    sections.push(current);
  }
  const out: ResolvedSection[] = [];
  if (preamble.join("").trim() !== "") {
    out.push({
      sectionId: "SEC00",
      title: "Preamble",
      level: 1,
      units: splitParagraphs(preamble.join("\n")).map((text) => ({ text })),
    });
  }
  for (const section of sections) {
    const body = section.lines.join("\n");
    if (body.trim() === "") {
      continue;
    }
    out.push({
      sectionId: `SEC${String(out.length + 1).padStart(2, "0")}`,
      title: section.title,
      level: section.level,
      units: splitParagraphs(body).map((text) => ({ text })),
    });
  }
  return out;
}

function wholeDocumentSections(raw: string): ResolvedSection[] {
  const units = splitParagraphs(raw).map((text) => ({ text }));
  if (units.length === 0) {
    return [];
  }
  return [{ sectionId: "SEC01", title: "Whole Document", level: 1, units }];
}

/** 结构化产物 → sections（按资产大类选投影；null = 该类不消费产物投影） */
function sectionsFromAssetDocument(
  document: ParsedDocument,
  kind: SourceAssetKind,
): { sections: ResolvedSection[]; parser: ChunkParserKind } | null {
  switch (kind) {
    case "pdf": {
      const sections = sectionsFromDocument(document);
      if (sections.length === 0) {
        return null;
      }
      return {
        sections,
        parser: document.parser.id === "docling" ? "docling" : "structured-document",
      };
    }
    case "csv":
    case "xlsx":
    case "json":
    case "yaml": {
      const sections = tabularSectionsFromDocument(document);
      return sections.length > 0 ? { sections, parser: "tabular" } : null;
    }
    case "text":
    case "markdown":
    case "latex": {
      const sections = sectionsFromDocument(document);
      return sections.length > 0 ? { sections, parser: kind } : null;
    }
    case "code": {
      const sections = codeSectionsFromDocument(document);
      return sections.length > 0 ? { sections, parser: "code" } : null;
    }
    case "notebook": {
      const sections = notebookSectionsFromDocument(document);
      return sections.length > 0 ? { sections, parser: "notebook" } : null;
    }
    default:
      return null;
  }
}

function skipped(
  sourceId: string,
  reason: NonNullable<SourceChunkOutcome["reason"]>,
  note: string,
): SourceChunkResult {
  return {
    outcome: { sourceId, status: "skipped", chunkCount: 0, reason, note },
    chunks: [],
    sectionTitles: new Map(),
  };
}
