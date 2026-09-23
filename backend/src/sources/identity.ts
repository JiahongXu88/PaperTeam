/**
 * SourceIdentity：跨 Provider 的文献身份（D-0033 §12 草案的 M6.2 落地）。
 *
 * 分层确定性键（高 → 低）：
 *   DOI > arXiv ID > PMID > 归一标题指纹+年份+一作 family > canonical URL
 *
 * 纪律（M6.1 ADR §2-5）：
 * - 键是**精确相等**，不是相似度——「仅标题相似」永远不构成同一身份；
 * - preprint（arXiv 键）与正式发表版（DOI 键）是两个不同身份 → 两条独立 Source，
 *   互相不覆盖；版本关系用 SourceItem 的 workKey / versionType / relatedSourceIds
 *   表达（见 SourceStore），不做自动合并、不引入 Knowledge Graph；
 * - 归一化只做确定性变换（前缀剥离、小写、URL 参数清洗），不猜测、不改写原文。
 */

import { compactTitle } from "../citation/referenceText.js";

/** 跨源同一文献身份（持久化于 SourceItem.identity；CandidateSource 同构） */
export interface SourceIdentity {
  /** 小写归一，无 https://doi.org/ 前缀 */
  doi?: string;
  /** 去版本号（2401.12345v2 → 2401.12345） */
  arxivId?: string;
  pmid?: string;
  /** provider 原生记录 id（M6.3 检索接入后由 discovery 写入） */
  openalexId?: string;
  s2Id?: string;
  aminerId?: string;
  /** canonical URL（仅当无更强键时作为身份键；URL import / web 结果用） */
  url?: string;
  /** 归一标题指纹（compactTitle：大小写/标点/连字符/空白不敏感的紧凑形式） */
  normalizedTitleFingerprint: string;
  year?: number;
  firstAuthorFamily?: string;
}

/** 构建身份的原始输入（各字段先经归一化，非法值静默丢弃） */
export interface IdentityInput {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  openalexId?: string;
  s2Id?: string;
  aminerId?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
}

/**
 * DOI 归一化：接受 "https://doi.org/10.x/abc" / "doi:10.x/abc" / "10.x/abc"，
 * 统一为小写裸 DOI；不匹配 10.<registry>/<suffix> 形态（含常见拖带标点剥离）
 * 返回 undefined。DOI 后缀理论上大小写敏感，但 Crossref / OpenAlex / S2
 * API 均按全小写收录（scholarly.ts 同一约定），跟随全小写。
 */
