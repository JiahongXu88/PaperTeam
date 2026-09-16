/**
 * 多源融合：SourceIdentity 去重 + 带权重倒数排名融合（D-0033 §2-5）。
 *
 * 借 SearXNG 打分公式（分析报告 §3.3-10）：score = Σ(来源权重 / (K + 名次))，
 * K=60（标准 RRF 常数），极简可解释、确定性（无 ML reranker——D-0033 拒绝项）。
 *
 * 去重复用 M6.2 SourceIdentity 分层键（identity.ts），不造第二套 dedup：
 * - 同 DOI（跨库大小写/前缀已归一）→ 同一结果，metadata 互补合并；
 * - **arXiv preprint 与 DOI 正式版键不同 → 不 collapse**（M6.2 纪律），两条独立
 *   结果并存，由用户/后续 Agent 用 link 显式建立版本关系；
 * - 互补合并只填空缺：provider A 的缺失字段不覆盖 provider B 的有效字段。
 */

import type { CanonicalPaperRecord } from "../citation/integrity.js";
import { identityKey, type SourceIdentity } from "../sources/identity.js";
import type { AcademicSearchResult } from "./types.js";

/** RRF 常数（标准 reciprocal rank fusion 的 k=60） */
export const RRF_K = 60;

/** provider 融合权重（primary 略高；enrichment / secondary 依次） */
export const PROVIDER_WEIGHTS: Readonly<Record<string, number>> = {
  openalex: 1.0,
  "semantic-scholar": 0.9,
  arxiv: 0.8,
  aminer: 0.7,
};

export interface FusedAcademicResult {
  identity: SourceIdentity;
  record: CanonicalPaperRecord;
  citationCount?: number;
  openAccess?: boolean;
  /** 融合分（Σ 权重/(K+rank)；无重复命中时即单源归一分） */
  score: number;
  /** 命中该结果的所有 provider 及名次（provenance） */
  sources: Array<{ provider: string; rank: number }>;
}

export function providerWeight(provider: string): number {
  return PROVIDER_WEIGHTS[provider] ?? 0.5;
}

/**
 * 融合多 provider 结果：按 identityKey 分组 → RRF 打分 → 字段互补合并 →
 * 确定性排序（score 降序；并列时按 最强来源权重 > 最佳名次 > 标题指纹）。
 * 无判等键的结果（理论上 provider 已过滤）安全起见丢弃。
 */
export function fuseAcademicResults(providerResults: AcademicSearchResult[][]): FusedAcademicResult[] {
  const groups = new Map<string, AcademicSearchResult[]>();
  for (const results of providerResults) {
    for (const result of results) {
      const key = identityKey(result.identity);
      if (key === undefined) {
        continue;
      }
      const bucket = groups.get(key);
      if (bucket === undefined) {
        groups.set(key, [result]);
      } else {
        bucket.push(result);
      }
    }
  }
  const fused: FusedAcademicResult[] = [];
  for (const hits of groups.values()) {
    const score = hits.reduce(
      (sum, hit) => sum + providerWeight(hit.relevance.provider) / (RRF_K + hit.relevance.rank),
      0,
    );
    fused.push({
      identity: mergeIdentities(hits.map((hit) => hit.identity)),
      record: mergeRecords(hits),
      ...mergeScalars(hits),
      score,
      sources: hits
        .map((hit) => ({ provider: hit.relevance.provider, rank: hit.relevance.rank }))
        .sort((a, b) => providerWeight(b.provider) - providerWeight(a.provider) || a.rank - b.rank),
    });
  }
  fused.sort(
    (a, b) =>
      b.score - a.score ||
      bestSourceWeight(b) - bestSourceWeight(a) ||
      bestRank(a) - bestRank(b) ||
      a.identity.normalizedTitleFingerprint.localeCompare(b.identity.normalizedTitleFingerprint),
  );
  return fused;
}

