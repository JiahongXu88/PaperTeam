/**
 * M14.1b：跨研究输入的表格对齐 + 单元格级冲突检测（纯函数、确定性）。
 *
 * 对齐规则（只认结构与内容证据，不做语义猜测）：
 *   comparable      列标签归一后一致 + 行数相等 + 已比较单元格 ≥ 4 且 ≥ 50% 相同
 *                   + 无标签不兼容的行；
 *   candidate       列标签一致且 ≥ 30% 相同，或共享 ≥ 2 个标识符 token 且 ≥ 30% 相同
 *                   （留给作者确认，不进入冲突检测）；
 *   其余不产生对齐记录。
 *
 * 冲突规则（只在 comparable 对齐内、标签兼容的行对上逐列比较）：
 *   value_mismatch（blocking）/ rounding_difference / unit_incomparable /
 *   equal_after_unit_normalization（advisory）；相等不生成记录。
 *   不同实验协议 = 不同表格 → 不会被对齐 → 不是冲突。
 */

import { sha256Hex } from "../util/hash.js";
import type { ExtractedTable } from "./factExtraction.js";
import { compareFactValues, identifierTokens, normalizeLabel, parseFactValue } from "./factValues.js";
import {
  RESEARCH_INPUT_ALGORITHM_VERSION,
  type ConflictClassification,
  type FactConflict,
  type ResearchInput,
  type RowLabelCompatibility,
  type ScientificFact,
  type TableAlignment,
} from "./researchInputTypes.js";

export interface InputTables {
  input: ResearchInput;
  tables: ExtractedTable[];
}

const MIN_COMPARED_CELLS = 4;
const COMPARABLE_RATIO = 0.5;
const CANDIDATE_RATIO = 0.3;

export function alignTables(left: InputTables, right: InputTables, projectId: string, now: string): TableAlignment[] {
  const alignments: TableAlignment[] = [];
  for (const a of left.tables) {
    for (const b of right.tables) {
      const alignment = alignPair(left.input, a, right.input, b, projectId, now);
      if (alignment !== null) {
        alignments.push(alignment);
      }
    }
  }
  return alignments;
}

function dataHeaders(table: ExtractedTable): string[] {
  return table.headers.slice(table.labelColumnCount).map(normalizeLabel);
}

function labelCompatibility(a: string, b: string): RowLabelCompatibility {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (na === nb) {
    return na === "" ? "empty" : "equal";
  }
  if (na === "" || nb === "") {
    return "empty";
  }
  const ta = new Set(labelTokens(a));
  const tb = new Set(labelTokens(b));
  if (ta.size > 0 && tb.size > 0 && ([...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t)))) {
    return "contains";
  }
  return "mismatch";
}

function labelTokens(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((token) => token !== "");
}

