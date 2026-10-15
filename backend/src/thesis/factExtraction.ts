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
  /**
   * M14.1c 噪声判定（封面 / 目录被 parser 误识别为表格的定向标记）。
   * likely=true 时不进入事实抽取与对齐候选；判定只降权不删除——真实表格
   * 误判可由作者在事实侧补登记，不从解析产物中消失。
   */
  noise?: { likely: boolean; reasons: string[] };
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
  const noise = classifyTableNoise({ page: block.provenance.page, caption, headers, rows, labelBasis: labelInfo.basis });
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
    ...(noise !== undefined ? { noise } : {}),
  };
}

// ---------------------------------------------------------------------------
// 噪声表格分类（M14.1c）
// ---------------------------------------------------------------------------

/** 目录页码列：整列绝大多数是小的连续整数（页码形态） */
const TOC_KEYWORDS = /目录|contents|参考文献|references|致谢|acknowledg|图目录|表目录|索引|index/i;

export interface TableNoiseInput {
  page?: number;
  caption?: string;
  headers: string[];
  rows: string[][];
  labelBasis: FactTableLocation["labelBasis"];
}

/**
 * 封面 / 目录等非数据表格的定向判定。规则全部保守（多条共同证据才判噪声，
 * 避免真实无题注表格被误杀）：
 *   1. 目录页码形态：≥2 列整列为递增小整数（差值 ≤ 3），或标题/题注含目录类关键词；
 *   2. 封面区：page ≤ 2 且无题注且无表格标签且行数 ≤ 6 且数据单元格全为短文本；
 *   3. 退化网格：单行或单列（parser 对版面装饰的常见误判形态）且无题注。
 */
export function classifyTableNoise(input: TableNoiseInput): { likely: boolean; reasons: string[] } | undefined {
  const reasons: string[] = [];
  const { page, caption, headers, rows, labelBasis } = input;
  const captionText = caption ?? "";

  if (TOC_KEYWORDS.test(captionText) || (labelBasis === "adjacent_text" && caption !== undefined && TOC_KEYWORDS.test(caption))) {
    reasons.push("caption_toc_keyword");
  }
  const pageLikeColumns = countPageLikeColumns(rows);
  if (pageLikeColumns >= 2) {
    reasons.push(`page_number_columns:${pageLikeColumns}`);
  } else if (pageLikeColumns >= 1 && hasChapterLabelColumn(rows)) {
    // 两列目录（「章节 | 页码」）：一列页码 + 一列章节标签（第X章 / Chapter n / 参考文献…）
    reasons.push("toc_page_layout");
  }

  const noCaption = caption === undefined && labelBasis === "none";
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  if (page !== undefined && page <= 2 && noCaption && rows.length <= 6) {
    const cells = rows.flat().filter((cell) => cell !== "");
    const allShortText = cells.every((cell) => cell.length <= 12 && parseFactValue(cell).numeric === undefined);
    if (allShortText && cells.length > 0) {
      reasons.push("cover_page_short_text");
    }
  }
  // 退化网格：仅单列（多行单列是 parser 对版面装饰的常见误判形态）；
  // 单行多列（键值对形态 "Overall: 0.999"）可能是真实数据 → 不按噪声处理
  if (noCaption && width <= 1) {
    reasons.push("degenerate_grid");
  }

  if (reasons.length === 0) {
    return undefined;
  }
  return { likely: true, reasons };
}

/** 首列 ≥ 60% 为章节标签形态（第X章 / Chapter n / 参考文献 / 致谢 / 附录） */
function hasChapterLabelColumn(rows: string[][]): boolean {
  const CHAPTER_LABEL_RE = /^(?:第\s*[一二三四五六七八九十百\d]+\s*章|Chapter\s+\d+|参考文献|致谢|附录|结论)/u;
  const firstColumn = rows.map((row) => (row[0] ?? "").trim()).filter((cell) => cell !== "");
  if (firstColumn.length < 3) {
    return false;
  }
  const matched = firstColumn.filter((cell) => CHAPTER_LABEL_RE.test(cell)).length;
  return matched / firstColumn.length >= 0.6;
}

/** 整列 ≥ 80% 为 1-999 的整数且列内按行非降序 → 页码列（目录页码跨章跳跃，不限制步长） */
function countPageLikeColumns(rows: string[][]): number {
  if (rows.length < 4) {
    return 0;
  }
  const width = Math.max(...rows.map((row) => row.length));
  let columns = 0;
  for (let column = 0; column < width; column += 1) {
    const values = rows.map((row) => parseFactValue(row[column] ?? "").numeric);
    const present = values.filter((value): value is number => value !== undefined);
    if (present.length < rows.length * 0.8 || present.length < 3) {
      continue;
    }
    const allSmallInts = present.every((value) => Number.isInteger(value) && value >= 1 && value <= 999);
    const nonDescending = present.every((value, index) => index === 0 || value >= present[index - 1]!);
    if (allSmallInts && nonDescending) {
      columns += 1;
    }
  }
  return columns;
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
  /** M14.1c：噪声表格（封面 / 目录误判）跳过数 */
  skippedNoiseTables: number;
}

/** 确定性表格单元格事实（仅数值单元格；标签列与表头不成为事实） */
export function extractTableFacts(input: ResearchInput, document: ParsedDocument, now: string): ExtractTableFactsResult {
  const tables = extractTables(document);
  const facts: ScientificFact[] = [];
  let skippedCells = 0;
  let skippedNoiseTables = 0;
  for (const table of tables) {
    if (table.noise?.likely === true) {
      skippedNoiseTables += 1;
      continue;
    }
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
  return { facts, tables, skippedCells, skippedNoiseTables };
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
