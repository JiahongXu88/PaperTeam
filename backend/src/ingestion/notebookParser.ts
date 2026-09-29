/**
 * Jupyter Notebook (.ipynb) → DocumentExtraction（M10.1.1）。
 *
 * 硬约束：只做静态解析——不启动 kernel、不执行任何 cell 代码、不渲染
 * HTML/JS 输出。唯一「消费」用户内容的行为是 base64 解码图片输出并落
 * 盘为资产文件（纯字节操作，无执行语义）。
 *
 * 结构映射：
 *   markdown cell → text 块（cell 内行 provenance，ATX 标题维护 section）
 *   code cell     → code 块（语言自 kernelspec/language_info 推断；
 *                   execution_count 存在时记录）
 *   text 类输出   → output 块（stream / execute_result / display_data 的
 *                   text/plain / error traceback；超长截断如实标记）
 *   图片类输出    → figure 块（解码落盘 asset；超上限登记
 *                   visualOutputPresent=true，事实不丢失）
 * provenance：cellIndex（0-based，与 nbformat cells 数组下标一致）+
 * cellId（存在时）+ outputIndex（输出序号）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import { imageDimensions, imageSignature } from "./imageHeaders.js";
import {
  INGESTION_LIMITS,
  type DocumentExtraction,
  type DocumentParseOptions,
  type DocumentParser,
  type ParsedBlock,
  type ParsedCodeBlock,
  type ParsedFigureBlock,
  type ParsedOutputBlock,
  type ParsedTextBlock,
  type TextKind,
} from "./types.js";

interface RawOutput {
  output_type?: unknown;
  name?: unknown;
  text?: unknown;
  data?: unknown;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
}

interface CellBase {
  fileName: string;
  cellIndex: number;
  cellId?: string;
}

export class NotebookParser implements DocumentParser {
  readonly id = "notebook";

  async parseFile(absolutePath: string, options?: DocumentParseOptions): Promise<DocumentExtraction> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      throw new DocumentParseFailedError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.parseBuffer(buffer, basename(absolutePath), options?.figuresDir);
  }

  async parseBuffer(buffer: Buffer, fileName: string, figuresDir?: string): Promise<DocumentExtraction> {
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    if (text.trim() === "") {
      throw new DocumentParseFailedError("Notebook 文件内容为空");
    }
    let notebook: unknown;
    try {
      notebook = JSON.parse(text);
    } catch (error) {
      throw new DocumentParseFailedError(
        `Notebook JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      notebook === null ||
      typeof notebook !== "object" ||
      !Array.isArray((notebook as { cells?: unknown }).cells)
    ) {
      throw new DocumentParseFailedError("不是有效的 Notebook（缺少 cells 数组）");
    }
    const nb = notebook as {
      cells: unknown[];
      metadata?: { kernelspec?: { language?: unknown }; language_info?: { name?: unknown } };
    };
    const language = notebookLanguage(nb.metadata);
    const notes: string[] = [];
    const blocks: ParsedBlock[] = [];
    let imageAssets = 0;
    let visualSkipped = 0;

    const pushBlock = (block: ParsedBlock): void => {
      if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
        const note = `块数达到上限 ${INGESTION_LIMITS.maxBlocks}，已截断`;
        if (!notes.includes(note)) {
          notes.push(note);
        }
        return;
      }
      block.blockId = `B${String(blocks.length + 1).padStart(4, "0")}`;
      blocks.push(block);
    };

    for (let cellIndex = 0; cellIndex < nb.cells.length; cellIndex += 1) {
      const cell = nb.cells[cellIndex]!;
      if (
        cell === null ||
        typeof cell !== "object" ||
        typeof (cell as { cell_type?: unknown }).cell_type !== "string"
      ) {
        throw new DocumentParseFailedError(`cell ${cellIndex} 缺少 cell_type（不是有效的 Notebook 结构）`);
      }
      const raw = cell as {
        cell_type: string;
        id?: unknown;
        source?: unknown;
        execution_count?: unknown;
        outputs?: unknown;
      };
      const base: CellBase = {
        fileName,
        cellIndex,
        ...(typeof raw.id === "string" ? { cellId: raw.id } : {}),
      };
      const source = normalizeMultiline(raw.source);
      if (raw.cell_type === "code") {
        const executionCount =
          typeof raw.execution_count === "number" && Number.isFinite(raw.execution_count)
            ? raw.execution_count
            : undefined;
        for (const part of cellCodeParts(source, language, executionCount, base)) {
          pushBlock(part);
        }
        if (Array.isArray(raw.outputs)) {
          for (let outputIndex = 0; outputIndex < raw.outputs.length; outputIndex += 1) {
            const output = raw.outputs[outputIndex]!;
            if (output === null || typeof output !== "object") {
              continue; // 输出槽位损坏：跳过该输出（cell 本体已登记）
            }
            const outputBlocks = await staticOutputBlocks(output as RawOutput, base, outputIndex, {
              figuresDir,
              notes,
              canWriteImage: () => imageAssets < INGESTION_LIMITS.maxNotebookImages,
              onImageWritten: () => {
                imageAssets += 1;
              },
              onVisualSkipped: () => {
                visualSkipped += 1;
              },
            });
            for (const block of outputBlocks) {
              pushBlock(block);
            }
          }
        }
        continue;
      }
      // markdown / raw / 未知类型：按文本投影（未知类型如实记 note）
      if (raw.cell_type !== "markdown" && raw.cell_type !== "raw") {
        const note = `cell ${cellIndex} 为未知类型 ${raw.cell_type}，按文本处理`;
        if (!notes.includes(note) && notes.length < INGESTION_LIMITS.maxNotes - 1) {
          notes.push(note);
        }
      }
      for (const part of cellTextParts(source, base)) {
        pushBlock(part);
      }
    }
    if (visualSkipped > 0) {
      notes.push(`${visualSkipped} 个图片输出未落资产（超上限或无 figures 目录；已登记 visualOutputPresent）`);
    }
    if (blocks.length === 0) {
      throw new DocumentParseFailedError("Notebook 未解析出任何内容块（cells 为空）");
    }
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      mimeType: "application/x-ipynb+json",
      blocks,
      notes: notes.slice(0, INGESTION_LIMITS.maxNotes),
    };
  }
}

// ---- 输出静态投影（纯函数；无执行语义） ----

interface OutputContext {
  figuresDir: string | undefined;
  notes: string[];
  canWriteImage: () => boolean;
  onImageWritten: () => void;
  onVisualSkipped: () => void;
}

/** 单个输出 → 0..n 个块（figure 资产 + 文本可并存） */
async function staticOutputBlocks(
  output: RawOutput,
  base: CellBase,
  outputIndex: number,
  context: OutputContext,
): Promise<ParsedBlock[]> {
  const provenance = {
    fileName: base.fileName,
    cellIndex: base.cellIndex,
    ...(base.cellId !== undefined ? { cellId: base.cellId } : {}),
    outputIndex,
  };
  const where = `cell ${base.cellIndex} output ${outputIndex}`;
  const outputType = typeof output.output_type === "string" ? output.output_type : "unknown";
  if (outputType === "stream") {
    const raw = normalizeMultiline(output.text);
    const { text, truncated } = clipOutput(raw, context.notes, where);
    if (text.trim() === "") {
      return [];
    }
    return [
      {
        blockId: "",
        type: "output",
        provenance,
        outputKind: "stream",
        ...(typeof output.name === "string" ? { stream: output.name } : {}),
        text,
        ...(truncated ? { truncated: true } : {}),
      },
    ];
  }
  if (outputType === "error") {
    const ename = typeof output.ename === "string" ? output.ename : "Error";
    const evalue = typeof output.evalue === "string" ? output.evalue : "";
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.map((line) => (typeof line === "string" ? line : String(line))).join("\n")
      : "";
    const { text, truncated } = clipOutput(
      `${ename}: ${evalue}\n${stripAnsi(traceback)}`.trim(),
      context.notes,
      where,
    );
    if (text.trim() === "") {
      return [];
    }
    return [
      {
        blockId: "",
        type: "output",
        provenance,
        outputKind: "error",
        text,
        ...(truncated ? { truncated: true } : {}),
      },
    ];
  }
  if (outputType === "execute_result" || outputType === "display_data") {
    const data =
      typeof output.data === "object" && output.data !== null
        ? (output.data as Record<string, unknown>)
        : {};
    const blocks: ParsedBlock[] = [];
    const figure = await figureOutputBlock(data, provenance, outputIndex, context);
    if (figure !== null) {
      blocks.push(figure);
    }
    const plainRaw = normalizeMultiline(data["text/plain"]);
    const { text: plain, truncated } = clipOutput(plainRaw, context.notes, where);
    if (plain.trim() !== "") {
      const textBlock: ParsedOutputBlock = {
        blockId: "",
        type: "output",
        provenance,
        outputKind: outputType,
        text: plain,
        ...(truncated ? { truncated: true } : {}),
      };
      blocks.push(textBlock);
    }
    if (blocks.length === 0) {
      // 无图片无 text/plain：登记可用 data mime 类型（不执行、不猜测内容）
      const mimes = Object.keys(data).join(", ");
      return [
        {
          blockId: "",
          type: "output",
          provenance,
          outputKind: "other",
          text: `[non-text output data: ${mimes === "" ? "empty" : mimes}]`,
        },
      ];
    }
    return blocks;
  }
  // 其它输出类型（update_display_data / 自定义）：登记类型标记（不执行、不猜测）
  return [{ blockId: "", type: "output", provenance, outputKind: "other", text: `[non-text output: ${outputType}]` }];
}

