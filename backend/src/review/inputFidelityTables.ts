/**
 * M14.9.3 表格保真：用 PDF 文本层**逐词坐标**独立复原单元格位置（不依赖解析器表格网格），与投影
 * Markdown 表格逐行逐列比较数值与非数字符号（√ × ● …）。数字齐全但勾选列 / 数值列错位 → 硬失败；
 * 表头无法在文本层定位等无法可信复原的情形 → 不确定（需人工 QA），从不默认通过。
 */

import { canon, cellMarkers, cellNumbers, multisetKey } from "./inputFidelityText.js";

export interface FidelityWord { text: string; x0: number; x1: number; y0: number; y1: number }

export interface ProjectedTable { offset: number; header: string[]; rows: string[][] }

export type TableCheckStatus = "VERIFIED" | "MISMATCH" | "UNVERIFIED";

export interface TableCheck {
  status: TableCheckStatus;
  codes: string[];
  detail: string;
  projectedTableIndex: number | null;
}

/** 解析投影中的 Markdown 表格（连续的 | 行；第二行为分隔行） */
export function parseMarkdownTables(input: string): ProjectedTable[] {
  const text = input.replace(/\r\n?/g, "\n");
  const tables: ProjectedTable[] = [];
  for (const match of text.matchAll(/(?:^\|.*\|[ \t]*$\n?)+/gm)) {
    const lines = match[0].split("\n").filter((line) => line.trim() !== "");
    const cells = lines.map(splitRow);
    const separator = cells.findIndex((row) => row.every((cell) => /^:?-{2,}:?$/.test(cell.trim()) || cell.trim() === ""));
    const header = separator > 0 ? cells[separator - 1]! : [];
    const rows = separator >= 0 ? cells.slice(separator + 1) : cells;
    tables.push({ offset: match.index!, header, rows });
  }
  return tables;
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char === "\\" && inner[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

function tokensOf(input: string): string[] {
  // 圈码（①②③：表注 / 组别标记）保持为符号——NFKC 会把它们变成数字并与相邻数值粘连
  const text = input.replace(/[^\u2460-\u2473]+/g, (run) => run.normalize("NFKC"));
  return [...cellNumbers(text), ...cellMarkers(text)];
}

/** 投影表格全部单元格的词元（单元格之间用制表符分隔，避免相邻单元格的数字被当作千分组合并） */
function tableTokens(table: ProjectedTable): string[] {
  return tokensOf([table.header, ...table.rows].map((row) => row.join("\t")).join("\n"));
}

/** 文本层逐词按行（y 中心）拼接：同一单元格内被拆开的词（「177.」「905」）合并后再取词元 */
export function wordsText(words: readonly FidelityWord[]): string {
  const sorted = [...words].sort((a, b) => middle(a) - middle(b) || a.x0 - b.x0);
  const lines: FidelityWord[][] = [];
  for (const word of sorted) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(middle(last[0]!) - middle(word)) < (word.y1 - word.y0) * 0.5) last.push(word);
    else lines.push([word]);
  }
  return lines.map((line) => joinCell(line)).join("\n");
}

/** 同一单元格的词：按 x 排序；只有被拆开的小数（「0.」+「351」）直接拼接，其余以空格分隔 */
function joinCell(cell: readonly FidelityWord[]): string {
  const sorted = [...cell].sort((a, b) => a.x0 - b.x0);
  let out = "";
  let previous: FidelityWord | null = null;
  for (const word of sorted) {
    if (previous === null) out = word.text;
    else {
      const gap = word.x0 - previous.x1;
      const height = word.y1 - word.y0;
      out += gap < height * 0.5 && /\d\.$/.test(previous.text) && /^\d/.test(word.text) ? word.text : gap > height * 0.6 ? `\t${word.text}` : ` ${word.text}`;
    }
    previous = word;
  }
  return out;
}

