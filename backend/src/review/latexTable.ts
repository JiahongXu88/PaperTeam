/**
 * M15.2 LaTeX 表格结构解析（确定性、零模型）：把 tabular 系环境解析成「行 × 列」单元格，记录行键（行标签 / multirow 行组 /
 * 分组行）、多级列表头（multicolumn 展开）、caption / label、列单位与每个单元格在原文中的偏移。
 *
 * 用途：论断核验证书（claimCertificate）判定「论断与对照单元格是否为同一观察量」——同名指标出现在不同表、不同行组、不同数据集
 * 列组时，只有结构键能把它们区分开；M15.1 的不同表格行误判就是缺这一层。
 *
 * 纪律：解析不了的结构（嵌套 tabular、无法配对的 \end、行列数严重不齐）如实标 `parseIssues`，下游据此不得出具证书；
 * 不猜测表头语义，表头文字原样保留（去排版命令）。
 */

import { parseNumbers, type ParsedNumber } from "./claimAuditText.js";
import { createHash } from "node:crypto";

export const LATEX_TABLE_PARSER_VERSION = "latex-table/v1";

export interface LatexTableCell {
  tableIndex: number;
  row: number;
  /** 展开后的起始列（multicolumn 占 colSpan 列） */
  col: number;
  colSpan: number;
  /** 原文切片（未清洗） */
  raw: string;
  /** 清洗后的纯文本（去排版命令 / 数学定界 / 脚注上标） */
  text: string;
  /** 在被解析文本中的偏移（end 不含） */
  start: number;
  end: number;
  /** 单元格主数值（数值格才有）及其在原文中的偏移 */
  value: ParsedNumber | null;
  valueStart: number | null;
  valueEnd: number | null;
  /** 数值格是否含次要数值（± 标准差、括号内增量等） */
  compound: boolean;
  /** 数据行：行键（行首连续非数值单元格，含 multirow 下延）；表头行为空 */
  rowKey: string[];
  /** 数据区分组行标签（如单独一行的 "MOT17" / "Ablation"） */
  rowGroup: string | null;
  /** 列表头路径（自上而下，multicolumn 展开） */
  headerPath: string[];
  /** 列单位（来自表头括号 / 单元格自带单位；未知 = null） */
  unit: string | null;
  isHeader: boolean;
}

export interface LatexTableRow {
  index: number;
  start: number;
  end: number;
  cells: LatexTableCell[];
  kind: "header" | "data" | "group" | "empty" | "other";
}

export interface LatexTable {
  tableIndex: number;
  /** sha256(表格原文)[0:16]：内容寻址 id（同一表格内容 → 同一 id） */
  tableId: string;
  env: string;
  start: number;
  end: number;
  caption: string | null;
  label: string | null;
  /** 浮动体（table / table*）范围；不在浮动体中 = null */
  floatStart: number | null;
  floatEnd: number | null;
  columnCount: number;
  headerRowCount: number;
  rows: LatexTableRow[];
  cells: LatexTableCell[];
  parseIssues: string[];
}

const TABULAR_ENVS = ["tabular", "tabular*", "tabularx", "tabulary", "longtable", "longtable*", "supertabular", "xtabular", "array", "NiceTabular", "tblr"];

/** 从 at（指向 "{"）读一个平衡花括号参数；返回内容与结束位置（"}" 之后） */
export function readBraced(text: string, at: number): { content: string; end: number } | null {
  if (text[at] !== "{") return null;
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(at + 1, index), end: index + 1 };
    }
  }
  return null;
}

