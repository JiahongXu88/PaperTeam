/**
 * Named Reference Provenance Guard（M13 Final Closure，A2）：修订是否引入了证据池 /
 * 参考文献 / 修订前稿件都不存在的**具名文献、作者、系统或实体名**。
 *
 * 真实样本（M13.7.11 §5.4 / §10-5）：academic reviewer 的 finding 点名「2021 Krinner 等
 * 阈值实验」「早期重复码演示」（不在任何 Evidence 中），修订 Writer 据此把「未覆盖阈值实验、
 * 早期重复码演示等奠基性工作」写进摘要限制句；下一轮 fact reviewer 判其与正文自相矛盾。
 * 既有守卫（数字 / 表格 / 公式 / 方向 / cite key）对「无数字、无 \cite 的具名文献提及」全部
 * 失明。本模块补上这一类，但只做**高置信**的词面判定：
 *
 * - 拉丁字母具名词（首字母大写 ≥ 3 字符、内部大小写混排如 ByteTrack、全大写缩写如 GKP）
 *   在 CJK 主导的稿件里几乎只可能是人名 / 机构 / 模型 / 系统名；英文稿件只认
 *   「作者引用形态」（Krinner et al. / Krinner 等 / Krinner (2021)）、内部混排与全大写缩写，
 *   不认普通首字母大写（句首词、专有名词以外的大写会造成误报）。
 * - 允许词表 = 修订前全部稿件文本 + 证据记录文本（claim / quote / summary / 标题 / 作者）+
 *   参考文献条目（key / 标题）。**审稿意见与修订计划文本不在允许词表内**——那正是污染通道。
 * - 命中 = 修订后新出现、且不在允许词表中的具名词。输出带上下文片段供人读与修复 prompt。
 *
 * 不做的事：不判断中文具名（「张等人的实验」在非中文作者语境罕见，误报代价高）；不把
 * 常见 LaTeX / 结构词（Figure / Table / Section…）当具名词；不猜词义。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";

export type NamedReferenceKind = "cited_author" | "latin_name";

export interface IntroducedNamedReference {
  term: string;
  kind: NamedReferenceKind;
  /** 修订后文本中的原始形态（首次出现） */
  surface: string;
  /** 上下文片段（≤ 120 字符） */
  context: string;
}

/** 结构词 / LaTeX 常见大写词：不是具名实体 */
const STOP_TERMS: ReadonlySet<string> = new Set(
  [
    "figure", "figures", "fig", "table", "tables", "section", "sections", "equation", "eq", "appendix",
    "algorithm", "algorithms", "abstract", "introduction", "conclusion", "conclusions", "method", "methods",
    "results", "discussion", "related", "work", "background", "references", "acknowledgments", "appendices",
    "note", "see", "the", "this", "that", "these", "those", "however", "moreover", "therefore", "thus",
    "first", "second", "third", "finally", "although", "while", "when", "where", "which", "what", "who",
    "chapter", "part", "step", "case", "example", "theorem", "lemma", "proof", "definition", "remark",
    "latex", "tex", "pdf", "json", "xml", "html", "url", "doi", "arxiv", "ieee", "acm", "springer",
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december",
  ],
);

/** 去掉 LaTeX 命令与其参数（\cite{...} / \ref{...} / \label{...} / \begin{...} 等），避免把 key 当成具名词 */
function stripLatex(text: string): string {
  return text
    .replace(/\\(?:cite[tp]?\*?|citeauthor|citeyear|ref|eqref|label|begin|end|input|include|includegraphics|bibliography|bibliographystyle|url|href)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/%[^\n]*/g, " ");
}

function isCjkDominant(text: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjk += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
    }
  }
  return cjk > 0 && cjk >= latin * 0.6;
}

