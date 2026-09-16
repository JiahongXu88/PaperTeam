/**
 * M6.3 Live search smoke（真实外部服务；默认跳过，不进默认 CI）。
 *
 * 运行：
 *   PAPERTEAM_LIVE_SMOKE=1 npx vitest run test/search/searchLive.smoke.test.ts
 * SearXNG live（可选，另需本地/远端 SearXNG 且已开启 JSON format）：
 *   PAPERTEAM_LIVE_SMOKE=1 PAPERTEAM_SEARXNG_LIVE_URL=http://127.0.0.1:8080 ...
 *
 * 结果单独记录；live API 不稳定不作为单测失败依据。
 */

import { describe, expect, it } from "vitest";

import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { OpenAlexSearchProvider } from "../../src/search/openalexProvider.js";
import { SemanticScholarSearchProvider } from "../../src/search/semanticScholarProvider.js";
import { ArxivSearchProvider } from "../../src/search/arxivProvider.js";
import { SearXNGProvider } from "../../src/search/searxngProvider.js";

const live = process.env["PAPERTEAM_LIVE_SMOKE"] === "1";
const searxngLive = process.env["PAPERTEAM_SEARXNG_LIVE_URL"];

describe.skipIf(!live)("M6.3 live academic search smoke（真实公网调用）", () => {
  const http = new ProviderHttpClient({ defaultTimeoutMs: 15_000, defaultMaxRetries: 1 });

  it(
    "OpenAlex：关键词发现检索（非标题查证）",
    { timeout: 60_000 },
    async () => {
      const provider = new OpenAlexSearchProvider({
        http,
        mailto: process.env["PAPERTEAM_OPENALEX_MAILTO"],
      });
      const results = await provider.search("multi-agent LLM systems", { limit: 5, yearFrom: 2023 });
      // eslint-disable-next-line no-console
      console.log(
        "[live] openalex:",
        JSON.stringify(results.map((r) => ({ title: r.record.title, doi: r.record.doi, year: r.record.year, cites: r.citationCount }))),
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.identity.doi !== undefined || r.identity.openalexId !== undefined)).toBe(true);
    },
  );

  it(
    "Semantic Scholar：匿名调用（受限如实报告）",
    { timeout: 60_000 },
    async () => {
      const provider = new SemanticScholarSearchProvider({ http, ...(process.env["PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY"] ? { apiKey: process.env["PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY"] } : {}) });
      try {
        const results = await provider.search("graph neural networks", { limit: 5 });
        // eslint-disable-next-line no-console
        console.log("[live] s2:", JSON.stringify(results.map((r) => ({ title: r.record.title, cites: r.citationCount }))));
        expect(Array.isArray(results)).toBe(true);
      } catch (error) {
        // 匿名 429 高发：如实记录为已知的限流形态，不算 smoke 失败
        // eslint-disable-next-line no-console
        console.log("[live] s2: 限流/失败（预期内形态）→", (error as { kind?: string }).kind ?? String(error));
        expect(["rate_limited", "timeout"]).toContain((error as { kind?: string }).kind ?? "other");
      }
    },
  );

  it(
    "arXiv：Atom 检索 + 健康状态",
    { timeout: 60_000 },
    async () => {
      const provider = new ArxivSearchProvider({ http });
      const results = await provider.search("transformer attention", { limit: 5 });
      // eslint-disable-next-line no-console
      console.log("[live] arxiv:", JSON.stringify(results.map((r) => ({ id: r.identity.arxivId, title: r.record.title }))));
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.identity.arxivId).toBeDefined();
    },
  );
});

describe.skipIf(!live || searxngLive === undefined)("M6.3 live SearXNG smoke（需本地 SearXNG + JSON format）", () => {
  it(
    "SearXNG JSON API：web 检索 + 引擎聚合",
    { timeout: 60_000 },
    async () => {
      const http = new ProviderHttpClient({ defaultTimeoutMs: 15_000, defaultMaxRetries: 1 });
      const provider = new SearXNGProvider({ http, baseUrl: searxngLive! });
      const results = await provider.search("multi-agent systems survey", { limit: 5 });
      // eslint-disable-next-line no-console
      console.log(
        "[live] searxng:",
        JSON.stringify({ count: results.length, engines: [...new Set(results.flatMap((r) => r.engines))], health: provider.healthSnapshot() }),
      );
      expect(results.length).toBeGreaterThan(0);
    },
  );
});