function skipSpaces(text: string, at: number): number {
  let index = at;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

/** 跳过可选参数 [..]（可多个） */
function skipOptional(text: string, at: number): number {
  let index = skipSpaces(text, at);
  while (text[index] === "[") {
    let depth = 0;
    let closed = -1;
    for (let k = index; k < text.length; k += 1) {
      if (text[k] === "[") depth += 1;
      else if (text[k] === "]") {
        depth -= 1;
        if (depth === 0) {
          closed = k;
          break;
        }
      }
    }
    if (closed < 0) return index;
    index = skipSpaces(text, closed + 1);
  }
  return index;
}

/** 清洗单元格 / 表头 / caption 文本为纯文本 */
export function plainLatexText(raw: string): string {
  let text = raw;
  // 引用 / 交叉引用的键不是可读文字（"TicrossNet \cite{ticross}" 的行标签只取 TicrossNet）
  text = text.replace(/\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label|footnote|url)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, " ");
  text = text.replace(/\\rule(?:\[[^\]]*\])?\{[^{}]*\}\{[^{}]*\}/g, " ");
  text = text.replace(/\\[()[\]]/g, " ");
  // 脚注上标（†、*、数字角标）不属于数值
  text = text.replace(/\^\{[^{}]*\}|\^\\[A-Za-z]+|\^[^\s{\\]/g, " ");
  text = text.replace(/_\{([^{}]*)\}/g, "$1").replace(/_([A-Za-z0-9])/g, "$1");
  text = text.replace(/\\(?:cellcolor|rowcolor|columncolor)(?:\[[^\]]*\])?\{[^{}]*\}/g, " ");
  text = text.replace(/\\color(?:\[[^\]]*\])?\{[^{}]*\}/g, " ");
  text = text.replace(/\\textcolor(?:\[[^\]]*\])?\{[^{}]*\}/g, " ");
  text = text.replace(/\\(?:hspace|vspace|rule|raisebox|resizebox|scalebox)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g, " ");
  text = text.replace(/\\pm\b|±/g, " ± ").replace(/\\%/g, "%").replace(/\\&/g, "&").replace(/\\_/g, "_");
  text = text.replace(/\\(?:uparrow|downarrow|Uparrow|Downarrow)\b|[↑↓]/g, " ");
  text = text.replace(/\\(?:times)\b/g, "×").replace(/\\(?:approx|sim)\b/g, "~");
  text = text.replace(/\\\\/g, " ");
  text = text.replace(/\\[,;:! ]/g, " ").replace(/~/g, " ");
  text = text.replace(/\\[A-Za-z]+\*?/g, " ");
  text = text.replace(/[{}$]/g, " ");
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const RULE_PREFIX = /^\s*(?:\\(?:hline|toprule|midrule|bottomrule|hdashline|endhead|endfirsthead|endfoot|endlastfoot|tabucline|Xhline\{[^{}]*\}|specialrule\{[^{}]*\}\{[^{}]*\}\{[^{}]*\}|cmidrule(?:\([^)]*\))?\{[^{}]*\}|cline\{[^{}]*\}|addlinespace(?:\[[^\]]*\])?|arrayrulecolor\{[^{}]*\}|rowcolor(?:\[[^\]]*\])?\{[^{}]*\}|noalign\{[^{}]*\})(?:\[[^\]]*\])?\s*)+/;

/** 把表体切成行（\\ / \tabularnewline，花括号深度 0）；保留偏移 */
function splitRows(body: string, base: number): Array<{ text: string; start: number; end: number; ruleBefore: boolean; midrule: boolean }> {
  const rows: Array<{ text: string; start: number; end: number; ruleBefore: boolean; midrule: boolean }> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number, next: number) => {
    const piece = body.slice(start, end);
    const rule = RULE_PREFIX.exec(piece);
    const offset = rule === null ? 0 : rule[0].length;
    const trimmedStart = start + offset + (piece.slice(offset).length - piece.slice(offset).trimStart().length);
    const content = body.slice(trimmedStart, end).trimEnd();
    rows.push({ text: content, start: base + trimmedStart, end: base + trimmedStart + content.length, ruleBefore: rule !== null, midrule: rule !== null && rule[0].includes("midrule") });
    start = next;
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "%" && body[index - 1] !== "\\") {
      const newline = body.indexOf("\n", index);
      index = newline < 0 ? body.length : newline;
      continue;
    }
    if (char === "\\") {
      if (depth === 0 && body[index + 1] === "\\") {
        let next = index + 2;
        // \\[2pt] / \\*
        if (body[next] === "*") next += 1;
        const afterSpace = skipSpaces(body, next);
        if (body[afterSpace] === "[") {
          const close = body.indexOf("]", afterSpace);
          if (close > 0) next = close + 1;
        }
        push(index, next);
        index = next - 1;
        continue;
      }
      if (depth === 0 && body.startsWith("\\tabularnewline", index)) {
        push(index, index + "\\tabularnewline".length);
        index += "\\tabularnewline".length - 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  if (start < body.length) push(body.length, body.length);
  return rows.filter((row) => row.text.replace(RULE_PREFIX, "").trim() !== "" || row.ruleBefore);
}

/** 行内按未转义 & 切单元格（花括号深度 0） */
function splitCells(row: string, base: number): Array<{ text: string; start: number; end: number }> {
  const cells: Array<{ text: string; start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const piece = row.slice(start, end);
    const lead = piece.length - piece.trimStart().length;
    const content = piece.trim();
    cells.push({ text: content, start: base + start + lead, end: base + start + lead + content.length });
  };
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "&" && depth === 0) {
      push(index);
      start = index + 1;
    }
  }
  push(row.length);
  return cells;
}

