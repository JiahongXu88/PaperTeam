/**
 * SemanticScholarSearchProvider：enrichment / fallback（D-0033 §4）。
 *
 * 角色约束（分析报告 §7）：S2 429/503 高发、匿名 ~1rps——不做系统唯一 primary；
 * 有 x-api-key 走正式额度，无 key 匿名调用（受限如实进 degraded / rate_limited，
 * 由 ProviderHttpClient 统一冷却，provider 不自判）。
 *
 * 能力：paper/search 关键词检索 + 引用数 / openAccessPdf / TLDR 级字段集。
 * 不做 citation graph（不在 M6.3）。
 */

import { buildIdentity, normalizeDoi, type SourceIdentity } from "../sources/identity.js";
import type { CanonicalPaperRecord } from "../citation/integrity.js";
import type { ProviderHttpClient } from "./providerHttp.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "./types.js";
import { clampLimit } from "./openalexProvider.js";

const SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

export interface SemanticScholarSearchProviderOptions {
  http: ProviderHttpClient;
  /** 可选 API Key（PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY）；无 key 匿名调用 */
  apiKey?: string;
  userAgent?: string;
}

export class SemanticScholarSearchProvider implements AcademicSearchProvider {
  readonly name = "semantic-scholar";
  private readonly http: ProviderHttpClient;
  private readonly apiKey?: string;
  private readonly userAgent: string;

  constructor(options: SemanticScholarSearchProviderOptions) {
    this.http = options.http;
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (research discovery)";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResult[]> {
    const limit = clampLimit(opts.limit);
    const fields = "title,authors,year,venue,externalIds,abstract,citationCount,isOpenAccess,openAccessPdf,publicationDate";
    const params = new URLSearchParams({ query, limit: String(limit), fields });
    const yearFilter = yearRangeParam(opts);
    if (yearFilter !== undefined) {
      params.set("year", yearFilter);
    }
    const body = await this.http.fetchJson<Record<string, unknown>>(
      { name: this.name },
      `${SEARCH_URL}?${params.toString()}`,
      {
        signal: opts.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(this.apiKey !== undefined ? { "x-api-key": this.apiKey } : {}),
        },
      },
    );
    const items = Array.isArray(body["data"]) ? (body["data"] as Array<Record<string, unknown>>) : [];
    const results: AcademicSearchResult[] = [];
    for (const [index, item] of items.entries()) {
      const mapped = toResult(item, index, opts);
      if (mapped !== null) {
        results.push(mapped);
      }
    }
    return results;
  }

  healthSnapshot() {
    return this.http.health(this.name);
  }
}

/** S2 year 过滤参数（原生支持 "2020-2023" / "2020-" / "-2023"）；OA 过滤无原生参数 → 客户端 */
function yearRangeParam(opts: SearchOptions): string | undefined {
  if (opts.yearFrom !== undefined && opts.yearTo !== undefined) {
    return `${opts.yearFrom}-${opts.yearTo}`;
  }
  if (opts.yearFrom !== undefined) {
    return `${opts.yearFrom}-`;
  }
  if (opts.yearTo !== undefined) {
    return `-${opts.yearTo}`;
  }
  return undefined;
}

function toResult(
  item: Record<string, unknown>,
  index: number,
  opts: SearchOptions,
): AcademicSearchResult | null {
  const title = typeof item["title"] === "string" && item["title"].trim() !== "" ? item["title"] : undefined;
  if (title === undefined) {
    return null;
  }
  const external = (item["externalIds"] ?? {}) as Record<string, unknown>;
  const doi = typeof external["DOI"] === "string" ? normalizeDoi(external["DOI"]) : undefined;
  const arxivId = typeof external["ArXiv"] === "string" ? external["ArXiv"] : undefined;
  const pmid = typeof external["PubMed"] === "string" ? external["PubMed"] : undefined;
  const s2Id = typeof item["paperId"] === "string" ? item["paperId"] : undefined;
  const authors = Array.isArray(item["authors"])
    ? (item["authors"] as Array<Record<string, unknown>>)
        .map((author) => (typeof author["name"] === "string" ? (author["name"] as string) : ""))
        .filter((name) => name !== "")
    : undefined;
  const year = typeof item["year"] === "number" ? (item["year"] as number) : undefined;
  const identity: SourceIdentity | null = buildIdentity({
    ...(doi !== undefined ? { doi } : {}),
    ...(arxivId !== undefined ? { arxivId } : {}),
    ...(pmid !== undefined ? { pmid } : {}),
    ...(s2Id !== undefined ? { s2Id } : {}),
    title,
    ...(authors !== undefined && authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
  });
  if (identity === null) {
    return null;
  }
  // 客户端过滤（provider 无原生参数的字段）
  if (opts.openAccessOnly === true && item["isOpenAccess"] !== true) {
    return null;
  }
  const venue = typeof item["venue"] === "string" && item["venue"] !== "" ? item["venue"] : undefined;
  const abstract = typeof item["abstract"] === "string" && item["abstract"] !== "" ? item["abstract"] : undefined;
  const record: CanonicalPaperRecord = {
    provider: "semantic-scholar",
    recordId: s2Id ?? "",
    title,
    ...(authors !== undefined && authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(venue !== undefined ? { venue } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(arxivId !== undefined ? { arxivId } : {}),
    ...(abstract !== undefined ? { abstract: abstract.slice(0, 3000) } : {}),
    ...(s2Id !== undefined ? { url: `https://www.semanticscholar.org/paper/${s2Id}` } : {}),
    retrievedAt: new Date().toISOString(),
  };
  return {
    identity,
    record,
    ...(typeof item["citationCount"] === "number" ? { citationCount: item["citationCount"] as number } : {}),
    ...(typeof item["isOpenAccess"] === "boolean" ? { openAccess: item["isOpenAccess"] as boolean } : {}),
    relevance: { provider: "semantic-scholar", rank: index + 1 },
  };
}
