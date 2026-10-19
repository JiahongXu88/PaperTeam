/**
 * M14.9.3 输入保真门的文本工具（零模型、确定性）：规范化（带原文偏移映射）、n-gram 定位、
 * 「像正文」判据与投稿元数据字段签名。签名只认**来源可证明**的字段特征（标签词 / 邮箱 /
 * 收稿日期 / 中图号 …），从不按「大学」「基金」二字判正文为元数据。
 */

/** 规范化：NFKC + 只保留字母 / 数字（去空白、标点、Markdown 标记），小写；map[i] = 规范串第 i 个字符在原文中的下标 */
export function canonWithMap(text: string): { canon: string; map: number[] } {
  let canon = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    const width = char.length;
    const normalized = char.normalize("NFKC").toLowerCase();
    for (const piece of normalized) {
      if (/[\p{L}\p{N}]/u.test(piece)) {
        canon += piece;
        map.push(index);
      }
    }
    index += width - 1;
  }
  return { canon, map };
}

export function canon(text: string): string {
  return canonWithMap(text).canon;
}

export type GramIndex = Map<string, number[]>;

export function buildGramIndex(text: string, n: number): GramIndex {
  const index: GramIndex = new Map();
  for (let at = 0; at + n <= text.length; at += 1) {
    const gram = text.slice(at, at + n);
    const list = index.get(gram);
    if (list === undefined) index.set(gram, [at]);
    else if (list.length < 64) list.push(at);
  }
  return index;
}

/**
 * 在规范化投影中定位一段规范化源文本：命中 n-gram 比例 + 偏移投票锚点（重复短语不会把锚点拉偏）。
 * 短于 n 的文本按子串查找。
 */
export function locateCanon(needle: string, haystack: string, index: GramIndex, n: number): { fraction: number; anchor: number | null } {
  if (needle.length === 0) return { fraction: 1, anchor: null };
  if (needle.length < n) {
    const at = haystack.indexOf(needle);
    return { fraction: at >= 0 ? 1 : 0, anchor: at >= 0 ? at : null };
  }
  let hits = 0;
  const votes = new Map<number, number>();
  const total = needle.length - n + 1;
  for (let at = 0; at < total; at += 1) {
    const positions = index.get(needle.slice(at, at + n));
    if (positions === undefined) continue;
    hits += 1;
    for (const position of positions) votes.set(position - at, (votes.get(position - at) ?? 0) + 1);
  }
  let anchor: number | null = null;
  let best = 0;
  for (const [start, count] of votes) {
    if (count > best || (count === best && anchor !== null && start < anchor)) {
      best = count;
      anchor = start;
    }
  }
  return { fraction: hits / total, anchor: anchor === null ? null : Math.max(0, anchor) };
}

export function cjkCount(text: string): number {
  return (text.match(/[一-鿿]/g) ?? []).length;
}

/** 「像正文」：≥40 个汉字且含句内标点，或 ≥35 个英文词且有句子结构 */
export function looksLikeBody(text: string): boolean {
  if (cjkCount(text) >= 40 && /[，。；：,;]/.test(text)) return true;
  const words = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  return words >= 35 && /[.;,]\s/.test(text);
}

