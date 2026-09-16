/**
 * Academic Providers 单元测试（M6.3；指令 §41）。
 *
 * 全部 mock HTTP（注入 fetchImpl + 假时钟零退避等待），不访问公网。
 * 覆盖：OpenAlex 查询映射/归一/DOI/缺字段/畸形/limit；S2 可选 key/429/归一；
 * arXiv Atom 解析/新旧 ID/PDF URL；AMiner HTTP-200 业务错误/缺 key 不注册/
 * 正常映射/付费端点不被调用。
 */

import { describe, expect, it } from "vitest";

import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { OpenAlexSearchProvider } from "../../src/search/openalexProvider.js";
import { SemanticScholarSearchProvider } from "../../src/search/semanticScholarProvider.js";
import { ArxivSearchProvider } from "../../src/search/arxivProvider.js";
import { AMinerSearchProvider } from "../../src/search/aminerProvider.js";

/** 记录请求并回放响应的假 fetch */
function recorder(responses: Array<(url: string, init?: RequestInit) => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let call = 0;
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(record);
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return response(record.url, init);
  };
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function makeHttp(fetchImpl: typeof fetch): ProviderHttpClient {
  return new ProviderHttpClient({
    fetchImpl,
    now: () => 1_000_000,
    sleep: async () => {},
    defaultTimeoutMs: 500,
    defaultMaxRetries: 0,
  });
}

// ---- OpenAlex ----

describe("OpenAlexSearchProvider", () => {
  it("查询映射：search / per-page / mailto / 年份与 OA filter", async () => {
    const rec = recorder([() => json({ results: [] })]);
    const provider = new OpenAlexSearchProvider({ http: makeHttp(rec.impl), mailto: "team@example.com" });
    await provider.search("multi-agent survey", { limit: 7, yearFrom: 2022, yearTo: 2024, openAccessOnly: true });
    const url = new URL(rec.calls[0]!.url);
    expect(url.hostname).toBe("api.openalex.org");
    expect(url.pathname).toBe("/works");
    expect(url.searchParams.get("search")).toBe("multi-agent survey");
    expect(url.searchParams.get("per-page")).toBe("7");
    expect(url.searchParams.get("mailto")).toBe("team@example.com");
    expect(url.searchParams.get("filter")).toBe("publication_year:2022-2024,is_oa:true");
    expect(rec.calls[0]!.headers["X-User-Agent"]).toBe("mailto:team@example.com");
  });

  it("响应归一化：DOI 小写剥离前缀 / 摘要倒排重建 / venue / 引用数 / OA", async () => {
    const rec = recorder([
      () =>
        json({
          results: [
            {
              id: "https://openalex.org/W123",
              title: "Attention Is All You Need",
              doi: "https://doi.org/10.5555/3294771.3295065",
              publication_year: 2017,
              authorships: [{ author: { display_name: "Ashish Vaswani" } }, { author: { display_name: "Noam Shazeer" } }],
              primary_location: { source: { display_name: "NeurIPS" } },
              cited_by_count: 100000,
              open_access: { is_oa: true },
              ids: { openalex: "https://openalex.org/W123" },
              abstract_inverted_index: { Hello: [0], world: [1] },
            },
          ],
        }),
    ]);
    const provider = new OpenAlexSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("attention");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.identity.doi).toBe("10.5555/3294771.3295065");
    expect(result.identity.openalexId).toBe("W123");
    expect(result.identity.firstAuthorFamily).toBe("vaswani");
    expect(result.record.title).toBe("Attention Is All You Need");
    expect(result.record.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(result.record.venue).toBe("NeurIPS");
    expect(result.record.abstract).toBe("Hello world");
    expect(result.citationCount).toBe(100000);
    expect(result.openAccess).toBe(true);
    expect(result.relevance).toEqual({ provider: "openalex", rank: 1 });
    expect(result.record.url).toBe("https://doi.org/10.5555/3294771.3295065");
  });

  it("缺字段（无 DOI / 无作者 / 无摘要）：条目仍可用，字段省缺不伪造", async () => {
    const rec = recorder([
      () => json({ results: [{ title: "Plain Preprint Note", publication_year: 2023 }] }),
    ]);
    const provider = new OpenAlexSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("note");
    expect(results).toHaveLength(1);
    expect(results[0]!.identity.doi).toBeUndefined();
    expect(results[0]!.record.authors).toBeUndefined();
    expect(results[0]!.record.abstract).toBeUndefined();
  });

  it("畸形 payload（results 非数组 / 非 JSON）：空结果或明确错误，不崩溃", async () => {
    const rec = recorder([() => json({ foo: "bar" }), () => new Response("not json", { status: 200 })]);
    const provider = new OpenAlexSearchProvider({ http: makeHttp(rec.impl) });
    await expect(provider.search("x")).resolves.toEqual([]);
    await expect(provider.search("x")).rejects.toMatchObject({ kind: "network_error" });
  });

  it("limit 钳制：>25 截到 25；无 title 条目被丢弃", async () => {
    const rec = recorder([
      () => json({ results: [{ publication_year: 2020 }, { title: "ok" }] }),
    ]);
    const provider = new OpenAlexSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("x", { limit: 99 });
    expect(new URL(rec.calls[0]!.url).searchParams.get("per-page")).toBe("25");
    expect(results.map((r) => r.record.title)).toEqual(["ok"]); // 无 title 条目丢弃
  });
});