/**
 * 图片输出 → figure 块（base64 解码 + 落盘 asset）。超上限 / 无目录 /
 * 签名无效 → visualOutputPresent 占位块（事实不丢）；无图片数据 → null。
 */
async function figureOutputBlock(
  data: Record<string, unknown>,
  provenance: ParsedFigureBlock["provenance"],
  outputIndex: number,
  context: OutputContext,
): Promise<ParsedFigureBlock | null> {
  let mime: string | undefined;
  let value: unknown;
  if (typeof data["image/png"] === "string" || Array.isArray(data["image/png"])) {
    mime = "image/png";
    value = data["image/png"];
  } else if (typeof data["image/jpeg"] === "string" || Array.isArray(data["image/jpeg"])) {
    mime = "image/jpeg";
    value = data["image/jpeg"];
  }
  if (mime === undefined) {
    return null;
  }
  const fallback: ParsedFigureBlock = {
    blockId: "",
    type: "figure",
    provenance,
    visualOutputPresent: true,
    truncated: true,
  };
  const base64 = normalizeMultiline(value);
  // 上限先于解码判断（base64 长度 ≈ 4/3 字节）
  if (base64.length > (INGESTION_LIMITS.maxNotebookImageBytes * 4) / 3) {
    context.onVisualSkipped();
    return fallback;
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > INGESTION_LIMITS.maxNotebookImageBytes) {
    context.onVisualSkipped();
    return fallback;
  }
  if (!context.canWriteImage() || context.figuresDir === undefined) {
    context.onVisualSkipped();
    return fallback;
  }
  const signature = imageSignature(bytes);
  if (signature === null) {
    const note = `${provenance.cellIndex} 号 cell 的 output ${outputIndex} 图片数据签名无效，未落资产`;
    if (!context.notes.includes(note) && context.notes.length < INGESTION_LIMITS.maxNotes - 1) {
      context.notes.push(note);
    }
    context.onVisualSkipped();
    return fallback;
  }
  const extension = signature === "image/png" ? ".png" : ".jpg";
  // 文件名与 provenance 索引一致（0-based）——审计可直接对上
  const assetName = `cell-${provenance.cellIndex}-output-${outputIndex}${extension}`;
  const dimensions = imageDimensions(bytes, signature);
  try {
    await mkdir(context.figuresDir, { recursive: true });
    await writeFile(join(context.figuresDir, assetName), bytes);
  } catch (error) {
    const note = `图片输出落盘失败（${assetName}）：${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`;
    if (!context.notes.includes(note) && context.notes.length < INGESTION_LIMITS.maxNotes - 1) {
      context.notes.push(note);
    }
    context.onVisualSkipped();
    return fallback;
  }
  context.onImageWritten();
  return {
    blockId: "",
    type: "figure",
    provenance,
    assetName,
    ...(dimensions !== null && dimensions !== undefined
      ? { width: dimensions.width, height: dimensions.height }
      : {}),
  };
}

