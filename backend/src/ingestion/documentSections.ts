/**
 * ParsedDocument → 检索 sections 投影（M10.1 + M10.1.1：结构化解析产物喂给
 * 既有 SourceChunker / RAG 管线，复用 buildSourceChunks 的 chunk 构建、
 * page/line provenance 与稳定 chunkId）。
 *
 * - PDF / TXT / Markdown / LaTeX（docling·text 结构化产物）：text 块按
 *   provenance.section 分组保序；table 块渲染为可检索文本（行列投影）
 *   作为同节 unit；figure / formula 不进检索（无文本语义——视觉理解属
 *   M10.2，但已在文档产物中登记）；行 provenance（lineStart/lineEnd）
 *   随 unit 透传。
 * - CSV/XLSX/JSON/YAML：每条 structured_record 渲染为带定位标记的行文本
 *   （[sheet row N] / [path · line N]——行级 provenance 直接可见于 chunk
 *   文本），按 sheet / 文件分节。
 * - 源码：code 块 → 单节（Whole File）行窗口 unit（lineStart/lineEnd 透传）。
 * - Notebook：cell 分节（Cell N · 类型），text/code/output 块全部可检索；
 *   figure（图片输出）不进检索（已登记资产供 M10.2）。
 */

import type { ResolvedSection } from "../retrieval/chunking.js";
import type {
  ParsedDocument,
  ParsedRecordBlock,
  ParsedTableBlock,
} from "./types.js";

/**
 * 结构化文档（pdf / text / markdown / latex）→ sections。阅读顺序保持：
 * 块数组顺序即文档顺序；连续同节块归一组，同名节再现时开新组（不跨段
 * 合并）。行 provenance 透传到 unit（chunk 层落 lineStart/lineEnd）。
 */
export function sectionsFromDocument(document: ParsedDocument): ResolvedSection[] {
  const sections: Array<{ title: string; units: Array<{ text: string; page?: number; lineStart?: number; lineEnd?: number }> }> = [];
  let current = -1;
  let currentTitle: string | null = null;
  for (const block of document.blocks) {
    if (block.type !== "text" && block.type !== "table") {
      continue; // figure / formula / code / output / record：其它投影路径处理
    }
    const text = block.type === "text" ? block.text.trim() : renderTableBlock(block);
    if (text === "") {
      continue;
    }
    const section = block.provenance.section ?? "";
    if (current === -1 || section !== currentTitle) {
      sections.push({ title: section !== "" ? section : "Document Body", units: [] });
      current = sections.length - 1;
      currentTitle = section;
    }
    sections[current]!.units.push({
      text,
      ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
      ...(block.provenance.lineStart !== undefined
        ? { lineStart: block.provenance.lineStart, lineEnd: block.provenance.lineEnd ?? block.provenance.lineStart }
        : {}),
    });
  }
  return sections
    .filter((section) => section.units.length > 0)
    .map((section, index) => ({
      sectionId: `SEC${String(index + 1).padStart(2, "0")}`,
      title: section.title,
      level: 1,
      units: section.units,
    }));
}

/** 表格块 → 行列投影文本（可检索形态；结构化数据本体在 blocks 中） */
function renderTableBlock(block: ParsedTableBlock): string {
  const lines: string[] = [];
  if (block.caption !== undefined && block.caption.trim() !== "") {
    lines.push(block.caption.trim());
  }
  if (block.headers.length > 0) {
    lines.push(block.headers.join(" | "));
  }
  for (const row of block.rows) {
    const cells = row.map((cell) => cell.replace(/\s+/g, " ").trim());
    if (cells.some((cell) => cell !== "")) {
      lines.push(cells.join(" | "));
    }
  }
  return lines.join("\n");
}