// ---- Semantic Scholar ----

describe("SemanticScholarSearchProvider", () => {
  const s2Body = {
    data: [
      {
        paperId: "abc123",
        title: "BERT: Pre-training of Deep Bidirectional Transformers",
        authors: [{ name: "Jacob Devlin" }],
        year: 2019,
        venue: "NAACL",
        externalIds: { DOI: "10.18653/v1/n19-1423", ArXiv: "1810.04805" },
        abstract: "We introduce BERT.",
        citationCount: 50000,
        isOpenAccess: true,
      },
    ],
  };

  it("元数据归一化：DOI/arXiv/externalIds/引用数/OA/年度过滤参数", async () => {
    const rec = recorder([() => json(s2Body)]);
    const provider = new SemanticScholarSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("bert", { yearFrom: 2019, yearTo: 2020 });
    const url = new URL(rec.calls[0]!.url);
    expect(url.searchParams.get("query")).toBe("bert");
    expect(url.searchParams.get("year")).toBe("2019-2020");
    expect(url.searchParams.get("fields")).toContain("externalIds");
    expect(rec.calls[0]!.headers["x-api-key"]).toBeUndefined(); // 无 key 匿名
    const result = results[0]!;
    expect(result.identity.doi).toBe("10.18653/v1/n19-1423");
    expect(result.identity.arxivId).toBe("1810.04805");
    expect(result.identity.s2Id).toBe("abc123");
    expect(result.record.venue).toBe("NAACL");
    expect(result.citationCount).toBe(50000);
    expect(result.openAccess).toBe(true);
  });

  it("可选 API key：x-api-key 头只在配置时出现", async () => {
    const rec = recorder([() => json(s2Body)]);
    const provider = new SemanticScholarSearchProvider({ http: makeHttp(rec.impl), apiKey: "secret-key" });
    await provider.search("bert");
    expect(rec.calls[0]!.headers["x-api-key"]).toBe("secret-key");
  });

  it("429：类型化 rate_limited（HTTP 层纪律，provider 不自写 retry）", async () => {
    const rec = recorder([() => json({ message: "Too Many Requests" }, 429, { "Retry-After": "30" })]);
    const provider = new SemanticScholarSearchProvider({ http: makeHttp(rec.impl) });
    await expect(provider.search("bert")).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
  });

  it("openAccessOnly 客户端过滤（无原生参数）", async () => {
    const rec = recorder([
      () =>
        json({
          data: [
            { ...s2Body.data[0]!, isOpenAccess: false },
            s2Body.data[0],
          ],
        }),
    ]);
    const provider = new SemanticScholarSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("bert", { openAccessOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.openAccess).toBe(true);
  });
});

// ---- arXiv ----

describe("ArxivSearchProvider", () => {
  const atom = (entries: string[]) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${entries.join("\n")}
</feed>`;

  const entryNew = `<entry>
  <id>http://arxiv.org/abs/2401.12345v2</id>
  <updated>2024-02-01T00:00:00Z</updated>
  <published>2024-01-21T00:00:00Z</published>
  <title>A New Preprint on  Agents</title>
  <summary>We study multi-agent systems.</summary>
  <author><name>Alice Zhang</name></author>
  <author><name>Bob Li</name></author>
  <link href="http://arxiv.org/pdf/2401.12345v2" rel="related" title="pdf"/>
</entry>`;

  const entryOld = `<entry>
  <id>http://arxiv.org/abs/cs/0501034</id>
  <published>2005-01-20T00:00:00Z</published>
  <title>Old Style Identifier Paper</title>
  <summary>Legacy.</summary>
  <author><name>Carol Wu</name></author>
</entry>`;

  it("查询映射 + Atom 解析（新式 ID 去版本号 / 作者 / 年份 / 摘要 / PDF URL）", async () => {
    const rec = recorder([() => new Response(atom([entryNew, entryOld]), { status: 200 })]);
    const provider = new ArxivSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("multi-agent", { limit: 5 });
    const url = new URL(rec.calls[0]!.url);
    expect(url.hostname).toBe("export.arxiv.org");
    expect(url.searchParams.get("search_query")).toBe("all:multi-agent");
    expect(url.searchParams.get("sortBy")).toBe("relevance");
    expect(results).toHaveLength(2);
    const first = results[0]!;
    expect(first.identity.arxivId).toBe("2401.12345"); // v2 剥离
    expect(first.identity.year).toBe(2024);
    expect(first.record.authors).toEqual(["Alice Zhang", "Bob Li"]);
    expect(first.record.abstract).toContain("multi-agent systems");
    expect(first.openAccess).toBe(true);
    expect(first.relevance.rank).toBe(1);
    const second = results[1]!;
    expect(second.identity.arxivId).toBe("cs/0501034"); // 老式分类编号
    expect(second.identity.year).toBe(2005);
  });

  it("年份客户端过滤", async () => {
    const rec = recorder([() => new Response(atom([entryNew, entryOld]), { status: 200 })]);
    const provider = new ArxivSearchProvider({ http: makeHttp(rec.impl) });
    const results = await provider.search("x", { yearFrom: 2020 });
    expect(results).toHaveLength(1);
    expect(results[0]!.identity.arxivId).toBe("2401.12345");
  });

  it("畸形 XML（无 entry）：空结果", async () => {
    const rec = recorder([() => new Response("<html>bad gateway</html>", { status: 200 })]);
    const provider = new ArxivSearchProvider({ http: makeHttp(rec.impl) });
    await expect(provider.search("x")).resolves.toEqual([]);
  });
});

// ---- AMiner ----

describe("AMinerSearchProvider", () => {
  const card = {
    id: "63a7b8c9d0e1f2a3",
    title: "Deep Learning for Chinese NLP",
    doi: "10.1000/aminer-1",
    first_author: "Xu Jiahong",
    year: 2022,
    venue_name: "中文信息学报",
    n_citation_bucket: "10-50",
  };

  it("正常响应：免费端点映射（Authorization 裸 token / aminerId / 无摘要如实缺省）", async () => {
    const rec = recorder([() => json({ code: 200, msg: "success", data: { data: [card] } })]);
    const provider = new AMinerSearchProvider({ http: makeHttp(rec.impl), apiKey: "aminer-token" });
    const results = await provider.search("中文 NLP", { limit: 5 });
    const url = new URL(rec.calls[0]!.url);
    expect(url.pathname).toBe("/gateway/open_platform/api/paper/search"); // 免费端点
    expect(url.searchParams.get("title")).toBe("中文 NLP");
    expect(url.searchParams.get("size")).toBe("5");
    expect(rec.calls[0]!.headers["Authorization"]).toBe("aminer-token"); // 无 Bearer 前缀
    const result = results[0]!;
    expect(result.identity.aminerId).toBe("63a7b8c9d0e1f2a3");
    expect(result.identity.doi).toBe("10.1000/aminer-1");
    // AMiner first_author 是「姓 名」中文序；M6.2 firstAuthorFamily 对自然序名取
    // 末词（西方序启发）→ "jiahong"。判等主键是 DOI，family 只是 tier-4 弱键成分。
    expect(result.identity.firstAuthorFamily).toBe("jiahong");
    expect(result.record.venue).toBe("中文信息学报");
    expect(result.record.abstract).toBeUndefined(); // 免费层无摘要，不伪造
    expect(result.record.url).toBe("https://www.aminer.cn/pub/63a7b8c9d0e1f2a3");
  });

  it("HTTP 200 + 信封 40306 → rate_limited（不是空结果，不是 healthy）", async () => {
    const rec = recorder([() => json({ code: 40306, msg: "rate limited" })]);
    const provider = new AMinerSearchProvider({ http: makeHttp(rec.impl), apiKey: "t" });
    await expect(provider.search("x")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(provider.healthSnapshot().state).toBe("rate_limited");
  });

  it("HTTP 200 + 信封 40301（permission_denied）→ business_error，不 healthy 不熔断", async () => {
    const rec = recorder([() => json({ code: 40301, msg: "no permission" })]);
    const provider = new AMinerSearchProvider({ http: makeHttp(rec.impl), apiKey: "t" });
    await expect(provider.search("x")).rejects.toMatchObject({ kind: "business_error", status: 40301 });
    const health = provider.healthSnapshot();
    expect(health.state).toBe("degraded");
    expect(health.circuit).toBe("closed");
  });

  it("openAccessOnly：免费层无 OA 字段 → 无法判定不放行（不猜测）", async () => {
    const rec = recorder([() => json({ code: 0, data: [card] })]);
    const provider = new AMinerSearchProvider({ http: makeHttp(rec.impl), apiKey: "t" });
    await expect(provider.search("x", { openAccessOnly: true })).resolves.toEqual([]);
  });

  it("成本护栏：任何请求都只打免费路径，不含 pro / qa / relation 等付费端点", async () => {
    const rec = recorder([
      () => json({ code: 0, data: [] }),
      () => json({ code: 40306, msg: "limited" }),
    ]);
    const provider = new AMinerSearchProvider({ http: makeHttp(rec.impl), apiKey: "t" });
    await provider.search("x");
    await expect(provider.search("x")).rejects.toMatchObject({ kind: "rate_limited" });
    for (const call of rec.calls) {
      expect(call.url).toContain("/api/paper/search?");
      expect(call.url).not.toMatch(/pro|qa|relation|detail|person|org/i);
    }
  });
});