export function normalizeDoi(input: string): string | undefined {
  let value = input.trim();
  // 复制粘贴常见包裹（左右括号）先剥（合法 DOI 以 10. 开头，安全）
  value = value.replace(/^[<(]+/, "").replace(/[>)]+$/, "");
  value = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
  value = value.replace(/^doi:\s*/i, "");
  value = value.replace(/^info:doi\//i, "");
  value = value.toLowerCase();
  // 句末拖带标点剥一次，剥完必须仍是合法形态
  value = value.replace(/[.,;]+$/, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(value) || /\s/.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * arXiv ID 归一化：接受
 *   https://arxiv.org/abs/2401.12345v2 / arXiv:2401.12345 / 2401.12345v2
 *   老式分类编号（cs/0501034）
 * 统一为去版本号小写形态。
 */
export function normalizeArxivId(input: string): string | undefined {
  const value = input.trim();
  // 新式 YYMM.NNNNN + 老式 archive/NNNNNNN（archive 含子分类点号：math.GT/…）
  const match =
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(?:arxiv:)?([a-z][a-z.-]*\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.exec(
      value,
    );
  if (match === null) {
    return undefined;
  }
  return match[1]!.toLowerCase();
}

/**
 * arXiv DOI（DataCite 前缀 10.48550/arxiv.*）→ 归一化 arXiv ID（M9.7.4）。
 * `10.48550/arxiv.2210.03629` → `2210.03629`；非 arXiv DOI / 非法 ID 返回
 * undefined。arXiv DOI 的身份权威源是 arXiv 本身——这是 DOI-only 查询防
 * provider 错配（M9.7.3 真实案例：OpenAlex 对 arXiv DOI 索引错配返回
 * match + 错误论文）的唯一独立参照。放在 identity.ts 供 citation 与
 * sources 两域共用（避免 scholarly ↔ candidateScoring 运行时循环依赖）。
 */
export function arxivIdFromDoi(doi: string): string | undefined {
  const match = /^10\.48550\/arxiv\.(\S+)$/i.exec(doi.trim());
  if (match === null) {
    return undefined;
  }
  return normalizeArxivId(match[1]!);
}

/** PMID 归一化（纯数字串） */
export function normalizePmid(input: string): string | undefined {
  const value = input.trim();
  return /^\d{1,9}$/.test(value) ? value : undefined;
}

/**
 * URL canonicalization（最小确定性子集，不做 crawler）：
 * - 仅 http/https；host 小写、默认端口剥离（URL 构造器行为）；
 * - 去 fragment、去 utm_x / fbclid / gclid / ref 追踪参数；
 * - 查询参数按名排序（参数序不敏感）；
 * - 路径尾部斜杠折叠（/abs/x/ → /abs/x；根路径 / 保留）。
 */
export function canonicalUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  url.hash = "";
  const drop = [...url.searchParams.keys()].filter((key) =>
    /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref)$/i.test(key),
  );
  for (const key of drop) {
    url.searchParams.delete(key);
  }
  // (key, value) 双排序：同名参数的取值顺序也不影响 canonical 形态
  const pairs: Array<[string, string]> = [...url.searchParams];
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const sorted = new URLSearchParams(pairs);
  url.search = sorted.size > 0 ? `?${sorted.toString()}` : "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

/** 一作 family 名（小写归一）："Jiahong Xu" / "Xu, Jiahong" → "xu"；中文整体保留 */
export function firstAuthorFamily(authors: string[] | undefined): string | undefined {
  const first = authors?.[0]?.trim();
  if (first === undefined || first === "") {
    return undefined;
  }
  // BibTeX 风格 "Family, Given"：逗号前是 family
  const commaFamily = /^([^,]+),/.exec(first);
  if (commaFamily !== null && commaFamily[1]!.trim() !== "") {
    return commaFamily[1]!.trim().normalize("NFKC").toLowerCase();
  }
  // 自然序 "Given Family"（含中间名）：最后一个 token 是 family
  const parts = first
    .replace(/[.;:]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (parts.length === 0) {
    return undefined;
  }
  const token = parts.length > 1 ? parts[parts.length - 1]! : parts[0]!;
  return token.normalize("NFKC").toLowerCase();
}

/** 从原始输入构建归一化身份；无任何可用身份字段（无指纹）返回 null */
export function buildIdentity(input: IdentityInput): SourceIdentity | null {
  const title = input.title?.trim();
  const identity: SourceIdentity = {
    normalizedTitleFingerprint: title !== undefined && title !== "" ? compactTitle(title) : "",
  };
  const doi = input.doi !== undefined ? normalizeDoi(input.doi) : undefined;
  if (doi !== undefined) {
    identity.doi = doi;
  }
  const arxivId = input.arxivId !== undefined ? normalizeArxivId(input.arxivId) : undefined;
  if (arxivId !== undefined) {
    identity.arxivId = arxivId;
  }
  const pmid = input.pmid !== undefined ? normalizePmid(input.pmid) : undefined;
  if (pmid !== undefined) {
    identity.pmid = pmid;
  }
  if (input.openalexId !== undefined && input.openalexId.trim() !== "") {
    identity.openalexId = input.openalexId.trim();
  }
  if (input.s2Id !== undefined && input.s2Id.trim() !== "") {
    identity.s2Id = input.s2Id.trim();
  }
  if (input.aminerId !== undefined && input.aminerId.trim() !== "") {
    identity.aminerId = input.aminerId.trim();
  }
  const url = input.url !== undefined ? canonicalUrl(input.url) : undefined;
  if (url !== undefined) {
    identity.url = url;
  }
  if (typeof input.year === "number" && Number.isInteger(input.year)) {
    identity.year = input.year;
  }
  const family = firstAuthorFamily(input.authors);
  if (family !== undefined) {
    identity.firstAuthorFamily = family;
  }
  if (
    identity.doi === undefined &&
    identity.arxivId === undefined &&
    identity.pmid === undefined &&
    identity.url === undefined &&
    identity.normalizedTitleFingerprint === ""
  ) {
    return null;
  }
  return identity;
}

/**
 * 身份键：按分层优先级取第一个可用键。
 * tier-4（标题指纹）要求 年份 与 一作 family 同时存在——仅标题不构成身份。
 * 返回 undefined 表示该身份没有任何可用于判等的键。
 */
export function identityKey(identity: SourceIdentity): string | undefined {
  if (identity.doi !== undefined) {
    return `doi:${identity.doi}`;
  }
  if (identity.arxivId !== undefined) {
    return `arxiv:${identity.arxivId}`;
  }
  if (identity.pmid !== undefined) {
    return `pmid:${identity.pmid}`;
  }
  if (
    identity.normalizedTitleFingerprint !== "" &&
    identity.year !== undefined &&
    identity.firstAuthorFamily !== undefined
  ) {
    return `tf:${identity.normalizedTitleFingerprint}|${identity.year}|${identity.firstAuthorFamily}`;
  }
  if (identity.url !== undefined) {
    return `url:${identity.url}`;
  }
  return undefined;
}

/**
 * 同一性判定：身份键精确相等。
 * 注意 arXiv preprint 与 DOI 正式版键不同 → 不是同一身份（各自独立 Source）；
 * 同 DOI 不同大小写 / 前缀形态 → 同一键（归一化已消除）。
 */
export function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  const keyA = identityKey(a);
  const keyB = identityKey(b);
  return keyA !== undefined && keyA === keyB;
}

/**
 * 从 SourceItem.metadata 推导身份（老项目 lazy 兼容：M6.2 之前入库的条目没有
 * identity 字段，判等时动态推导，不重写旧 index.json）。
 */
export function identityFromMetadata(metadata: {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
}): SourceIdentity | null {
  return buildIdentity({
    ...(metadata.doi !== undefined ? { doi: metadata.doi } : {}),
    ...(metadata.arxivId !== undefined ? { arxivId: metadata.arxivId } : {}),
    ...(metadata.pmid !== undefined ? { pmid: metadata.pmid } : {}),
    ...(metadata.url !== undefined ? { url: metadata.url } : {}),
    ...(metadata.title !== undefined ? { title: metadata.title } : {}),
    ...(metadata.authors !== undefined ? { authors: metadata.authors } : {}),
    ...(metadata.year !== undefined ? { year: metadata.year } : {}),
  });
}
