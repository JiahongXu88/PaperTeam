/**
 * Legacy PDF 文本层降级解析器（M10.1B 降级链第二级）。
 *
 * Docling 不可用时的显式降级：复用 paper 域既有 PdfParser（pymupdf child
 * process——blocks 带页码 + TOC 章节）产出 text 块；pymupdf 也不可用时
 * 退到 BuiltinPdfAnalyzer 的零依赖文本层（无页码）。产出标记
 * mode="text_only"——表格 / 图 / 版面结构不可用，调用方必须能感知降级
 * （IngestionService 会写入 degradedFrom 审计字段）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import type { PdfParser, RawPdfExtraction } from "../paper/PdfParser.js";
import { deriveDocumentStructure } from "../paper/sectionChunking.js";
import { extractPdfText } from "../sources/PdfAnalyzer.js";
import type {
  DocumentExtraction,
  DocumentParseOptions,
  DocumentParser,
  ExtractionBlock,
} from "./types.js";

/** builtin 文本层的最小可用门槛（与 SourceChunker 同口径） */
const BUILTIN_MIN_TEXT_CHARS = 200;
/** builtin 文本层单块切分（无版面信息，按屏幕行数切；仅保底可读） */
const BUILTIN_BLOCK_CHARS = 4_000;

export class LegacyPdfTextParser implements DocumentParser {
  readonly id = "pdf-text-legacy";
  private readonly pdfParser?: PdfParser;
  private readonly log: (message: string) => void;

  constructor(options: { pdfParser?: PdfParser; log?: (message: string) => void } = {}) {
    this.pdfParser = options.pdfParser;
    this.log = options.log ?? (() => {});
  }

  async parseFile(
    absolutePath: string,
    _options: DocumentParseOptions = {},
  ): Promise<DocumentExtraction> {
    const fileName = basename(absolutePath);
    if (this.pdfParser !== undefined) {
      try {
        const extraction = await this.pdfParser.parseFile(absolutePath);
        return this.fromPymupdf(extraction, fileName);
      } catch (error) {
        // pymupdf 不可用 / 失败 → builtin 文本层（二级降级，如实标注）
        this.log(
          `[ingestion] pymupdf 文本层不可用，退到 builtin：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return this.fromBuiltin(absolutePath, fileName);
  }

  /** pymupdf 输出 → text 块（页码 provenance + 章节标题） */
  private fromPymupdf(extraction: RawPdfExtraction, fileName: string): DocumentExtraction {
    const { sections: paperSections, blocks } = deriveDocumentStructure(extraction);
    const titleBySectionId = new Map(paperSections.map((section) => [section.sectionId, section.title]));
    const mapped: ExtractionBlock[] = [];
    for (const block of blocks) {
      const text = block.text.trim();
      if (text === "") {
        continue;
      }
      const section = titleBySectionId.get(block.sectionId);
      mapped.push({
        blockId: `B${String(mapped.length + 1).padStart(4, "0")}`,
        type: "text",
        provenance: {
          fileName,
          page: block.page,
          ...(section !== undefined ? { section } : {}),
        },
        text,
        textKind: "paragraph",
      });
      if (mapped.length >= 20_000) {
        break;
      }
    }
    return {
      parser: {
        id: "pymupdf",
        ...(extraction.parser.version !== undefined ? { version: extraction.parser.version } : {}),
      },
      mode: "text_only",
      quality: mapped.length > 0 ? "partial" : "partial",
      ...(extraction.pageCount > 0 ? { pageCount: extraction.pageCount } : {}),
      blocks: mapped,
      notes: [
        "文本层降级解析（docling 不可用）：表格 / 图片 / 公式 / 版面坐标不可用",
        ...extraction.notes.slice(0, 5),
      ],
    };
  }

  /** builtin 零依赖文本层（无页码 / 无章节；最后一级保底） */
  private async fromBuiltin(absolutePath: string, fileName: string): Promise<DocumentExtraction> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      throw new DocumentParseFailedError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = extractPdfText(buffer).trim();
    if (text.length < BUILTIN_MIN_TEXT_CHARS) {
      throw new DocumentParseFailedError(
        "PDF 文本层过薄（可能为扫描件 / 子集字体），文本层降级解析也不可用",
      );
    }
    const mapped: ExtractionBlock[] = [];
    for (let offset = 0; offset < text.length && mapped.length < 20_000; offset += BUILTIN_BLOCK_CHARS) {
      mapped.push({
        blockId: `B${String(mapped.length + 1).padStart(4, "0")}`,
        type: "text",
        provenance: { fileName },
        text: text.slice(offset, offset + BUILTIN_BLOCK_CHARS),
        textKind: "paragraph",
      });
    }
    return {
      parser: { id: "builtin-text" },
      mode: "text_only",
      quality: "partial",
      blocks: mapped,
      notes: [
        "builtin 文本层降级解析（docling / pymupdf 均不可用）：无页码 / 表格 / 图片 / 章节结构",
      ],
    };
  }
}
