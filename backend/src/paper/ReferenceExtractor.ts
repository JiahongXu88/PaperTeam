/**
 * Reference / Citation Callout 提取。
 *
 * 从解析产物（非模型、确定性）提取：
 *   ReferenceEntry —— References 章节条目（numeric [n] 分割为主，
 *                     block 兜底；title/authors/year/venue/doi/arXiv best-effort）
 *   CitationCallout —— 正文引用标记：[1] / [2,3] / [4-7]（range 展开为
 *                     多条 relation）+ author-year best-effort
 *
 * 纪律：
 * - 关联不上就标 unresolved / invalid——绝不猜；
 * - [4-7] 展开成 4 条 reference relation，不是字符串；
 * - 全部 provenance（page / sectionId / chunkId）回链。
 */

import { sha256Hex } from "../util/hash.js";
import type { CitationCallout, ReferenceEntry } from "../citation/integrity.js";
import { REFERENCE_NORMALIZATION_VERSION, normalizeReferenceText } from "../citation/referenceText.js";
import type { PaperChunk, PaperDocument } from "./types.js";

/**
 * 提取算法版本（纳入 references stage 指纹）：条目切分 / 文本归一化 / 字段解析
 * 任一变化就递增，让旧提取结果在下次 extract 时自动重算。
 * v3：callout 保留原始标记 rawText（citation group 信息不丢失——[35, 2, 5] 是
 * 一个组，不再是三条失去组归属的独立 relation）。
 * v4（M15.16）：出版年解析剔除 DOI / arXiv id / URL 标识符 span——标识符内的
 * 年形数字（arXiv 2004.10934 → "2004"）不再是出版年（P0-B 年份口径严谨性）。
 */
export const REFERENCE_EXTRACTION_VERSION = `v4.n${REFERENCE_NORMALIZATION_VERSION}`;

/** range 展开上限（防 [1-999] 之类解析事故） */
const RANGE_EXPAND_LIMIT = 60;

/** sentence 上下文半径（contextBefore/After） */
const CONTEXT_CHARS = 120;

/**
 * References 节内不是条目的单元（页级 section 归属的代价：同页图注/页眉/页码/
 * 作者简介块会落进参考文献 chunk）。CJK 期刊版式实测形态。
 */
const NON_ENTRY_UNIT =
  /^(?:[图表]\s*\d+|Fig\.?\s*\d+|Tab\.?\s+\d+|Figure\s+\d+|Table\s+\d+|作者简介|基金项目|通信作者|资助信息|Vol\.?\s*\d+|\d{1,4}$)/;

/** 页眉变体：CJK 作者名开头 + 行内含「第N卷/期」签名（如 CJIG 页眉「胡明娣，…
第27 卷／第5 期…」） */
function isNonEntryUnit(text: string): boolean {
  return NON_ENTRY_UNIT.test(text) || (text.length < 120 && /第\s*\d+\s*[卷期]/.test(text));
}

/**
 * author-year 条目起点（CJIG 实测：`Baek Y，` / `Alexandrov S V,` / `Child R,`）：
 * 大写姓氏词（含 PUA 字形替身与撇号连字符）后跟 1~3 个单字母缩写 + 逗号（全/半角）。
 * 续行（小写开头 / 出版地 / 页码 / DOI）不命中。
 */
const AUTHOR_YEAR_ENTRY_START =
  /^(?:(?:van|von|de|del|der|den|di|da|dos|do|du|la|le|el|al|bin|ibn|mac|mc)\s+)?\p{Lu}[\p{L}\p{M}'’\--]*(?:\s+\p{Lu}\.?){1,3}(?:\s*[，,.．]|\s+and\s+|\s+(?=(?:19|20)\d{2}))/u;

/**
 * author-year 条目终止符（CJIG 实测条目都以之收尾）：DOI/文献标识全/半角方括号、
 * URL（.pdf/.html 等）、页码区间（可带句点）、或全/半角右括号（双语条目的中文括注收尾）。长作者列表跨行换行的续行虽然也以
 * 「姓氏+缩写」开头，但上一行不以终止符收尾——据此区分真条目边界与作者换行。
 */
const AUTHOR_YEAR_ENTRY_END =
  /(?:[］\]]|[）)](?:\s*[．.;,;])?|pdf\b|html?\b|https?\s*[：:]\/\/\S*|\d{1,4}\s*[-–—]\s*\d{1,4}\s*[.．]?|[,，]\s*\d{1,3}$)\s*$/i;

