/**
 * M15.2 论断核验证书（claim-certificate/v1）：VERIFIED_SUPPORTED / VERIFIED_CONTRADICTED 的唯一来源。
 *
 * M15.1 的「原文内跨处核对」只比较模型写出的两个数，对应关系完全由模型决定——冻结 DEV 批次 11 条强判中 5 条错（不同表格行、
 * 派生求和、比例量）。本模块把「两个数是不是同一个观察量」改为确定性判定，并且 fail-closed：
 *
 *  1. 原子值：论断 / 对照两侧的数值必须在各自原文切片中逐字出现（值 + 显示精度），表格单元格带 表 / 行 / 列 / 行键 / 多级表头 /
 *     行组 / caption / 单位（latexTable 解析）；
 *  2. 唯一绑定：原文数值（论断句）按「列维（指标词在数值附近）+ 行维（方法名 / 本文方法别名）+ 语境维（数据集 / 划分 / caption）」
 *     在全文所有表格中检索候选单元格——候选必须唯一，且必须就是模型提出的对照单元格；同名指标跨表 / 跨行组 / 跨数据集列组、
 *     「Ours」与「Ours w/o X」并存、论断带有表格语境解释不了的限定词（validation / w/o / post-processing / 其他数据集名）→ 不出证书；
 *  3. 数值关系：显示精度区间 + 显式同量纲单位换算；单位缺失且两数恰差 10^k → 量纲歧义；约数 / 不等式限定 → 不出证书
 *     （约数唯一例外：两数相差 ≥2 倍才可证矛盾，规则 APPROX_FACTOR_2）；
 *  4. 派生量（提升 / 百分点 / 相对百分比 / 倍数 / 平均）：由论断措辞确定运算，操作数必须是论断中点名的行在同一绑定列上的单元格，
 *     用受控 AST + 区间算术复算（derivedFormula）；运算解释不唯一（「提升 3.2%」可能是相对也可能是百分点、「N 倍快」可能是比值或比值−1、
 *     聚合的加权方式未知）、参照对象是「最佳基线 / SOTA」这类非点名对象 → 只记录复算结果，不出证书；
 *  5. 模型的核对结论（CONSISTENT / INCONSISTENT）与证书一致才升级（双钥匙）；任何一步失败都写 reason code，状态由调用方降为
 *     REVIEWER_* / NOT_EVALUATED。
 *
 * 证书只证明「两处写出的数在给定材料内一致 / 矛盾」，不证明实验真实、结果可复现或论文无其他错误；对应关系若由模型提出，
 * provenance.correspondenceProposedBy = "model"（证书是对该提议的确定性检验，不是机器独立发现）。
 */

import { createHash } from "node:crypto";
import { distinctiveTerms, parseNumbers, type ParsedNumber } from "./claimAuditText.js";
import { parseLatexTables, plainLatexText, type LatexTable, type LatexTableCell } from "./latexTable.js";
import { displayInterval, evaluateFormula, intervalsOverlap, renderFormula, unitFactor, validateFormula, type FormulaAtom, type FormulaNode, type Interval } from "./derivedFormula.js";

export const CLAIM_CERTIFICATE_VERSION = "claim-certificate/v1";

export interface CertificateDocument {
  files: Array<{ file: string; content: string; tables: LatexTable[] }>;
  /** 本文方法名（题目中的区分性术语，小写） */
  ownTerms: string[];
}

export function buildCertificateDocument(files: ReadonlyArray<{ file: string; content: string }>, title?: string | null): CertificateDocument {
  const titleText = title ?? files.map((file) => /\\title\s*(?:\[[^\]]*\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/.exec(file.content)?.[1]).find((value) => value !== undefined) ?? "";
  const ownTerms = distinctiveTerms(plainLatexText(titleText)).map((term) => term.toLowerCase()).filter((term) => term.length >= 3);
  return { files: files.map((file) => ({ file: file.file, content: file.content, tables: parseLatexTables(file.content) })), ownTerms };
}

// ---- 词元 ----

const STOP = new Set([
  "the", "a", "an", "of", "on", "in", "for", "and", "or", "to", "by", "at", "from", "as", "is", "are", "was", "were", "be", "with", "its", "their", "this", "that", "these", "those",
  "method", "methods", "model", "models", "approach", "approaches", "results", "result", "table", "tab", "score", "scores", "performance", "metric", "metrics", "value", "values",
  "achieves", "achieve", "achieved", "obtains", "obtain", "obtained", "reaches", "reach", "reached", "reports", "reported", "shows", "show", "yields", "yield", "gets", "attains",
  "which", "while", "whereas", "also", "both", "all", "each", "respectively", "using", "used", "use", "our", "ours", "we", "proposed", "work", "paper", "new",
  "et", "al", "fig", "figure", "sec", "section", "see", "eq", "i", "e", "g", "vs", "via",
]);
const SYNONYMS: Record<string, string> = {
  avg: "average", mean: "average", acc: "accuracy",
  // 指标缩写 OA（overall accuracy）↔ 全称 accuracy：M15.3.2 逐词裁决 GO_ONE_ALIAS 的唯一条目（maf1/mif1 NO_GO，不入）
  oa: "accuracy",
  sec: "s", secs: "s", seconds: "s", second: "s", milliseconds: "ms", fps: "fps",
  // 速度措辞 ↔ 速度列（「N times faster」绑定 Speed / FPS 列）
  faster: "speed", slower: "speed", quicker: "speed", fastest: "speed",
  // 派生列表头（Improv. / Impr.）↔ 文中 improvement(s)
  improv: "improvement", impr: "improvement",
};
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, twice: 2, double: 2, triple: 3,
};
const OWN_ALIASES = /\b(?:ours|our|we|proposed|this work|this paper|the present work)\b|本文|我们|所提|提出的方法/i;
const OWN_ROW = /\b(?:ours|proposed|this work|our method|our approach|our model)\b|本文|我们|所提/i;

function canonical(token: string): string {
  const mapped = SYNONYMS[token];
  if (mapped !== undefined) return mapped;
  // 复数归一（copies / copy、errors / error）：只处理 ≥4 字母的纯拉丁词，不动 -ss / -us / -is 结尾与缩写
  if (/^[a-z]{4,}$/.test(token)) {
    if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  }
  return token;
}

export function contextTokens(text: string): string[] {
  const plain = plainLatexText(text).toLowerCase();
  const out: string[] = [];
  for (const match of plain.matchAll(/[a-z0-9]+(?:[-_.@/][a-z0-9]+)*|[一-鿿]+/g)) {
    const token = match[0].replace(/[.]+$/, "");
    if (token === "" || /^\d+(?:\.\d+)?$/.test(token)) continue;
    out.push(canonical(token));
    if (/[-_/]/.test(token)) for (const part of token.split(/[-_/]/)) if (part.length >= 2 && !/^\d+$/.test(part)) out.push(canonical(part));
  }
  return out;
}

function significant(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !STOP.has(token) && token.length >= 2);
}

function hasCjk(token: string): boolean {
  return /[一-鿿]/.test(token);
}

/** term 是否出现在 context 中（拉丁：词元相等；中文：子串包含） */
function mentions(context: { tokens: Set<string>; plain: string }, term: string): boolean {
  if (hasCjk(term)) return term.length >= 2 && context.plain.includes(term);
  return context.tokens.has(term);
}

interface Context {
  tokens: Set<string>;
  plain: string;
}

function contextOf(text: string): Context {
  return { tokens: new Set(contextTokens(text)), plain: plainLatexText(text).toLowerCase() };
}

// ---- 原文中数值的语境（句 / 分句 / 窗口） ----

export interface TextScopes {
  sentence: string;
  segment: string;
  /** 数值前后各 ~8 个词的窗口（指标词须在此出现） */
  window: string;
  /** 数值前紧邻的文字（限定词判断） */
  before: string;
  /** 数值后紧邻的文字（单位 / 派生词判断） */
  after: string;
  /** 窗口的左右两半（指标词就近归属用） */
  beforeWide: string;
  afterWide: string;
  /** 整句中数值之前的 ≤16 个词（并列结构的派生语义继承） */
  sentenceBefore: string;
  /** 去掉数值之后的参照短语（than / over / compared to …）的句子：行维绑定只看论断主语 */
  subjectSentence: string;
  /** 句子在文件中的起始偏移 */
  sentenceStart: number;
}

interface PositionedToken {
  token: string;
  number: boolean;
}

/** 按出现顺序的词元（数字保留并标记，用于「指标词与数值之间不得隔着另一个数」） */
function orderedTokens(text: string): PositionedToken[] {
  const plain = plainLatexText(text).toLowerCase();
  const out: PositionedToken[] = [];
  for (const match of plain.matchAll(/[a-z0-9]+(?:[-_.@/][a-z0-9]+)*|[一-鿿]+/g)) {
    const token = match[0].replace(/[.]+$/, "");
    if (token === "") continue;
    if (/^\d+(?:[.,]\d+)?$/.test(token)) {
      out.push({ token, number: true });
      continue;
    }
    out.push({ token: canonical(token), number: false });
    if (/[-_/]/.test(token)) for (const part of token.split(/[-_/]/)) if (part.length >= 2 && !/^\d+$/.test(part)) out.push({ token: canonical(part), number: false });
  }
  return out;
}

/** 数值左侧（同一并列列表之前、遇到另一个数值之前）扫描到的词元：用于检测「IoU and F1 of 80.1 and 85.2」这种多指标并列 */
function leftScanTokens(scopes: TextScopes): Set<string> {
  const out = new Set<string>();
  let listOnly = true;
  for (const entry of orderedTokens(scopes.beforeWide).reverse()) {
    if (entry.number) {
      if (listOnly) continue;
      break;
    }
    if (listOnly && (entry.token === "and" || entry.token === "or")) continue;
    listOnly = false;
    out.add(entry.token);
  }
  return out;
}

/**
 * 表头词到数值的「就近距离」：左侧从近到远、右侧从近到远，遇到另一个数值即停（那个词归属于另一个数）。
 * 返回最小距离；不出现 = Infinity。中文表头词按子串在左右文本中查找（不计距离，记 3）。
 */
function metricDistance(scopes: TextScopes, headerTokens: readonly string[]): number {
  const left = orderedTokens(scopes.beforeWide).reverse();
  const right = orderedTokens(scopes.afterWide);
  let best = Infinity;
  const scan = (tokens: PositionedToken[]) => {
    // 紧邻的并列数值（「IoU score of 80.68%, 81.92%, 82.48%」）属于同一列表，跳过；一旦遇到普通词，再遇到数值即停
    let listOnly = true;
    for (let index = 0; index < tokens.length; index += 1) {
      const entry = tokens[index]!;
      if (entry.number) {
        if (listOnly) continue;
        break;
      }
      if (listOnly && (entry.token === "and" || entry.token === "or")) continue;
      listOnly = false;
      if (headerTokens.includes(entry.token)) best = Math.min(best, index + 1);
    }
  };
  scan(left);
  scan(right);
  if (best === Infinity) {
    const plainBefore = plainLatexText(scopes.beforeWide).toLowerCase();
    const plainAfter = plainLatexText(scopes.afterWide).toLowerCase();
    if (headerTokens.some((token) => hasCjk(token) && token.length >= 2 && (plainBefore.endsWith(token) || plainBefore.includes(token) || plainAfter.includes(token)))) best = 3;
  }
  return best;
}

/**
 * A1（M15.3.4 预注册方案A）：层级列维距离——对 headerPath 每层取 metricDistance，
 * 加 2×(该层距叶层深度) 的惩罚后取最小值：叶层无惩罚，上层仅在更近时胜出。
 * 多级表头（数据集 / 指标 / 子指标）的上层词可与数值就近匹配，解决「指标词写在非叶层」的列归属失败。
 */
