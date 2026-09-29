/**
 * 文本资产 parser（M10.1.1）：TXT / Markdown / LaTeX / 常见源码 → DocumentExtraction。
 *
 * 最小必要解析纪律：
 * - 全部按 UTF-8 文本处理（二进制 / 非 UTF-8 显式拒绝，不猜编码）；
 * - TXT：空行分段块，lineStart/lineEnd 物理行 provenance；
 * - Markdown：ATX 标题（#{1,6}）→ section + section_header 块（零新依赖，
 *   不为 Markdown AST 引入重库）；
 * - LaTeX：\\section / \\subsection 等命令行 → section；不执行、不展开宏、
 *   无 TeX AST——.tex 就是 source text；
 * - 源码（CodeTextAsset）：无 AST；行窗口块（≤ maxCodeBlockLines，优先在
 *   空行边界切），单行永不截断，language 由扩展名映射。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import { languageOfFileName } from "./parserRegistry.js";
import {
  INGESTION_LIMITS,
  type DocumentExtraction,
  type DocumentParser,
  type ParsedBlock,
  type ParsedCodeBlock,
  type TextKind,
} from "./types.js";

export type TextAssetMode = "text" | "markdown" | "latex" | "code";

export class TextAssetParser implements DocumentParser {
  readonly id: TextAssetMode;

  constructor(private readonly mode: TextAssetMode) {
    this.id = mode;
  }

  async parseFile(absolutePath: string): Promise<DocumentExtraction> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      throw new DocumentParseFailedError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.parseBuffer(buffer, basename(absolutePath));
  }

  parseBuffer(buffer: Buffer, fileName: string): DocumentExtraction {
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    assertPlainText(text, this.mode);
    const notes: string[] = [];
    if (text.length > INGESTION_LIMITS.maxTextAssetChars) {
      // 硬顶截断在字符边界（不破坏行结构假设）；如实记录
      text = text.slice(0, INGESTION_LIMITS.maxTextAssetChars);
      notes.push(`文本超过 ${INGESTION_LIMITS.maxTextAssetChars} 字符读取上限，已截断`);
    }
    if (text.trim() === "") {
      throw new DocumentParseFailedError(`${labelOf(this.mode)} 文件内容为空`);
    }
    const blocks =
      this.mode === "code"
        ? codeBlocks(text, fileName, notes)
        : textBlocks(text, fileName, this.mode);
    if (blocks.length === 0) {
      throw new DocumentParseFailedError(`${labelOf(this.mode)} 未解析出任何内容块`);
    }
    if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
      notes.push(`块数达到上限 ${INGESTION_LIMITS.maxBlocks}，已截断`);
    }
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      blocks,
      notes,
    };
  }
}

function labelOf(mode: TextAssetMode): string {
  switch (mode) {
    case "markdown":
      return "Markdown";
    case "latex":
      return "LaTeX";
    case "code":
      return "源码";
    default:
      return "文本";
  }
}

/** 文本可解码性防线：NUL 或大量 U+FFFD → 疑似二进制 / 非 UTF-8（明确失败） */
function assertPlainText(text: string, mode: TextAssetMode): void {
  if (text.includes("\u0000")) {
    throw new DocumentParseFailedError(
      `内容包含 NUL（疑似二进制文件伪装成 ${labelOf(mode)} 文本）`,
    );
  }
  const probe = text.slice(0, 10_000);
  if (probe.length > 0) {
    let replacement = 0;
    for (const ch of probe) {
      if (ch === "�") {
        replacement += 1;
      }
    }
    if (replacement / probe.length > 0.01) {
      throw new DocumentParseFailedError(
        "检测到大量不可解码字节（仅支持 UTF-8 文本；疑似二进制或其它编码）",
      );
    }
  }
}

interface TextLine {
  content: string;
  /** 1-based 物理行号 */
  number: number;
}

function splitLines(text: string): TextLine[] {
  const raw = text.split(/\r?\n/);
  return raw.map((content, index) => ({ content, number: index + 1 }));
}