/** 身份合并：强键字段取第一个非空（DOI > arXiv > pmid > tf），provider 原生 id 全部并集保留 */
function mergeIdentities(identities: SourceIdentity[]): SourceIdentity {
  const merged: SourceIdentity = {
    normalizedTitleFingerprint: identities[0]?.normalizedTitleFingerprint ?? "",
  };
  const doi = firstPresent(identities, "doi");
  if (doi !== undefined) {
    merged.doi = doi;
  }
  const arxivId = firstPresent(identities, "arxivId");
  if (arxivId !== undefined) {
    merged.arxivId = arxivId;
  }
  const pmid = firstPresent(identities, "pmid");
  if (pmid !== undefined) {
    merged.pmid = pmid;
  }
  const openalexId = firstPresent(identities, "openalexId");
  if (openalexId !== undefined) {
    merged.openalexId = openalexId;
  }
  const s2Id = firstPresent(identities, "s2Id");
  if (s2Id !== undefined) {
    merged.s2Id = s2Id;
  }
  const aminerId = firstPresent(identities, "aminerId");
  if (aminerId !== undefined) {
    merged.aminerId = aminerId;
  }
  const url = firstPresent(identities, "url");
  if (url !== undefined) {
    merged.url = url;
  }
  const year = firstPresent(identities, "year");
  if (year !== undefined) {
    merged.year = year;
  }
  const firstAuthorFamily = firstPresent(identities, "firstAuthorFamily");
  if (firstAuthorFamily !== undefined) {
    merged.firstAuthorFamily = firstAuthorFamily;
  }
  return merged;
}

/** 取一组对象中该字段第一个非空值（空串/空数组视为缺失） */
function firstPresent<T, K extends keyof T>(objects: T[], field: K): T[K] | undefined {
  for (const object of objects) {
    const value = object[field];
    if (value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) {
      return value;
    }
  }
  return undefined;
}

/** 值是否为空缺（undefined / 空串 / 空数组） */
function isBlank(value: unknown): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * 记录合并：以「最强来源」的记录为基座（primary 权重高者优先），其余只填空缺
 * 字段——provider A 的缺失字段不覆盖 provider B 的有效字段。
 */
function mergeRecords(hits: AcademicSearchResult[]): CanonicalPaperRecord {
  const ordered = [...hits].sort(
    (a, b) =>
      providerWeight(b.relevance.provider) - providerWeight(a.relevance.provider) ||
      a.relevance.rank - b.relevance.rank,
  );
  const base = ordered[0]!;
  const merged: CanonicalPaperRecord = { ...base.record };
  const rest = ordered.slice(1);
  merged.title = firstPresent(rest.map((hit) => hit.record), "title") ?? merged.title;
  const authors = merged.authors;
  if (isBlank(authors)) {
    merged.authors = firstPresent(rest.map((hit) => hit.record), "authors");
  }
  if (isBlank(merged.year)) {
    merged.year = firstPresent(rest.map((hit) => hit.record), "year");
  }
  if (isBlank(merged.venue)) {
    merged.venue = firstPresent(rest.map((hit) => hit.record), "venue");
  }
  if (isBlank(merged.doi)) {
    merged.doi = firstPresent(rest.map((hit) => hit.record), "doi");
  }
  if (isBlank(merged.arxivId)) {
    merged.arxivId = firstPresent(rest.map((hit) => hit.record), "arxivId");
  }
  if (isBlank(merged.url)) {
    merged.url = firstPresent(rest.map((hit) => hit.record), "url");
  }
  if (isBlank(merged.abstract)) {
    merged.abstract = firstPresent(rest.map((hit) => hit.record), "abstract");
  }
  return merged;
}

/** 标量聚合：引用数取最大（各库统计口径不同，取保守最大）；OA 任一来源为真即真 */
function mergeScalars(hits: AcademicSearchResult[]): { citationCount?: number; openAccess?: boolean } {
  const counts = hits
    .map((hit) => hit.citationCount)
    .filter((count): count is number => typeof count === "number");
  return {
    ...(counts.length > 0 ? { citationCount: Math.max(...counts) } : {}),
    ...(hits.some((hit) => hit.openAccess === true) ? { openAccess: true } : {}),
  };
}

function bestSourceWeight(result: FusedAcademicResult): number {
  return result.sources.length > 0 ? providerWeight(result.sources[0]!.provider) : 0;
}

function bestRank(result: FusedAcademicResult): number {
  return result.sources.reduce((min, source) => Math.min(min, source.rank), Number.MAX_SAFE_INTEGER);
}
