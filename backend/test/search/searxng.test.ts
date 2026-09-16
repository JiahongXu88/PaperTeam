/**
 * SearXNGProvider + WebSearchService 单元测试（M6.3；指令 §43）。
 *
 * 全部 mock HTTP：正常 JSON / URL 归一 / 重复 URL 合并 / 服务离线 /
 * JSON API 未启用（403）/ 畸形响应 / 超时 / 未配置 optional / 后端可启动。
 */

import { describe, expect, it } from "vitest";

import { ProviderHttpClient, ProviderHttpError } from "../../src/search/providerHttp.js";
import { SearXNGProvider } from "../../src/search/searxngProvider.js";
import { WebSearchService } from "../../src/search/webSearchService.js";

function makeHttp(fetchImpl: typeof fetch): ProviderHttpClient {
  return new ProviderHttpClient({
    fetchImpl,
    now: () => 1_000_000,
    sleep: async () => {},
    defaultTimeoutMs: 100,
    defaultMaxRetries: 0,
  });
}

const searxngBody = (results: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  query: "test",
  results,
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [],
  ...extra,
});

describe("SearXNGProvider", () => {
  it("1. 正常 JSON 响应：字段归一映射（snippet/content → snippet；engines；score；rank）", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () =>
        new Response(
          JSON.stringify(
            searxngBody([
              { url: "https://example.com/page", title: "Example Page", content: "A snippet.", engine: "bing", engines: ["bing", "baidu"], score: 4.5, publishedDate: "2026-01-02T00:00:00Z" },
            ]),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
      baseUrl: "http://127.0.0.1:8080",
    });
    const results = await provider.search("test");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: "https://example.com/page",
      title: "Example Page",
      snippet: "A snippet.",
      engines: ["bing", "baidu"],
      score: 4.5,
      rank: 1,
      publishedDate: "2026-01-02T00:00:00Z",
      provider: "searxng",
    });
  });

  it("2. URL canonicalization：utm 清洗 / 参数排序 / 尾斜杠 / host 大小写", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async (_url) => {
        const requestUrl = String(_url);
        expect(requestUrl).toContain("format=json");
        expect(requestUrl).toContain("q=test");
        return new Response(
          JSON.stringify(
            searxngBody([
              { url: "https://Example.com/docs/?utm_source=bing&id=2&tag=x", title: "A", content: "c", engine: "baidu" },
            ]),
          ),
          { status: 200 },
        );
      }),
      baseUrl: "http://127.0.0.1:8080",
    });
    const results = await provider.search("test");
    expect(results[0]!.url).toBe("https://example.com/docs?id=2&tag=x");
  });

  it("3. 重复 URL 合并：engines 并集 / 分累加 / 更长标题摘要保留", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () =>
        new Response(
          JSON.stringify(
            searxngBody([
              { url: "https://example.com/a", title: "Short", content: "c1", engine: "bing", engines: ["bing"], score: 1 },
              { url: "https://example.com/a?utm_medium=cpc", title: "A Much Longer Title", content: "", engine: "baidu", engines: ["baidu"], score: 2 },
              { url: "https://example.com/b", title: "Other", content: "c3", engine: "bing", engines: ["bing"], score: 3 },
            ]),
          ),
          { status: 200 },
        ),
      ),
      baseUrl: "http://127.0.0.1:8080",
    });
    const results = await provider.search("test");
    expect(results).toHaveLength(2);
    const merged = results[0]!;
    expect(merged.url).toBe("https://example.com/a");
    expect(merged.engines.sort()).toEqual(["baidu", "bing"]);
    expect(merged.score).toBe(3); // 1 + 2
    expect(merged.title).toBe("A Much Longer Title");
  });

  it("4. 服务离线（连接拒绝）：类型化 network_error，provider 不崩溃", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8080");
      }),
      baseUrl: "http://127.0.0.1:8080",
    });
    await expect(provider.search("test")).rejects.toMatchObject({ kind: "network_error" });
    expect(provider.healthSnapshot().state).not.toBe("healthy");
  });

  it("5. JSON API 未启用（HTTP 403）：结构化 provider_misconfigured 语义", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () => new Response("Forbidden", { status: 403 })),
      baseUrl: "http://127.0.0.1:8080",
    });
    await expect(provider.search("test")).rejects.toMatchObject({
      kind: "business_error",
      message: expect.stringContaining("JSON API 未启用"),
    });
  });

  it("6. 畸形响应（200 但非 SearXNG 形状 / 非 JSON）：空结果或明确错误", async () => {
    const shape = new SearXNGProvider({
      http: makeHttp(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })),
      baseUrl: "http://127.0.0.1:8080",
    });
    await expect(shape.search("test")).resolves.toEqual([]);
    const notJson = new SearXNGProvider({
      http: makeHttp(async () => new Response("<html>login</html>", { status: 200 })),
      baseUrl: "http://127.0.0.1:8080",
    });
    await expect(notJson.search("test")).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("7. 超时：类型化 timeout", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted: provider timeout")));
          }),
      ),
      baseUrl: "http://127.0.0.1:8080",
    });
    await expect(provider.search("test")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("8. unresponsive_engines 非空 → health degraded（继续可用，如实标记）", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () =>
        new Response(
          JSON.stringify(
            searxngBody(
              [{ url: "https://example.com/ok", title: "OK", content: "c", engine: "bing", engines: ["bing"], score: 1 }],
              { unresponsive_engines: ["baidu: timeout"] },
            ),
          ),
          { status: 200 },
        ),
      ),
      baseUrl: "http://127.0.0.1:8080",
    });
    const results = await provider.search("test");
    expect(results).toHaveLength(1);
    expect(provider.healthSnapshot().state).toBe("degraded");
    expect(provider.healthSnapshot().lastError).toContain("baidu");
  });
});

describe("WebSearchService", () => {
  it("9. 未配置 SearXNG（providers 空）：结构化 SEARCH_PROVIDER_NOT_CONFIGURED", async () => {
    const service = new WebSearchService([]);
    expect(service.configured).toBe(false);
    await expect(service.search("test")).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_NOT_CONFIGURED",
    });
  });

  it("配置非法 URL：provider 构造即拒绝（不进服务栈）", () => {
    expect(() => {
      new SearXNGProvider({ http: makeHttp(async () => new Response("{}")), baseUrl: "not-a-url" }); // eslint-disable-line no-new
    }).toThrow(/PAPERTEAM_SEARXNG_URL/);
  });

  it("provider 失败上抛为结构化 SEARCH_ALL_PROVIDERS_FAILED", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () => {
        throw new TypeError("fetch failed");
      }),
      baseUrl: "http://127.0.0.1:8080",
    });
    const service = new WebSearchService([provider]);
    await expect(service.search("test")).rejects.toMatchObject({
      code: "SEARCH_ALL_PROVIDERS_FAILED",
      message: expect.stringContaining("searxng"),
    });
  });

  it("正常路径：degraded（引擎部分失败）如实进 diagnostics 与 status", async () => {
    const provider = new SearXNGProvider({
      http: makeHttp(async () =>
        new Response(
          JSON.stringify(
            searxngBody([{ url: "https://example.com/x", title: "X", content: "c", engines: ["bing"], score: 1 }], {
              unresponsive_engines: ["baidu: CAPTCHA"],
            }),
          ),
          { status: 200 },
        ),
      ),
      baseUrl: "http://127.0.0.1:8080",
    });
    const service = new WebSearchService([provider]);
    const response = await service.search("test");
    expect(response.status).toBe("degraded");
    expect(response.diagnostics.providers[0]).toMatchObject({ provider: "searxng", outcome: "degraded" });
  });
});