function hierarchicalMetricDistance(scopes: TextScopes, headerPath: readonly string[]): number {
  let best = Infinity;
  for (let level = 0; level < headerPath.length; level += 1) {
    const distance = metricDistance(scopes, significant(contextTokens(headerPath[level]!)));
    if (distance === Infinity) continue;
    best = Math.min(best, distance + 2 * (headerPath.length - 1 - level));
  }
  return best;
}

export function textScopes(content: string, start: number, end: number): TextScopes {
  const isBoundary = (index: number): boolean => {
    const char = content[index]!;
    if (char === "\n" && content[index + 1] === "\n") return true;
    if ("。！？；".includes(char)) return true;
    if (".!?".includes(char)) {
      const next = content[index + 1];
      const prev = content[index - 1];
      if (next !== undefined && /\d/.test(next) && prev !== undefined && /\d/.test(prev)) return false;
      return next === undefined || /\s/.test(next);
    }
    return false;
  };
  let left = start;
  while (left > 0 && !isBoundary(left - 1) && start - left < 1500) left -= 1;
  let right = end;
  while (right < content.length && !isBoundary(right) && right - end < 1500) right += 1;
  // 跨越结构边界（\section / 表格环境 / \item）不算同一句
  const sentenceRaw = content.slice(left, right + 1);
  const structural = /\\(?:section|subsection|subsubsection|paragraph|item|begin|end|caption)\b/g;
  let sStart = left;
  let sEnd = right + 1;
  for (const match of sentenceRaw.matchAll(structural)) {
    const at = left + match.index!;
    if (at < start) sStart = at + match[0].length;
    else if (at >= end && at < sEnd) sEnd = at;
  }
  const sentence = content.slice(sStart, sEnd);
  const rel = start - sStart;
  const relEnd = end - sStart;
  // 分句：分号 / 中文逗号 / 「and」后接含数字的并列结果分句
  const splitters: number[] = [];
  for (const match of sentence.matchAll(/[;；，]|,?\s+and\s+(?=[^,;.]*\d)|,\s+(?:while|whereas|but)\s+/g)) {
    // 数值列表的延续（「82.48\% and 83.7\%」「8.51\%, 22.51\%」）不是分句边界
    const prev = sentence.slice(Math.max(0, match.index! - 12), match.index!);
    const next = sentence.slice(match.index! + match[0].length, match.index! + match[0].length + 8);
    if (/\d\s*(?:\\?%|\$)?\s*\$?\s*$/.test(prev) && /^\s*\$?\s*[-+]?\.?\d/.test(next)) continue;
    splitters.push(match.index!, match.index! + match[0].length);
  }
  let segStart = 0;
  let segEnd = sentence.length;
  for (let k = 0; k < splitters.length; k += 2) {
    const a = splitters[k]!;
    const b = splitters[k + 1]!;
    if (b <= rel) segStart = Math.max(segStart, b);
    else if (a >= relEnd) segEnd = Math.min(segEnd, a);
  }
  const segment = sentence.slice(segStart, segEnd);
  const beforeText = sentence.slice(segStart, rel);
  const afterText = sentence.slice(relEnd, segEnd);
  const beforeWords = beforeText.split(/\s+/).filter(Boolean);
  const afterWords = afterText.split(/\s+/).filter(Boolean);
  const window = [...beforeWords.slice(-8), sentence.slice(rel, relEnd), ...afterWords.slice(0, 8)].join(" ");
  // 整句范围内数值之前的 16 个词（并列结构「improvements of 6.22% in mAP and 5.31% in mAR」中第二个数继承派生语义）
  const sentenceBefore = sentence.slice(0, rel).split(/\s+/).filter(Boolean).slice(-16).join(" ");
  // 参照短语之前的句子部分（行维绑定只认论断主语，不认比较对象：「… over RODNet-CDC」中的 RODNet 不是数值的归属行）
  const referenceAt = sentence.search(/\b(?:than|over|compared (?:to|with)|versus|vs\.?|relative to|against)\b|相比|相较于?/i);
  const subjectSentence = referenceAt > relEnd ? sentence.slice(0, referenceAt) : sentence;
  return {
    sentence, segment, window, before: beforeWords.slice(-5).join(" "), after: afterWords.slice(0, 6).join(" "),
    beforeWide: beforeWords.slice(-8).join(" "), afterWide: afterWords.slice(0, 8).join(" "),
    sentenceBefore, subjectSentence, sentenceStart: sStart,
  };
}

// ---- 限定词 / 派生词 ----

const APPROX_BEFORE = /(?:\b(?:about|approximately|approx\.?|around|nearly|almost|roughly|circa|close to|some)\s*$|[~≈∼]\s*$|\\sim\s*\$?\s*$|\\approx\s*\$?\s*$|(?:约|大约|近|接近|将近)\s*$)/i;
const APPROX_AFTER = /^\s*(?:\\?%\s*)?(?:or so\b|左右|上下)/i;
const INEQ_BEFORE = /(?:\b(?:over|more than|above|exceeding|exceeds?|greater than|higher than|at least|up to|less than|below|under|at most|fewer than|lower than|no more than|no less than|beyond|surpass(?:es|ing)?)\s*$|[<>≤≥]\s*$|\\(?:leq|geq|le|ge|lt|gt)\s*\$?\s*$|(?:超过|高于|低于|不低于|不超过|大于|小于|多于|少于|以上|以下)\s*$)/i;
const INEQ_AFTER = /^\s*(?:\\?%\s*)?(?:or (?:more|less|higher|lower|above|below)|以上|以下|以内)/i;
/** 派生措辞（数值前）：「by 2.1」「improvement of 3.2」「relative improvements of」「outperforms X by」「+2.1」「提升了 2.1」；「improves to 61.7」不是派生 */
const DERIVED_BEFORE = /(?:\bby\s*$|\b(?:improvements?|gains?|increases?|decreases?|reductions?|boosts?|drops?|declines?|margins?|advantages?|lead|speed-?ups?|enhancements?)\s+(?:of\s*)?(?:about\s+|approximately\s+|nearly\s+|roughly\s+|around\s+|almost\s+|up to\s+|over\s+)?$|\b(?:relative|relatively)\b[^.;]{0,40}$|[+−]\s*$|(?:^|\s)-\s*$|(?:提升|提高|降低|增加|减少|下降|超出|领先|改善)了?(?:约|近)?\s*$)/i;
const DERIVED_AFTER = /^\s*(?:\\?%|percent)?\s*(?:percentage[- ]points?|pp\b|p\.p\.|points?\b|个百分点|百分点|[×x]\b|×|times\b|-?fold\b|倍|(?:\\?%|percent)?\s*(?:higher|lower|better|worse|faster|slower|more|less|fewer|larger|smaller|improvement|gain|increase|decrease|reduction|relative|speed-?up|boost)\b|(?:的)?(?:提升|提高|降低|增加|减少|下降))/i;
const AGGREGATE = /\b(?:on average|average(?:d)? (?:improvement|gain|increase|decrease|reduction)|mean (?:improvement|gain)|across (?:all|the|\w+) (?:datasets|benchmarks|models|tasks|settings)|overall (?:improvement|gain))\b|平均(?:提升|提高|增益|降低)/i;
/** 需要表格语境才能解释的限定词（论断写了、绑定单元格语境里没有 → 不是同一观察量） */
const QUALIFIER_LEXICON = [
  "validation", "val", "dev", "train", "training", "test-dev", "held-out", "zero-shot", "few-shot", "one-shot", "fine-tuned", "finetuned", "pretrained", "pre-trained",
  "post-processing", "postprocessing", "offline", "ensemble", "oracle", "upper", "tta", "test-time", "w/o", "without", "ablation", "ablated", "variant", "single-scale", "multi-scale",
  "small", "large", "base", "tiny", "lite", "ablations", "cross-domain", "occluded", "subset", "split",
  "验证集", "训练集", "消融", "后处理", "零样本",
];
/**
 * M15.2.1（N09）：复现 / 公平对比 / 原文限定词家族——论断写的是「复现得到的 / 公平对比下的 / 原文报告的」数值时，
 * 最佳候选的表格语境（caption / label / 行组 / 表头上层）里整个家族都不出现 → 不是同一观察量，拒绝出证。
 * 家族内互通：「Reproduction results」的 caption 能解释「reproduced」限定词（同词族视为同一限定）。
 */
const QUALIFIER_FAMILIES: string[][] = [
  ["reproduce", "reproduces", "reproduced", "reproducing", "reproduction", "reproductions", "replicate", "replicates", "replicated", "replication", "复现"],
  ["fair"],
  ["original"],
];
const ROW_QUALIFIERS = /\bw\/o\b|\bwithout\b|\bonly\b|\bno\s+\w+|\bbase(?:line)?\b|\bsmall\b|\blarge\b|\btiny\b|\blite\b|\bfull\b|[-–]\s*[SMLB]\b|\+|\bvariant\b|\bablat|去掉|仅/i;

export type AtomQualifier = "APPROX" | "INEQUALITY" | "DERIVED" | "AGGREGATE" | "SIGNED";

export function atomQualifiers(scopes: TextScopes, rawValue: string): AtomQualifier[] {
  const out: AtomQualifier[] = [];
  const before = scopes.before.replace(/\$/g, " ").replace(/\s+/g, " ");
  const after = scopes.after.replace(/\$/g, " ").replace(/\s+/g, " ");
  if (APPROX_BEFORE.test(before) || APPROX_AFTER.test(after)) out.push("APPROX");
  if (INEQ_BEFORE.test(before) || INEQ_AFTER.test(after)) out.push("INEQUALITY");
  if (DERIVED_BEFORE.test(before) || DERIVED_AFTER.test(after)) out.push("DERIVED");
  // 派生语义继承：整句中更早出现派生触发词，且触发词与本数值之间没有「报告绝对值」的动词（achieves / reaches / is …）
  const longBefore = scopes.sentenceBefore.replace(/\$/g, " ");
  const trigger = /\b(?:improv\w*|gains?|increas\w*|decreas\w*|reduc\w*|boost\w*|outperform\w*|surpass\w*|relative(?:ly)?|higher|lower|better|worse|faster|slower|speed-?ups?|margins?)\b|提升|提高|降低|增加|减少|超出|领先/gi;
  let lastTrigger = -1;
  for (const match of longBefore.matchAll(trigger)) lastTrigger = match.index! + match[0].length;
  // 「35.3 → 36.9」「from 35.3 to 36.9」的两端都是绝对值（前后对比写法），不继承派生语义
  const arrowAdjacent = /(?:\\rightarrow|\\to|→|->|\bto)\s*\$?\s*$/i.test(longBefore) || /^\s*\$?\s*(?:\\rightarrow|\\to|→|->)/.test(scopes.after);
  if (!arrowAdjacent && lastTrigger >= 0 && !/\b(?:achiev\w*|reach\w*|obtain\w*|attain\w*|yield\w*|scor\w*|is|are|was|were|gets?|records?|reports?)\b|达到|取得|获得|为/i.test(longBefore.slice(lastTrigger))) out.push("DERIVED");
  if (/^[+−]/.test(rawValue) || /[+−]\s*$/.test(before)) out.push("SIGNED");
  if (AGGREGATE.test(scopes.segment)) out.push("AGGREGATE");
  return [...new Set(out)];
}

// ---- 原子值 ----

