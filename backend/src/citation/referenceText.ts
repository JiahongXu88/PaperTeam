/**
 * 参考文献文本归一化（Citation Verification 唯一的文本清洗 seam）。
 *
 * PDF 文本层常见污染：行尾断词连字符（"asso-\nciation" / 已被拍平成 "asso- ciation"）、
 * 软连字符 U+00AD、不换行空格、Unicode 连字符变体、多余空白。这些会让 provider
 * 检索与标题比对同时失效——真实存在的文献被判 NOT_FOUND。
 *
 * 纪律：
 * - 断行连字符不能靠 heuristic 决定原词是 "ByteTrack" 还是 "multi-object"：
 *   有行边界信息时把它编码为软连字符 U+00AD（Unicode 里"可选连字符"的本义——
 *   渲染时不可见、比对时忽略、检索时展开为 "Bytetrack" / "Byte-track" 两个 variant），
 *   不猜原词；已拍平的 "word- word" 同样在检索期展开，不改写存储标题；
 * - 合法复合词连字符（multi-object / OC-SORT / real-time）不被删除；
 * - 标题比对用 canonical / compact 形式：大小写、标点、连字符、空白差异不影响相等。
 */

/** 归一化算法版本：变更即让旧核验记录失效（纳入 cache fingerprint） */
export const REFERENCE_NORMALIZATION_VERSION = 2;

const SOFT_HYPHEN = /\u00AD/g;
/** 各类空白（含 NBSP / 全角空格 / 零宽空格）→ ASCII 空格 */
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g;
/** 连字符变体（hyphen / non-breaking hyphen / figure dash / minus）→ ASCII 连字符 */
const HYPHEN_VARIANTS = /[\u2010\u2011\u2012\u2212]/g;

/** 断词标记：行尾连字符在 PDF 文本层的本义就是 Unicode 软连字符（可选连字符） */
export const HYPHENATION_MARKER = "\u00AD";

/**
 * 行边界仍在时的断词修复："word-\nword" → "word\u00ADword"（软连字符标记）。
 * 只处理连字符后紧跟换行（允许多个换行——pymupdf 会把跨列/跨页的一行拆成两个 block）
 * 且下一行以小写字母开头的情形；下一行大写（新条目 / 专名）不动。
 */
export function repairLineBreakHyphenation(text: string): string {
  return text.replace(/(\p{L})-[ \t]*\n+[ \t]*(\p{Ll})/gu, `$1${HYPHENATION_MARKER}$2`);
}

/** 去掉断词标记（展示 / 纯文本导出用）："Byte\u00ADtrack" → "Bytetrack" */
export function stripHyphenationMarkers(text: string): string {
  return text.replace(SOFT_HYPHEN, "");
}

/**
 * 参考文献条目文本归一化（Unicode NFC、来源软连字符移除、空白折叠、连字符变体统一、
 * 断行连字符 → 软连字符标记）。来源里的软连字符先移除，之后出现的 U+00AD 只可能是
 * 本函数标记的断词位置。输出仍是"如实"的条目文本：不删真实连字符、不猜原词。
 */
export function normalizeReferenceText(text: string): string {
  return repairLineBreakHyphenation(
    text.normalize("NFC").replace(SOFT_HYPHEN, "").replace(EXOTIC_SPACES, " ").replace(HYPHEN_VARIANTS, "-"),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** 已拍平的断词形态："as- sociation"（连字符 + 空格 + 小写续词；旧提取结果 / 其它解析器） */
const FLATTENED_HYPHEN_BREAK = /(\p{L})- (\p{Ll})/gu;

/** 标题是否带断词不确定性（软连字符标记或已拍平形态） */
export function hasHyphenationArtifact(text: string): boolean {
  return text.includes(HYPHENATION_MARKER) || new RegExp(FLATTENED_HYPHEN_BREAK.source, "u").test(text);
}

/**
 * 标题检索 query variants（去重、按命中概率排序）：
 *   1. 断词直接拼合（"Byte\u00ADtrack" / "Byte- track" → "Bytetrack"）——原词为单词时
 *      唯一能命中检索 token 的形式；
 *   2. 保留连字符（"Byte-track"）——原词为复合词时的形式，检索引擎按连字符分词；
 *   3. 已拍平的原文（只有拍平输入才有第三条）。
 * 无断词痕迹时只返回原文一条。
 */
export function titleQueryVariants(title: string): string[] {
  const base = title.normalize("NFC").replace(EXOTIC_SPACES, " ").replace(HYPHEN_VARIANTS, "-").replace(/\s+/g, " ").trim();
  if (base === "") {
    return [];
  }
  if (!hasHyphenationArtifact(base)) {
    return [base];
  }
  const marked = base.replace(FLATTENED_HYPHEN_BREAK, `$1${HYPHENATION_MARKER}$2`);
  const joined = marked.replace(SOFT_HYPHEN, "");
  const hyphenated = marked.replace(SOFT_HYPHEN, "-");
  return dedupe(base.includes(HYPHENATION_MARKER) ? [joined, hyphenated] : [joined, hyphenated, base]);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// ---- 标题 canonical 形式 ----

/**
 * 标题 canonical token 序列：NFKC + 小写 + 软连字符移除 + 标点/连字符/破折号 → 空格 +
 * 空白折叠 + 去首冠词。保序（不是 bag-of-words）。
 */
export function canonicalTitleTokens(title: string): string[] {
  const tokens = title
    .normalize("NFKC")
    .replace(SOFT_HYPHEN, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length > 1 && (tokens[0] === "a" || tokens[0] === "an" || tokens[0] === "the")) {
    return tokens.slice(1);
  }
  return tokens;
}

/** 空格化 canonical 标题（"Multi-Object Tracking" → "multi object tracking"） */
export function canonicalTitle(title: string): string {
  return canonicalTitleTokens(title).join(" ");
}

/**
 * 紧凑形式：去掉全部分隔——"Byte- track" / "Byte-track" / "ByteTrack" 完全相同，
 * "Multi-Object" / "Multi Object" 也相同。用于断词/连字符/空白不敏感的相等判定。
 */
export function compactTitle(title: string): string {
  return canonicalTitleTokens(title).join("");
}

/**
 * 标题相似度 [0,1]：紧凑形式相等 → 1；否则紧凑形式的归一化编辑距离相似度
 * （1 - levenshtein / maxLen）。保序、逐字符，"Attention Is All You Need" 与
 * "Attention Is Almost All You Need Probably" 只有 ~0.6；SORT 与 Deep SORT ~0.55。
 */
export function titleSimilarity(left: string, right: string): number {
  const a = compactTitle(left);
  const b = compactTitle(right);
  if (a === "" || b === "") {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const distance = levenshtein(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}