/** 文本 / Markdown / LaTeX：空行分段；标题命令 / ATX 标题维护 section 上下文 */
function textBlocks(text: string, fileName: string, mode: "text" | "markdown" | "latex"): ParsedBlock[] {
  const lines = splitLines(text);
  const blocks: ParsedBlock[] = [];
  let section = "";
  let paragraph: TextLine[] = [];

  const pushTextBlock = (
    body: string,
    lineStart: number,
    lineEnd: number,
    textKind: TextKind | undefined,
  ) => {
    if (blocks.length >= INGESTION_LIMITS.maxBlocks || body.trim() === "") {
      return;
    }
    blocks.push({
      blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
      type: "text",
      provenance: {
        fileName,
        ...(section !== "" ? { section } : {}),
        lineStart,
        lineEnd,
      },
      text: body,
      ...(textKind !== undefined ? { textKind } : {}),
    });
  };

  const flush = () => {
    if (paragraph.length === 0 || paragraph.every((line) => line.content.trim() === "")) {
      paragraph = [];
      return;
    }
    if (paragraph.map((line) => line.content).join("\n").length > INGESTION_LIMITS.maxTextChars) {
      // 超长段落按行边界切（不截断单行；内容不丢失，不标 truncated）
      const kind = textKindOf(paragraph);
      for (const part of splitOversizedParagraph(paragraph)) {
        pushTextBlock(part.text, part.lineStart, part.lineEnd, kind);
      }
      paragraph = [];
      return;
    }
    const first = paragraph[0]!;
    const last = paragraph[paragraph.length - 1]!;
    pushTextBlock(paragraph.map((line) => line.content).join("\n"), first.number, last.number, textKindOf(paragraph));
    paragraph = [];
  };

  for (const line of lines) {
    const heading =
      mode === "markdown"
        ? markdownHeading(line.content)
        : mode === "latex"
          ? latexSection(line.content)
          : null;
    if (heading !== null) {
      flush();
      // 标题行自成一个 section_header 块，并成为后续块的 section 上下文
      section = heading.title;
      if (blocks.length < INGESTION_LIMITS.maxBlocks) {
        blocks.push({
          blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
          type: "text",
          provenance: {
            fileName,
            section: heading.title,
            lineStart: line.number,
            lineEnd: line.number,
          },
          text: heading.title,
          textKind: "section_header",
        });
      }
      continue;
    }
    if (line.content.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** ATX 标题（与 SourceChunker.markdownSections 同规则：# 空格 标题） */
function markdownHeading(line: string): { title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (match === null) {
    return null;
  }
  return { title: match[2] ?? "" };
}

/** LaTeX 分节命令行（\section{…} / \subsection*{…} / \title{…} 等） */
function latexSection(line: string): { title: string } | null {
  const match = /^\s*\\(?:chapter|section|subsection|subsubsection|paragraph|title)\*?\s*\{([^}]*)\}/.exec(line);
  if (match === null) {
    return null;
  }
  const title = (match[1] ?? "").trim();
  return title === "" ? null : { title };
}

/** 段落首行判型：列表标记 → list_item（轻量，不做完整 Markdown 语义） */
function textKindOf(paragraph: TextLine[]): TextKind | undefined {
  const first = paragraph[0]?.content ?? "";
  if (/^(?:[-*+]\s|\d+[.)]\s)/.test(first)) {
    return "list_item";
  }
  return undefined;
}

/** 超长段落按行窗口再切（行完整性保留；textKind 由调用方统一判定） */
function splitOversizedParagraph(
  paragraph: TextLine[],
): Array<{ text: string; lineStart: number; lineEnd: number }> {
  const parts: Array<{ text: string; lineStart: number; lineEnd: number }> = [];
  let window: TextLine[] = [];
  let charCount = 0;
  const flushWindow = () => {
    if (window.length === 0) {
      return;
    }
    parts.push({
      text: window.map((line) => line.content).join("\n"),
      lineStart: window[0]!.number,
      lineEnd: window[window.length - 1]!.number,
    });
    window = [];
    charCount = 0;
  };
  for (const line of paragraph) {
    if (charCount + line.content.length > INGESTION_LIMITS.maxTextChars && window.length > 0) {
      flushWindow();
    }
    window.push(line);
    charCount += line.content.length + 1;
  }
  flushWindow();
  return parts;
}

/** 源码：行窗口块（≤ maxCodeBlockLines；≥20 行后在空行边界优先切分） */
function codeBlocks(text: string, fileName: string, notes: string[]): ParsedBlock[] {
  const language = languageOfFileName(fileName) ?? "unknown";
  const lines = splitLines(text);
  const blocks: ParsedBlock[] = [];
  const CODE_WINDOW_FLUSH_LINES = 20;
  let window: TextLine[] = [];

  const flush = () => {
    if (window.length === 0) {
      return;
    }
    if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
      if (notes.length < INGESTION_LIMITS.maxNotes && !notes.some((note) => note.includes("块数达到上限"))) {
        notes.push(`块数达到上限 ${INGESTION_LIMITS.maxBlocks}，已截断`);
      }
      window = [];
      return;
    }
    const body = window.map((line) => line.content).join("\n");
    if (body.trim() === "") {
      window = [];
      return;
    }
    const block: ParsedCodeBlock = {
      blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
      type: "code",
      provenance: {
        fileName,
        lineStart: window[0]!.number,
        lineEnd: window[window.length - 1]!.number,
      },
      language,
      text: body,
    };
    blocks.push(block);
    window = [];
  };

  for (const line of lines) {
    const isBlank = line.content.trim() === "";
    window.push(line);
    if (
      window.length >= INGESTION_LIMITS.maxCodeBlockLines ||
      (isBlank && window.length >= CODE_WINDOW_FLUSH_LINES)
    ) {
      flush();
    }
  }
  flush();
  return blocks;
}