/** CSV/XLSX/JSON/YAML 结构化记录 → sections（按 sheet 连续段分节；行级 provenance 入文本） */
export function tabularSectionsFromDocument(document: ParsedDocument): ResolvedSection[] {
  const sections: Array<{ title: string; units: Array<{ text: string }> }> = [];
  let current = -1;
  let currentSheet: string | null = null;
  for (const block of document.blocks) {
    if (block.type !== "structured_record") {
      continue;
    }
    const sheet = block.provenance.sheet ?? "";
    if (current === -1 || sheet !== currentSheet) {
      sections.push({ title: block.provenance.sheet ?? document.fileName, units: [] });
      current = sections.length - 1;
      currentSheet = sheet;
    }
    sections[current]!.units.push({ text: renderRecordBlock(block) });
  }
  return sections
    .filter((section) => section.units.length > 0)
    .map((section, index) => ({
      sectionId: `SEC${String(index + 1).padStart(2, "0")}`,
      title: section.title,
      level: 1,
      units: section.units,
    }));
}

/** 记录块 → 单行文本：定位标记 + header=value（chunk 文本自带回溯锚） */
export function renderRecordBlock(block: ParsedRecordBlock): string {
  const cells = block.cells
    .filter((cell) => cell.value !== "")
    .map((cell) => `${cell.header}=${cell.value.replace(/\s+/g, " ").trim()}`);
  const provenance = block.provenance;
  if (provenance.jsonPath !== undefined) {
    // JSON/YAML 投影：路径即定位（YAML 附行号；JSON 无行号不伪造）
    const line = provenance.row !== undefined ? ` · line ${provenance.row}` : "";
    return `[${provenance.jsonPath}${line}] ${cells.join("; ")}`;
  }
  const where =
    provenance.sheet !== undefined
      ? `[${provenance.sheet} row ${provenance.row}]`
      : `[row ${provenance.row}]`;
  return `${where} ${cells.join("; ")}`;
}

/** 源码文档 → sections：单节（Whole File），code 块行窗口 unit（行 provenance 透传） */
export function codeSectionsFromDocument(document: ParsedDocument): ResolvedSection[] {
  const units: Array<{ text: string; lineStart?: number; lineEnd?: number }> = [];
  for (const block of document.blocks) {
    if (block.type !== "code") {
      continue;
    }
    if (block.text.trim() === "") {
      continue;
    }
    units.push({
      text: block.text,
      ...(block.provenance.lineStart !== undefined
        ? {
            lineStart: block.provenance.lineStart,
            lineEnd: block.provenance.lineEnd ?? block.provenance.lineStart,
          }
        : {}),
    });
  }
  if (units.length === 0) {
    return [];
  }
  return [
    {
      sectionId: "SEC01",
      title: "Whole File",
      level: 1,
      units,
    },
  ];
}

/**
 * Notebook 文档 → sections：按 cell 分节（连续块归组；标题 Cell N · 类型），
 * text / code / output 全部可检索（cellIndex 进节标题可回溯）；figure
 * （图片输出）不进检索——资产已登记，理解属 M10.2。
 */
export function notebookSectionsFromDocument(document: ParsedDocument): ResolvedSection[] {
  const sections: Array<{ title: string; units: Array<{ text: string; lineStart?: number; lineEnd?: number }> }> = [];
  let current = -1;
  let currentCell: number | null = null;
  for (const block of document.blocks) {
    if (block.type !== "text" && block.type !== "code" && block.type !== "output") {
      continue;
    }
    const text =
      block.type === "output"
        ? block.text.trim() === ""
          ? ""
          : block.text.trim()
        : block.text.trim();
    if (text === "") {
      continue;
    }
    const cellIndex = block.provenance.cellIndex;
    if (current === -1 || cellIndex !== currentCell) {
      const kind =
        block.type === "code" ? "code" : block.type === "output" ? "output" : "markdown";
      sections.push({
        title: cellIndex !== undefined ? `Cell ${cellIndex} · ${kind}` : "Notebook",
        units: [],
      });
      current = sections.length - 1;
      currentCell = cellIndex ?? null;
    }
    sections[current]!.units.push({
      text,
      ...(block.provenance.lineStart !== undefined
        ? {
            lineStart: block.provenance.lineStart,
            lineEnd: block.provenance.lineEnd ?? block.provenance.lineStart,
          }
        : {}),
    });
  }
  return sections
    .filter((section) => section.units.length > 0)
    .map((section, index) => ({
      sectionId: `SEC${String(index + 1).padStart(2, "0")}`,
      title: section.title,
      level: 1,
      units: section.units,
    }));
}