function alignPair(
  leftInput: ResearchInput,
  a: ExtractedTable,
  rightInput: ResearchInput,
  b: ExtractedTable,
  projectId: string,
  now: string,
): TableAlignment | null {
  const headersA = dataHeaders(a);
  const headersB = dataHeaders(b);
  const columnLabelsMatch =
    headersA.length > 0 && headersA.length === headersB.length && headersA.every((h, i) => h === headersB[i]);
  const sharedIdentifiers = sharedIdentifierTokens(a, b);
  // 行配对：行数相等按下标；否则按归一化行标签相等
  const rowPairs: TableAlignment["evidence"]["rowPairs"] = [];
  if (a.rows.length === b.rows.length) {
    a.rows.forEach((row, i) => {
      const other = b.rows[i]!;
      rowPairs.push({ leftRow: row.rowIndex, rightRow: other.rowIndex, labelCompatibility: labelCompatibility(row.rowLabel, other.rowLabel) });
    });
  } else {
    for (const row of a.rows) {
      const key = normalizeLabel(row.rowLabel);
      if (key === "") continue;
      const matches = b.rows.filter((other) => normalizeLabel(other.rowLabel) === key);
      if (matches.length === 1) {
        rowPairs.push({ leftRow: row.rowIndex, rightRow: matches[0]!.rowIndex, labelCompatibility: "equal" });
      }
    }
  }
  // 单元格相同计数（仅可比列：列标签一致时按列下标；否则按列标签相等）
  let compared = 0;
  let identical = 0;
  const columnMap = columnPairs(a, b, headersA, headersB, columnLabelsMatch);
  for (const pair of rowPairs) {
    if (pair.labelCompatibility === "mismatch") continue;
    const rowA = a.rows.find((r) => r.rowIndex === pair.leftRow)!;
    const rowB = b.rows.find((r) => r.rowIndex === pair.rightRow)!;
    for (const [ca, cb] of columnMap) {
      const va = parseFactValue(rowA.cells[ca] ?? "");
      const vb = parseFactValue(rowB.cells[cb] ?? "");
      if (va.numeric === undefined || vb.numeric === undefined) continue;
      compared += 1;
      if (compareFactValues(va, vb).outcome === "equal") identical += 1;
    }
  }
  const ratio = compared === 0 ? 0 : identical / compared;
  const anyMismatchRow = rowPairs.some((pair) => pair.labelCompatibility === "mismatch");
  // M14.1c：列标签集合相等但顺序不同（列重排）→ 只能作为候选（作者确认列对应关系）
  const columnLabelsSetMatch =
    !columnLabelsMatch &&
    headersA.length > 0 &&
    headersA.length === headersB.length &&
    multisetEqual(headersA, headersB);
  let status: TableAlignment["status"] | null = null;
  let reason: string | undefined;
  if (columnLabelsMatch && a.rows.length === b.rows.length && compared >= MIN_COMPARED_CELLS && ratio >= COMPARABLE_RATIO && !anyMismatchRow) {
    status = "comparable";
  } else if (
    (columnLabelsMatch && ratio >= CANDIDATE_RATIO && compared > 0) ||
    (sharedIdentifiers.length >= 2 && ratio >= CANDIDATE_RATIO && compared > 0) ||
    (columnLabelsSetMatch && ratio >= CANDIDATE_RATIO && compared > 0)
  ) {
    status = "candidate";
    reason = anyMismatchRow
      ? "存在行标签不兼容的行对，需作者确认对应关系"
      : columnLabelsSetMatch
        ? "列标签集合一致但顺序不同（列重排），只能作为候选"
        : !columnLabelsMatch
          ? "列标签不一致，只能作为候选"
          : a.rows.length !== b.rows.length
            ? "行数不等（增删行），只能作为候选"
            : `相同单元格比例 ${(ratio * 100).toFixed(0)}% 低于可比阈值`;
  }
  if (status === null) {
    return null;
  }
  const leftRef = { researchInputId: leftInput.inputId, contentHash: leftInput.version.contentHash, blockId: a.blockId, ...(a.label !== undefined ? { label: a.label } : {}), labelBasis: a.labelBasis, ...(a.page !== undefined ? { page: a.page } : {}) };
  const rightRef = { researchInputId: rightInput.inputId, contentHash: rightInput.version.contentHash, blockId: b.blockId, ...(b.label !== undefined ? { label: b.label } : {}), labelBasis: b.labelBasis, ...(b.page !== undefined ? { page: b.page } : {}) };
  return {
    alignmentId: `A${sha256Hex([leftRef.researchInputId, leftRef.contentHash, a.blockId, rightRef.researchInputId, rightRef.contentHash, b.blockId].join("|")).slice(0, 16)}`,
    projectId,
    left: leftRef,
    right: rightRef,
    status,
    basis: "deterministic",
    evidence: {
      columnLabelsMatch,
      rowCounts: [a.rows.length, b.rows.length],
      identicalCells: identical,
      comparedCells: compared,
      sharedIdentifiers,
      rowPairs,
      ...(reason !== undefined ? { reason } : {}),
      // M14.1c：候选对齐展示用表头样本（作者肉眼比对列结构；确定性证据仍是布尔/计数）
      columnLabelsSample: [
        a.headers.slice(a.labelColumnCount),
        b.headers.slice(b.labelColumnCount),
      ],
    },
    algorithmVersion: RESEARCH_INPUT_ALGORITHM_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

function columnPairs(a: ExtractedTable, b: ExtractedTable, headersA: string[], headersB: string[], labelsMatch: boolean): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  if (labelsMatch) {
    headersA.forEach((_, i) => pairs.push([a.labelColumnCount + i, b.labelColumnCount + i]));
    return pairs;
  }
  headersA.forEach((header, i) => {
    if (header === "") return;
    const matches = headersB.map((h, j) => (h === header ? j : -1)).filter((j) => j >= 0);
    if (matches.length === 1) pairs.push([a.labelColumnCount + i, b.labelColumnCount + matches[0]!]);
  });
  return pairs;
}

/** 列标签多重集相等（重排检测；归一化后比较） */
function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function sharedIdentifierTokens(a: ExtractedTable, b: ExtractedTable): string[] {
  const textOf = (t: ExtractedTable) => [t.caption ?? "", t.label ?? "", ...t.headers].join(" ");
  const ta = new Set(identifierTokens(textOf(a)));
  return identifierTokens(textOf(b)).filter((token) => ta.has(token));
}

export interface ConflictDetectionInput {
  projectId: string;
  alignments: TableAlignment[];
  /** 两侧输入的表格视图（按 inputId） */
  tablesByInput: Map<string, ExtractedTable[]>;
  /** 全部事实（按 factId 查找表格单元格事实） */
  facts: ScientificFact[];
  now: string;
}

/** 返回新检测到的冲突（含 advisory）；调用方按 conflictId 幂等合并 */
export function detectTableConflicts(input: ConflictDetectionInput): FactConflict[] {
  const byLocation = new Map<string, ScientificFact>();
  for (const fact of input.facts) {
    const table = fact.provenance.table;
    if (fact.kind !== "table_cell" || table === undefined || fact.provenance.blockId === undefined) continue;
    byLocation.set(`${fact.researchInputId}|${fact.provenance.contentHash}|${fact.provenance.blockId}|${table.rowIndex}|${table.columnIndex}`, fact);
  }
  const conflicts: FactConflict[] = [];
  for (const alignment of input.alignments) {
    if (alignment.status !== "comparable") continue;
    const left = input.tablesByInput.get(alignment.left.researchInputId)?.find((t) => t.blockId === alignment.left.blockId);
    const right = input.tablesByInput.get(alignment.right.researchInputId)?.find((t) => t.blockId === alignment.right.blockId);
    if (left === undefined || right === undefined) continue;
    const headersA = dataHeaders(left);
    const headersB = dataHeaders(right);
    const columns = columnPairs(left, right, headersA, headersB, alignment.evidence.columnLabelsMatch);
    for (const pair of alignment.evidence.rowPairs) {
      if (pair.labelCompatibility === "mismatch") continue;
      for (const [ca, cb] of columns) {
        const fa = byLocation.get(`${alignment.left.researchInputId}|${alignment.left.contentHash}|${left.blockId}|${pair.leftRow}|${ca}`);
        const fb = byLocation.get(`${alignment.right.researchInputId}|${alignment.right.contentHash}|${right.blockId}|${pair.rightRow}|${cb}`);
        if (fa === undefined || fb === undefined) continue;
        const comparison = compareFactValues(fa.value, fb.value);
        if (comparison.outcome === "equal" || comparison.outcome === "non_numeric") continue;
        const classification: ConflictClassification = comparison.outcome;
        const ids = [fa.factId, fb.factId].sort();
        conflicts.push({
          schemaVersion: 1,
          conflictId: `C${sha256Hex(ids.join("|")).slice(0, 16)}`,
          projectId: input.projectId,
          classification,
          severity: classification === "value_mismatch" ? "blocking" : "advisory",
          key: {
            ...(fa.key.subject !== undefined ? { subject: fa.key.subject } : {}),
            ...(fa.key.metric !== undefined ? { metric: fa.key.metric } : {}),
            ...(alignment.evidence.sharedIdentifiers.length > 0 ? { dataset: alignment.evidence.sharedIdentifiers.join("/") } : {}),
          },
          parties: [fa, fb].map((fact) => ({
            factId: fact.factId,
            researchInputId: fact.researchInputId,
            contentHash: fact.provenance.contentHash,
            raw: fact.value.raw,
            ...(fact.value.normalized !== undefined ? { normalized: fact.value.normalized } : {}),
            ...(fact.value.unit !== undefined ? { unit: fact.value.unit } : {}),
            location: describeFactLocation(fact),
          })),
          alignmentId: alignment.alignmentId,
          detectedBy: "deterministic_table_alignment",
          algorithmVersion: RESEARCH_INPUT_ALGORITHM_VERSION,
          status: "unresolved",
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
    }
  }
  return conflicts;
}

export function describeFactLocation(fact: ScientificFact): string {
  const p = fact.provenance;
  const parts: string[] = [p.sourceId];
  if (p.page !== undefined) parts.push(`p${p.page}`);
  if (p.table !== undefined) {
    parts.push(`${p.table.label ?? p.table.tableRef}[${p.table.rowLabel || `row${p.table.rowIndex}`} × ${p.table.columnLabel || `col${p.table.columnIndex}`}]`);
  } else if (p.section !== undefined) {
    parts.push(p.section);
  }
  return parts.join(" ");
}