// ---- cell 内容投影 ----

/** markdown / raw cell：cell 内行分段（ATX 标题维护 section） */
function cellTextParts(source: string, base: CellBase): ParsedTextBlock[] {
  const lines = source.split(/\r?\n/);
  const parts: ParsedTextBlock[] = [];
  let section = "";
  let paragraph: Array<{ content: string; number: number }> = [];
  const flush = () => {
    if (paragraph.length === 0 || paragraph.every((line) => line.content.trim() === "")) {
      paragraph = [];
      return;
    }
    const textKind = listKindOf(paragraph[0]?.content ?? "");
    parts.push({
      blockId: "",
      type: "text",
      provenance: {
        ...base,
        ...(section !== "" ? { section } : {}),
        lineStart: paragraph[0]!.number,
        lineEnd: paragraph[paragraph.length - 1]!.number,
      },
      text: paragraph.map((line) => line.content).join("\n"),
      ...(textKind !== undefined ? { textKind } : {}),
    });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i]!;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(content);
    if (heading !== null) {
      flush();
      section = heading[2] ?? "";
      parts.push({
        blockId: "",
        type: "text",
        provenance: { ...base, section, lineStart: i + 1, lineEnd: i + 1 },
        text: section,
        textKind: "section_header" as TextKind,
      });
      continue;
    }
    if (content.trim() === "") {
      flush();
      continue;
    }
    paragraph.push({ content, number: i + 1 });
  }
  flush();
  return parts;
}

