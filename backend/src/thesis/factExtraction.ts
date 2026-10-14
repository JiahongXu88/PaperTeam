/**
 * M14.1b：从 ParsedDocument 确定性抽取研究事实（当前覆盖表格单元格）。
 *
 * 复用 M10.1 ingestion 的 ParsedTableBlock（docling TableFormer 网格 + 页码 /
 * bbox provenance）；不新建 PDF parser。抽取结果全部 status=extracted ——
 * 来源核验（文本层独立通道）与作者确认在后续步骤完成。
 *
 * 可靠性边界（如实记录，不编造）：
 *   - 表格标签（表4.3 / Table 5）来自 parser caption，否则取同页相邻题注文本块，
 *     否则 labelBasis=none；
 *   - parser headers 为占位符（"0","1",…）时以首行为表头并标 headerRowDerived；
 *   - 只有能可靠解析为数值的单元格成为事实（文本 / 范围 / 勾选不进入数值比较）；
 *   - 含私用区字形的内容标 glyphIssues，不参与比较。
 */

import type { ParsedDocument, ParsedTableBlock, ParsedTextBlock } from "../ingestion/types.js";
import { sha256Hex } from "../util/hash.js";
import { hasGlyphIssues, normalizeLabel, normalizeSurfaceText, parseFactValue } from "./factValues.js";
import {
  RESEARCH_INPUT_ALGORITHM_VERSION,
  type FactTableLocation,
  type ResearchInput,
  type ScientificFact,
} from "./researchInputTypes.js";

export const TABLE_FACT_EXTRACTOR = "thesis/factExtraction#table_cell";

const CAPTION_LABEL_RE = /^(?:表|Table|TABLE|Tab\.)\s*([0-9]+(?:\s*[.\-－．]\s*[0-9]+)?|[IVXLC]+)(?![0-9])/u;

/** 表格（抽取用的归一视图）：标签 / 题注 / 标签列 / 数据列 / 数据行 */
export interface ExtractedTable {
  blockId: string;
  page?: number;
  label?: string;
  labelBasis: FactTableLocation["labelBasis"];
  caption?: string;
  section?: string;
  /** 表头（可能由首行推导） */
  headers: string[];
  headerRowDerived: boolean;
  /** 前导标签列数（这些列的单元格对所有行都不是数值） */
  labelColumnCount: number;
  rows: ExtractedRow[];
}

export interface ExtractedRow {
  /** 原表格 rows 下标（表头推导后为原下标；用于 provenance） */
  rowIndex: number;
  /** 标签列拼接（"SSAA | explicit"） */
  rowLabel: string;
  cells: string[];
}

export function extractTables(document: ParsedDocument): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  document.blocks.forEach((block, index) => {
    if (block.type !== "table") {
      return;
    }
    const table = normalizeTable(block, document, index);
    if (table !== null) {
      tables.push(table);
    }
  });
  return tables;
}

function normalizeTable(block: ParsedTableBlock, document: ParsedDocument, index: number): ExtractedTable | null {
  let headers = block.headers.map((header) => normalizeSurfaceText(header));
  let rows = block.rows.map((row) => row.map((cell) => normalizeSurfaceText(cell)));
  let headerRowDerived = false;
  if (rows.length >= 1 && headers.length > 0 && headers.every((header, position) => header === String(position))) {
    headers = rows[0] ?? [];
    rows = rows.slice(1);
    headerRowDerived = true;
  }
  if (headers.length === 0 || rows.length === 0) {
    return null;
  }
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  headers = padTo(headers, width);
  rows = rows.map((row) => padTo(row, width));
  const labelColumnCount = countLabelColumns(rows, width);
  const caption = block.caption !== undefined ? normalizeSurfaceText(block.caption) : undefined;
  const labelInfo = resolveLabel(caption, block, document, index);
  const rowOffset = headerRowDerived ? 1 : 0;
  return {
    blockId: block.blockId,
    ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
    ...(labelInfo.label !== undefined ? { label: labelInfo.label } : {}),
    labelBasis: labelInfo.basis,
    ...(labelInfo.caption !== undefined ? { caption: labelInfo.caption } : {}),
    ...(block.provenance.section !== undefined ? { section: block.provenance.section } : {}),
    headers,
    headerRowDerived,
    labelColumnCount,
    rows: rows.map((cells, position) => ({
      rowIndex: position + rowOffset,
      rowLabel: cells
        .slice(0, labelColumnCount)
        .map((cell) => cell.trim())
        .join(" | "),
      cells,
    })),
  };
}

function padTo(cells: string[], width: number): string[] {
  return cells.length >= width ? cells.slice(0, width) : [...cells, ...new Array<string>(width - cells.length).fill("")];
}