interface CellSpec {
  content: string;
  contentOffset: number;
  colSpan: number;
  rowSpan: number;
}

/** \multicolumn{n}{spec}{content} / \multirow{n}[..]{w}{content}（可互相嵌套一层） */
function unwrapSpan(text: string): CellSpec {
  let content = text;
  let offset = 0;
  let colSpan = 1;
  let rowSpan = 1;
  for (let guard = 0; guard < 3; guard += 1) {
    const trimmed = content.trimStart();
    const lead = content.length - trimmed.length;
    const mc = /^\\multicolumn\s*\{\s*(\d+)\s*\}/.exec(trimmed);
    const mr = /^\\multirow(?:cell)?\s*(?:\[[^\]]*\])?\s*\{\s*(-?\d+)\s*\}/.exec(trimmed);
    if (mc !== null) {
      colSpan = Number(mc[1]);
      let at = skipSpaces(trimmed, mc[0].length);
      const spec = readBraced(trimmed, at);
      if (spec === null) break;
      at = skipSpaces(trimmed, spec.end);
      const body = readBraced(trimmed, at);
      if (body === null) break;
      offset += lead + at + 1;
      content = body.content;
      continue;
    }
    if (mr !== null) {
      // 负数行跨（向上跨行）不下延
      rowSpan = Math.max(1, Number(mr[1]));
      let at = skipOptional(trimmed, mr[0].length);
      // \multirow{n}{width}{content}；\multirowcell{n}[..]{content}
      const first = readBraced(trimmed, at);
      if (first === null) break;
      at = skipOptional(trimmed, first.end);
      const second = readBraced(trimmed, at);
      if (second === null) {
        offset += lead + (first.end - first.content.length - 1);
        content = first.content;
      } else {
        offset += lead + at + 1;
        content = second.content;
      }
      continue;
    }
    break;
  }
  return { content, contentOffset: offset, colSpan, rowSpan };
}

