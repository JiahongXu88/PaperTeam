/**
 * WebSearchService：Web 检索编排（M6.1 ADR §3）。
 *
 * SearXNG 是 optional 能力：未配置 PAPERTEAM_SEARXNG_URL → 结构化
 * SEARCH_PROVIDER_NOT_CONFIGURED（503），**不阻塞启动、不影响学术链路**。
 * 全部引擎无响应时 SearXNG 仍返回 200 + 空结果 + unresponsive_engines——
 * 如实进 degraded 诊断，不当作「互联网上没有」。
 */

import { BusinessError } from "../errors.js";
import type { ProviderHealthSnapshot } from "./providerHttp.js";
import type { SearchDiagnostics, SearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

export interface WebSearchResponse {
  status: "success" | "degraded";
  results: WebSearchResult[];
  diagnostics: SearchDiagnostics;
}

export class WebSearchService {
  private readonly providers: WebSearchProvider[];

  /** providers 为空 = 未配置（SearXNG optional；未来可加其他实现） */
  constructor(providers: WebSearchProvider[]) {
    this.providers = providers;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<WebSearchResponse> {
    if (this.providers.length === 0) {
      throw new BusinessError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "Web Search 未配置（需要独立 SearXNG 服务与 PAPERTEAM_SEARXNG_URL；详见 docs/DEPLOYMENT.md）",
      );
    }
    const provider = this.providers[0]!;
    const startedAt = Date.now();
    try {
      const results = await provider.search(query, opts);
      const health = provider.healthSnapshot();
      const degraded = health.state === "degraded";
      return {
        status: degraded ? "degraded" : "success",
        results,
        diagnostics: {
          providers: [
            {
              provider: provider.name,
              outcome: degraded ? "degraded" : "ok",
              resultCount: results.length,
              latencyMs: Date.now() - startedAt,
              ...(degraded && health.lastError !== undefined ? { note: health.lastError } : {}),
            },
          ],
          rawResultCount: results.length,
          fusedResultCount: results.length,
        },
      };
    } catch (error) {
      // 单一 provider 失败即 Web Search 失败（无第二 Web 源可降级）——结构化上抛
      const kind = (error as { kind?: string }).kind ?? "internal";
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      throw new BusinessError(
        "SEARCH_ALL_PROVIDERS_FAILED",
        `Web Search 失败（${provider.name}:${kind}）：${message}`,
      );
    }
  }

  healthSnapshots(): ProviderHealthSnapshot[] {
    return this.providers.map((provider) => provider.healthSnapshot());
  }

  get configured(): boolean {
    return this.providers.length > 0;
  }
}
