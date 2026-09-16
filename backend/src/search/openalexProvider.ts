/**
 * OpenAlexSearchProvider：Academic Discovery **primary**（D-0033 §4）。
 *
 * 最小能力集（openalex-mcp「薄原语」裁定，分析报告 §8.3——外围编排后补、原语不能缺）：
 * - search works：`GET /works?search=<query>&per-page=<n>`（默认按相关性排序）；
 * - filter 最小集：publication_year 区间 / is_oa；mailto 礼貌池（config，可选）；
 * - 响应投影：title / authors / year / venue / doi / 摘要重建（倒排索引）/
 *   openalexId / cited_by_count / open_access。
 *
 * 不实现：authors / institutions / topics / funders / publishers / autocomplete /
 * group_by / cursor 深分页（Discovery 不需要）。请求失败全部经 ProviderHttpClient
 * （超时 / 重试 / 429 Retry-After / 熔断），provider 自身不写第二套 retry。
 */

import { rebuildAbstract } from "../citation/scholarly.js";
import { buildIdentity, normalizeDoi, type SourceIdentity } from "../sources/identity.js";
import type { CanonicalPaperRecord } from "../citation/integrity.js";
import type { ProviderHttpClient } from "./providerHttp.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "./types.js";

const BASE_URL = "https://api.openalex.org/works";
/** OpenAlex 单页上限 200；Discovery 单源 ≤ 25（ADR §12） */
const PER_PROVIDER_LIMIT_CAP = 25;

export interface OpenAlexSearchProviderOptions {
  http: ProviderHttpClient;
  /** 礼貌池标识（PAPERTEAM_OPENALEX_MAILTO / CITATION_CONTACT_EMAIL；可选） */
  mailto?: string;
  userAgent?: string;
}

export class OpenAlexSearchProvider implements AcademicSearchProvider {
  readonly name = "openalex";
  private readonly http: ProviderHttpClient;
  private readonly mailto?: string;
  private readonly userAgent: string;

  constructor(options: OpenAlexSearchProviderOptions) {
    this.http = options.http;
    this.mailto = options.mailto;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (research discovery)";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResult[]> {
    const limit = clampLimit(opts.limit);
    const url = this.buildUrl(query, limit, opts);
    const body = await this.http.fetchJson<Record<string, unknown>>(
      { name: this.name },
      url,
      {
        signal: opts.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(this.mailto !== undefined ? { "X-User-Agent": `mailto:${this.mailto}` } : {}),
        },
      },
    );
    const items = Array.isArray(body["results"]) ? (body["results"] as Array<Record<string, unknown>>) : [];
    const results: AcademicSearchResult[] = [];
    for (const [index, item] of items.slice(0, limit).entries()) {
      const mapped = toResult(item, index);
      if (mapped !== null) {
        results.push(mapped);
      }
    }
    return results;
  }

  private buildUrl(query: string, limit: number, opts: SearchOptions): string {
    const params = new URLSearchParams();
    params.set("search", query);
    params.set("per-page", String(limit));
    const filters: string[] = [];
    if (opts.yearFrom !== undefined && opts.yearTo !== undefined) {
      filters.push(`publication_year:${opts.yearFrom}-${opts.yearTo}`);
    } else if (opts.yearFrom !== undefined) {
      filters.push(`publication_year:>${opts.yearFrom - 1}`);
    } else if (opts.yearTo !== undefined) {
      filters.push(`publication_year:<${opts.yearTo + 1}`);
    }
    if (opts.openAccessOnly === true) {
      filters.push("is_oa:true");
    }
    if (filters.length > 0) {
      params.set("filter", filters.join(","));
    }
    if (this.mailto !== undefined) {
      params.set("mailto", this.mailto);
    }
    return `${BASE_URL}?${params.toString()}`;
  }

  healthSnapshot() {
    return this.http.health(this.name);
  }
}

/** provider 结果 → AcademicSearchResult（identity 缺强键时为 null：无判等键的记录不进融合） */
function toResult(item: Record<string, unknown>, index: number): AcademicSearchResult | null {
  const title = typeof item["title"] === "string" && item["title"].trim() !== "" ? item["title"] : undefined;
  const doiRaw = typeof item["doi"] === "string" ? item["doi"] : undefined;
  const doi = doiRaw !== undefined ? normalizeDoi(doiRaw) : undefined;
  const authors = Array.isArray(item["authorships"])
    ? (item["authorships"] as Array<Record<string, unknown>>)
        .map((authorship) => {
          const author = authorship["author"] as Record<string, unknown> | undefined;
          return typeof author?.["display_name"] === "string" ? (author["display_name"] as string) : "";
        })
        .filter((name) => name !== "")
    : undefined;
  const year = typeof item["publication_year"] === "number" ? (item["publication_year"] as number) : undefined;
  const openalexId =
    typeof item["ids"] === "object" && item["ids"] !== null
      ? String((item["ids"] as Record<string, unknown>)["openalex"] ?? "").replace("https://openalex.org/", "") ||
        undefined
      : undefined;
  const identity: SourceIdentity | null = buildIdentity({
    ...(doi !== undefined ? { doi } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(authors !== undefined && authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(openalexId !== undefined ? { openalexId } : {}),
    ...(doi !== undefined ? { url: `https://doi.org/${doi}` } : {}),
  });
  if (identity === null || identity.normalizedTitleFingerprint === "" || title === undefined) {
    return null;
  }
  const record: CanonicalPaperRecord = {
    provider: "openalex",
    recordId: openalexId ?? "",
    title,
    ...(authors !== undefined && authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(venueOf(item) !== undefined ? { venue: venueOf(item)! } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(doi !== undefined ? { url: `https://doi.org/${doi}` } : {}),
    ...(item["abstract_inverted_index"] != null && typeof item["abstract_inverted_index"] === "object"
      ? { abstract: rebuildAbstract(item["abstract_inverted_index"] as Record<string, number[]>) }
      : {}),
    retrievedAt: new Date().toISOString(),
  };
  return {
    identity,
    record,
    ...(typeof item["cited_by_count"] === "number" ? { citationCount: item["cited_by_count"] as number } : {}),
    ...(typeof (item["open_access"] as Record<string, unknown> | undefined)?.["is_oa"] === "boolean"
      ? { openAccess: (item["open_access"] as Record<string, unknown>)["is_oa"] as boolean }
      : {}),
    relevance: { provider: "openalex", rank: index + 1 },
  };
}

/** venue：primary_location.source（现行字段）优先，host_venue（旧字段）兜底 */
function venueOf(item: Record<string, unknown>): string | undefined {
  const primary = item["primary_location"] as Record<string, unknown> | null | undefined;
  const source =
    typeof primary === "object" && primary !== null ? (primary["source"] as Record<string, unknown> | null | undefined) : undefined;
  if (typeof source === "object" && source !== null && typeof source["display_name"] === "string" && source["display_name"] !== "") {
    return source["display_name"];
  }
  const host = item["host_venue"] as Record<string, unknown> | null | undefined;
  if (typeof host === "object" && host !== null && typeof host["display_name"] === "string" && host["display_name"] !== "") {
    return host["display_name"];
  }
  return undefined;
}

export function clampLimit(limit: number | undefined, cap = PER_PROVIDER_LIMIT_CAP, fallback = 10): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return fallback;
  }
  return Math.min(limit, cap);
}
