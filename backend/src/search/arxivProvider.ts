/**
 * ArxivSearchProvider：preprint discovery（D-0033 §4）。
 *
 * 定位：预印本补充，不是全学科主库。`GET /api/query`（Atom XML）：
 * `search_query=all:<query>&sortBy=relevance&sortOrder=descending`。
 * XML 解析沿用 scholarly.ts ArxivLookupProvider 的轻量正则模式（仓库既有能力，
 * 不为 arXiv 引入 XML 框架）。arXiv 无年份 / OA 原生过滤（全部 OA）→ 年份客户端过滤。
 */

import { buildIdentity, normalizeArxivId, type SourceIdentity } from "../sources/identity.js";
import type { CanonicalPaperRecord } from "../citation/integrity.js";
import type { ProviderHttpClient } from "./providerHttp.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "./types.js";
import { clampLimit } from "./openalexProvider.js";

const QUERY_URL = "https://export.arxiv.org/api/query";

export interface ArxivSearchProviderOptions {
  http: ProviderHttpClient;
  userAgent?: string;
}

export class ArxivSearchProvider implements AcademicSearchProvider {
  readonly name = "arxiv";
  private readonly http: ProviderHttpClient;
  private readonly userAgent: string;

  constructor(options: ArxivSearchProviderOptions) {
    this.http = options.http;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (research discovery)";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResult[]> {
    const limit = clampLimit(opts.limit);
    const params = new URLSearchParams({
      search_query: `all:${query}`,
      start: "0",
      max_results: String(limit),
      sortBy: "relevance",
      sortOrder: "descending",
    });
    const xml = await this.http.fetchText({ name: this.name }, `${QUERY_URL}?${params.toString()}`, {
      signal: opts.signal,
      headers: { "User-Agent": this.userAgent },
    });
    const results: AcademicSearchResult[] = [];
    let rank = 0;
    for (const block of [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? "")) {
      const mapped = toResult(block);
      if (mapped === null) {
        continue;
      }
      // 客户端年份过滤（arXiv API 无原生 year filter；按 published 日期推导年份）
      const year = mapped.identity.year;
      if (opts.yearFrom !== undefined && (year === undefined || year < opts.yearFrom)) {
        continue;
      }
      if (opts.yearTo !== undefined && (year === undefined || year > opts.yearTo)) {
        continue;
      }
      rank += 1;
      results.push({ ...mapped, relevance: { provider: "arxiv", rank } });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  healthSnapshot() {
    return this.http.health(this.name);
  }
}

function toResult(block: string): AcademicSearchResult | null {
  const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "");
  if (title === "") {
    return null;
  }
  const idRaw = /<id>http:\/\/arxiv\.org\/abs\/([^<\s]+)<\/id>/.exec(block)?.[1];
  const arxivId = idRaw !== undefined ? normalizeArxivId(idRaw) : undefined;
  const authors = [...block.matchAll(/<author>([\s\S]*?)<\/author>/g)]
    .map((match) => decodeXml(/<name>([\s\S]*?)<\/name>/.exec(match[1] ?? "")?.[1] ?? ""))
    .filter((name) => name !== "");
  const published = decodeXml(/<published>([\s\S]*?)<\/published>/.exec(block)?.[1] ?? "");
  const year = /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : undefined;
  const abstract = decodeXml(/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? "");
  const identity: SourceIdentity | null = buildIdentity({
    ...(arxivId !== undefined ? { arxivId } : {}),
    title,
    ...(authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(arxivId !== undefined ? { url: `https://arxiv.org/abs/${arxivId}` } : {}),
  });
  if (identity === null) {
    return null;
  }
  const record: CanonicalPaperRecord = {
    provider: "arxiv",
    recordId: arxivId ?? "",
    title,
    ...(authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(arxivId !== undefined ? { arxivId } : {}),
    ...(arxivId !== undefined ? { url: `https://arxiv.org/abs/${arxivId}` } : {}),
    ...(abstract !== "" ? { abstract: abstract.slice(0, 3000) } : {}),
    retrievedAt: new Date().toISOString(),
  };
  return {
    identity,
    record,
    // arXiv 全部开放获取
    openAccess: true,
    relevance: { provider: "arxiv", rank: 0 },
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