/** code cell：行窗口（与 TextAssetParser 的源码策略一致） */
function cellCodeParts(
  source: string,
  language: string,
  executionCount: number | undefined,
  base: CellBase,
): ParsedCodeBlock[] {
  const lines = source.split(/\r?\n/);
  const parts: ParsedCodeBlock[] = [];
  let window: Array<{ content: string; number: number }> = [];
  const flush = () => {
    if (window.length === 0) {
      return;
    }
    const body = window.map((line) => line.content).join("\n");
    if (body.trim() !== "") {
      parts.push({
        blockId: "",
        type: "code",
        provenance: {
          ...base,
          lineStart: window[0]!.number,
          lineEnd: window[window.length - 1]!.number,
        },
        language,
        ...(executionCount !== undefined ? { executionCount } : {}),
        text: body,
      });
    }
    window = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i]!;
    window.push({ content, number: i + 1 });
    if (
      window.length >= INGESTION_LIMITS.maxCodeBlockLines ||
      (content.trim() === "" && window.length >= 20)
    ) {
      flush();
    }
  }
  flush();
  return parts;
}

function listKindOf(line: string): TextKind | undefined {
  if (/^(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
    return "list_item";
  }
  return undefined;
}

/** nbformat source 形态归一：string | string[] → string（[] 各项已含换行） */
function normalizeMultiline(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : String(part))).join("");
  }
  return "";
}

/** 输出文本截断（上限如实标记 truncated；note 去重有界） */
function clipOutput(text: string, notes: string[], where: string): { text: string; truncated: boolean } {
  if (text.length <= INGESTION_LIMITS.maxOutputChars) {
    return { text, truncated: false };
  }
  const note = `输出超过 ${INGESTION_LIMITS.maxOutputChars} 字符，已截断（${where}）`;
  if (!notes.includes(note) && notes.length < INGESTION_LIMITS.maxNotes - 1) {
    notes.push(note);
  }
  return { text: text.slice(0, INGESTION_LIMITS.maxOutputChars), truncated: true };
}

/** traceback ANSI 颜色序列剥离（ESC 前缀必需——纯静态文本净化） */
function stripAnsi(text: string): string {
  return text.replace(ESC_SEQUENCE_PATTERN, "");
}

const ESC_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** kernelspec.language / language_info.name → 规范语言标签 */
function notebookLanguage(
  metadata: { kernelspec?: { language?: unknown }; language_info?: { name?: unknown } } | undefined,
): string {
  const raw =
    (typeof metadata?.kernelspec?.language === "string" && metadata.kernelspec.language) ||
    (typeof metadata?.language_info?.name === "string" && metadata.language_info.name) ||
    "";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return "python"; // 事实缺省：ipynb 生态主流
  }
  if (normalized === "python3" || normalized === "ipykernel") {
    return "python";
  }
  if (normalized === "c++" || normalized === "cpp17") {
    return "cpp";
  }
  if (normalized === "js" || normalized === "node") {
    return "javascript";
  }
  return normalized;
}