/** 投影表与源表的匹配：数值 + 符号多重集重合度最高者（≥0.5） */
export function matchProjectedTable(words: readonly FidelityWord[], tables: readonly ProjectedTable[], used: ReadonlySet<number>): number | null {
  const source = countMap(tokensOf(wordsText(words)));
  const sourceTotal = [...source.values()].reduce((a, b) => a + b, 0);
  const sourceCanon = canon(words.map((word) => word.text).join(""));
  let best: number | null = null;
  let bestScore = 0;
  tables.forEach((table, index) => {
    if (used.has(index)) return;
    const all = [table.header, ...table.rows].map((row) => row.join("\t")).join("\n");
    let score: number;
    if (sourceTotal === 0) {
      const projectedCanon = canon(all);
      score = projectedCanon.length === 0 ? 0 : overlapRatio(sourceCanon, projectedCanon);
    } else {
      const projected = countMap(tokensOf(all));
      let common = 0;
      for (const [token, count] of source) common += Math.min(count, projected.get(token) ?? 0);
      score = common / Math.max(sourceTotal, 1);
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return bestScore >= 0.5 ? best : null;
}

function overlapRatio(a: string, b: string): number {
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= b.length; index += 1) grams.add(b.slice(index, index + 3));
  let hits = 0;
  let total = 0;
  for (let index = 0; index + 3 <= a.length; index += 1) {
    total += 1;
    if (grams.has(a.slice(index, index + 3))) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

function countMap(items: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

const center = (word: FidelityWord): number => (word.x0 + word.x1) / 2;
const middle = (word: FidelityWord): number => (word.y0 + word.y1) / 2;

/** 表头叶子（多级表头「组 / 叶」取最后一级） */
function headerLeaf(cell: string): string {
  const parts = cell.split(" / ").map((part) => part.trim()).filter((part) => part !== "");
  return parts.length === 0 ? "" : parts[parts.length - 1]!;
}

/**
 * 在文本层中定位表头叶子：同一行上相邻若干词拼接后的规范串 = 叶子规范串。返回每列 x 中心
 * （列序必须单调递增；空表头列 = null）。
 */
function locateHeaders(words: readonly FidelityWord[], header: readonly string[]): { centers: Array<number | null>; headerBottom: number } | null {
  const sorted = [...words].sort((a, b) => middle(a) - middle(b) || a.x0 - b.x0);
  const lineHeight = median(sorted.map((word) => word.y1 - word.y0)) || 8;
  const lines: FidelityWord[][] = [];
  for (const word of sorted) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(middle(last[0]!) - middle(word)) < lineHeight * 0.5) last.push(word);
    else lines.push([word]);
  }
  for (const line of lines) line.sort((a, b) => a.x0 - b.x0);
  const centers: Array<number | null> = [];
  let previous = -Infinity;
  let headerBottom = -Infinity;
  for (const cell of header) {
    const leaf = canon(headerLeaf(cell));
    if (leaf === "") {
      centers.push(null);
      continue;
    }
    // 先找完整叶子；找不到时接受跨行表头的首行前缀（≥2 字符且 ≥ 叶子长度 40%，如「未失能组」+ 下一行「(n=2 281)」）
    const search = (accept: (joined: string) => boolean): { x: number; bottom: number } | null => {
      for (const line of lines.slice(0, 6)) {
        for (let start = 0; start < line.length; start += 1) {
          let joined = "";
          for (let end = start; end < line.length; end += 1) {
            joined += canon(line[end]!.text);
            if (joined.length > leaf.length) break;
            const x = (line[start]!.x0 + line[end]!.x1) / 2;
            if (accept(joined) && x > previous && (end + 1 >= line.length || !leaf.startsWith(joined + canon(line[end + 1]!.text)))) {
              return { x, bottom: Math.max(...line.slice(start, end + 1).map((word) => word.y1)) };
            }
          }
        }
      }
      return null;
    };
    const found = search((joined) => joined === leaf) ??
      search((joined) => joined.length >= 2 && joined.length >= 0.4 * leaf.length && leaf.startsWith(joined));
    if (found === null) return null;
    centers.push(found.x);
    previous = found.x;
    headerBottom = Math.max(headerBottom, found.bottom);
  }
  return { centers, headerBottom };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 独立复原：表头列中心 → 列边界；正文词按 y 聚行（只含符号的行并入最近的数据行），按 x 中心分列 */
export function reconstructGrid(words: readonly FidelityWord[], header: readonly string[]): { grid: string[][]; ambiguousRows: number } | null {
  const located = locateHeaders(words, header);
  if (located === null) return null;
  const columns = located.centers.length;
  const known = located.centers.map((x, index) => ({ x, index })).filter((entry): entry is { x: number; index: number } => entry.x !== null);
  if (known.length < Math.max(2, columns - 1)) return null;
  const body = words.filter((word) => word.y0 > located.headerBottom - 0.5);
  const leftmost = Math.min(...body.map((word) => word.x0), known[0]!.x);
  const centers = located.centers.map((x, index) => x ?? (index === 0 ? leftmost : null));
  if (centers.some((x) => x === null)) return null;
  const xs = centers as number[];
  const columnOf = (word: FidelityWord): number => {
    const x = center(word);
    let best = 0;
    for (let index = 1; index < xs.length; index += 1) if (Math.abs(xs[index]! - x) < Math.abs(xs[best]! - x)) best = index;
    return best;
  };
  const lineHeight = median(body.map((word) => word.y1 - word.y0)) || 8;
  const sorted = [...body].sort((a, b) => middle(a) - middle(b));
  const rows: FidelityWord[][] = [];
  for (const word of sorted) {
    const last = rows[rows.length - 1];
    if (last !== undefined && middle(word) - middle(last[0]!) < lineHeight * 0.55) last.push(word);
    else rows.push([word]);
  }
  const markerOnly = (row: FidelityWord[]): boolean => row.every((word) => cellMarkers(word.text).length > 0 && canon(word.text).length === 0);
  const dataRows = rows.filter((row) => !markerOnly(row));
  let ambiguousRows = 0;
  for (const row of rows.filter(markerOnly)) {
    if (dataRows.length === 0) break;
    const y = median(row.map(middle));
    const distances = dataRows.map((candidate) => Math.abs(median(candidate.map(middle)) - y));
    const order = distances.map((distance, index) => ({ distance, index })).sort((a, b) => a.distance - b.distance);
    if (order.length > 1 && order[1]!.distance - order[0]!.distance < lineHeight * 0.15) ambiguousRows += 1;
    dataRows[order[0]!.index]!.push(...row);
  }
  dataRows.sort((a, b) => median(a.map(middle)) - median(b.map(middle)));
  const grid = dataRows.map((row) => {
    const cells: FidelityWord[][] = Array.from({ length: columns }, () => []);
    for (const word of row) cells[columnOf(word)]!.push(word);
    return cells.map((cell) => joinCell(cell));
  });
  return { grid, ambiguousRows };
}

/**
 * 断开 / 合并的同一数字（「1 332」↔「1332」、跨行表头「(n=1」「332)」、「50.334 3」被拆成数值 + 自由度）：
 * 一侧缺失的若干相邻词元的数字串拼接 = 另一侧多出的单个词元 → 视为分词差异而非内容差异（原地移除）。
 */
function reconcileSplitNumbers(extras: string[], missing: string[]): void {
  const digits = (token: string) => token.replace(/\D/g, "");
  const settle = (singles: string[], parts: string[]) => {
    for (let index = singles.length - 1; index >= 0; index -= 1) {
      const target = digits(singles[index]!);
      if (target.length < 2) continue;
      let match: number[] | null = null;
      for (let a = 0; a < parts.length && match === null; a += 1) {
        for (let b = 0; b < parts.length && match === null; b += 1) {
          if (b === a) continue;
          const ab = digits(parts[a]!) + digits(parts[b]!);
          if (ab === target) match = [a, b];
          else if (target.startsWith(ab)) {
            for (let c = 0; c < parts.length; c += 1) {
              if (c !== a && c !== b && ab + digits(parts[c]!) === target) {
                match = [a, b, c];
                break;
              }
            }
          }
        }
      }
      if (match !== null) {
        for (const at of [...match].sort((x, y) => y - x)) parts.splice(at, 1);
        singles.splice(index, 1);
      }
    }
  };
  settle(extras, missing);
  settle(missing, extras);
}

const HARD_TABLE_CODES = new Set(["TABLE_CELL_POSITION_MISMATCH", "TABLE_MARKER_COUNT_MISMATCH", "TABLE_EXTRA_VALUES", "TABLE_VALUES_MISSING", "TABLE_HEADER_SYNTHETIC"]);
const hasHardCode = (codes: readonly string[]) => codes.some((code) => HARD_TABLE_CODES.has(code));

/** 源表（逐词坐标）对投影表的保真判定 */
export function checkTable(words: readonly FidelityWord[], tables: readonly ProjectedTable[], used: Set<number>): TableCheck {
  const index = matchProjectedTable(words, tables, used);
  if (index === null) {
    const hasContent = tokensOf(wordsText(words)).length > 0;
    return { status: hasContent ? "MISMATCH" : "UNVERIFIED", codes: [hasContent ? "TABLE_NOT_FOUND" : "TABLE_EMPTY_SOURCE"], detail: "投影中找不到与源表数值 / 符号重合度 ≥50% 的表格", projectedTableIndex: null };
  }
  used.add(index);
  const table = tables[index]!;
  const sourceTokens = tokensOf(wordsText(words));
  const projectedTokens = tableTokens(table);
  const sourceMarkers = sourceTokens.filter((token) => !/\d/.test(token));
  const projectedMarkers = projectedTokens.filter((token) => !/\d/.test(token));
  const codes: string[] = [];
  if (multisetKey(sourceMarkers) !== multisetKey(projectedMarkers)) codes.push("TABLE_MARKER_COUNT_MISMATCH");
  // 数值核对：表体逐值多重集；表头按「去重集合」比较——多级表头的组标题（「95%置信区间」「模型1」）
  // 在 Markdown 中按子列重复展开，属可解释的表示差异，不算多出的值
  const isValue = (token: string) => /\d/.test(token);
  const sourceCount = countMap(sourceTokens.filter(isValue));
  const bodyTokens = tokensOf(table.rows.map((row) => row.join("\t")).join("\n")).filter(isValue);
  const headerTokens = new Set(tokensOf(table.header.join("\t")).filter(isValue));
  const sourceDigits = canon(wordsText(words)).replace(/\D/g, "");
  const extras: string[] = [];
  for (const [token, count] of countMap(bodyTokens)) {
    for (let k = sourceCount.get(token) ?? 0; k < count; k += 1) extras.push(token);
  }
  for (const token of headerTokens) if (!sourceCount.has(token) && !sourceDigits.includes(token.replace(/\D/g, ""))) extras.push(token);
  const missingValues: string[] = [];
  const projectedCount = countMap(bodyTokens);
  for (const [token, count] of sourceCount) {
    for (let k = (projectedCount.get(token) ?? 0) + (headerTokens.has(token) ? count : 0); k < count; k += 1) missingValues.push(token);
  }
  reconcileSplitNumbers(extras, missingValues);
  // 跨行表头（「(n=1」「332)」）在投影表头中合并为一个值
  reconcileSplitNumbers([...headerTokens].filter((token) => !sourceCount.has(token)), missingValues);
  // 分级：源表根本不存在的有效数值 / 源表有效数值缺失 = 硬失败；已有值的重复（合并单元格按子格展开）
  // 与一位整数差异（上标、表注序号、角标）= 需人工 QA
  const significant = (token: string) => /\./.test(token) || token.replace(/\D/g, "").replace(/^0+/, "").length >= 2;
  const extrasAbsent = extras.filter((token) => !sourceCount.has(token) && significant(token));
  const missingSignificant = missingValues.filter(significant);
  if (extrasAbsent.length > 0) codes.push("TABLE_EXTRA_VALUES");
  else if (extras.length > 0) codes.push("TABLE_VALUE_DUPLICATED_OR_MINOR");
  if (missingSignificant.length > 0) codes.push("TABLE_VALUES_MISSING");
  else if (missingValues.length > 0) codes.push("TABLE_MINOR_TOKEN_MISSING");
  // 解析器补出的列序号表头（「0 | 1 | 2 | …」）：真实表头被降为第一行数据
  const headerCells = table.header.map((cell) => cell.trim()).filter((cell) => cell !== "");
  if (headerCells.length >= 3 && headerCells.every((cell, k) => cell === String(k) || cell === String(k + 1))) codes.push("TABLE_HEADER_SYNTHETIC");
  const valuesDetail = (extras.length > 0 ? `；投影多出源表不存在的值 ${extras.slice(0, 8).join(" ")}` : "") + (missingValues.length > 0 ? `；源表数值缺失 ${missingValues.slice(0, 8).join(" ")}` : "") +
    (codes.includes("TABLE_HEADER_SYNTHETIC") ? "；投影表头是解析器补出的列序号，真实表头被降为数据行" : "");
  const reconstructed = reconstructGrid(words, table.header);
  if (reconstructed === null) {
    return {
      status: hasHardCode(codes) ? "MISMATCH" : "UNVERIFIED",
      codes: [...codes, "TABLE_STRUCTURE_UNVERIFIED"],
      detail: `表头无法在文本层逐列定位（${table.header.length} 列），单元格位置未能独立核验；非数字符号 源 ${sourceMarkers.length} / 投影 ${projectedMarkers.length}${valuesDetail}`,
      projectedTableIndex: index,
    };
  }
  const { grid, ambiguousRows } = reconstructed;
  const interesting = (row: readonly string[]) => row.some((cell) => tokensOf(cell).length > 0);
  const sourceRows = grid.filter(interesting);
  const projectedRows = table.rows.filter(interesting);
  if (sourceRows.length !== projectedRows.length) {
    return { status: hasHardCode(codes) ? "MISMATCH" : "UNVERIFIED", codes: [...codes, "TABLE_ROW_COUNT_MISMATCH"], detail: `含数值 / 符号的行数 源 ${sourceRows.length} / 投影 ${projectedRows.length}（换行单元格或合并行无法逐行对齐）${valuesDetail}`, projectedTableIndex: index };
  }
  const misplaced: string[] = [];
  const rowDiffs: string[] = [];
  sourceRows.forEach((sourceRow, rowIndex) => {
    const projectedRow = projectedRows[rowIndex]!;
    if (multisetKey(sourceRow.flatMap(tokensOf)) !== multisetKey(projectedRow.flatMap(tokensOf))) {
      rowDiffs.push(`第 ${rowIndex + 1} 行（源「${sourceRow.filter((cell) => cell !== "").join(" ").slice(0, 60)}」/ 投影「${projectedRow.filter((cell) => cell !== "").join(" ").slice(0, 60)}」）`);
      return;
    }
    for (let column = 0; column < Math.max(sourceRow.length, projectedRow.length); column += 1) {
      if (multisetKey(tokensOf(sourceRow[column] ?? "")) !== multisetKey(tokensOf(projectedRow[column] ?? ""))) {
        misplaced.push(`第 ${rowIndex + 1} 行第 ${column + 1} 列（源「${sourceRow[column] ?? ""}」/ 投影「${projectedRow[column] ?? ""}」）`);
      }
    }
  });
  if (misplaced.length > 0) codes.push("TABLE_CELL_POSITION_MISMATCH");
  if (rowDiffs.length > 0) codes.push("TABLE_ROW_CONTENT_MISMATCH");
  if (ambiguousRows > 0) codes.push("TABLE_MARKER_ROW_AMBIGUOUS");
  // 行数一致、列位独立复原可信时，行内容不一致 = 数值 / 符号落在错误的行（勾选错位的典型形态）；
  // 只有符号行归属本身不确定时才降级为人工 QA
  const hard = hasHardCode(codes) ||
    (codes.includes("TABLE_ROW_CONTENT_MISMATCH") && ambiguousRows === 0);
  return {
    status: hard ? "MISMATCH" : codes.length > 0 ? "UNVERIFIED" : "VERIFIED",
    codes,
    detail: codes.length === 0
      ? `逐行逐列一致（${sourceRows.length} 行 × ${table.header.length} 列，数值与符号按文本层坐标独立复原）`
      : [valuesDetail.replace(/^；/, ""), misplaced.slice(0, 4).join("；"), rowDiffs.length > 0 ? `行内容不一致：${rowDiffs.slice(0, 4).join("、")}` : "", ambiguousRows > 0 ? `${ambiguousRows} 个符号行归属不确定` : ""].filter((part) => part !== "").join("；"),
    projectedTableIndex: index,
  };
}