export interface ExtractionResult {
  references: ReferenceEntry[];
  callouts: CitationCallout[];
  notes: string[];
}

/** extract 的结构化输入（M15.16：AssembledPaper 与 PaperDocument 都满足——只消费这两个字段） */
export type ReferenceExtractionDocument = Pick<PaperDocument, "referencesSectionId" | "chunks">;

export class ReferenceExtractor {
  extract(document: ReferenceExtractionDocument): ExtractionResult {
    const referencesSectionId = document.referencesSectionId;
    const notes: string[] = [];
    const bodyChunks = document.chunks.filter(
      (chunk) => referencesSectionId === undefined || chunk.sectionId !== referencesSectionId,
    );
    const referenceChunks =
      referencesSectionId === undefined
        ? []
        : document.chunks.filter((chunk) => chunk.sectionId === referencesSectionId);

    if (referencesSectionId === undefined) {
      notes.push("未识别到 References 章节（条目为空；正文标记仍提取）");
    }

    const references = this.extractReferences(referenceChunks, notes);
    const callouts = this.extractCallouts(bodyChunks, references, notes);
    return { references, callouts, notes };
  }

  // ---- References 条目 ----

  /** chunk text 由 block 以 \n\n 连接——先还原 block 单元，再按 [n] 归并 */
  private extractReferences(chunks: PaperChunk[], notes: string[]): ReferenceEntry[] {
    const sectionId = chunks[0]?.sectionId ?? "";
    const units: Array<{ page: number; chunkId: string; text: string }> = [];
    for (const chunk of chunks) {
      // 归一化必须在按 \n\n 切单元之前：pymupdf 会把跨列/跨页的一行拆成两个 block
      // （"Byte-\n\ntrack"），切完再修就只剩 "Byte- track"。断词只去换行、保留连字符，
      // 不猜原词是 ByteTrack 还是 multi-object——检索期由 query variants 处理
      for (const part of normalizeReferenceText(chunk.text).split(/\n{2,}/)) {
        const text = part.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        if (text !== "" && !isNonEntryUnit(text)) {
          units.push({ page: chunk.pageStart, chunkId: chunk.chunkId, text });
        }
      }
    }
    if (units.length === 0) {
      return [];
    }

    // numeric 模式：以 [n] 开头的单元为条目起点；无标记的续行单元并入上一条
    const numericHead = /^\[(\d{1,3})\]\s*/;
    const hasNumeric = units.some((unit) => numericHead.test(unit.text));
    if (hasNumeric) {
      return this.collectNumeric(units, numericHead, sectionId, notes);
    }
    return this.collectAuthorYear(units, sectionId, notes);
  }

  private collectNumeric(
    units: Array<{ page: number; chunkId: string; text: string }>,
    numericHead: RegExp,
    sectionId: string,
    notes: string[],
  ): ReferenceEntry[] {
    const collected: Array<{ number?: number; text: string; page: number; chunkId: string }> = [];
    let sawNumeric = false;
    for (const unit of units) {
      const match = numericHead.exec(unit.text);
      if (match !== null) {
        sawNumeric = true;
        collected.push({
          number: Number.parseInt(match[1] ?? "0", 10),
          text: unit.text.slice(match[0].length).trim(),
          page: unit.page,
          chunkId: unit.chunkId,
        });
        continue;
      }
      if (sawNumeric && collected.length > 0) {
        const last = collected[collected.length - 1]!;
        last.text = `${last.text} ${unit.text}`.trim();
        continue;
      }
      if (!sawNumeric) {
        collected.push({ text: unit.text, page: unit.page, chunkId: unit.chunkId });
      }
    }
    if (!sawNumeric) {
      notes.push("References 无 [n] 编号（author-year 风格：按 block 单元切分，字段提取 best-effort）");
    } else {
      // section 边界是页级的：References 标题常在页中，标题前的正文块
      // （上一章结尾）不是参考文献——丢弃首个 [n] 条目之前的全部单元
      const firstNumeric = collected.findIndex((entry) => entry.number !== undefined);
      if (firstNumeric > 0) {
        collected.splice(0, firstNumeric);
      }
    }

    return collected.map((entry, index) => toReferenceEntry(entry, index, sectionId));
  }

