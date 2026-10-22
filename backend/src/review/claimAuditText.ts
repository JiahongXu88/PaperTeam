/**
 * M15.1 Claim Audit 的确定性文本工具（零模型）：逐字定位、数值解析与可比性判定、区分性术语。
 *
 * 纪律：
 * - 定位只做空白折叠 + NFKC（与 M15 quote 可定位率口径一致），不做模糊匹配——找不到就是找不到；
 * - 数值比较只回答「两个写出来的数是否相等 / 是否可能只差一个量纲换算」，不推断派生量（倍数、相对提升）；
 *   量纲不可判定时给 SCALE_AMBIGUOUS，调用方据此不得给出已核实矛盾。
 */

import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 定位口径：NFKC + 去全部空白（compact）。返回 compact 串与 compact 下标 → 原文下标的映射 */
function compactWithMap(text: string): { compact: string; map: number[] } {
  const map: number[] = [];
  let compact = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) continue;
    const normalized = char.normalize("NFKC");
    for (const piece of normalized) {
      if (/\s/.test(piece)) continue;
      compact += piece;
      map.push(index);
    }
  }
  return { compact, map };
}

export function compactText(text: string): string {
  return compactWithMap(text).compact;
}

export interface LocatedSpan {
  /** 原文（haystack）中的起止下标（end 不含） */
  start: number;
  end: number;
  /** 同一 compact 片段在 haystack 中的出现次数（>1 = 引文不唯一） */
  occurrences: number;
  /** 本次命中是第几次出现（0 基） */
  occurrenceIndex: number;
}