/** 词形归一：小写 + 去所有格 / 复数尾 s（Transformers ≡ Transformer；Krinner's ≡ Krinner） */
export function normalizeNamedTerm(surface: string): string {
  let term = surface.normalize("NFKC").toLowerCase().replace(/['’]s$/u, "");
  if (term.length > 4 && term.endsWith("s") && !term.endsWith("ss")) {
    term = term.slice(0, -1);
  }
  return term;
}

const LATIN_WORD = /\p{L}[\p{L}\d'’-]*/gu;
const AUTHOR_FORM_TAIL = /^\s*(?:等|et\s+al\.?|\(\s*(?:19|20)\d{2}|（\s*(?:19|20)\d{2}|,\s*(?:19|20)\d{2}\b|\s(?:19|20)\d{2}\b)/u;

/**
 * 提取文本中的具名词（归一化词 → 首个 surface + 上下文 + kind）。
 * cjkDominant 可显式传入（允许词表与修订文本应共用修订文本的判定，不各算各的）。
 */
export function extractNamedReferenceTerms(
  text: string,
  options: { cjkDominant?: boolean } = {},
): Map<string, { surface: string; context: string; kind: NamedReferenceKind }> {
  const cleaned = stripLatex(text.normalize("NFKC"));
  const cjkDominant = options.cjkDominant ?? isCjkDominant(cleaned);
  const found = new Map<string, { surface: string; context: string; kind: NamedReferenceKind }>();
  let match: RegExpExecArray | null;
  LATIN_WORD.lastIndex = 0;
  while ((match = LATIN_WORD.exec(cleaned)) !== null) {
    const surface = match[0]!.replace(/^[-'’]+|[-'’]+$/gu, "");
    if (surface.length < 2) {
      continue;
    }
    const first = surface.charAt(0);
    if (first.toUpperCase() !== first || first.toLowerCase() === first) {
      continue; // 不以大写字母开头
    }
    if (!/^[A-Za-z]/.test(first)) {
      continue; // 非拉丁字母（如希腊字母）不在本守卫范围
    }
    const normalized = normalizeNamedTerm(surface);
    if (normalized.length < 2 || STOP_TERMS.has(normalized) || /^\d/.test(normalized)) {
      continue;
    }
    const tail = cleaned.slice(match.index + match[0]!.length, match.index + match[0]!.length + 12);
    const authorForm = AUTHOR_FORM_TAIL.test(tail);
    const internalCaps = /^[A-Z][a-z0-9]*[A-Z]/.test(surface) || /^[A-Z]{3,}[a-z0-9]*$/.test(surface) || /^[A-Z][a-z]+\d+[A-Za-z]*$/.test(surface);
    const bareCapitalized = surface.length >= 3 && /^[A-Z][a-z]+(?:-[A-Za-z]+)*$/.test(surface);
    // 句首普通大写词（英文稿件）：前一个非空白字符是句末标点或文本开头
    const before = cleaned.slice(Math.max(0, match.index - 3), match.index).trimEnd();
    const sentenceInitial = before === "" || /[.!?;:。！？；：]$/.test(before);
    let kind: NamedReferenceKind | null = null;
    if (authorForm) {
      kind = "cited_author";
    } else if (internalCaps) {
      kind = "latin_name";
    } else if (bareCapitalized && (cjkDominant || !sentenceInitial)) {
      // 英文稿件里非句首的首字母大写词仍可能是普通名词的强调；只在 CJK 主导时认，
      // 或在英文稿件里要求非句首 + 后接年份 / 等 已由 authorForm 覆盖——这里英文稿件保守跳过
      kind = cjkDominant ? "latin_name" : null;
    }
    if (kind === null) {
      continue;
    }
    if (!found.has(normalized)) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(cleaned.length, match.index + surface.length + 40);
      found.set(normalized, { surface, context: cleaned.slice(start, end).replace(/\s+/g, " ").trim(), kind });
    } else if (kind === "cited_author" && found.get(normalized)!.kind !== "cited_author") {
      found.get(normalized)!.kind = "cited_author";
    }
  }
  return found;
}

/** 允许词表 token（归一化具名词 + 全部拉丁词形，宽口径——允许侧宁可多认） */
function allowedTermSet(texts: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of texts) {
    const cleaned = text.normalize("NFKC");
    LATIN_WORD.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LATIN_WORD.exec(cleaned)) !== null) {
      const normalized = normalizeNamedTerm(match[0]!.replace(/^[-'’]+|[-'’]+$/gu, ""));
      if (normalized !== "") {
        allowed.add(normalized);
      }
    }
  }
  return allowed;
}

/** 证据记录 + 参考文献 → 允许文本（claim / quote / summary / 标题 / 作者 / key） */
export function buildReferenceVocabulary(params: {
  evidence: readonly EvidenceRecord[];
  bibEntries?: readonly { key: string; title?: string; authors?: readonly string[] | string }[];
  extraTexts?: readonly string[];
}): string[] {
  const texts: string[] = [];
  for (const record of params.evidence) {
    texts.push(record.claim, record.quote ?? "", record.summary ?? "", record.source?.title ?? "");
    const authors = record.source?.authors;
    if (Array.isArray(authors)) {
      texts.push(authors.join(" "));
    } else if (typeof authors === "string") {
      texts.push(authors);
    }
  }
  for (const entry of params.bibEntries ?? []) {
    texts.push(entry.key.replace(/[^A-Za-z]+/g, " "), entry.title ?? "");
    if (Array.isArray(entry.authors)) {
      texts.push(entry.authors.join(" "));
    } else if (typeof entry.authors === "string") {
      texts.push(entry.authors);
    }
  }
  texts.push(...(params.extraTexts ?? []));
  return texts.filter((text) => text.trim() !== "");
}

/**
 * 修订后文本相对修订前新引入、且不在允许词表中的具名词（确定性；按首次出现顺序）。
 */
export function findIntroducedNamedReferences(params: {
  before: string;
  after: string;
  allowedTexts: readonly string[];
}): IntroducedNamedReference[] {
  const cjkDominant = isCjkDominant(stripLatex(params.after.normalize("NFKC")));
  const afterTerms = extractNamedReferenceTerms(params.after, { cjkDominant });
  if (afterTerms.size === 0) {
    return [];
  }
  const allowed = allowedTermSet([params.before, ...params.allowedTexts]);
  const introduced: IntroducedNamedReference[] = [];
  for (const [term, info] of afterTerms) {
    if (allowed.has(term)) {
      continue;
    }
    introduced.push({ term, kind: info.kind, surface: info.surface, context: info.context.slice(0, 120) });
  }
  return introduced;
}

/** 人读 / 修复 prompt 用的一行描述 */
export function describeIntroducedNamedReferences(entries: readonly IntroducedNamedReference[]): string {
  return entries
    .slice(0, 6)
    .map((entry) => `「${entry.surface}」（${entry.kind === "cited_author" ? "作者引用形态" : "具名实体"}；…${entry.context}…）`)
    .join("；");
}