  /**
   * author-year 无编号条目（CJIG 实测版式：`Surname X， Surname Y and Surname Z. 2019.
   * Title//Venue…`）。每个视觉行是独立 block：以「大写姓氏 + 1~3 个单字母缩写 + 逗号」
   * 行首作为条目起点合并续行；首个条目起点之前的单元（同页正文结尾/页眉）丢弃。
   */
  private collectAuthorYear(
    units: Array<{ page: number; chunkId: string; text: string }>,
    sectionId: string,
    notes: string[],
  ): ReferenceEntry[] {
    const collected: Array<{ text: string; page: number; chunkId: string }> = [];
    for (const unit of units) {
      const last = collected[collected.length - 1];
      const terminated = last !== undefined && AUTHOR_YEAR_ENTRY_END.test(last.text);
      if (AUTHOR_YEAR_ENTRY_START.test(unit.text) && (last === undefined || terminated)) {
        collected.push({ text: unit.text, page: unit.page, chunkId: unit.chunkId });
        continue;
      }
      if (last !== undefined) {
        last.text = `${last.text} ${unit.text}`.trim();
      }
      // 首个条目起点之前的单元（同页正文结尾/页眉）丢弃
    }
    if (collected.length > 0) {
      notes.push("References 无 [n] 编号（author-year 风格：按作者行首合并条目，字段提取 best-effort）");
    }
    return collected.map((entry, index) => toReferenceEntry(entry, index, sectionId));
  }

  // ---- 正文引用标记 ----