/** 投稿元数据字段签名（来源可证明的特征；作用于被删文本本身） */
export const METADATA_SIGNATURES = {
  email: /[\w.%+-]+@[\w-]+(\.[\w-]+)+|E-?mail|电子邮箱|邮箱/i,
  funding: /基金|资助|Fund(ed|ing)?\b|Foundation|supported by|Grant|Program(me)?\s*(No|项目)|(项目|计划|课题|专项|团队)\s*[（(]\s*[A-Za-z0-9-]{5,}|[（(]\s*\d{4}[A-Z]{2,}[A-Z0-9]{2,}\s*[）)]/i,
  author_bio: /作者简介|[男女]\s*[，,、（(]|\d{4}\s*[-—–]|\d{4}\s*年\s*生|出生|研究方向|主要从事|研究兴趣|born\b|research interests?|教授|讲师|博士|硕士|研究生|工程师|主任|E-?mail|Biograph/i,
  author: /作者|通信作者|通讯作者|Corresponding|Author/i,
  affiliation: /大学|学院|研究院|研究所|研究中心|实验室|医院|疾病预防控制中心|疾控中心|卫生健康|公司|集团|University|College|Institute|Laborator|Hospital|School|Academy|Cent(er|re)|Department|Faculty|Province|China|CHN|P\.\s*R\.\s*C|(?<!\d)\d{6}(?!\d)/i,
  submission_dates: /收稿|修回|录用|接受日期|网络出版|Received|Revised|Accepted/i,
  submission_metadata: /中图分类号|中图法分类号|文献标识码|文献标志码|文章编号|文章编码|\bDOI\b|\bdoi\b|OSID|开放科学/i,
  citation_format: /引用格式|引用本文|Cite\s+this|Citation|\b(19|20)\d{2}\s*[,，]\s*\d+\s*[(（]\s*\d+\s*[)）]/i,
  running_header: /[，,]\s*等\s*[:：]|et\s+al\.\s*[:：]/i,
  editorial_metadata: /编辑|校对|Editor/i,
  journal_identity: /第\s*\d+\s*卷|第\s*\d+\s*期|Vol\.?\s*\d+|No\.?\s*\d+|ISSN|CN\s*\d{2}\s*[-‐]\s*\d{4}|学\s*报|杂\s*志|Journal|JOURNAL|\d{4}\s*年\s*\d{1,2}\s*月/,
  author_contribution: /作者贡献|作者分工|利益冲突|Author\s*contributions?|Conflicts?\s*of\s*interests?/i,
  author_orcid: /orcid/i,
  acknowledgement: /致\s*谢|鸣\s*谢|感谢|Acknowledg/i,
  continuation: /[上下]\s*[接转]\s*第\s*\d+\s*页/,
} as const;

const FIELD_LABEL_START = /^[\s［\[【（(*＊]*(作者简介|第一作者|通信作者|通讯作者|基金项目|资助项目|收稿日期|修回日期|录用日期|中图分类号|文献标[识志]码|文章编号|引用格式|引用本文|E-?mail|Corresponding|Fund|Foundation items?|Supported by|This (work|study|research|paper)|Biograph)/i;

const ANY_METADATA = new RegExp(Object.values(METADATA_SIGNATURES).map((pattern) => pattern.source).join("|"), "i");

/**
 * 强字段签名：只会出现在投稿元数据里的形态（邮箱、收稿日期、中图号 / DOI、引用格式、刊号卷期、「男 / 女 + 出生年」、
 * 基金编号、邮编、born in / research interests）。「大学」「基金」「作者」这类弱词在正文里同样常见
 * （「某大学发布的数据集」「得到国家自然科学基金支持」），单凭弱词不能把一句正文判成元数据。
 */
const STRONG_METADATA = new RegExp([
  METADATA_SIGNATURES.email.source,
  METADATA_SIGNATURES.submission_dates.source,
  METADATA_SIGNATURES.submission_metadata.source,
  METADATA_SIGNATURES.citation_format.source,
  "第\\s*\\d+\\s*卷|Vol\\.?\\s*\\d+|ISSN|CN\\s*\\d{2}\\s*[-‐]\\s*\\d{4}",
  METADATA_SIGNATURES.author_orcid.source,
  METADATA_SIGNATURES.continuation.source,
  "[男女]\\s*[，,、（(]", "\\d{4}\\s*[-—–]\\s*[）)]", "(?<!\\d)\\d{6}(?!\\d)", "[（(]\\s*[A-Za-z0-9-]{6,}\\s*[）)]",
  "born in", "research interests?", "研究方向", "主要从事", "作者简介", "通信作者", "通讯作者", "Corresponding",
].join("|"), "i");

/** 作者署名行形态：中文姓名列表（含上标数字 / 星号）或「WANG Quan 1,2, YE Guangfei」 */
export function looksLikeNameList(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 90) return false;
  if (/^[一-鿿·\s　,，、;；\d*＊+†‡¹²³⁴⁵⁶⁷⁸⁹⁰①-⑳a-f]+$/.test(t)) return cjkCount(t) >= 2 && !/[。：:]/.test(t);
  return /^([A-Z][A-Za-z-]*\s*[A-Z][a-z]+([-‐][A-Za-z]+)?[\s\d,，*+①-⑳]*){1,12}$/.test(t.normalize("NFKC"));
}

/**
 * 被删文本扣除元数据片段后的「残余正文」：按句读 / 字段标签切段，带任一元数据签名或很短的段视为
 * 元数据，其余拼接。残余像正文 → 删除越界（例如英文摘要被并进通信作者块后整块删除）。
 */
export function residualBody(input: string): string {
  const text = input.normalize("NFKC");
  const segments = text.split(/(?<=[。！？；;])|(?<=\.)\s+(?=[A-Z])|(?=(?:基金项目|作者简介|收稿日期|修回日期|通信作者|通讯作者|Corresponding|Fund|E-?mail)[:：\s])/);
  // 元数据片段 = 以字段标签开头，或带元数据签名的短片段；长句里偶然出现「China」「University」不算元数据
  return segments.filter((segment) => {
    const trimmed = segment.trim();
    if (trimmed.length < 25) return false;
    if (FIELD_LABEL_START.test(trimmed)) return false;
    if (STRONG_METADATA.test(trimmed)) return false;
    return !(ANY_METADATA.test(trimmed) && canon(trimmed).length <= 30);
  }).join("");
}

/** 以显式字段标签开头的投稿字段（整块即该字段；标签来源可证明，正文不会以这些标签开头） */
export const LABELED_PROSE_FIELD = /^\s*[［\[【（(]?\s*(作者贡献|作者分工|利益冲突|利益冲突声明|Author\s*contributions?|Conflicts?\s*of\s*interests?|致\s*谢|鸣\s*谢|Acknowledg\w*)\s*[］\]】）)]?\s*[:：]?/i;

/** 单行是否为可证明的元数据 / 署名行（删除侧逐行审计用） */
export function isMetadataLine(line: string): boolean {
  const t = line.normalize("NFKC").trim();
  if (t === "") return true;
  if (FIELD_LABEL_START.test(t) || STRONG_METADATA.test(t) || looksLikeNameList(t)) return true;
  if (ANY_METADATA.test(t) && canon(t).length <= 30) return true;
  // 英文署名「LIU Tianjiao, DU Songye and AN Tao*」：几乎全是首字母大写的词，无句读
  const words = t.replace(/[*†‡\d,，]/g, " ").split(/\s+/).filter((word) => word !== "");
  return words.length >= 2 && words.length <= 24 && !/[.;。；]/.test(t) &&
    words.filter((word) => /^[A-Z]/.test(word) || word === "and").length >= 0.85 * words.length;
}

export const CAPTION_PATTERN = /^\s*(表|图|Table|Tab\.|Fig\.?|Figure)\s*\d/i;
export const NUMBERED_HEADING_PATTERN = /^\s*(\d+(\s*[.．]\s*\d+)*\s*[.．、]?\s*[一-鿿A-Za-z]|[一二三四五六七八九十]+\s*、|[（(]\s*[一二三四五六七八九十]+\s*[）)])/;
export const MARKER_PATTERN = /[√✓✔×✗✘●○◎▲△★☆■□◆◇①-⑳]/g;

/** 数值词元（与 reviewInputEquivalence.numberTokens 同口径；先合并千分组空格「1 024」） */
export function cellNumbers(text: string): string[] {
  // 排版拆开的小数「177. 905」「0. 351」；小数部分千分组「0.000 5」；整数千分组「1 332」「2 489」
  //（只认单元格内的窄空白——跨单元格的大间距由调用方用制表符分隔，不参与合并）
  const joined = text
    .replace(/(\d)\.[^\S\n\t]+(?=\d)/g, "$1.")
    .replace(/(\.\d{3})[^\S\n\t](?=\d{1,3}(?![\d.]))/g, "$1")
    .replace(/(?<![\d.])(\d{1,3})((?:[^\S\n\t]\d{3})+)(?![\d.])/g, (_whole, head: string, tail: string) => head + tail.replace(/\s/g, ""));
  return [...joined.replace(/[{}]/g, "").matchAll(/(?<![A-Za-z0-9_\\.]|(?<![A-Za-z0-9])[A-Za-z] )\.?\d+(?:[.,]\d+)*/g)].map((match) => match[0].replace(/,(?=\d{3}\b)/g, ""));
}

export function cellMarkers(text: string): string[] {
  return (text.match(MARKER_PATTERN) ?? []).map((marker) => (marker === "✓" || marker === "✔" ? "√" : marker === "✗" || marker === "✘" ? "×" : marker));
}

export function multisetKey(items: readonly string[]): string {
  return [...items].sort().join("");
}