/** 逐字定位（空白折叠 + NFKC）。needle 归一后过短（< minChars）或不存在 → null */
export function locateQuote(haystack: string, needle: string, minChars = 8): LocatedSpan | null {
  const target = compactText(needle);
  if (target.length < minChars) return null;
  const { compact, map } = compactWithMap(haystack);
  const first = compact.indexOf(target);
  if (first < 0) return null;
  let occurrences = 0;
  for (let at = first; at >= 0; at = compact.indexOf(target, at + 1)) occurrences += 1;
  const start = map[first]!;
  const end = map[first + target.length - 1]! + 1;
  return { start, end, occurrences, occurrenceIndex: 0 };
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

// ---- 数值 ----

export interface ParsedNumber {
  raw: string;
  value: number;
  /** 小数位数（显示精度；整数 = 0） */
  decimals: number;
  /** 紧随的单位（归一后；无 = null） */
  unit: string | null;
}

/** 长单位在前（mm 先于 m、ms 先于 s）；拉丁单位要求词边界（「s」不吞「speed」） */
const UNIT_PATTERN = /^(?:\\?%|％|percent\b|pp\b|mm\b|cm\b|km\b|ms\b|min\b|mhz\b|khz\b|ghz\b|hz\b|fps\b|db\b|mb\b|gb\b|kb\b|sec\b|s\b|h\b|m\b|k\b|x\b|×|倍|毫米|厘米|毫秒|米|秒)/i;

function normalizeUnit(raw: string): string | null {
  const lower = raw.toLowerCase().replace(/^\\/, "");
  if (lower === "%" || lower === "％" || lower === "percent") return "%";
  if (lower === "毫米") return "mm";
  if (lower === "厘米") return "cm";
  if (lower === "米") return "m";
  if (lower === "秒") return "s";
  if (lower === "毫秒") return "ms";
  if (lower === "sec") return "s";
  if (lower === "×" || lower === "倍") return "x";
  return lower === "" ? null : lower;
}

/** LaTeX 数值写法归一：\% → %、\, ~ 细空格、{,} 千分位、$ 数学定界 */
function stripLatexForNumbers(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\{,\}/g, "")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/~/g, " ")
    .replace(/\$/g, " ")
    .replace(/\\textbf\{|\\textit\{|\\emph\{|\\mathbf\{|\\mathrm\{|\\text\{/g, " ");
}

/** 解析文本中的全部数值（含千分位、小数、紧随单位） */
export function parseNumbers(text: string): ParsedNumber[] {
  const cleaned = stripLatexForNumbers(text);
  const out: ParsedNumber[] = [];
  for (const match of cleaned.matchAll(/(?<![\w.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)/g)) {
    const raw = match[1]!;
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = raw.includes(".") ? raw.split(".")[1]!.length : 0;
    const after = cleaned.slice(match.index! + match[0].length).replace(/^\s+/, "");
    const unitMatch = UNIT_PATTERN.exec(after);
    out.push({ raw, value, decimals, unit: unitMatch === null ? null : normalizeUnit(unitMatch[0]) });
  }
  return out;
}

/** value 字符串（模型给出的 claimValue / counterpartValue）→ 第一个数值 */
export function parseValue(text: string | undefined): ParsedNumber | null {
  if (text === undefined) return null;
  return parseNumbers(text)[0] ?? null;
}

/** 数值是否作为一个完整数出现在文本中（同值同精度；「61.7」不匹配「161.7」也不匹配「61.75」） */
export function textContainsNumber(text: string, number: ParsedNumber): boolean {
  return parseNumbers(text).some((candidate) => candidate.value === number.value && candidate.decimals === number.decimals);
}

const UNIT_SCALE: Record<string, { dimension: string; factor: number }> = {
  mm: { dimension: "length", factor: 0.001 },
  cm: { dimension: "length", factor: 0.01 },
  m: { dimension: "length", factor: 1 },
  km: { dimension: "length", factor: 1000 },
  ms: { dimension: "time", factor: 0.001 },
  s: { dimension: "time", factor: 1 },
  min: { dimension: "time", factor: 60 },
  h: { dimension: "time", factor: 3600 },
};

export type ValueComparison = "EQUAL" | "DIFFERENT" | "SCALE_AMBIGUOUS";

/**
 * 两个写出来的数是否一致（按显示精度的半个末位单位容差）。
 * - 单位都写明且同量纲：换算后比较（14 cm ≡ 140 mm）；
 * - 有一侧没写单位（表格单元格常见）而两数只差 10^k（k∈[-3,3]，含 % ↔ 小数）：SCALE_AMBIGUOUS——不能凭写出的数断言矛盾；
 * - 其余：EQUAL / DIFFERENT。
 */
export function compareValues(rawA: ParsedNumber, rawB: ParsedNumber): ValueComparison {
  // 「54K」= 54000（千位后缀；不处理 M——与米冲突）
  const thousands = (n: ParsedNumber): ParsedNumber => (n.unit === "k" ? { ...n, value: n.value * 1000, decimals: n.decimals - 3, unit: null } : n);
  const a = thousands(rawA);
  const b = thousands(rawB);
  const tolerance = (n: ParsedNumber) => 0.5 * 10 ** -n.decimals;
  const close = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol + 1e-12;
  const unitA = a.unit !== null ? UNIT_SCALE[a.unit] : undefined;
  const unitB = b.unit !== null ? UNIT_SCALE[b.unit] : undefined;
  if (unitA !== undefined && unitB !== undefined && unitA.dimension === unitB.dimension) {
    const x = a.value * unitA.factor;
    const y = b.value * unitB.factor;
    const tol = Math.max(tolerance(a) * unitA.factor, tolerance(b) * unitB.factor);
    return close(x, y, tol) ? "EQUAL" : "DIFFERENT";
  }
  const tol = Math.max(tolerance(a), tolerance(b));
  if (close(a.value, b.value, tol)) return "EQUAL";
  const bothUnitsExplicitSame = a.unit !== null && b.unit !== null && a.unit === b.unit;
  if (!bothUnitsExplicitSame) {
    for (let k = -3; k <= 3; k += 1) {
      if (k === 0) continue;
      const scale = 10 ** k;
      if (close(a.value * scale, b.value, Math.max(tolerance(a) * scale, tolerance(b)))) return "SCALE_AMBIGUOUS";
    }
  }
  return "DIFFERENT";
}

// ---- 数值描述词（两个值是否在说同一种量） ----

const DESCRIPTOR_STOP = new Set(["of", "the", "a", "an", "on", "in", "at", "and", "or", "for", "to", "about", "approximately", "approx", "around", "nearly", "almost", "is", "are", "was", "with", "by", "vs", "约", "大约", "为", "的", "和", "及"]);

/**
 * 模型写的 claimValue / counterpartValue 去掉数字后的描述词集合（「HOTA 61.7; 2241.8 Hz」→ {hota, hz}；「61.7%」→ {%}）。
 * 两侧描述词互不包含（「7-fold」vs「4 videos」、「Fixed IDF1」vs「Default IDF1」）= 不是同一种量，数值比较不能作为依据；
 * 任一侧是裸数（表格单元格常见）视为可比。
 */
export function valueDescriptors(text: string): Set<string> {
  const cleaned = text.normalize("NFKC").toLowerCase().replace(/\\%/g, "%").replace(/\\[a-z]+/g, " ").replace(/\d+(?:[.,]\d+)*/g, " ");
  const out = new Set<string>();
  for (const match of cleaned.matchAll(/%|[a-z][a-z0-9-]*|[一-龥]+/g)) {
    const token = match[0].replace(/^-+|-+$/g, "");
    if (token === "" || DESCRIPTOR_STOP.has(token)) continue;
    out.add(token);
  }
  return out;
}

export function descriptorsComparable(a: string, b: string): boolean {
  const left = valueDescriptors(a);
  const right = valueDescriptors(b);
  if (left.size === 0 || right.size === 0) return true;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  return [...small].every((token) => large.has(token));
}

/** LaTeX 表格行的行标签（第一个未转义 & 之前的单元格，去命令与空白）；不是表格行 = null */
export function tableRowLabel(text: string): string | null {
  const at = text.search(/(?<!\\)&/);
  if (at < 0) return null;
  const label = text.slice(0, at).replace(/\\[A-Za-z]+\*?/g, " ").replace(/[{}$\\]/g, " ").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return label === "" ? null : label;
}

/**
 * 「同一个量在两处的写法」前提：两处都是表格行且行标签不同（「Default」行 vs「Fixed Hyperparameter」行）时，
 * 写出的数值本来就不该相等——数值不同不能证明任何矛盾（M15.1 真实 run 误报回归）。
 */
export function sameQuantityPremise(quote: string, counterpart: string): boolean {
  const left = tableRowLabel(quote);
  const right = tableRowLabel(counterpart);
  return left === null || right === null || left === right;
}

/**
 * 派生量：模型写的值本身是运算（「38800+5300+18700」「80% × 54K」「sum of …」）——确定性比较只认写出的单个数，
 * 不替模型做算术，也不把「两数不等」当作派生关系不成立的证据（M15.1 真实 run 误报回归）。
 */
export function isDerivedValue(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return /\d\s*(?:%|[kK])?\s*[+×*÷]\s*[\d(]|\(\s*\+|\b(?:sum|total|average|mean|ratio|difference|times)\b|总和|合计|平均|之和|之差|倍/i.test(normalized);
}

// ---- 区分性术语（缺失型断言的全文查找） ----

const COMMON_TERMS = new Set([
  "SOTA", "CNN", "CNNS", "DNN", "RNN", "LSTM", "GPU", "CPU", "API", "URL", "PDF", "IEEE", "ACM", "AI", "ML", "DL", "RGB", "FPS",
  "IOU", "NMS", "MLP", "SGD", "ADAM", "VS", "ET", "AL", "OK", "PS", "LATEX", "TEX", "DOI", "ID", "IDS",
]);

/**
 * 描述 / 引文中的区分性术语：含数字、连字符 / 下划线、内部大小写混排或 ≥2 个大写字母的拉丁标识符
 * （IJB-S、TinyFace、MSMT17、CFP-FP、TH、TL），去掉通用缩写。
 */
export function distinctiveTerms(text: string): string[] {
  const cleaned = text.normalize("NFKC").replace(/\\[A-Za-z]+\*?(?:\{[^{}]*\})?/g, " ");
  const out = new Set<string>();
  for (const match of cleaned.matchAll(/(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)(?![A-Za-z0-9_])/g)) {
    const term = match[1]!;
    if (term.length < 2 || term.length > 40) continue;
    const upper = (term.match(/[A-Z]/g) ?? []).length;
    // 连字符 / 下划线只在同时含大写或数字时算区分性（IJB-S、CFP-FP；不收 state-of-the-art、re-identification）
    const distinctive = /\d/.test(term) || (/[-_]/.test(term) && upper >= 1) || /[a-z][A-Z]/.test(term) || upper >= 2;
    if (!distinctive) continue;
    if (COMMON_TERMS.has(term.toUpperCase())) continue;
    out.add(term);
  }
  return [...out];
}

/** 术语是否作为独立标识符出现在文本中 */
export function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text.normalize("NFKC"));
}

/** 包含给定下标的句子（中英文句末标点 / 空行为界；用于摘录） */
export function sentenceAt(text: string, offset: number, maxChars = 320): string {
  const before = text.slice(0, offset);
  const startMatch = /[。！？.!?\n]\s*[^。！？.!?\n]*$/.exec(before);
  const start = startMatch === null ? 0 : startMatch.index + 1;
  const after = text.slice(offset);
  const endMatch = /[。！？\n]|[.!?](?=\s)/.exec(after);
  const end = endMatch === null ? text.length : offset + endMatch.index + 1;
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, maxChars);
}