export interface CertificateAtom {
  kind: "TEXT" | "TABLE_CELL";
  file: string;
  start: number;
  end: number;
  raw: string;
  value: number;
  decimals: number;
  unit: string | null;
  qualifiers: AtomQualifier[];
  cell?: {
    tableId: string;
    tableIndex: number;
    label: string | null;
    caption: string | null;
    row: number;
    col: number;
    rowKey: string[];
    rowGroup: string | null;
    headerPath: string[];
  };
  scopes?: Pick<TextScopes, "segment" | "window">;
}

function normalizedValue(number: ParsedNumber): { value: number; decimals: number; unit: string | null } {
  if (number.unit === "k") return { value: number.value * 1000, decimals: number.decimals - 3, unit: null };
  return { value: number.value, decimals: number.decimals, unit: number.unit };
}

function sameNumber(a: ParsedNumber, b: ParsedNumber): boolean {
  return a.value === b.value && a.decimals === b.decimals;
}

/** 在 [spanStart, spanEnd) 内定位与 valueText 相同的数字（值 + 精度）；唯一才返回 */
export function locateAtom(document: CertificateDocument, file: string, spanStart: number, spanEnd: number, valueText: string | undefined): { atom: CertificateAtom | null; reason?: string } {
  const entry = document.files.find((candidate) => candidate.file === file);
  if (entry === undefined) return { atom: null, reason: "FILE_NOT_FOUND" };
  if (valueText === undefined) return { atom: null, reason: "VALUE_NOT_GIVEN" };
  const target = parseNumbers(valueText)[0];
  if (target === undefined) {
    // 英文数词（「seven times」）：span 内恰好出现一次才作为原文数字
    const word = /\b([a-z]+)\b/i.exec(valueText.trim())?.[1]?.toLowerCase();
    const numeric = word === undefined ? undefined : WORD_NUMBERS[word];
    if (word === undefined || numeric === undefined) return { atom: null, reason: "VALUE_UNPARSEABLE" };
    const spanText = entry.content.slice(spanStart, spanEnd);
    const hits = [...spanText.matchAll(new RegExp(`\\b${word}\\b`, "gi"))];
    if (hits.length !== 1) return { atom: null, reason: hits.length === 0 ? "VALUE_NOT_IN_SPAN" : "VALUE_AMBIGUOUS_IN_SPAN" };
    const start = spanStart + hits[0]!.index!;
    const scopes = textScopes(entry.content, start, start + word.length);
    return {
      atom: {
        kind: "TEXT", file, start, end: start + word.length, raw: hits[0]![0], value: numeric, decimals: 0, unit: null,
        qualifiers: atomQualifiers(scopes, word), scopes: { segment: scopes.segment.slice(0, 600), window: scopes.window.slice(0, 300) },
      },
    };
  }
  // 表格单元格优先：span 覆盖的数值格
  const cells: LatexTableCell[] = [];
  for (const table of entry.tables) {
    if (table.end <= spanStart || table.start >= spanEnd) continue;
    for (const cell of table.cells) {
      if (cell.value === null || cell.valueStart === null || cell.isHeader) continue;
      if (cell.valueStart >= spanStart && cell.valueEnd! <= spanEnd && sameNumber(cell.value, target)) cells.push(cell);
    }
  }
  if (cells.length > 1) return { atom: null, reason: "VALUE_AMBIGUOUS_IN_SPAN" };
  if (cells.length === 1) {
    const cell = cells[0]!;
    const table = entry.tables[cell.tableIndex]!;
    const normalized = normalizedValue(cell.value!);
    return {
      atom: {
        kind: "TABLE_CELL", file, start: cell.valueStart!, end: cell.valueEnd!, raw: cell.value!.raw,
        value: normalized.value, decimals: normalized.decimals, unit: normalized.unit ?? cell.unit, qualifiers: [],
        cell: { tableId: table.tableId, tableIndex: table.tableIndex, label: table.label, caption: table.caption, row: cell.row, col: cell.col, rowKey: cell.rowKey, rowGroup: cell.rowGroup, headerPath: cell.headerPath },
      },
    };
  }
  // 原文数字：span 内同值同精度恰好一次
  const spanText = entry.content.slice(spanStart, spanEnd);
  const hits: Array<{ start: number; end: number; number: ParsedNumber }> = [];
  const escaped = target.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of spanText.matchAll(new RegExp(`(?<![0-9.])${escaped}(?![0-9])(?!\\.[0-9])`, "g"))) {
    const absolute = spanStart + match.index!;
    const parsed = parseNumbers(entry.content.slice(absolute, Math.min(entry.content.length, absolute + match[0].length + 24)))[0];
    if (parsed !== undefined && sameNumber(parsed, target)) hits.push({ start: absolute, end: absolute + match[0].length, number: parsed });
  }
  // 位于表格中的命中（单元格未被解析为数值格）不作为原文数字
  const inTable = (offset: number) => entry.tables.some((table) => offset >= table.start && offset < table.end);
  const textHits = hits.filter((hit) => !inTable(hit.start));
  if (textHits.length === 0) return { atom: null, reason: hits.length > 0 ? "VALUE_IN_UNPARSED_TABLE" : "VALUE_NOT_IN_SPAN" };
  if (textHits.length > 1) return { atom: null, reason: "VALUE_AMBIGUOUS_IN_SPAN" };
  const hit = textHits[0]!;
  const scopes = textScopes(entry.content, hit.start, hit.end);
  const normalized = normalizedValue(hit.number);
  return {
    atom: {
      kind: "TEXT", file, start: hit.start, end: hit.end, raw: hit.number.raw, value: normalized.value, decimals: normalized.decimals, unit: normalized.unit,
      qualifiers: atomQualifiers(scopes, hit.number.raw), scopes: { segment: scopes.segment.slice(0, 600), window: scopes.window.slice(0, 300) },
    },
  };
}

// ---- 唯一绑定（原文数值 → 表格单元格） ----

interface CellCandidate {
  cell: LatexTableCell;
  table: LatexTable;
  file: string;
  colScore: number;
  rowScore: number;
  contextScore: number;
  /** 最低优先级平局裁决：所在章节标题与表格 caption / label 的共有词数 */
  headingScore: number;
  /** 行（或转置表的列）名区分词中被论断点到的比例：「TokenAdv」更像是指「+ GRPO + TokenAdv」而不是「+ GRPO + Zoom + TokenAdv」 */
  coverage: number;
  own: boolean;
}

export interface BindingResult {
  status: "UNIQUE" | "AMBIGUOUS" | "UNBOUND";
  rule: string;
  bound?: { file: string; tableId: string; row: number; col: number; value: string; rowKey: string[]; headerPath: string[] };
  candidates: Array<{ file: string; tableId: string; row: number; col: number; value: string; rowKey: string[]; headerPath: string[]; score: [number, number, number] }>;
  rejections: string[];
  /** A2（M15.3.4）：精确同分并列集内恰一个格值区间与论断值重叠且其表有 caption/label → 以其继续（加性标记，不进 bound/哈希配方） */
  valueTieBreak?: boolean;
}

function cellRef(candidate: { file: string; table: LatexTable; cell: LatexTableCell }) {
  return { file: candidate.file, tableId: candidate.table.tableId, row: candidate.cell.row, col: candidate.cell.col, value: candidate.cell.value?.raw ?? "", rowKey: candidate.cell.rowKey, headerPath: candidate.cell.headerPath };
}

function cellContextText(table: LatexTable, cell: LatexTableCell): string {
  return [table.caption ?? "", table.label ?? "", cell.rowGroup ?? "", ...cell.headerPath, ...cell.rowKey].join(" \n ");
}

function rowIsOwn(document: CertificateDocument, cell: LatexTableCell): boolean {
  const key = cell.rowKey.join(" ");
  if (OWN_ROW.test(key)) return true;
  const tokens = new Set(contextTokens(key));
  return document.ownTerms.some((term) => tokens.has(term));
}

function rowQualified(cell: LatexTableCell): boolean {
  return ROW_QUALIFIERS.test(cell.rowKey.slice(-1).join(" ")) || ROW_QUALIFIERS.test(cell.rowKey.join(" "));
}

function rowMentionScore(document: CertificateDocument, cell: LatexTableCell, context: Context): { score: number; own: boolean } {
  const rowTokens = significant(contextTokens(cell.rowKey.join(" ")));
  // 点名行（行键区分词出现在论断主语里）权重 2；本文方法别名（we / ours / 方法名）权重 1——「we notice that DiverseVul has …」归 DiverseVul
  let score = 2 * rowTokens.filter((token) => mentions(context, token) && !document.ownTerms.includes(token)).length;
  const own = rowIsOwn(document, cell);
  if (own && (OWN_ALIASES.test(context.plain) || document.ownTerms.some((term) => context.tokens.has(term)))) score += 1;
  return { score, own };
}

/** 行键（方向 A）/ 表头叶子（方向 B）的区分词被论断点到的比例（0–1） */
function rowCoverage(cell: LatexTableCell, orientationA: boolean, context: Context): number {
  const tokens = significant(contextTokens(orientationA ? cell.rowKey.join(" ") : cell.headerPath.slice(-1).join(" "))).filter((token) => token.length >= 2);
  if (tokens.length === 0) return 0;
  return tokens.filter((token) => mentions(context, token)).length / tokens.length;
}

/** 转置表：方法在列表头。表头叶子的区分词被点名权重 2；表头是本文方法（Ours / 题目方法名）且论断用本文别名权重 1 */
function headerEntityScore(document: CertificateDocument, cell: LatexTableCell, context: Context): { score: number; own: boolean } {
  const leaf = cell.headerPath.slice(-1).join(" ");
  const tokens = significant(contextTokens(leaf));
  let score = 2 * tokens.filter((token) => mentions(context, token) && !document.ownTerms.includes(token)).length;
  const leafTokens = new Set(contextTokens(leaf));
  const own = OWN_ROW.test(leaf) || document.ownTerms.some((term) => leafTokens.has(term));
  if (own && (OWN_ALIASES.test(context.plain) || document.ownTerms.some((term) => context.tokens.has(term)))) score += 1;
  return { score, own };
}

/** 去掉比较对象短语（than / over / compared with / outperform / surpass / unlike … 到下一个标点）：比较对象不是数值的归属行 */
export function stripComparatorPhrases(text: string): string {
  return text
    .replace(/\b(?:than|over|compared (?:to|with)|in comparison (?:to|with)|versus|vs\.?|relative to|against|outperform\w*|surpass\w*|beat\w*|exceed\w*|unlike|better than|worse than)\b[^,;:.。，；]*/gi, " ")
    .replace(/(?:相比于?|相较于?|优于|超过|高于|低于|比)[^，。；,;.]*/g, " ");
}

/**
 * 「A、B、C … achieve 80.68%, 81.92% and 82.48% respectively」：按位置对齐（确定性）。只在同一张表里、按首次出现顺序点名的行数
 * 恰好等于数值列表长度时成立；返回该数值对应的 (表, 行)，否则 null（不猜）。
 */