/** 前导标签列：该列在所有行都不是可解析数值（允许空） */
function countLabelColumns(rows: string[][], width: number): number {
  let count = 0;
  for (let column = 0; column < width - 1; column += 1) {
    const allNonNumeric = rows.every((row) => {
      const cell = row[column] ?? "";
      return cell === "" || parseFactValue(cell).numeric === undefined;
    });
    const anyText = rows.some((row) => (row[column] ?? "") !== "");
    if (allNonNumeric && anyText) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function resolveLabel(
  caption: string | undefined,
  block: ParsedTableBlock,
  document: ParsedDocument,
  index: number,
): { label?: string; basis: FactTableLocation["labelBasis"]; caption?: string } {
  if (caption !== undefined) {
    const match = CAPTION_LABEL_RE.exec(caption);
    if (match !== null) {
      return { label: canonicalLabel(match[0]), basis: "parser_caption", caption };
    }
  }
  const page = block.provenance.page;
  const candidates: Array<{ distance: number; text: ParsedTextBlock }> = [];
  for (let offset = 1; offset <= 4; offset += 1) {
    for (const position of [index - offset, index + offset]) {
      const candidate = document.blocks[position];
      if (candidate === undefined || candidate.type !== "text") {
        continue;
      }
      if (page !== undefined && candidate.provenance.page !== undefined && candidate.provenance.page !== page) {
        continue;
      }
      if (CAPTION_LABEL_RE.test(candidate.text.trim())) {
        candidates.push({ distance: offset * 2 + (position < index ? 0 : 1), text: candidate });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (best !== undefined) {
    const text = normalizeSurfaceText(best.text.text);
    const match = CAPTION_LABEL_RE.exec(text);
    return {
      label: canonicalLabel(match?.[0] ?? text.slice(0, 20)),
      basis: "adjacent_text",
      caption: text.slice(0, 300),
      ...(caption !== undefined ? { caption } : {}),
    };
  }
  return { basis: "none", ...(caption !== undefined ? { caption } : {}) };
}

function canonicalLabel(raw: string): string {
  return normalizeSurfaceText(raw).replace(/\s+/g, "").replace(/[－．]/g, ".");
}

export interface ExtractTableFactsResult {
  facts: ScientificFact[];
  tables: ExtractedTable[];
  /** 数值不可解析而未成为事实的单元格数（透明度） */
  skippedCells: number;
}

/** 确定性表格单元格事实（仅数值单元格；标签列与表头不成为事实） */
export function extractTableFacts(input: ResearchInput, document: ParsedDocument, now: string): ExtractTableFactsResult {
  const tables = extractTables(document);
  const facts: ScientificFact[] = [];
  let skippedCells = 0;
  for (const table of tables) {
    for (const row of table.rows) {
      for (let column = table.labelColumnCount; column < table.headers.length; column += 1) {
        const surface = row.cells[column] ?? "";
        if (surface === "") {
          continue;
        }
        const value = parseFactValue(surface);
        if (value.numeric === undefined) {
          skippedCells += 1;
          continue;
        }
        const columnLabel = table.headers[column] ?? "";
        const location: FactTableLocation = {
          tableRef: tableRefOf(input, table.blockId),
          ...(table.label !== undefined ? { label: table.label } : {}),
          labelBasis: table.labelBasis,
          ...(table.caption !== undefined ? { caption: table.caption } : {}),
          rowIndex: row.rowIndex,
          columnIndex: column,
          rowLabel: row.rowLabel,
          columnLabel,
          ...(table.headerRowDerived ? { headerRowDerived: true } : {}),
        };
        const factId = tableCellFactId(input, table.blockId, row.rowIndex, column);
        facts.push({
          schemaVersion: 1,
          factId,
          projectId: input.projectId,
          researchInputId: input.inputId,
          kind: "table_cell",
          key: {
            subject: normalizeLabel(row.rowLabel),
            metric: normalizeLabel(columnLabel),
            ...(table.label !== undefined ? { protocol: `table:${table.label}` } : {}),
          },
          surface,
          value: { ...value, ...(hasGlyphIssues(row.rowLabel) || hasGlyphIssues(columnLabel) ? { glyphIssues: true } : {}) },
          provenance: {
            researchInputId: input.inputId,
            sourceId: input.version.sourceId,
            contentHash: input.version.contentHash,
            blockId: table.blockId,
            ...(table.page !== undefined ? { page: table.page } : {}),
            pageBasis: table.page !== undefined ? "parser" : "unknown",
            ...(table.section !== undefined ? { section: table.section } : {}),
            table: location,
            surfaceHash: sha256Hex(surface),
          },
          extraction: {
            method: "deterministic_table",
            extractor: TABLE_FACT_EXTRACTOR,
            algorithmVersion: RESEARCH_INPUT_ALGORITHM_VERSION,
          },
          verification: { status: "extracted", sourceCheck: "unchecked" },
          conflict: { status: "none", conflictIds: [] },
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  return { facts, tables, skippedCells };
}

export function tableRefOf(input: ResearchInput, blockId: string): string {
  return `${input.inputId}/${blockId}`;
}

/** 事实 id：输入 + 内容版本 + 表格块 + 行列 → 确定性（重放幂等；版本变化 = 新事实） */
export function tableCellFactId(input: ResearchInput, blockId: string, rowIndex: number, columnIndex: number): string {
  return `F${sha256Hex(`${input.inputId}|${input.version.contentHash}|${blockId}|${rowIndex}|${columnIndex}`).slice(0, 16)}`;
}

/** 非表格事实 id（模型候选 / 手工登记）：输入 + 内容版本 + kind + 归一化 surface */
export function statementFactId(input: ResearchInput, kind: string, surface: string): string {
  return `F${sha256Hex(`${input.inputId}|${input.version.contentHash}|${kind}|${normalizeSurfaceText(surface).toLowerCase()}`).slice(0, 16)}`;
}