  private extractCallouts(
    bodyChunks: PaperChunk[],
    references: ReferenceEntry[],
    notes: string[],
  ): CitationCallout[] {
    const byNumber = new Map<number, ReferenceEntry>();
    for (const reference of references) {
      if (reference.number !== undefined && !byNumber.has(reference.number)) {
        byNumber.set(reference.number, reference);
      }
    }
    const callouts: CitationCallout[] = [];
    const maxReferenceNumber = references.reduce(
      (max, reference) => (reference.number !== undefined ? Math.max(max, reference.number) : max),
      0,
    );
    for (const chunk of bodyChunks) {
      const text = chunk.text;
      // numeric：[1] / [2,3] / [4-7] / [2,3,5-7]（含 en-dash）
      const numericPattern = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g;
      for (const match of text.matchAll(numericPattern)) {
        const inner = match[1] ?? "";
        const expanded = expandNumericList(inner);
        if (expanded.length === 0) {
          continue;
        }
        const relations = expanded.map((label) => {
          const reference = byNumber.get(label);
          if (reference === undefined) {
            // 无条目可关联：编号超出 References 最大编号 → invalid（明显无效数字）；
            // 在编号范围内的空缺 → unresolved（不猜）。完全没有条目时一律 unresolved。
            return {
              label: String(label),
              status:
                maxReferenceNumber > 0 && label > maxReferenceNumber
                  ? ("invalid" as const)
                  : ("unresolved" as const),
            };
          }
          return { label: String(label), referenceId: reference.referenceId, status: "resolved" as const };
        });
        const sentence = sentenceAround(text, match.index ?? 0, (match[0] ?? "").length);
        callouts.push({
          citationId: `CT${String(callouts.length + 1).padStart(3, "0")}`,
          style: "numeric",
          references: relations,
          rawText: match[0] ?? "",
          page: chunk.pageStart,
          sectionId: chunk.sectionId,
          chunkId: chunk.chunkId,
          sentence: sentence.sentence,
          ...(sentence.before !== "" ? { contextBefore: sentence.before } : {}),
          ...(sentence.after !== "" ? { contextAfter: sentence.after } : ""),
        });
      }
      // author-year：(Surname, 2017) / (Surname et al., 2017) / (Surname and Other, 2017)
      const authorYearPattern =
        /\(([A-Z][A-Za-z'’-]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][A-Za-z'’-]+))?),?\s*((?:19|20)\d{2}[a-z]?)\)/g;
      for (const match of text.matchAll(authorYearPattern)) {
        const label = `${match[1] ?? ""}, ${match[2] ?? ""}`;
        const relations = resolveAuthorYear(label, references);
        const sentence = sentenceAround(text, match.index ?? 0, (match[0] ?? "").length);
        callouts.push({
          citationId: `CT${String(callouts.length + 1).padStart(3, "0")}`,
          style: "author-year",
          references: relations,
          rawText: match[0] ?? "",
          page: chunk.pageStart,
          sectionId: chunk.sectionId,
          chunkId: chunk.chunkId,
          sentence: sentence.sentence,
          ...(sentence.before !== "" ? { contextBefore: sentence.before } : {}),
          ...(sentence.after !== "" ? { contextAfter: sentence.after } : {}),
        });
      }
      // 中文 author-year（CJK 期刊正文实测）：`Liao等人（2020）` / `Islam 等人(2017)` / `李四等（2020）`
      // 全/半角括号都认；姓名可为拉丁或 ≤4 字汉字，必须带 等/等人/et al. 标记（降误报）
      const cjkAuthorYearPattern =
        /(\p{Script=Latin}[\p{Script=Latin}'’\-]*|\p{Script=Han}{1,4})\s*(?:等\s*人?|et\s+al\.?)\s*[（(]\s*((?:19|20)\d{2}[a-z]?)\s*[)）]/gu;
      for (const match of text.matchAll(cjkAuthorYearPattern)) {
        const label = `${match[1] ?? ""}, ${match[2] ?? ""}`;
        const relations = resolveAuthorYear(label, references);
        const sentence = sentenceAround(text, match.index ?? 0, (match[0] ?? "").length);
        callouts.push({
          citationId: `CT${String(callouts.length + 1).padStart(3, "0")}`,
          style: "author-year",
          references: relations,
          rawText: match[0] ?? "",
          page: chunk.pageStart,
          sectionId: chunk.sectionId,
          chunkId: chunk.chunkId,
          sentence: sentence.sentence,
          ...(sentence.before !== "" ? { contextBefore: sentence.before } : {}),
          ...(sentence.after !== "" ? { contextAfter: sentence.after } : {}),
        });
      }
    }
    if (callouts.length === 0 && bodyChunks.length > 0) {
      notes.push("正文未提取到引用标记（可能是纯 author-year 或无引用）");
    }
    return callouts;
  }
}

// ---- 条目字段 best-effort 提取 ----

function toReferenceEntry(
  entry: { number?: number; text: string; page: number; chunkId: string },
  index: number,
  sectionId: string,
): ReferenceEntry {
  const rawText = entry.number !== undefined ? `[${entry.number}] ${entry.text}` : entry.text;
  const fields = parseReferenceFields(entry.text);
  return {
    referenceId: `R${String(index + 1).padStart(3, "0")}`,
    ...(entry.number !== undefined ? { number: entry.number } : {}),
    rawText,
    ...fields,
    page: entry.page,
    sectionId,
    ...(entry.chunkId !== "" ? { chunkId: entry.chunkId } : {}),
    fingerprint: sha256Hex(rawText),
  };
}