export function respectivelyAlignment(document: CertificateDocument, scopes: TextScopes, atom: CertificateAtom): Array<{ tableIndex: number; file: string; row: number }> | null {
  if (!/\brespectively\b|分别/i.test(scopes.sentence)) return null;
  // 掩掉引用 / 交叉引用键（不改偏移）
  const masked = scopes.sentence.replace(/\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, (match) => " ".repeat(match.length));
  const numbers = [...masked.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?|\.\d+)/g)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const rel = atom.start - scopes.sentenceStart;
  const k = numbers.findIndex((entry) => entry.start === rel);
  if (k < 0) return null;
  const glue = (a: { end: number }, b: { start: number }) => /^[\s$%\\,;:~]*(?:and|&|以及|和|、)?[\s$%\\,;:~、]*$/i.test(masked.slice(a.end, b.start));
  let first = k;
  while (first > 0 && glue(numbers[first - 1]!, numbers[first]!)) first -= 1;
  let last = k;
  while (last + 1 < numbers.length && glue(numbers[last]!, numbers[last + 1]!)) last += 1;
  const length = last - first + 1;
  if (length < 2) return null;
  const listStart = numbers[first]!.start;
  const prefix = masked.slice(0, listStart).toLowerCase();
  const hits: Array<{ tableIndex: number; file: string; row: number }> = [];
  for (const file of document.files) {
    for (const table of file.tables) {
      const mentioned: Array<{ row: number; at: number }> = [];
      for (const row of table.rows.filter((entry) => entry.kind === "data")) {
        const key = row.cells.find((cell) => cell.rowKey.length > 0);
        if (key === undefined) continue;
        const tokens = significant(contextTokens(key.rowKey.join(" "))).filter((token) => token.length >= 3 && !/^\d+$/.test(token));
        let at = -1;
        for (const token of tokens) {
          const hit = new RegExp(`(?<![a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).exec(prefix);
          if (hit !== null && (at < 0 || hit.index < at)) at = hit.index;
        }
        if (at >= 0) mentioned.push({ row: row.index, at });
      }
      const ordered = [...new Map(mentioned.sort((a, b) => a.at - b.at).map((entry) => [entry.at, entry])).values()];
      if (ordered.length === length) hits.push({ tableIndex: table.tableIndex, file: file.file, row: ordered[k - first]!.row });
    }
  }
  return hits.length > 0 ? hits : null;
}

/** 数值所在章节标题（最近的 \section / \subsection；没有 = 空） */
export function enclosingHeading(content: string, offset: number): string {
  let heading = "";
  for (const match of content.slice(0, offset).matchAll(/\\(?:sub)*section\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g)) heading = match[1] ?? "";
  return heading;
}

/**
 * 原文数值 → 表格单元格的唯一绑定。列维：表头词须出现在数值窗口；行维：行键词 / 本文方法别名须出现在句中；
 * 语境维：caption / label / 行组 / 表头上层（数据集、划分）在分句或句中出现的个数。候选按（列、行、语境）字典序取最大，
 * 最大者必须唯一；论断窗口里出现、但最佳候选语境解释不了的区分性术语 / 限定词 → 拒绝。
 */
export function bindTextAtom(document: CertificateDocument, atom: CertificateAtom): BindingResult {
  const entry = document.files.find((candidate) => candidate.file === atom.file)!;
  const scopes = textScopes(entry.content, atom.start, atom.end);
  const segmentContext = contextOf(scopes.segment);
  const sentenceContext = contextOf(scopes.sentence);
  const subjectContext = contextOf(stripComparatorPhrases(scopes.subjectSentence));
  // 行维先看数值所在分句（并列结果各有主语时以本分句为准）；分句里没有任何行名 / 本文别名时才回退到整句主语
  const segmentRowContext = contextOf(stripComparatorPhrases(scopes.segment));
  const headingContext = contextOf(enclosingHeading(entry.content, atom.start));
  const candidates: CellCandidate[] = [];
  const rowContextFor = (cell: LatexTableCell): { score: number; own: boolean } => {
    const inSegment = rowMentionScore(document, cell, segmentRowContext);
    return inSegment.score > 0 ? inSegment : rowMentionScore(document, cell, subjectContext);
  };
  const segmentNamesAnyRow = document.files.some((file) => file.tables.some((table) => table.cells.some((cell) => cell.rowKey.length > 0 && cell.value !== null && rowMentionScore(document, cell, segmentRowContext).score > 0)));
  const aligned = respectivelyAlignment(document, scopes, atom);
  for (const file of document.files) {
    for (const table of file.tables) {
      if (table.parseIssues.includes("NESTED_TABULAR")) continue;
      for (const cell of table.cells) {
        if (cell.value === null || cell.isHeader || cell.rowKey.length === 0) continue;
        // 方向 A（常规）：表头 = 指标、行键 = 方法；方向 B（转置表，常见于时序 / NLP）：行键 = 指标、表头 = 方法
        // A1（M15.3.4）：列维距离改为多级表头逐层计算（上层加距叶深度惩罚），不再只看叶层
        const distanceA = hierarchicalMetricDistance(scopes, cell.headerPath);
        const rowA = distanceA === Infinity ? { score: 0, own: false } : aligned !== null
          ? (aligned.some((entry) => entry.file === file.file && entry.tableIndex === table.tableIndex && entry.row === cell.row) ? { score: 10, own: rowIsOwn(document, cell) } : { score: 0, own: false })
          : segmentNamesAnyRow ? rowMentionScore(document, cell, segmentRowContext) : rowContextFor(cell);
        const keyTokens = significant(contextTokens(cell.rowKey.join(" ")));
        const distanceB = aligned !== null ? Infinity : metricDistance(scopes, keyTokens);
        const rowB = distanceB === Infinity ? { score: 0, own: false } : headerEntityScore(document, cell, segmentNamesAnyRow ? segmentRowContext : subjectContext);
        const useA = distanceA !== Infinity && rowA.score > 0 && (distanceB === Infinity || rowB.score === 0 || 100 - distanceA >= 100 - distanceB);
        const useB = !useA && distanceB !== Infinity && rowB.score > 0;
        if (!useA && !useB) continue;
        // 列维 = 指标词离数值越近越好（「HOTA of 61.7% with a processing speed of …」中 61.7 归 HOTA 而不是 Speed）
        const colScore = 100 - (useA ? distanceA : distanceB);
        const row = useA ? rowA : rowB;
        const upper = significant(contextTokens([table.caption ?? "", table.label ?? "", cell.rowGroup ?? "", ...cell.headerPath.slice(0, -1)].join(" ")));
        const contextScore = upper.filter((token) => mentions(segmentContext, token)).length * 2 + upper.filter((token) => mentions(sentenceContext, token)).length;
        const tableWords = significant(contextTokens(`${table.caption ?? ""} ${(table.label ?? "").replace(/[:_-]/g, " ")}`));
        const headingScore = tableWords.filter((token) => mentions(headingContext, token)).length;
        candidates.push({ cell, table, file: file.file, colScore, rowScore: row.score, contextScore, headingScore, coverage: rowCoverage(cell, useA, segmentNamesAnyRow ? segmentRowContext : subjectContext), own: row.own });
      }
    }
  }
  const rejections: string[] = [];
  let pool = candidates;
  // 句内显式指向的表（「As shown in Table~\ref{tab:ab}, …」）：只在被指向的表里找（作者自己指明的出处）
  const referenced = new Set([...scopes.sentence.matchAll(/\\(?:ref|cref|Cref|autoref|subref)\*?\{([^{}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((label) => label.trim())));
  if (referenced.size > 0 && pool.some((candidate) => candidate.table.label !== null && referenced.has(candidate.table.label))) {
    pool = pool.filter((candidate) => candidate.table.label !== null && referenced.has(candidate.table.label));
  }
  // 行限定：论断没写「w/o / small / + X」这类变体词时，排除带变体词的行（仍有其他候选时）
  // 变体词在整句范围判断（「90.69% and 95.28% without SDM」的 without 同时修饰并列的两个数）
  const claimMentionsVariant = ROW_QUALIFIERS.test(scopes.sentence);
  if (!claimMentionsVariant && pool.some((candidate) => !rowQualified(candidate.cell))) pool = pool.filter((candidate) => !rowQualified(candidate.cell));
  const summary = candidates.slice(0, 12).map((candidate) => ({ ...cellRef(candidate), score: [candidate.colScore, candidate.rowScore, candidate.contextScore] as [number, number, number] }));
  if (pool.length === 0) return { status: "UNBOUND", rule: "NO_CELL_MATCHES_METRIC_AND_ROW", candidates: summary, rejections };
  const better = (a: CellCandidate, b: CellCandidate): number => a.colScore - b.colScore || a.rowScore - b.rowScore || a.contextScore - b.contextScore || a.coverage - b.coverage || a.headingScore - b.headingScore;
  pool.sort((a, b) => better(b, a));
  let top = pool[0]!;
  const ties = pool.filter((candidate) => better(candidate, top) === 0 && candidate.cell !== top.cell);
  let valueTieBreak = false;
  if (ties.length > 0) {
    // A2（M15.3.4 预注册方案A）：值重合平局裁决——只在精确同分并列集内生效。
    // 存活条件：格值显示精度区间与论断值重叠（compareAtoms OVERLAP，含单位换算），且所在表有非空 caption 或 label
    // （无题注表无归属证据，禁止用值定归属）；恰一个存活 → 以其继续；0 个或 ≥2 个 → 维持 TIED_CANDIDATES。
    // 该裁决不改变任何非并列情形的排序，也不覆盖后续 B2 / 解释性 / 限定词检查。
    const survivors = [top, ...ties].filter((candidate) => {
      if (candidate.cell.value === null) return false;
      if ((candidate.table.caption ?? "") === "" && candidate.table.label === null) return false;
      return compareAtoms(atom, normalizedValue(candidate.cell.value)).relation === "OVERLAP";
    });
    if (survivors.length === 1) {
      top = survivors[0]!;
      valueTieBreak = true;
    }
  }
  if (ties.length > 0 && !valueTieBreak) return { status: "AMBIGUOUS", rule: "TIED_CANDIDATES", candidates: summary, rejections: [`${ties.length + 1} 个候选单元格得分相同`] };
  // M15.2.1（N09）：跨表数值竞争——唯一性不能只在「解析成功进入候选集的单元格」里判断。
  // 论断数值与绑定单元格不一致（即将按差异出证）而该数值逐字出现在其他表格的表格体内时，
  // 论断指向的可能正是那张表（复现表 / 公平对比表的同名行）：跨表归属不可证 → 拒绝出证。
  // 数值一致（OVERLAP）的绑定本身已有数值印证，不受此检查影响。
  if (top.cell.value !== null && compareAtoms(atom, top.cell.value).relation !== "OVERLAP") {
    const needle = atom.raw.replace(/,/g, "");
    if (/^\d+(?:\.\d+)?$/.test(needle)) {
      const pattern = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d.])`, "g");
      const otherTableIds = new Set<string>();
      for (const file of document.files) {
        for (const match of file.content.matchAll(pattern)) {
          for (const table of file.tables) {
            if (table.tableId !== top.table.tableId && match.index! >= table.start && match.index! < table.end) otherTableIds.add(table.tableId);
          }
        }
      }
      if (otherTableIds.size > 0) rejections.push(`VALUE_APPEARS_IN_OTHER_TABLE:${[...otherTableIds].slice(0, 3).join(",")}`);
    }
  }
  // 多指标并列（「IoU and F1 of 80.1 and 85.2」）：数值左侧同时出现本表 ≥2 个不同列的表头词 → 列归属不唯一（除非「respectively」已按位置对齐列表）
  const leftTokens = leftScanTokens(scopes);
  const columnsMentioned = new Set(top.table.cells.filter((cell) => !cell.isHeader && cell.value !== null).map((cell) => cell.headerPath.slice(-1).join(" ")).filter((leaf) => significant(contextTokens(leaf)).some((token) => leftTokens.has(token))));
  if (columnsMentioned.size >= 2 && !/\brespectively\b|分别/i.test(scopes.sentence)) rejections.push(`MULTIPLE_METRICS_BEFORE_VALUE:${[...columnsMentioned].slice(0, 3).join("|")}`);
  // 解释性检查：窗口内区分性术语、分句内限定词须由最佳候选的语境解释
  // 「respectively」位置对齐时，列表里其他被点名的行名是对齐结构本身，不是未解释的限定
  // 比较对象短语（outperforming X / compared with Y）先剥离再取区分词：比较对象不是数值归属（与行维 stripComparatorPhrases 同一语义，M15.3.1）
  const alignedRowNames = aligned !== null ? top.table.cells.filter((cell) => cell.rowKey.length > 0).map((cell) => cell.rowKey.join(" ")) : [];
  const explain = contextOf([cellContextText(top.table, top.cell), ...top.table.cells.filter((cell) => cell.isHeader).map((cell) => cell.text), ...alignedRowNames].join(" \n "));
  const ownWords = new Set(document.ownTerms);
  // A1-b（M15.3.4）：聚合措辞词描述统计口径而非实体归属——原子无 AGGREGATE 限定词时不作为区分性术语要求解释。
  // 该忽略只作用于本区分词循环，不影响下方 QUALIFIER_LEXICON / QUALIFIER_FAMILIES（reproduce/fair/original）防线。
  const aggregateWording = atom.qualifiers.includes("AGGREGATE");
  for (const term of distinctiveTerms(plainLatexText(stripComparatorPhrases(scopes.window)))) {
    const lower = canonical(term.toLowerCase());
    if (ownWords.has(lower) || mentions(explain, lower) || STOP.has(lower)) continue;
    if (!aggregateWording && (lower === "average" || lower === "overall")) continue;
    if (/^(?:cpu|gpu|ghz|mhz|tb|gb|mb)$/i.test(lower)) continue;
    rejections.push(`UNEXPLAINED_TERM:${term}`);
  }
  for (const qualifier of QUALIFIER_LEXICON) {
    if (mentions(segmentContext, qualifier) && !mentions(explain, qualifier)) rejections.push(`UNEXPLAINED_QUALIFIER:${qualifier}`);
  }
  for (const family of QUALIFIER_FAMILIES) {
    const used = family.filter((qualifier) => mentions(segmentContext, qualifier));
    if (used.length > 0 && !family.some((qualifier) => mentions(explain, qualifier))) rejections.push(`UNEXPLAINED_QUALIFIER:${used[0]}`);
  }
  // 分句里点名的、只属于其他候选语境的术语（MOT20 vs MOT17）
  const topUpper = contextOf(cellContextText(top.table, top.cell));
  // A1-c（M15.3.4，与 M15.3.1 comparator 剥离同一语义）：比较对象短语里的名字（outperforming SimpleHGN by …）
  // 既不算数值归属，也不得在此反向否决唯一绑定——「on MOT20」这类非比较语的数据集限定不受影响。
  const segmentStripped = contextOf(stripComparatorPhrases(scopes.segment));
  for (const candidate of candidates) {
    if (candidate === top) continue;
    // 只看区分性术语（数据集 / 划分 / 设置名：MOT20、LEVIR-CD、WMT16），不看 parameters / compared 这类普通词
    const otherUpper = distinctiveTerms(plainLatexText([candidate.table.caption ?? "", candidate.cell.rowGroup ?? "", ...candidate.cell.headerPath.slice(0, -1)].join(" "))).map((term) => canonical(term.toLowerCase()));
    for (const token of otherUpper) {
      if (mentions(segmentStripped, token) && !mentions(topUpper, token) && !mentions(explain, token)) rejections.push(`DISCRIMINATING_TERM_OF_OTHER_CANDIDATE:${token}`);
    }
  }
  if (top.table.parseIssues.length > 0) rejections.push(`TABLE_PARSE_ISSUES:${top.table.parseIssues.join(",")}`);
  const unique = [...new Set(rejections)];
  if (unique.length > 0) return { status: "AMBIGUOUS", rule: "UNEXPLAINED_CONTEXT", bound: cellRef(top), candidates: summary, rejections: unique, ...(valueTieBreak ? { valueTieBreak: true } : {}) };
  return { status: "UNIQUE", rule: "UNIQUE_MAX_SCORE", bound: cellRef(top), candidates: summary, rejections: [], ...(valueTieBreak ? { valueTieBreak: true } : {}) };
}

// ---- 数值关系 ----

export type ValueRelation = "OVERLAP" | "DISJOINT" | "SCALE_AMBIGUOUS" | "UNIT_MISMATCH";

export function compareAtoms(a: Pick<CertificateAtom, "value" | "decimals" | "unit">, b: Pick<CertificateAtom, "value" | "decimals" | "unit">): { relation: ValueRelation; a: Interval; b: Interval; note: string } {
  let ia = displayInterval(a.value, a.decimals);
  let ib = displayInterval(b.value, b.decimals);
  const unitA = a.unit === "%" ? "%" : a.unit;
  const unitB = b.unit === "%" ? "%" : b.unit;
  if (unitA !== null && unitB !== null && unitA !== unitB) {
    const factor = unitFactor(unitA, unitB);
    if (factor === null) return { relation: "UNIT_MISMATCH", a: ia, b: ib, note: `单位 ${unitA} 与 ${unitB} 不同量纲` };
    ia = { lo: ia.lo * factor, hi: ia.hi * factor };
    return { relation: intervalsOverlap(ia, ib) ? "OVERLAP" : "DISJOINT", a: ia, b: ib, note: `单位换算 ${unitA}→${unitB}` };
  }
  if (intervalsOverlap(ia, ib)) return { relation: "OVERLAP", a: ia, b: ib, note: "显示精度区间相交" };
  if (unitA === null || unitB === null) {
    for (let k = -3; k <= 3; k += 1) {
      if (k === 0) continue;
      const scale = 10 ** k;
      if (intervalsOverlap({ lo: ia.lo * scale, hi: ia.hi * scale }, ib)) return { relation: "SCALE_AMBIGUOUS", a: ia, b: ib, note: `一侧缺单位且两数恰差 10^${k}` };
    }
  }
  return { relation: "DISJOINT", a: ia, b: ib, note: "显示精度区间不相交" };
}

// ---- 派生量 ----

export interface DerivedInterpretation {
  name: string;
  formula: string;
  ast: FormulaNode;
  /** 复算值的绝对量区间（方向单独判断） */
  value: Interval | null;
  /** 量级是否与论断值相容（矛盾证书只看量级不相容） */
  consistent: boolean | null;
  /** 复算方向是否与措辞（提升 / 降低 + 指标极性）一致；极性未知 = UNKNOWN */
  direction: "AS_WORDED" | "OPPOSITE" | "UNKNOWN";
}

export interface DerivedRecompute {
  family: "DIFFERENCE" | "PERCENT" | "MULTIPLE" | "AGGREGATE" | "UNKNOWN";
  subject: { status: "BOUND" | "AMBIGUOUS" | "MISSING"; rows: string[] };
  reference: { status: "BOUND" | "AMBIGUOUS" | "MISSING" | "GROUP"; rows: string[]; phrase: string };
  column: { status: "BOUND" | "AMBIGUOUS" | "UNBOUND"; header: string[] };
  operands: Array<{ ref: string; file: string; tableId: string; row: number; col: number; raw: string; rowKey: string[] }>;
  interpretations: DerivedInterpretation[];
  /** 所有可接受解释都与论断值不相容（证据，但只在解释唯一时才出证书） */
  allInterpretationsDisagree: boolean | null;
  anyInterpretationAgrees: boolean | null;
  /** A3（M15.3.4）：subject/reference/column 由句内操作数对发现绑定（加性标记，不参与哈希配方） */
  bindingProvenance?: "operand-discovered";
}

const REFERENCE_WORDS = /\b(?:than|over|compared (?:to|with)|versus|vs\.?|relative to|against|beyond|from)\b|相比|相较于?|比|较/i;
const GENERIC_REFERENCE = /\b(?:best|previous|prior|state[- ]of[- ]the[- ]art|sota|leading|strongest|second|baselines?|existing|other|competing|counterparts?|competitors?|average|all)\b|最优|最佳|现有|已有/i;

function rowsByMention(table: LatexTable, text: string): LatexTableCell[][] {
  const context = contextOf(text);
  const rows = table.rows.filter((row) => row.kind === "data");
  const out: LatexTableCell[][] = [];
  for (const row of rows) {
    const keyCell = row.cells.find((cell) => cell.rowKey.length > 0);
    if (keyCell === undefined) continue;
    const tokens = significant(contextTokens(keyCell.rowKey.join(" ")));
    if (tokens.some((token) => mentions(context, token) && token.length >= 2)) out.push(row.cells);
  }
  return out;
}

function percentLike(header: readonly string[], unit: string | null): boolean | null {
  if (unit === "%") return true;
  if (unit !== null) return false;
  const text = header.join(" ").toLowerCase();
  if (/%|accuracy|\bacc\b|\bmap\b|\bap\d*\b|\bar\b|hota|idf1|mota|f1|recall|precision|miou|\biou\b|dice|auc|auroc|top-?1|top-?5|rank-?\d|bleu|rouge|exact match|\bem\b|准确率|召回率|精确率/.test(text)) return true;
  if (/\bfps\b|\bhz\b|\bms\b|latency|time|speed|param|flops|memory|\bmb\b|\bgb\b|mm\b|error|loss|mpjpe|rmse|mae|fid/.test(text)) return false;
  return null;
}

/**
 * 派生论断复算（零模型）：从论断措辞确定运算族、主语行、参照行（必须点名）与指标列，构造受控 AST 并区间求值。
 * 只有「主语 / 参照 / 列都唯一绑定 + 运算解释唯一 + 无约数 / 不等式限定」才 certifiable。
 */
export function recomputeDerived(document: CertificateDocument, atom: CertificateAtom): { recompute: DerivedRecompute; certifiable: boolean; outcome: "CONTRADICTED" | "SUPPORTED" | null; reasons: string[] } {
  const entry = document.files.find((candidate) => candidate.file === atom.file)!;
  const scopes = textScopes(entry.content, atom.start, atom.end);
  const reasons: string[] = [];
  const after = scopes.after.replace(/\$/g, " ");
  const windowText = scopes.window.replace(/\$/g, " ");
  let family: DerivedRecompute["family"] = "UNKNOWN";
  if (/^\s*(?:\\?%|percent)?\s*(?:percentage[- ]points?|pp\b|p\.p\.|points?\b|个百分点|百分点)/i.test(after)) family = "DIFFERENCE";
  else if (/^\s*(?:\\?%|percent)/i.test(after)) family = "PERCENT";
  else if (/^\s*(?:[×x]\b|×|times\b|-?fold\b|倍)/i.test(after) || /\\times\s*\$?\s*$/.test(scopes.before)) family = "MULTIPLE";
  else if (atom.qualifiers.includes("SIGNED") || /\bby\s*$/i.test(scopes.before.replace(/\$/g, " "))) family = "DIFFERENCE";
  if (atom.qualifiers.includes("AGGREGATE")) family = "AGGREGATE";
  const empty: DerivedRecompute = {
    family, subject: { status: "MISSING", rows: [] }, reference: { status: "MISSING", rows: [], phrase: "" }, column: { status: "UNBOUND", header: [] },
    operands: [], interpretations: [], allInterpretationsDisagree: null, anyInterpretationAgrees: null,
  };
  // 参照短语：比较词之后到分句末
  const segment = scopes.segment;
  const refMatch = REFERENCE_WORDS.exec(segment);
  const referencePhrase = refMatch === null ? "" : segment.slice(refMatch.index + refMatch[0].length);
  const subjectText = refMatch === null ? scopes.sentence.slice(0, Math.max(0, scopes.sentence.indexOf(segment)) + segment.length) : scopes.sentence.slice(0, scopes.sentence.indexOf(segment) + refMatch.index);
  // 指标列：窗口里出现的表头词；在含主语与参照行的表格中找
  const segmentContext = contextOf(segment);
  let best: { table: LatexTable; file: string; col: number; header: string[]; score: number; context: number } | null = null;
  let tie = false;
  for (const file of document.files) {
    for (const table of file.tables) {
      const columns = new Map<number, string[]>();
      for (const cell of table.cells) if (!cell.isHeader && cell.value !== null && cell.rowKey.length > 0) columns.set(cell.col, cell.headerPath);
      for (const [col, header] of columns) {
        // A1（M15.3.4）：派生路径列维与 bindTextAtom 共用层级匹配（上层加距叶深度惩罚）
        const distance = hierarchicalMetricDistance(scopes, header);
        if (distance === Infinity) continue;
        const score = 100 - distance;
        const upper = significant(contextTokens([table.caption ?? "", ...header.slice(0, -1)].join(" ")));
        const context = upper.filter((token) => mentions(segmentContext, token)).length;
        if (best === null || score > best.score || (score === best.score && context > best.context)) {
          best = { table, file: file.file, col, header, score, context };
          tie = false;
        } else if (score === best.score && context === best.context) tie = true;
      }
    }
  }
  // M15.2.1（N05）：行标签读取防护——数据行可能没有行标签（续表/重复列布局/无标签数据行）。
  // 缺标签的行无法参与点名或参照列举：跳过并计数，绝不因非空断言崩溃（此前会导致整篇账本丢失）。
  const rowKeyCellOf = (cells: LatexTableCell[]): LatexTableCell | undefined => cells.find((cell) => cell.rowKey.length > 0);
  const rowLabelOf = (cells: LatexTableCell[]): string | null => {
    const keyCell = rowKeyCellOf(cells);
    return keyCell === undefined ? null : keyCell.rowKey.join(" / ");
  };
  let unlabeledRows = 0;
  const withLabel = (rows: LatexTableCell[][]): LatexTableCell[][] => {
    const out = rows.filter((cells) => rowLabelOf(cells) !== null);
    unlabeledRows += rows.length - out.length;
    return out;
  };
  // 主语 / 参照的主路径绑定（列未绑定时跳过，A3 可补救）；原因码延迟到 A3 之后按原顺序写入。
  let subjectRows: LatexTableCell[][] = [];
  let subjectStatus: DerivedRecompute["subject"]["status"] = "MISSING";
  let referenceRows: LatexTableCell[][] = [];
  let referenceStatus: DerivedRecompute["reference"]["status"] = "MISSING";
  if (best !== null) {
    const tbl = best.table;
    const cellAtNow = (cells: LatexTableCell[]): LatexTableCell | undefined => cells.find((cell) => cell.col === best!.col && cell.value !== null);
    const dataRows = tbl.rows.filter((row) => row.kind === "data");
    const ownRows = dataRows.filter((row) => row.cells.some((cell) => cell.rowKey.length > 0 && rowIsOwn(document, cell))).map((row) => row.cells);
    // 主语行：本文方法别名 / 点名行（出现在比较词之前）
    subjectRows = rowsByMention(tbl, subjectText).filter((cells) => cellAtNow(cells) !== undefined);
    if (subjectRows.length === 0 && (OWN_ALIASES.test(subjectText) || document.ownTerms.some((term) => contextOf(subjectText).tokens.has(term)))) subjectRows = ownRows;
    if (subjectRows.length > 1 && !ROW_QUALIFIERS.test(subjectText)) {
      const plain = subjectRows.filter((cells) => {
        const keyCell = rowKeyCellOf(cells);
        return keyCell !== undefined && !rowQualified(keyCell);
      });
      if (plain.length >= 1) subjectRows = plain;
    }
    subjectStatus = subjectRows.length === 1 ? "BOUND" : subjectRows.length === 0 ? "MISSING" : "AMBIGUOUS";
    if (subjectRows.length === 0) subjectRows = ownRows;
    // 参照：点名行（排除主语行）；「RODNet 模型平均」= 组
    referenceRows = referencePhrase === "" ? [] : rowsByMention(tbl, referencePhrase).filter((cells) => !subjectRows.includes(cells) && cellAtNow(cells) !== undefined);
    const groupReference = /\b(?:average|mean)\b|平均/i.test(referencePhrase) && referenceRows.length >= 2;
    if (referencePhrase === "") referenceStatus = "MISSING";
    else if (groupReference) referenceStatus = "GROUP";
    else if (referenceRows.length === 1) referenceStatus = "BOUND";
    else referenceStatus = GENERIC_REFERENCE.test(referencePhrase) || referenceRows.length > 1 ? "AMBIGUOUS" : "MISSING";
    if (referenceStatus === "AMBIGUOUS" && referenceRows.length === 0) {
      // 非点名参照（「最佳 / 之前 / SOTA」）：列出全部非主语行供复算记录（无行标签的行跳过并计数）
      referenceRows = withLabel(dataRows.map((row) => row.cells)).filter((cells) => !subjectRows.includes(cells) && !ownRows.includes(cells) && cellAtNow(cells) !== undefined);
    }
  }
  // ---- A3（M15.3.4 预注册方案A）：操作数优先派生绑定 ----
  // family 已定且 subject / reference / column 任一未唯一绑定时：取论断所在句的其他数值词元（每个值全文档出现 ≤2 格），
  // 在同一表内枚举同列异行、与句内两个不同数值重合的格对，按 family 计算全部解释；
  // 恰一个（表, 列, 行对, 解释）在显示精度内复现论断值 → 由该对绑定 subject/reference/column
  // （DerivedRecompute.bindingProvenance = "operand-discovered"）；0 个或 ≥2 个 → 维持原弃判。
  // 仅 DIFFERENCE / MULTIPLE / PERCENT（AGGREGATE 排除）；既有 qualifier / 方向检查 / 区间算术 / 双钥匙门槛不变。
  const claimInterval = displayInterval(atom.value, atom.decimals);
  let operandDiscovered = false;
  if (family === "DIFFERENCE" || family === "MULTIPLE" || family === "PERCENT") {
    if (best === null || tie || subjectStatus !== "BOUND" || referenceStatus !== "BOUND") {
      // 句内数值词元（排除与论断值相同的派生数与 0；值 + 精度去重）
      const operandNums: Array<{ value: number; decimals: number; unit: string | null }> = [];
      for (const num of parseNumbers(plainLatexText(scopes.sentence).replace(/\\%/g, " %"))) {
        const normalized = normalizedValue(num);
        if (normalized.value === atom.value && normalized.decimals === atom.decimals) continue;
        if (normalized.value === 0) continue;
        if (!operandNums.some((entry) => entry.value === normalized.value && entry.decimals === normalized.decimals)) operandNums.push(normalized);
      }
      const cellMatches = (target: { value: number; decimals: number; unit: string | null }, cell: LatexTableCell): boolean =>
        cell.value !== null && !cell.isHeader && compareAtoms(target, normalizedValue(cell.value)).relation === "OVERLAP";
      const usable = operandNums.filter((target) => {
        let count = 0;
        for (const file of document.files) for (const tbl of file.tables) for (const cell of tbl.cells) if (cellMatches(target, cell)) count += 1;
        return count <= 2;
      });
      const solutions: Array<{ table: LatexTable; file: string; col: number; header: string[]; a: LatexTableCell; b: LatexTableCell; name: string }> = [];
      const entryKey = new WeakMap<object, string>();
      if (usable.length >= 2) {
        for (const file of document.files) {
          for (const tbl of file.tables) {
            const byCol = new Map<number, LatexTableCell[]>();
            for (const cell of tbl.cells) {
              if (cell.isHeader || cell.value === null || cell.rowKey.length === 0) continue;
              const list = byCol.get(cell.col) ?? [];
              list.push(cell);
              byCol.set(cell.col, list);
            }
            for (const [col, cells] of byCol) {
              const hits = cells
                .map((cell) => ({ cell, num: usable.find((target) => cellMatches(target, cell)) }))
                .filter((entry): entry is { cell: LatexTableCell; num: { value: number; decimals: number; unit: string | null } } => entry.num !== undefined);
              for (const { cell: a, num: na } of hits) {
                for (const { cell: b, num: nb } of hits) {
                  if (a.row === b.row || na === nb) continue;
                  const header = a.headerPath;
                  const pctA3 = percentLike(header, a.unit);
                  const lowerA3 = /\b(?:error|loss|latency|time|ms|mpjpe|rmse|mae|fid|params?|flops|memory)\b|误差|耗时/i.test(header.join(" "));
                  // 主语定向（M15.3.4）：句内先出现的操作数为主语侧（「84.58 over 72.06」先述新值），后出现为参照。
                  // 方向门（指标极性 + 措辞符号）仍独立校验：定向与措辞不合时按 OPPOSITE 弃判（fail-closed），
                  // 不会凭措辞强行翻转强判（如「reduces」而数值实为上升 → OPPOSITE → 弃判）。
                  const subjCell = operandNums.indexOf(na) <= operandNums.indexOf(nb) ? a : b;
                  const refCell = subjCell === a ? b : a;
                  const normA = normalizedValue(subjCell.value!);
                  const normB = normalizedValue(refCell.value!);
                  const atomsA3 = new Map<string, FormulaAtom>([
                    ["S", { ref: "S", value: normA.value, decimals: normA.decimals, unit: normA.unit ?? subjCell.unit }],
                    ["R", { ref: "R", value: normB.value, decimals: normB.decimals, unit: normB.unit ?? refCell.unit }],
                  ]);
                  const sub: FormulaNode = { op: "atom", ref: "S" };
                  const refNode: FormulaNode = { op: "atom", ref: "R" };
                  const formulas: Array<{ name: string; ast: FormulaNode; signed: boolean }> = [];
                  if (family === "DIFFERENCE" || family === "PERCENT") formulas.push({ name: pctA3 === true ? "percentage_point_difference" : "subtract", ast: { op: pctA3 === true ? "percentage_point_difference" : "subtract", args: [sub, refNode] }, signed: true });
                  if (family === "PERCENT") formulas.push({ name: "relative_change_percent", ast: { op: "relative_change_percent", args: [sub, refNode] }, signed: true });
                  if (family === "MULTIPLE") {
                    const ratio: FormulaNode = lowerA3 ? { op: "ratio", args: [refNode, sub] } : { op: "ratio", args: [sub, refNode] };
                    formulas.push({ name: "ratio", ast: ratio, signed: false });
                    formulas.push({ name: "ratio_minus_one", ast: { op: "subtract", args: [ratio, { op: "const", value: 1 }] }, signed: false });
                  }
                  for (const formula of formulas) {
                    if (!validateFormula(formula.ast, atomsA3).ok) continue;
                    const value = evaluateFormula(formula.ast, atomsA3);
                    if (value === null) continue;
                    const magnitude: Interval = !formula.signed ? value : value.lo >= 0 ? value : value.hi <= 0 ? { lo: -value.hi, hi: -value.lo } : { lo: 0, hi: Math.max(-value.lo, value.hi) };
                    if (!intervalsOverlap(magnitude, claimInterval)) continue;
                    // 有符号公式的量级与方向无关：(a,b) 与 (b,a) 是同一解——按无序行对去重，避免平白多出一解而弃判
                    const orientationKey = formula.signed ? `${Math.min(a.row, b.row)}~${Math.max(a.row, b.row)}` : `${subjCell.row}~${refCell.row}`;
                    const key = `${tbl.tableId}|${col}|${formula.name}|${orientationKey}`;
                    if (!solutions.some((entry) => entryKey.get(entry) === key)) {
                      solutions.push({ table: tbl, file: file.file, col, header, a: subjCell, b: refCell, name: formula.name });
                      entryKey.set(solutions[solutions.length - 1]!, key);
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (solutions.length === 1) {
        const sol = solutions[0]!;
        const rowCellsOf = (cell: LatexTableCell): LatexTableCell[] => sol.table.rows.find((row) => row.cells.some((entry) => entry === cell))!.cells;
        best = { table: sol.table, file: sol.file, col: sol.col, header: sol.header, score: 0, context: 0 };
        tie = false;
        subjectRows = [rowCellsOf(sol.a)];
        referenceRows = [rowCellsOf(sol.b)];
        subjectStatus = "BOUND";
        referenceStatus = "BOUND";
        operandDiscovered = true;
        unlabeledRows = 0;
      }
    }
  }
  if (best === null) {
    reasons.push("DERIVED_COLUMN_UNBOUND");
    return { recompute: empty, certifiable: false, outcome: null, reasons };
  }
  const column: DerivedRecompute["column"] = { status: tie ? "AMBIGUOUS" : "BOUND", header: best.header };
  if (tie) reasons.push("DERIVED_COLUMN_AMBIGUOUS");
  const table = best.table;
  const cellAt = (cells: LatexTableCell[]): LatexTableCell | undefined => cells.find((cell) => cell.col === best!.col && cell.value !== null);
  const subject: DerivedRecompute["subject"] = {
    status: subjectStatus,
    rows: subjectRows.map((cells) => rowLabelOf(cells) ?? ""),
  };
  if (subjectStatus !== "BOUND") reasons.push(`DERIVED_SUBJECT_${subjectStatus}`);
  const reference: DerivedRecompute["reference"] = {
    status: referenceStatus,
    rows: referenceRows.map((cells) => rowLabelOf(cells) ?? ""),
    phrase: plainLatexText(referencePhrase).slice(0, 160),
  };
  if (referenceStatus !== "BOUND") reasons.push(`DERIVED_REFERENCE_${referenceStatus}`);
  // 行枚举不完整（有无标签行被跳过）→ 复算覆盖不可证完整，fail-closed 不出证书（A3 恰一格对绑定的行不受此限）
  if (!operandDiscovered && unlabeledRows > 0) reasons.push("DERIVED_ROW_LABEL_MISSING");
  // 原子与解释
  const atoms = new Map<string, FormulaAtom>();
  const operands: DerivedRecompute["operands"] = [];
  const atomOf = (cells: LatexTableCell[], prefix: string): string | null => {
    const cell = cellAt(cells);
    if (cell === undefined || cell.value === null) return null;
    const ref = `${prefix}${operands.length + 1}`;
    const normalized = normalizedValue(cell.value);
    atoms.set(ref, { ref, value: normalized.value, decimals: normalized.decimals, unit: normalized.unit ?? cell.unit });
    operands.push({ ref, file: best!.file, tableId: table.tableId, row: cell.row, col: cell.col, raw: cell.value.raw, rowKey: cell.rowKey });
    return ref;
  };
  const interpretations: DerivedInterpretation[] = [];
  const pct = percentLike(best.header, cellAt(subjectRows[0] ?? [])?.unit ?? null);
  const lowerIsBetter = /\b(?:error|loss|latency|time|ms|mpjpe|rmse|mae|fid|params?|flops|memory)\b|误差|耗时/i.test(best.header.join(" "));
  const higherIsBetter = pct === true || /\b(?:speed|fps|hz|throughput)\b/i.test(best.header.join(" "));
  const decreaseWording = /\b(?:reduc\w*|decreas\w*|lower|fewer|less|smaller|drop\w*|cut\w*)\b|降低|减少|下降/i.test(windowText);
  const increaseWording = /\b(?:improv\w*|increas\w*|higher|better|outperform\w*|surpass\w*|gain\w*|boost\w*|more|larger|faster)\b|提升|提高|增加|超出|领先|改善/i.test(windowText);
  // 措辞断言的方向：主语 − 参照 应为正（提升）还是负（降低）；指标极性未知时方向 UNKNOWN（量级不相容仍可证矛盾，方向错误只记怀疑）
  const assertedSign: 1 | -1 | 0 = decreaseWording && !increaseWording ? -1 : increaseWording && !decreaseWording ? (lowerIsBetter ? -1 : higherIsBetter ? 1 : 0) : 0;
  const add = (name: string, ast: FormulaNode, signed: boolean) => {
    if (!validateFormula(ast, atoms).ok) return;
    const value = evaluateFormula(ast, atoms);
    if (value === null) {
      interpretations.push({ name, formula: renderFormula(ast), ast, value: null, consistent: null, direction: "UNKNOWN" });
      return;
    }
    const magnitude: Interval = !signed ? value : value.lo >= 0 ? value : value.hi <= 0 ? { lo: -value.hi, hi: -value.lo } : { lo: 0, hi: Math.max(-value.lo, value.hi) };
    const sign = value.lo > 0 ? 1 : value.hi < 0 ? -1 : 0;
    const direction: DerivedInterpretation["direction"] = !signed || assertedSign === 0 || sign === 0 ? "UNKNOWN" : sign === assertedSign ? "AS_WORDED" : "OPPOSITE";
    interpretations.push({ name, formula: renderFormula(ast), ast, value: magnitude, consistent: intervalsOverlap(magnitude, claimInterval), direction });
  };
  for (const subjectCells of subjectRows.slice(0, 3)) {
    const s = atomOf(subjectCells, "S");
    if (s === null) continue;
    const references: Array<{ ast: FormulaNode; label: string }> = [];
    if (referenceStatus === "GROUP") {
      const refs = referenceRows.map((cells) => atomOf(cells, "R")).filter((ref): ref is string => ref !== null);
      if (refs.length >= 2) references.push({ ast: { op: "mean", args: refs.map((ref) => ({ op: "atom", ref })) }, label: "mean(group)" });
    } else {
      for (const cells of referenceRows.slice(0, 12)) {
        const r = atomOf(cells, "R");
        if (r !== null) references.push({ ast: { op: "atom", ref: r }, label: rowLabelOf(cells) ?? "" });
      }
    }
    for (const refEntry of references) {
      const sub: FormulaNode = { op: "atom", ref: s };
      const label = `${rowLabelOf(subjectCells) ?? ""} vs ${refEntry.label}`;
      if (family === "DIFFERENCE" || family === "PERCENT" || family === "AGGREGATE") {
        add(`absolute_difference[${label}]`, { op: pct === true ? "percentage_point_difference" : "subtract", args: [sub, refEntry.ast] }, true);
      }
      if (family === "PERCENT" || family === "AGGREGATE") add(`relative_change_percent[${label}]`, { op: "relative_change_percent", args: [sub, refEntry.ast] }, true);
      if (family === "MULTIPLE") {
        const ratio: FormulaNode = lowerIsBetter ? { op: "ratio", args: [refEntry.ast, sub] } : { op: "ratio", args: [sub, refEntry.ast] };
        add(`ratio[${label}]`, ratio, false);
        add(`ratio_minus_one[${label}]`, { op: "subtract", args: [ratio, { op: "const", value: 1 }] }, false);
      }
    }
  }
  const computed = interpretations.filter((entry) => entry.consistent !== null);
  const recompute: DerivedRecompute = {
    family, subject, reference, column, operands, interpretations: interpretations.slice(0, 40),
    // A3（M15.3.4）：操作数发现绑定的加性溯源标记；derived 不参与 inputsSha256 配方，哈希不变。
    ...(operandDiscovered ? { bindingProvenance: "operand-discovered" as const } : {}),
    allInterpretationsDisagree: computed.length === 0 ? null : computed.every((entry) => entry.consistent === false),
    anyInterpretationAgrees: computed.length === 0 ? null : computed.some((entry) => entry.consistent === true),
  };
  // 解释唯一性
  if (family === "UNKNOWN") reasons.push("DERIVED_FAMILY_UNKNOWN");
  if (family === "AGGREGATE") reasons.push("DERIVED_AGGREGATION_WEIGHTING_UNKNOWN");
  if (family === "PERCENT") {
    const relativeExplicit = /\brelative(?:ly)?\b|相对/i.test(scopes.segment);
    if (!relativeExplicit && pct !== false) reasons.push("DERIVED_PERCENT_RELATIVE_OR_ABSOLUTE_AMBIGUOUS");
  }
  if (family === "MULTIPLE" && !/\bspeed-?ups?\b|\btimes as\b|加速比/i.test(scopes.segment)) reasons.push("DERIVED_MULTIPLE_RATIO_OR_RATIO_MINUS_ONE_AMBIGUOUS");
  if (atom.qualifiers.includes("APPROX") || atom.qualifiers.includes("INEQUALITY")) reasons.push("DERIVED_APPROX_OR_INEQUALITY_QUALIFIER");
  if (table.parseIssues.length > 0) reasons.push(`TABLE_PARSE_ISSUES:${table.parseIssues.join(",")}`);
  const certifiable = reasons.length === 0 && computed.length >= 1;
  if (!certifiable) return { recompute, certifiable: false, outcome: null, reasons };
  // 解释唯一：只保留与措辞一致的那一种
  const intended = computed.filter((entry) =>
    family === "DIFFERENCE" ? entry.name.startsWith("absolute_difference")
      : family === "PERCENT" ? (/\brelative(?:ly)?\b|相对/i.test(scopes.segment) || pct === false ? entry.name.startsWith("relative_change_percent") : false)
        : family === "MULTIPLE" ? entry.name.startsWith("ratio[") : false,
  );
  if (intended.length !== 1) return { recompute, certifiable: false, outcome: null, reasons: [...reasons, "DERIVED_INTERPRETATION_NOT_UNIQUE"] };
  const chosen = intended[0]!;
  // 量级不相容 → 可证矛盾；量级相容但方向与措辞相反 / 指标极性未知 → 只记怀疑，不出「一致」证书
  if (chosen.consistent === false) return { recompute, certifiable: true, outcome: "CONTRADICTED", reasons: [] };
  if (chosen.direction === "OPPOSITE") return { recompute, certifiable: false, outcome: null, reasons: ["DERIVED_DIRECTION_OPPOSITE_TO_WORDING"] };
  if (chosen.direction === "UNKNOWN" && family !== "MULTIPLE") return { recompute, certifiable: false, outcome: null, reasons: ["DERIVED_METRIC_POLARITY_UNKNOWN"] };
  return { recompute, certifiable: true, outcome: "SUPPORTED", reasons: [] };
}

// ---- 证书 ----

export type CertificateOutcome = "CONTRADICTED" | "SUPPORTED" | "NOT_CERTIFIED";
export type ComparisonType = "SAME_OBSERVABLE" | "DIFFERENT_VARIANT" | "DERIVED" | "NOT_COMPARABLE" | "INSUFFICIENT_EVIDENCE";

export interface ClaimCertificate {
  version: typeof CLAIM_CERTIFICATE_VERSION;
  kind: "ATOMIC_COMPARISON" | "DERIVED_RECOMPUTE" | "NONE";
  outcome: CertificateOutcome;
  comparisonType: ComparisonType;
  claimAtom: CertificateAtom | null;
  counterpartAtom: CertificateAtom | null;
  binding: BindingResult | null;
  valueRelation: { relation: ValueRelation | "APPROX_WITHIN" | "APPROX_FAR"; claim: Interval; counterpart: Interval; note: string } | null;
  derived: DerivedRecompute | null;
  reasons: string[];
  /** 复算输入摘要（两侧原文切片 + 绑定表格原文 + 规则版本）：同一输入 → 同一哈希 */
  inputsSha256: string;
  provenance: { correspondenceProposedBy: "model" | "deterministic"; verifier: typeof CLAIM_CERTIFICATE_VERSION; modelCheck: string | null };
}

export interface CertifyInput {
  claim: { file: string; start: number; end: number; value?: string };
  counterpart: { file: string; start: number; end: number; value?: string } | null;
  /** 模型的核对结论（双钥匙） */
  check: "CONSISTENT" | "INCONSISTENT" | null;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * M15.2.1（N05）：证书器异常隔离兜底——certifyClaim 意外抛错时按条兜底为 NOT_CERTIFIED，
 * 不让单条论断的异常拖垮整篇账本。诊断有界：只记错误类别 + 一行消息（不含论文原文 / 模型原始输出）。
 */
export function certifierErrorCertificate(error: unknown): ClaimCertificate {
  const name = error instanceof Error ? error.constructor.name : typeof error === "object" && error !== null ? "Error" : String(error);
  const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 120) : "";
  return {
    version: CLAIM_CERTIFICATE_VERSION, kind: "NONE", outcome: "NOT_CERTIFIED", comparisonType: "INSUFFICIENT_EVIDENCE",
    claimAtom: null, counterpartAtom: null, binding: null, valueRelation: null, derived: null,
    reasons: [`CERTIFIER_ERROR:${name}${detail === "" ? "" : `:${detail}`}`],
    inputsSha256: "",
    provenance: { correspondenceProposedBy: "deterministic", verifier: CLAIM_CERTIFICATE_VERSION, modelCheck: null },
  };
}

export function certifyClaim(document: CertificateDocument, input: CertifyInput): ClaimCertificate {
  const reasons: string[] = [];
  const base = (partial: Partial<ClaimCertificate>): ClaimCertificate => {
    const claimFile = document.files.find((file) => file.file === input.claim.file);
    const counterFile = input.counterpart === null ? undefined : document.files.find((file) => file.file === input.counterpart!.file);
    const tableText = (atom: CertificateAtom | null | undefined) => {
      if (atom?.cell === undefined) return "";
      const file = document.files.find((entry) => entry.file === atom.file);
      const table = file?.tables[atom.cell.tableIndex];
      return table === undefined ? "" : file!.content.slice(table.start, table.end);
    };
    const inputs = [
      CLAIM_CERTIFICATE_VERSION,
      claimFile?.content.slice(input.claim.start, input.claim.end) ?? "",
      input.counterpart === null ? "" : counterFile?.content.slice(input.counterpart.start, input.counterpart.end) ?? "",
      input.claim.value ?? "", input.counterpart?.value ?? "", input.check ?? "",
      tableText(partial.claimAtom), tableText(partial.counterpartAtom),
      partial.binding?.bound !== undefined ? JSON.stringify(partial.binding.bound) : "",
    ].join("\u0000");
    return {
      version: CLAIM_CERTIFICATE_VERSION, kind: "NONE", outcome: "NOT_CERTIFIED", comparisonType: "INSUFFICIENT_EVIDENCE",
      claimAtom: null, counterpartAtom: null, binding: null, valueRelation: null, derived: null, reasons,
      provenance: { correspondenceProposedBy: "model", verifier: CLAIM_CERTIFICATE_VERSION, modelCheck: input.check },
      ...partial,
      inputsSha256: sha(inputs),
    };
  };
  const claimLocated = locateAtom(document, input.claim.file, input.claim.start, input.claim.end, input.claim.value);
  if (claimLocated.atom === null) {
    reasons.push(`CLAIM_${claimLocated.reason}`);
    return base({});
  }
  const claimAtom = claimLocated.atom;
  // 对照处若是论文自己制表的派生列（Improv. / Δ / Gain / Rel.），文中的派生数与该列是同一观察量（原子比较，不需要复算）
  const counterEarly = input.counterpart === null ? null : locateAtom(document, input.counterpart.file, input.counterpart.start, input.counterpart.end, input.counterpart.value).atom;
  const derivedColumn = (atom: CertificateAtom | null) => atom?.kind === "TABLE_CELL" && /\b(?:improv\w*|imp\.?|gains?|increases?|delta|rel\.?|relative|changes?)\b|Δ|\\Delta|提升|增益/i.test(atom.cell!.headerPath.join(" "));
  const tabulatedDerived = derivedColumn(counterEarly) || derivedColumn(claimAtom);
  // 派生量：不依赖模型的对照，按论断措辞复算
  const textSide = claimAtom.kind === "TEXT" ? claimAtom : null;
  if (!tabulatedDerived && textSide !== null && (textSide.qualifiers.includes("DERIVED") || textSide.qualifiers.includes("AGGREGATE") || textSide.qualifiers.includes("SIGNED"))) {
    const derived = recomputeDerived(document, textSide);
    reasons.push(...derived.reasons);
    let outcome: CertificateOutcome = "NOT_CERTIFIED";
    if (derived.certifiable && derived.outcome !== null) {
      if ((derived.outcome === "CONTRADICTED" && input.check === "INCONSISTENT") || (derived.outcome === "SUPPORTED" && input.check === "CONSISTENT")) outcome = derived.outcome;
      else reasons.push("MODEL_CHECK_DISAGREES_WITH_RECOMPUTE");
    }
    return base({ kind: "DERIVED_RECOMPUTE", outcome, comparisonType: "DERIVED", claimAtom, derived: derived.recompute, provenance: { correspondenceProposedBy: "deterministic", verifier: CLAIM_CERTIFICATE_VERSION, modelCheck: input.check } });
  }
  if (input.counterpart === null) {
    reasons.push("COUNTERPART_NOT_LOCATED");
    return base({ claimAtom });
  }
  const counterLocated = locateAtom(document, input.counterpart.file, input.counterpart.start, input.counterpart.end, input.counterpart.value);
  if (counterLocated.atom === null) {
    reasons.push(`COUNTERPART_${counterLocated.reason}`);
    return base({ claimAtom });
  }
  const counterpartAtom = counterLocated.atom;
  if (!tabulatedDerived && counterpartAtom.kind === "TEXT" && (counterpartAtom.qualifiers.includes("DERIVED") || counterpartAtom.qualifiers.includes("AGGREGATE") || counterpartAtom.qualifiers.includes("SIGNED"))) {
    reasons.push("COUNTERPART_IS_DERIVED_QUANTITY");
    return base({ claimAtom, counterpartAtom, comparisonType: "NOT_COMPARABLE" });
  }
  // 原子比较：一侧文本、一侧单元格 → 唯一绑定；两侧文本 → 两者都须唯一绑定到同一单元格；两侧单元格 → 不出证书
  let binding: BindingResult | null = null;
  let comparisonType: ComparisonType = "INSUFFICIENT_EVIDENCE";
  const textAtoms = [claimAtom, counterpartAtom].filter((atom) => atom.kind === "TEXT");
  const cellAtoms = [claimAtom, counterpartAtom].filter((atom) => atom.kind === "TABLE_CELL");
  for (const atom of textAtoms) {
    if (atom.qualifiers.includes("INEQUALITY")) reasons.push("QUALIFIER_INEQUALITY");
  }
  if (cellAtoms.length === 2) {
    const [a, b] = cellAtoms as [CertificateAtom, CertificateAtom];
    if (a.cell!.tableId === b.cell!.tableId && a.cell!.row === b.cell!.row && a.cell!.col === b.cell!.col) comparisonType = "SAME_OBSERVABLE";
    else {
      reasons.push("CELL_CELL_CORRESPONDENCE_NOT_CERTIFIABLE");
      comparisonType = "NOT_COMPARABLE";
    }
  } else if (cellAtoms.length === 1) {
    const text = textAtoms[0]!;
    const cell = cellAtoms[0]!;
    binding = bindTextAtom(document, text);
    if (binding.status === "UNIQUE" && binding.bound !== undefined) {
      const same = binding.bound.file === cell.file && binding.bound.tableId === cell.cell!.tableId && binding.bound.row === cell.cell!.row && binding.bound.col === cell.cell!.col;
      if (same) comparisonType = "SAME_OBSERVABLE";
      else {
        comparisonType = "DIFFERENT_VARIANT";
        reasons.push("PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING");
      }
    } else {
      reasons.push(`BINDING_${binding.status}:${binding.rule}`, ...binding.rejections.slice(0, 6));
    }
  } else {
    const [a, b] = textAtoms as [CertificateAtom, CertificateAtom];
    const bindA = bindTextAtom(document, a);
    const bindB = bindTextAtom(document, b);
    binding = bindA;
    if (bindA.status === "UNIQUE" && bindB.status === "UNIQUE" && JSON.stringify(bindA.bound) === JSON.stringify(bindB.bound)) comparisonType = "SAME_OBSERVABLE";
    else reasons.push(`TEXT_TEXT_NO_COMMON_UNIQUE_BINDING:${bindA.status}/${bindB.status}`);
  }
  const relation = compareAtoms(claimAtom, counterpartAtom);
  let valueRelation: ClaimCertificate["valueRelation"] = { relation: relation.relation, claim: relation.a, counterpart: relation.b, note: relation.note };
  const approx = textAtoms.some((atom) => atom.qualifiers.includes("APPROX"));
  if (approx && relation.relation !== "UNIT_MISMATCH" && relation.relation !== "SCALE_AMBIGUOUS") {
    const mid = (interval: Interval) => (interval.lo + interval.hi) / 2;
    const ratio = Math.max(mid(relation.a), mid(relation.b)) / Math.max(1e-12, Math.min(Math.abs(mid(relation.a)), Math.abs(mid(relation.b))));
    valueRelation = { ...valueRelation, relation: ratio >= 2 ? "APPROX_FAR" : "APPROX_WITHIN", note: `约数限定：两数相差 ${ratio.toFixed(2)} 倍（≥2 倍才可证矛盾，APPROX_FACTOR_2）` };
  }
  let outcome: CertificateOutcome = "NOT_CERTIFIED";
  if (comparisonType === "SAME_OBSERVABLE" && reasons.length === 0) {
    const r = valueRelation.relation;
    const contradicted = r === "DISJOINT" || r === "APPROX_FAR";
    const supported = r === "OVERLAP";
    if (r === "SCALE_AMBIGUOUS") reasons.push("SCALE_AMBIGUOUS");
    else if (r === "UNIT_MISMATCH") reasons.push("UNIT_MISMATCH");
    else if (r === "APPROX_WITHIN") reasons.push("APPROX_QUALIFIER_NOT_CERTIFIABLE");
    else if (contradicted && input.check === "INCONSISTENT") outcome = "CONTRADICTED";
    else if (supported && input.check === "CONSISTENT") outcome = "SUPPORTED";
    else reasons.push("MODEL_CHECK_DISAGREES_WITH_VALUES");
  }
  return base({ kind: "ATOMIC_COMPARISON", outcome, comparisonType, claimAtom, counterpartAtom, binding, valueRelation });
}

/** 证书紧凑摘要（账本 / 报告） */
export function summarizeCertificate(certificate: ClaimCertificate) {
  return {
    version: certificate.version,
    kind: certificate.kind,
    outcome: certificate.outcome,
    comparisonType: certificate.comparisonType,
    reasons: certificate.reasons.slice(0, 8),
    binding: certificate.binding === null ? null : { status: certificate.binding.status, rule: certificate.binding.rule, bound: certificate.binding.bound ?? null, candidates: certificate.binding.candidates.length },
    derived: certificate.derived === null ? null : {
      family: certificate.derived.family, subject: certificate.derived.subject.status, reference: certificate.derived.reference.status,
      allInterpretationsDisagree: certificate.derived.allInterpretationsDisagree, anyInterpretationAgrees: certificate.derived.anyInterpretationAgrees,
      interpretations: certificate.derived.interpretations.slice(0, 6).map((entry) => ({ name: entry.name, value: entry.value, consistent: entry.consistent })),
    },
    inputsSha256: certificate.inputsSha256,
  };
}
