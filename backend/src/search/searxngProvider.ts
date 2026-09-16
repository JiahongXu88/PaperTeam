/**
 * SearXNGProvider：唯一 WebSearchProvider 实现（D-0033 §2-2）。
 *
 * 经 HTTP 调用独立 SearXNG 服务（`GET /search?format=json`）；不做 bundled
 * subprocess、不复制其代码（AGPL 进程边界隔离，ADR §8）。SearXNG 是 optional：
 * 未配置 / 未启动 / JSON API 未启用时 Web Search 降级为结构化 unavailable /
 * misconfigured，PaperTeam 其余能力不受影响。
 *
 * 归一化：URL 经 identity.ts canonicalUrl（utm 清洗 / 参数排序 / 尾斜杠折叠）；
 * 同 canonical URL 多引擎命中合并（借 SearXNG merge 语义：engines 并集、分累加）。
 * `unresponsive_engines` 非空 → markDegraded（继续用，结果带 degraded 事实）。
 */

import { canonicalUrl } from "../sources/identity.js";
import { ProviderHttpError, type ProviderHttpClient } from "./providerHttp.js";
import type { ProviderHealthSnapshot } from "./providerHttp.js";
import type { SearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

export interface SearXNGProviderOptions {
  http: ProviderHttpClient;
  /** 例如 http://127.0.0.1:8080（compose 内 http://searxng:8080）；必填 */
  baseUrl: string;
  userAgent?: string;
}

export class SearXNGProvider implements WebSearchProvider {
  readonly name = "searxng";
  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(options: SearXNGProviderOptions) {
    this.http = options.http;
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(trimmed)) {
      throw new Error(`PAPERTEAM_SEARXNG_URL 必须是 http(s) URL："${options.baseUrl}"`);
    }
    this.baseUrl = trimmed;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (web search)";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<WebSearchResult[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 50);
    const params = new URLSearchParams({ q: query, format: "json", pageno: "1" });
    if (opts.language !== undefined && opts.language !== "") {
      params.set("language", opts.language);
    }
    let body: Record<string, unknown>;
    try {
      body = await this.http.fetchJson<Record<string, unknown>>(
        { name: this.name },
        `${this.baseUrl}/search?${params.toString()}`,
        { signal: opts.signal, headers: { "User-Agent": this.userAgent, Accept: "application/json" } },
      );
    } catch (error) {
      if (error instanceof ProviderHttpError && error.kind === "http_error" && error.status === 403) {
        // SearXNG：format 不在 settings.search.formats 白名单 → 403（默认只有 html）
        throw new ProviderHttpError(
          "business_error",
          this.name,
          `[searxng] JSON API 未启用（HTTP 403）：请在 SearXNG settings.yml 的 search.formats 中加入 json`,
          { status: 403 },
        );
      }
      throw error;
    }
    const unresponsive = Array.isArray(body["unresponsive_engines"])
      ? (body["unresponsive_engines"] as unknown[])
          .map((engine) => (typeof engine === "string" ? engine : String((engine as { engine?: string })?.engine ?? engine)))
          .filter((engine) => engine !== "")
      : [];
    if (unresponsive.length > 0) {
      this.http.markDegraded(this.name, `部分引擎无响应：${unresponsive.slice(0, 5).join(", ")}`);
    }
    const raw = Array.isArray(body["results"]) ? (body["results"] as Array<Record<string, unknown>>) : [];
    return mergeByUrl(raw, limit);
  }

  healthSnapshot(): ProviderHealthSnapshot {
    return this.http.health(this.name);
  }
}

/** 归一化 + canonical URL 去重合并（engines 并集 / 分累加 / 保留更长标题与摘要） */
function mergeByUrl(raw: Array<Record<string, unknown>>, limit: number): WebSearchResult[] {
  const merged = new Map<string, WebSearchResult>();
  let rank = 0;
  for (const item of raw) {
    const rawUrl = typeof item["url"] === "string" ? item["url"] : undefined;
    const title = typeof item["title"] === "string" ? item["title"] : "";
    if (rawUrl === undefined || title.trim() === "") {
      continue;
    }
    const url = canonicalUrl(rawUrl);
    if (url === undefined) {
      continue;
    }
    const snippet = typeof item["content"] === "string" ? item["content"].slice(0, 1200) : "";
    const engines = Array.isArray(item["engines"])
      ? (item["engines"] as unknown[]).filter((engine): engine is string => typeof engine === "string")
      : typeof item["engine"] === "string"
        ? [item["engine"] as string]
        : [];
    const score = typeof item["score"] === "number" ? (item["score"] as number) : 0;
    const publishedDate =
      typeof item["publishedDate"] === "string" && item["publishedDate"] !== "" ? item["publishedDate"] : undefined;
    const existing = merged.get(url);
    if (existing === undefined) {
      rank += 1;
      merged.set(url, {
        url,
        title,
        snippet,
        engines,
        score,
        rank,
        ...(publishedDate !== undefined ? { publishedDate } : {}),
        provider: "searxng",
      });
      continue;
    }
    // 同 canonical URL：engines 并集、分累加、取更长标题/摘要、日期取先出现的非空值
    existing.engines = [...new Set([...existing.engines, ...engines])];
    existing.score += score;
    if (existing.title.length < title.length) {
      existing.title = title;
    }
    if (existing.snippet.length < snippet.length) {
      existing.snippet = snippet;
    }
    if (existing.publishedDate === undefined && publishedDate !== undefined) {
      existing.publishedDate = publishedDate;
    }
  }
  // 返回前按（合并后分, 保留稳定序）重排——多引擎命中的排前
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, limit)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}