/** 数值单元格：清洗后主体是单个数（可带 % / ×、± 次要值、括号增量、星号 / 标记） */
function numericCell(plain: string): { value: ParsedNumber; compound: boolean } | null {
  if (plain === "" || /^[-–—/]+$/.test(plain)) return null;
  const numbers = parseNumbers(plain);
  if (numbers.length === 0) return null;
  const stripped = plain
    .replace(/±\s*\d+(?:\.\d+)?/g, "")
    .replace(/\(\s*[-+−]?\s*\d+(?:\.\d+)?\s*%?\s*\)/g, "")
    .replace(/[*†‡§¶#]/g, "")
    .trim();
  const mainMatch = /^[-+−]?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:%|×|x|k|m|s|ms|hz|fps|mb|gb)?$/i.exec(stripped);
  if (mainMatch === null) return null;
  return { value: numbers[0]!, compound: numbers.length > 1 };
}

function unitFromHeader(header: string): string | null {
  const trailing = /(?:,|\bin)\s*(mm|cm|m|km|ms|s|min|h|hz|fps|%)\s*$/i.exec(header);
  if (trailing !== null) return trailing[1]!.toLowerCase();
  const bracket = /[([]\s*([A-Za-z%μ/]+)\s*[)\]]/.exec(header);
  const candidate = (bracket?.[1] ?? (/%/.test(header) ? "%" : "")).toLowerCase();
  if (candidate === "") return /\bfps\b/i.test(header) ? "fps" : /\bhz\b/i.test(header) ? "hz" : null;
  if (candidate === "%") return "%";
  if (["mm", "cm", "m", "km", "ms", "s", "min", "h", "hz", "fps", "mb", "gb", "kb", "k", "m/s", "db"].includes(candidate)) return candidate;
  if (candidate === "sec") return "s";
  return null;
}

function findEnclosingFloat(text: string, at: number): { start: number; end: number } | null {
  const before = text.slice(0, at);
  const openRe = /\\begin\{(table\*?|wraptable|sidewaystable)\}/g;
  let open: { index: number; env: string } | null = null;
  for (const match of before.matchAll(openRe)) open = { index: match.index!, env: match[1]! };
  if (open === null) return null;
  const closeTag = `\\end{${open.env}}`;
  const closeBefore = before.lastIndexOf(closeTag);
  if (closeBefore > open.index) return null;
  const close = text.indexOf(closeTag, at);
  if (close < 0) return null;
  return { start: open.index, end: close + closeTag.length };
}

function captionOf(text: string): string | null {
  const at = text.search(/\\caption\*?(?:\[[^\]]*\])?\s*\{/);
  if (at < 0) return null;
  const brace = text.indexOf("{", at + 8);
  const read = readBraced(text, brace);
  return read === null ? null : plainLatexText(read.content);
}

/** 解析文本中的全部 tabular 系表格 */
export function parseLatexTables(text: string): LatexTable[] {
  const tables: LatexTable[] = [];
  const envPattern = new RegExp(`\\\\begin\\{(${TABULAR_ENVS.map((env) => env.replace(/\*/g, "\\*")).join("|")})\\}`, "g");
  let consumedUntil = 0;
  for (const match of text.matchAll(envPattern)) {
    const envStart = match.index!;
    if (envStart < consumedUntil) continue; // 嵌套 tabular 归属外层（外层记 parseIssues）
    const env = match[1]!;
    const endTag = `\\end{${env}}`;
    const parseIssues: string[] = [];
    // 参数：tabular*/tabularx/tabulary 有宽度参数；longtable 可选 [pos]
    let at = skipOptional(text, envStart + match[0].length);
    const argCount = env === "tabular*" || env === "tabularx" || env === "tabulary" || env === "xtabular" ? 2 : 1;
    for (let k = 0; k < argCount; k += 1) {
      at = skipSpaces(text, at);
      const arg = readBraced(text, at);
      if (arg === null) {
        parseIssues.push("COLUMN_SPEC_UNREADABLE");
        break;
      }
      at = arg.end;
    }
    const bodyStart = at;
    // 配对 \end（计数同名嵌套）
    let depth = 1;
    let cursor = bodyStart;
    let bodyEnd = -1;
    const beginTag = `\\begin{${env}}`;
    while (cursor < text.length) {
      const nextEnd = text.indexOf(endTag, cursor);
      const nextBegin = text.indexOf(beginTag, cursor);
      if (nextEnd < 0) break;
      if (nextBegin >= 0 && nextBegin < nextEnd) {
        depth += 1;
        cursor = nextBegin + beginTag.length;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        bodyEnd = nextEnd;
        break;
      }
      cursor = nextEnd + endTag.length;
    }
    if (bodyEnd < 0) continue;
    const body = text.slice(bodyStart, bodyEnd);
    if (TABULAR_ENVS.some((inner) => body.includes(`\\begin{${inner}}`))) parseIssues.push("NESTED_TABULAR");
    consumedUntil = bodyEnd + endTag.length;
    const float = findEnclosingFloat(text, envStart);
    const floatText = float === null ? "" : text.slice(float.start, float.end);
    const labelMatch = /\\label\{([^{}]+)\}/.exec(floatText);
    const tableIndex = tables.length;
    const rowsRaw = splitRows(body, bodyStart);
    // 第一遍：单元格 + 跨列 / 跨行
    interface Pending { spec: CellSpec; raw: { text: string; start: number; end: number }; col: number; plain: string; numeric: ReturnType<typeof numericCell> }
    const grid: Pending[][] = [];
    const carry = new Map<number, { plain: string; remaining: number }>();
    let columnCount = 0;
    for (const rowRaw of rowsRaw) {
      const cellsRaw = splitCells(rowRaw.text, rowRaw.start);
      const pending: Pending[] = [];
      let col = 0;
      for (const raw of cellsRaw) {
        const spec = unwrapSpan(raw.text);
        const plain = plainLatexText(spec.content);
        pending.push({ spec, raw, col, plain, numeric: numericCell(plain) });
        col += Math.max(1, spec.colSpan);
      }
      columnCount = Math.max(columnCount, col);
      // multirow 下延：本行该列为空且上方 multirow 尚未用完
      for (const cell of pending) {
        const active = carry.get(cell.col);
        if (cell.plain === "" && active !== undefined && active.remaining > 0) {
          cell.plain = active.plain;
          active.remaining -= 1;
        } else if (cell.spec.rowSpan > 1 && cell.plain !== "") {
          carry.set(cell.col, { plain: cell.plain, remaining: cell.spec.rowSpan - 1 });
        } else if (active !== undefined && cell.plain !== "") {
          carry.delete(cell.col);
        }
      }
      grid.push(pending);
    }
    // 行类型：表头 = 首个「像数据」的行之前；有 booktabs / hline 时以「其后出现数据行的第一条规则线」为界（"1%" "10%" 这类数字表头不被误判为数据）
    const hasNumber = (row: Pending[]): boolean => row.slice(1).some((cell) => cell.numeric !== null);
    const dataLike = (row: Pending[]): boolean => {
      const nonEmpty = row.filter((cell) => cell.plain !== "");
      if (nonEmpty.length < 2) return false;
      const valueCells = nonEmpty.slice(1);
      const numeric = valueCells.filter((cell) => cell.numeric !== null).length;
      return numeric >= 1 && numeric / valueCells.length >= 0.5;
    };
    const fullSpanLabel = (row: Pending[]): boolean => {
      const nonEmpty = row.filter((cell) => cell.plain !== "");
      return nonEmpty.length === 1 && nonEmpty[0]!.numeric === null && (row.length === 1 || Math.max(1, nonEmpty[0]!.spec.colSpan) >= Math.max(2, columnCount - 1));
    };
    let headerRowCount = -1;
    // 每行都有横线（hline 网格表）时规则线不分隔表头，退回数值比例判定
    const ruled = rowsRaw.slice(1).filter((raw) => raw.ruleBefore).length;
    const gridRuled = rowsRaw.length > 3 && ruled / (rowsRaw.length - 1) > 0.7;
    const fraction = (row: Pending[]): number => {
      const valueCells = row.filter((cell) => cell.plain !== "").slice(1);
      return valueCells.length === 0 ? 0 : valueCells.filter((cell) => cell.numeric !== null).length / valueCells.length;
    };
    // booktabs：首个「紧随其后的行即含数值」的 \midrule 是表头边界（多级表头之间的 \midrule 不算）
    const midrule = rowsRaw.findIndex((raw, r) => r >= 1 && raw.midrule && (hasNumber(grid[r]!) || (fullSpanLabel(grid[r]!) && grid[r + 1] !== undefined && hasNumber(grid[r + 1]!))));
    if (midrule >= 1) headerRowCount = midrule;
    for (let r = 1; r < grid.length && !gridRuled && headerRowCount < 0; r += 1) {
      if (!rowsRaw[r]!.ruleBefore) continue;
      const startsData = dataLike(grid[r]!) || (fullSpanLabel(grid[r]!) && grid[r + 1] !== undefined && dataLike(grid[r + 1]!));
      // 「Method & Rank-1 & 1\% & 10\%」这类数字表头：下一条规则线之后的数据行数值比例更高 → 边界后移
      if (startsData && fraction(grid[r]!) < 1) {
        const nextRule = rowsRaw.findIndex((raw, k) => k > r && raw.ruleBefore);
        if (nextRule > r) {
          const later = grid.slice(nextRule).filter(dataLike).map(fraction);
          if (later.length > 0 && Math.max(...later) > fraction(grid[r]!)) continue;
        }
      }
      if (startsData) {
        headerRowCount = r;
        break;
      }
    }
    if (headerRowCount < 0) {
      const firstData = grid.findIndex(dataLike);
      headerRowCount = firstData < 0 ? grid.length : firstData;
    }
    // 表头末尾的整行单格（"MS1Mv* Training"、"OSNet-based models"）是数据区分组，不是列表头
    const fullSpanSingle = fullSpanLabel;
    while (headerRowCount > 1 && fullSpanSingle(grid[headerRowCount - 1]!) && grid.slice(0, headerRowCount - 1).some((row) => row.filter((cell) => cell.plain !== "").length >= 2)) headerRowCount -= 1;
    // 列表头路径
    const headerPaths: string[][] = Array.from({ length: columnCount }, () => []);
    for (let r = 0; r < headerRowCount; r += 1) {
      for (const cell of grid[r]!) {
        // multirow 已在第一遍下延到后续行的空单元格
        if (cell.plain === "") continue;
        for (let c = cell.col; c < cell.col + Math.max(1, cell.spec.colSpan) && c < columnCount; c += 1) {
          const path = headerPaths[c]!;
          if (path[path.length - 1] !== cell.plain) path.push(cell.plain);
        }
      }
    }
    const rows: LatexTableRow[] = [];
    const cells: LatexTableCell[] = [];
    let group: string | null = null;
    grid.forEach((row, r) => {
      const rowRaw = rowsRaw[r]!;
      const nonEmpty = row.filter((cell) => cell.plain !== "");
      let kind: LatexTableRow["kind"];
      if (nonEmpty.length === 0) kind = "empty";
      else if (r < headerRowCount) kind = "header";
      else if (nonEmpty.length === 1 && nonEmpty[0]!.numeric === null) kind = "group";
      else if (hasNumber(row)) kind = "data";
      else kind = "other";
      if (kind === "group") group = nonEmpty[0]!.plain;
      const keyCells: string[] = [];
      if (kind === "data") {
        for (const cell of row) {
          if (cell.numeric !== null) break;
          if (cell.plain !== "") keyCells.push(cell.plain);
        }
      }
      const rowCells: LatexTableCell[] = row.map((cell) => {
        const header = headerPaths[cell.col] ?? [];
        const ownUnit = cell.numeric?.value.unit ?? null;
        const headerUnit = header.map(unitFromHeader).find((unit) => unit !== null) ?? null;
        let valueStart: number | null = null;
        let valueEnd: number | null = null;
        if (cell.numeric !== null) {
          const pattern = new RegExp(`(?<![0-9.])${cell.numeric.value.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
          const hit = pattern.exec(cell.raw.text);
          if (hit !== null) {
            valueStart = cell.raw.start + hit.index;
            valueEnd = valueStart + cell.numeric.value.raw.length;
          }
        }
        const record: LatexTableCell = {
          tableIndex, row: r, col: cell.col, colSpan: Math.max(1, cell.spec.colSpan),
          raw: cell.raw.text, text: cell.plain, start: cell.raw.start, end: cell.raw.end,
          value: cell.numeric?.value ?? null, valueStart, valueEnd, compound: cell.numeric?.compound ?? false,
          rowKey: kind === "data" ? keyCells : [],
          rowGroup: kind === "data" ? group : null,
          headerPath: header,
          unit: ownUnit ?? headerUnit,
          isHeader: kind === "header",
        };
        return record;
      });
      cells.push(...rowCells);
      rows.push({ index: r, start: rowRaw.start, end: rowRaw.end, cells: rowCells, kind });
    });
    const dataRows = rows.filter((row) => row.kind === "data");
    if (dataRows.length > 0) {
      const widths = dataRows.map((row) => row.cells.reduce((sum, cell) => sum + cell.colSpan, 0));
      if (Math.max(...widths) - Math.min(...widths) > 1) parseIssues.push("RAGGED_ROWS");
    }
    if (headerRowCount === 0) parseIssues.push("NO_HEADER_ROW");
    tables.push({
      tableIndex,
      tableId: createHash("sha256").update(text.slice(envStart, consumedUntil), "utf8").digest("hex").slice(0, 16),
      env,
      start: envStart,
      end: consumedUntil,
      caption: captionOf(floatText),
      label: labelMatch?.[1] ?? null,
      floatStart: float?.start ?? null,
      floatEnd: float?.end ?? null,
      columnCount,
      headerRowCount,
      rows,
      cells,
      parseIssues,
    });
  }
  return tables;
}

/** 落在 [start, end) 内的数值单元格（按出现顺序） */
export function numericCellsInSpan(tables: readonly LatexTable[], start: number, end: number): LatexTableCell[] {
  const out: LatexTableCell[] = [];
  for (const table of tables) {
    if (table.end <= start || table.start >= end) continue;
    for (const cell of table.cells) {
      if (cell.value === null || cell.valueStart === null || cell.isHeader) continue;
      if (cell.valueStart >= start && (cell.valueEnd ?? cell.valueStart) <= end) out.push(cell);
    }
  }
  return out;
}

export function tableOfCell(tables: readonly LatexTable[], cell: LatexTableCell): LatexTable | undefined {
  return tables[cell.tableIndex];
}
