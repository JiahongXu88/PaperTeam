/**
 * ParsedDocument → 检索 sections 投影（M10.1：结构化解析产物喂给既有
 * SourceChunker / RAG 管线，复用 buildSourceChunks 的 chunk 构建、
 * page provenance 与稳定 chunkId）。
 *
 * - PDF（docling structured）：text 块按 provenance.section 分组保序；
 *   table 块渲染为可检索文本（行列投影）作为同节 unit；figure / formula
 *   不进检索（无文本语义——视觉理解属 M10.2，但已在文档产物中登记）。
 * - CSV/XLSX：每条 structured_record 渲染为带 [sheet/row] 标记的行文本
 *   （行级 provenance 直接可见于 chunk 文本），按 sheet 分节。
 */

import type { ResolvedSection } from "../retrieval/chunking.js";
import type { ParsedDocument, ParsedRecordBlock, ParsedTableBlock } from "./types.js";

/**
 * PDF 结构化文档 → sections。阅读顺序保持：块数组顺序即文档顺序；
 * 连续同节块归一组，同名节再现时开新组（不跨段合并）。
 */
export function sectionsFromDocument(document: ParsedDocument): ResolvedSection[] {
  const sections: Array<{ title: string; units: Array<{ text: string; page?: number }> }> = [];
  let current = -1;
  let currentTitle: string | null = null;
  for (const block of document.blocks) {
    if (block.type !== "text" && block.type !== "table") {
      continue; // figure / formula：不进检索；登记在文档产物供 M10.2 消费
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

/** CSV/XLSX 结构化记录 → sections（按 sheet 连续段分节；行级 provenance 入文本） */
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

/** 记录块 → 单行文本：[sheet row N] header=value; …（chunk 文本自带回溯锚） */
export function renderRecordBlock(block: ParsedRecordBlock): string {
  const where =
    block.provenance.sheet !== undefined
      ? `[${block.provenance.sheet} row ${block.provenance.row}]`
      : `[row ${block.provenance.row}]`;
  const cells = block.cells
    .filter((cell) => cell.value !== "")
    .map((cell) => `${cell.header}=${cell.value.replace(/\s+/g, " ").trim()}`);
  return `${where} ${cells.join("; ")}`;
}
