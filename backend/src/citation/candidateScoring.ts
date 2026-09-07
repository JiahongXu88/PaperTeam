/**
 * 候选文献确定性打分（无 LLM）。
 *
 * 信号强度（从强到弱）：
 *   DOI 精确相等                                   → 同一作品（字段差异只记 mismatch）
 *   标题 strong（紧凑形式相等 / 相似度 ≥ 0.92）      → 接受；年份/第一作者用于消歧与 mismatch
 *   标题 medium（≥ 0.80）+ 第一作者姓氏一致 + 年份 ±1 → 接受但记 title mismatch
 *   仅关键词相似                                   → 拒绝（不硬凑）
 *
 * 多版本（arXiv 预印本 vs 正式发表）同一作品：标题紧凑形式相等 + 第一作者一致，
 * 不判 ambiguous，按"年份精确 > 第一作者 > 正式 DOI > 有 DOI"选代表记录。
 */

import type { CanonicalPaperRecord, CitationFieldMismatch } from "./integrity.js";
import type { ScholarlyQuery } from "./scholarly.js";
import { compactTitle, titleSimilarity } from "./referenceText.js";

export const TITLE_STRONG_THRESHOLD = 0.92;
export const TITLE_MEDIUM_THRESHOLD = 0.8;
/** 年份容忍：arXiv / 会议 / 期刊再索引常差 1 年 */
export const YEAR_TOLERANCE = 1;

export type CandidateTier = "doi" | "strong" | "medium" | "reject";

export interface CandidateScore {
  candidate: CanonicalPaperRecord;
  tier: CandidateTier;
  titleSimilarity: number;
  doiExact: boolean;
  firstAuthorMatch: boolean | undefined;
  authorOverlap: boolean | undefined;
  yearDelta: number | undefined;
  /** 排序用综合分（越大越好；只在同 tier 内比较） */
  rank: number;
}

export function scoreCandidate(query: ScholarlyQuery, candidate: CanonicalPaperRecord): CandidateScore {
  const doiExact =
    query.doi !== undefined && candidate.doi !== undefined && query.doi.toLowerCase() === candidate.doi.toLowerCase();
  const similarity =
    query.title !== undefined && candidate.title !== undefined ? titleSimilarity(query.title, candidate.title) : 0;
  const firstAuthorMatch =
    query.authors !== undefined && query.authors.length > 0 && candidate.authors !== undefined && candidate.authors.length > 0
      ? surnamesShare(query.authors[0]!, candidate.authors[0]!)
      : undefined;
  const authorOverlap =
    query.authors !== undefined && query.authors.length > 0 ? authorsOverlap(query.authors, candidate.authors) : undefined;
  const yearDelta =
    query.year !== undefined && candidate.year !== undefined ? Math.abs(query.year - candidate.year) : undefined;

  let tier: CandidateTier = "reject";
  if (doiExact) {
    tier = "doi";
  } else if (query.title === undefined) {
    // 无标题只能靠 DOI / arXiv id 精确命中；搜索候选不可接受
    tier = "reject";
  } else if (similarity >= TITLE_STRONG_THRESHOLD) {
    tier = "strong";
  } else if (
    similarity >= TITLE_MEDIUM_THRESHOLD &&
    firstAuthorMatch === true &&
    yearDelta !== undefined &&
    yearDelta <= YEAR_TOLERANCE
  ) {
    tier = "medium";
  }

  const rank =
    similarity * 100 +
    (yearDelta === 0 ? 30 : yearDelta !== undefined && yearDelta <= YEAR_TOLERANCE ? 15 : 0) +
    (firstAuthorMatch === true ? 20 : authorOverlap === true ? 8 : 0) +
    (candidate.doi !== undefined ? (isPreprintDoi(candidate.doi) ? 3 : 6) : 0);

  return { candidate, tier, titleSimilarity: similarity, doiExact, firstAuthorMatch, authorOverlap, yearDelta, rank };
}

/** 两条候选是否为同一作品的不同版本（预印本 / 正式发表 / 多库收录） */
export function sameWork(a: CanonicalPaperRecord, b: CanonicalPaperRecord): boolean {
  if (a.doi !== undefined && b.doi !== undefined && a.doi.toLowerCase() === b.doi.toLowerCase()) {
    return true;
  }
  if (a.title === undefined || b.title === undefined || compactTitle(a.title) !== compactTitle(b.title)) {
    return false;
  }
  if (a.authors?.[0] !== undefined && b.authors?.[0] !== undefined) {
    return surnamesShare(a.authors[0], b.authors[0]);
  }
  // 一方无作者信息：标题完全相同且年份不冲突（±1）视为同一作品
  return a.year === undefined || b.year === undefined || Math.abs(a.year - b.year) <= YEAR_TOLERANCE;
}

export function isPreprintDoi(doi: string): boolean {
  return /^10\.48550\//i.test(doi);
}

/** 字段比对（DOI 路径 / 已接受候选）：年份 ±1 容忍，标题按相似度 */
export function compareFields(query: ScholarlyQuery, canonical: CanonicalPaperRecord): CitationFieldMismatch[] {
  const mismatches: CitationFieldMismatch[] = [];
  if (
    query.title !== undefined &&
    canonical.title !== undefined &&
    titleSimilarity(query.title, canonical.title) < TITLE_STRONG_THRESHOLD
  ) {
    mismatches.push({ field: "title", expected: query.title, actual: canonical.title });
  }
  if (query.year !== undefined && canonical.year !== undefined && Math.abs(query.year - canonical.year) > YEAR_TOLERANCE) {
    mismatches.push({ field: "year", expected: String(query.year), actual: String(canonical.year) });
  }
  if (query.doi !== undefined && canonical.doi !== undefined && query.doi.toLowerCase() !== canonical.doi.toLowerCase()) {
    mismatches.push({ field: "doi", expected: query.doi, actual: canonical.doi });
  }
  return mismatches;
}

// ---- 作者比对 ----

/** 姓氏候选：PDF 提取常「姓在前」，学术库多「姓在后」——首/末 token 都可能是姓 */
export function surnameCandidates(name: string): Set<string> {
  const tokens = name
    .normalize("NFKC")
    .replace(/\./g, " ")
    .split(/[\s,]+/)
    .map((token) => token.toLowerCase().replace(/[^\p{L}'-]/gu, ""))
    .filter((token) => token.length > 1);
  if (tokens.length === 0) {
    return new Set();
  }
  return new Set([tokens[0]!, tokens[tokens.length - 1]!]);
}

export function surnamesShare(left: string, right: string): boolean {
  const a = surnameCandidates(left);
  for (const surname of surnameCandidates(right)) {
    if (a.has(surname)) {
      return true;
    }
  }
  return false;
}

export function authorsOverlap(queryAuthors: string[], candidateAuthors?: string[]): boolean {
  if (candidateAuthors === undefined || candidateAuthors.length === 0) {
    return false;
  }
  return queryAuthors.some((queryAuthor) => candidateAuthors.some((candidate) => surnamesShare(queryAuthor, candidate)));
}