/** title/year/doi/arxiv/authors/venue best-effort（解析失败的字段留空，不猜） */
export function parseReferenceFields(text: string): Partial<ReferenceEntry> {
  const out: Partial<ReferenceEntry> = {};
  // 印刷空格修复（CJIG 版式实测：DOI/URL 内被排成 "10. 1007 / 978-…"、"https:/ / arxiv. org/ …"）
  const identifiers = despaceIdentifierSpans(text);

  const doiMatch = /(?:doi:|https?:\/\/doi\.org\/|DOI:\s*)?(10\.\d{4,9}\/[^\s"<>[\]]+)/i.exec(identifiers);
  if (doiMatch !== null) {
    out.doi = normalizeDoi(doiMatch[1] ?? "");
  }

  const arxivMatch =
    /arxiv(?:\.org)?[/:\s]*(?:abs|pdf)?\/?\s*(\d{4}\.\d{4,5})(v\d+)?/i.exec(identifiers);
  if (arxivMatch !== null) {
    out.arxivId = arxivMatch[1] ?? "";
  }

  // 出版年：在剔除标识符 span 后的文本上取最后一个年形数字（M15.16：arXiv
  // 2004.10934 / DOI 10.1109/...2016.98 内的年形数字不是出版年——先剥离再取）
  const yearsText = identifiers
    .replace(/10\s*[.．]\s*\d{4,5}\s*[/／][^\s］\]]*/gi, " ")
    .replace(/arxiv(?:\.org)?[/:\s]*(?:abs|pdf)?\/?\s*\d{4}\.\d{4,5}(?:v\d+)?/gi, " ")
    .replace(/https?\s*[：:]\s*\/\s*\/\S*/gi, " ");
  const years = [...yearsText.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number.parseInt(m[1] ?? "0", 10));
  if (years.length > 0) {
    out.year = years[years.length - 1]; // 条目末尾年份通常是出版年
  }

  const structured: { authors?: string[]; title: string; venue?: string; year?: number } | null =
    parseQuotedTitleStyle(text) ?? parseCjigAuthorYearStyle(identifiers) ?? parseGbt7714Style(text);
  if (structured !== null) {
    if (structured.authors !== undefined) {
      out.authors = structured.authors;
    }
    out.title = structured.title;
    if (Number.isInteger(structured.year)) {
      out.year = structured.year;
    }
    if (structured.venue !== undefined) {
      out.venue = structured.venue;
    }
  } else {
    // 分段启发：作者段在最前；标题段 = 首个非作者形态的 ≥4 词段。
    // 先按"不切姓名首字母"的规则分段（IEEE 的 C.-Y. Wang），找不到标题再退回朴素句点分段（APA 的 Surname, I. Title）
    const guarded = segmentsOf(text, /(?<=[a-z)\]”"])[.!?]\s+/);
    const plain = segmentsOf(text, /(?<=[.!?])\s+|\.\s+/);
    const picked = pickTitleSegment(guarded) ?? pickTitleSegment(plain);
    if (picked !== undefined) {
      out.authors = splitAuthors(picked.authorSegment);
      out.title = picked.title;
    }
  }

  // 出版物段：去掉已识别的标题后再找（否则含 "Conference" 的标题会被当成 venue）。
  // 结构化解析（CJIG 等）已给出 venue 时跳过，避免段式启发覆盖更精确的结果
  if (out.venue === undefined) {
    const withoutTitle = out.title !== undefined ? text.replace(out.title, " ") : text;
    const venueMatch = segmentsOf(withoutTitle, /(?<=[a-z)\]”"])[.,]\s+/)
      .slice(1)
      .find((segment) =>
        /\b(proceedings|journal|transactions|letters|review|conference|workshop|symposium|nature|science|ieee|acm|springer|elsevier|corr|abs\/)\b/i.test(
          segment,
        ),
      );
    if (venueMatch !== undefined) {
      out.venue = venueMatch
        .replace(/^[“”",.\s]+/, "")
        .replace(/\s*\(\d{4}\)\s*$/, "")
        .trim()
        .slice(0, 200);
    }
  }
  return out;
}

function segmentsOf(text: string, splitter: RegExp): string[] {
  return text
    .split(splitter)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** 首段视为作者；其后首个 ≥4 词且不像出版信息的段视为标题 */
function pickTitleSegment(segments: string[]): { authorSegment: string; title: string } | undefined {
  if (segments.length < 2) {
    return undefined;
  }
  const titleSegment = segments
    .slice(1)
    .find(
      (segment) =>
        countWords(segment) >= 4 &&
        !/^(in|proceedings|vol|no|pp|pages|arxiv|corr|abs\/)/i.test(segment) &&
        !/^\d{4}$/.test(segment) &&
        !/\b(?:et al|editor|Proceedings of the)\b/i.test(segment),
    );
  if (titleSegment === undefined) {
    return undefined;
  }
  return { authorSegment: segments[0] ?? "", title: titleSegment.replace(/["“”]/g, "").trim() };
}

/**
 * IEEE / ACM 风格：`A. Author, B. Author, and C. Author, “Title,” Venue, year.`
 * 引号内就是标题（弯引号 / 直引号都算），引号前是作者段。
 */
function parseQuotedTitleStyle(text: string): { authors?: string[]; title: string } | null {
  const match = /^(.*?)[,.]?\s*[“"]([^”"]{8,400})[,.]?[”"]/.exec(text);
  if (match === null) {
    return null;
  }
  const title = (match[2] ?? "").replace(/[,.\s]+$/, "").trim();
  if (countWords(title) < 2 && title.length < 12) {
    return null;
  }
  const authors = splitAuthors((match[1] ?? "").trim());
  return { ...(authors !== undefined ? { authors } : {}), title };
}

/**
 * GB/T 7714（中文论文常见）：`张三, 李四. 标题[J]. 期刊, 2021, 44(3): 1-20.`
 * 文献类型标识 [J]/[C]/[M]/[D]/[EB/OL]… 前面是标题，再往前以句点分隔的是作者段。
 */
function parseGbt7714Style(text: string): { authors?: string[]; title: string } | null {
  const match = /^(.*?)[.．]\s*([^.．\[]{4,300}?)\s*\[(?:J|C|M|D|N|P|R|S|EB\/OL|DB\/OL|J\/OL|C\/OL)\]/.exec(text);
  if (match === null) {
    return null;
  }
  const title = (match[2] ?? "").trim();
  if (title === "") {
    return null;
  }
  const authors = splitChineseAuthors((match[1] ?? "").trim());
  return { ...(authors !== undefined ? { authors } : {}), title };
}

function splitChineseAuthors(segment: string): string[] | undefined {
  const names = segment
    .split(/[,，;；]|\s+and\s+|\s+等/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && name.length <= 40 && !/\d/.test(name));
  return names.length >= 1 && names.length <= 15 ? names : undefined;
}

/**
 * DOI / URL 印刷空格去除（CJK 期刊排版实测：标识符内部被插入空格——
 * `[DOI: 10. 1007 / 978-3-7908-2604-3_16]`、`https:/ / arxiv. org/ pdf/ 1904. 10509. pdf`）。
 * 只在标识符 span 内去空白（DOI 从 `10 .` 起到配对括号/串尾；URL 从协议起到括号/串尾），
 * 不动其余文本——这是排版噪声归一，与连字归一同一纪律，不是猜测补全。
 */
export function despaceIdentifierSpans(text: string): string {
  return text
    .replace(/10\s*[.．]\s*\d{4,5}\s*[/／][^］\]]*/g, (span) => span.replace(/\s+/g, ""))
    .replace(/https?\s*[：:]\s*\/\s*\/[^［\]]*/gi, (span) => span.replace(/\s+/g, ""));
}

/**
 * CJIG author-year 著录（中国学术期刊常见）：
 * `Authors. Year. Title//Venue. Place： Publisher： pages ［DOI：…］`。
 * 会议条目以 `//` 分隔题名与出版项（印刷变体 `/ /`）；期刊条目 `//` 缺省，
 * 题名取到句点为止。作者段兼容全/半角逗号与 " and "。
 */
function parseCjigAuthorYearStyle(
  text: string,
): { authors?: string[]; title: string; venue?: string; year?: number } | null {
  const match =
    /^([\p{L}\p{M}­-'’\-.,，;；、\s]{3,200}?)[.．]\s*((?:19|20)\d{2}\s?[a-z]?)[.．]\s+(.+)$/u.exec(text);
  if (match === null) {
    return null;
  }
  const authors = splitChineseAuthors((match[1] ?? "").trim());
  if (authors === undefined) {
    return null;
  }
  const rest = (match[3] ?? "").replace(/\/\s*\//g, "//");
  const separator = rest.indexOf("//");
  const body = separator >= 0 ? rest.slice(0, separator) : rest;
  const title = (body.split(/[.．]/)[0] ?? "")
    .replace(/\s*[［[]\s*[A-Za-z]{1,2}(?:\s*\/\s*OL)?\s*[\]］]\s*.*$/u, "")
    .trim();
  if (title === "" || countWords(title) < 2) {
    return null;
  }
  const venuePart = separator >= 0 ? rest.slice(separator + 2) : rest.slice(body.length);
  const venue = venuePart
    .split(/[.．]/)[0]
    ?.replace(/^[\s:：,，]+/, "")
    .trim();
  return {
    ...(venue !== undefined && venue !== "" && countWords(venue) >= 2 ? { venue: venue.slice(0, 200) } : {}),
    year: Number.parseInt((match[2] ?? "").trim(), 10),
    authors,
    title,
  };
}

function normalizeDoi(raw: string): string {
  return raw
    .replace(/^doi:/i, "")
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/[.,;)\]］」，；:：]+$/u, "")
    .trim()
    .toLowerCase();
}

function splitAuthors(segment: string): string[] | undefined {
  const names = segment
    .split(/,| and |&/i)
    .map((name) => name.trim())
    .filter((name) => name !== "" && countWords(name) <= 5 && !/\d/.test(name));
  return names.length >= 1 && names.length <= 15 ? names : undefined;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((part) => part !== "").length;
}

// ---- numeric 列表展开 ----

/** "2,3,5-7" → [2,3,5,6,7]；越界/异常返回空（不猜） */
export function expandNumericList(inner: string): number[] {
  const out: number[] = [];
  for (const partRaw of inner.split(",")) {
    const part = partRaw.trim();
    const rangeMatch = /^(\d{1,3})\s*[–-]\s*(\d{1,3})$/.exec(part);
    if (rangeMatch !== null) {
      const start = Number.parseInt(rangeMatch[1] ?? "0", 10);
      const end = Number.parseInt(rangeMatch[2] ?? "0", 10);
      if (end <= start || end - start > RANGE_EXPAND_LIMIT || start === 0) {
        return [];
      }
      for (let n = start; n <= end; n += 1) {
        out.push(n);
      }
      continue;
    }
    const single = Number.parseInt(part, 10);
    if (!Number.isInteger(single) || single <= 0) {
      return [];
    }
    out.push(single);
  }
  return out.length > 0 ? out : [];
}

// ---- author-year 关联（best-effort；歧义/未命中 → unresolved） ----

function resolveAuthorYear(
  label: string,
  references: ReferenceEntry[],
): CitationCallout["references"] {
  const match = /^([A-Za-z'’-]+)(?:\s+(?:et\s+al\.?|and\s+\S+))?,\s*((?:19|20)\d{2})/.exec(label);
  if (match === null) {
    return [{ label, status: "unresolved" }];
  }
  const surname = (match[1] ?? "").toLowerCase();
  const year = Number.parseInt(match[2] ?? "0", 10);
  const candidates = references.filter((reference) => {
    if (reference.year !== year) {
      return false;
    }
    const first = reference.authors?.[0]?.toLowerCase() ?? "";
    return first.startsWith(surname) || surname.startsWith(first.split(/\s+/).pop() ?? "");
  });
  if (candidates.length === 1) {
    return [{ label, referenceId: candidates[0]!.referenceId, status: "resolved" }];
  }
  return [{ label, status: "unresolved" }];
}

// ---- 句子定位 ----

function sentenceAround(
  text: string,
  start: number,
  length: number,
): { sentence: string; before: string; after: string } {
  const beforePart = /[^.!?]*$/.exec(text.slice(0, start))?.[0] ?? "";
  const afterPart = /^[^.!?]*[.!?]?/.exec(text.slice(start + length))?.[0] ?? "";
  const marker = text.slice(start, start + length);
  const sentence = `${beforePart.trimStart()}${marker}${afterPart}`.replace(/\s+/g, " ").trim();
  return {
    sentence: sentence.slice(0, 600),
    before: text.slice(Math.max(0, start - CONTEXT_CHARS), start).replace(/\s+/g, " ").trim(),
    after: text
      .slice(start + length, start + length + CONTEXT_CHARS)
      .replace(/\s+/g, " ")
      .trim(),
  };
}
