/**
 * M7.2 FullTextResolver 单元测试（全部离线：fetchImpl 注入假实现）。
 *
 * 覆盖：三 resolver（found / not_found / error / 404 归一 / 字段映射）、
 * 链构建（身份键 → 适用 resolver 与优先级）、默认装配（email 缺省降级）、
 * 下载护栏（SSRF 拒绝矩阵 / 逐跳重定向 / 大小帽 / %PDF- 魔数 / 文件名建议）、
 * ProviderHttpClient.fetchBytes（二进制往返 / 3xx 不跟随 / 超限截断）。
 */

import { describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import {
  applicableFullTextResolvers,
  ArxivPdfResolver,
  assertDownloadableUrl,
  buildDefaultFullTextResolvers,
  downloadPdf,
  isPrivateOrLocalHost,
  OpenAlexOaResolver,
  UnpaywallResolver,
  type FullTextResolver,
} from "../../src/search/fullText.js";
import { ProviderHttpError, ProviderHttpClient } from "../../src/search/providerHttp.js";
import { buildIdentity, type SourceIdentity } from "../../src/sources/identity.js";

/** 按 URL 前缀路由的假 fetch（重定向链友好；未命中 URL → 500） */
function routeFetch(routes: Record<string, () => Response>): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const target = String(url);
    urls.push(target);
    for (const [prefix, respond] of Object.entries(routes)) {
      if (target.startsWith(prefix)) {
        return respond();
      }
    }
    return new Response("no route", { status: 500 });
  };
  return { impl, urls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pdfResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "application/pdf", ...headers },
  });
}

function makeHttp(fetchImpl: typeof fetch): ProviderHttpClient {
  return new ProviderHttpClient({ fetchImpl, defaultTimeoutMs: 2_000, defaultMaxRetries: 0 });
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");

// ---- UnpaywallResolver ----

describe("UnpaywallResolver", () => {
  it("is_oa + url_for_pdf → found（license 透传；email 进查询参数）", async () => {
    const { impl, urls } = routeFetch({
      "https://api.unpaywall.org/": () =>
        jsonResponse({
          is_oa: true,
          best_oa_location: { url_for_pdf: "https://publisher.org/oa/paper.pdf", license: "cc-by" },
        }),
    });
    const resolver = new UnpaywallResolver({ http: makeHttp(impl), email: "team@example.org" });
    const identity = buildIdentity({ doi: "10.1234/abc.def" })!;
    const result = await resolver.resolve(identity);
    expect(result).toEqual({
      kind: "found",
      url: "https://publisher.org/oa/paper.pdf",
      source: "unpaywall",
      license: "cc-by",
    });
    expect(urls[0]).toContain("email=team%40example.org");
    expect(urls[0]).toContain(encodeURIComponent("10.1234/abc.def"));
  });

  it("仅有 landing page URL（无 url_for_pdf）→ not_found", async () => {
    const { impl } = routeFetch({
      "https://api.unpaywall.org/": () =>
        jsonResponse({ is_oa: false, best_oa_location: null }),
    });
    const resolver = new UnpaywallResolver({ http: makeHttp(impl), email: "team@example.org" });
    const result = await resolver.resolve(buildIdentity({ doi: "10.1234/closed" })!);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("404（DOI 不在库）→ not_found（error ≠ not_found 分层）", async () => {
    const { impl } = routeFetch({ "https://api.unpaywall.org/": () => jsonResponse({}, 404) });
    const resolver = new UnpaywallResolver({ http: makeHttp(impl), email: "team@example.org" });
    const result = await resolver.resolve(buildIdentity({ doi: "10.1234/unknown" })!);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("5xx → error（不折叠成 not_found）", async () => {
    const { impl } = routeFetch({ "https://api.unpaywall.org/": () => jsonResponse({}, 503) });
    const resolver = new UnpaywallResolver({ http: makeHttp(impl), email: "team@example.org" });
    const result = await resolver.resolve(buildIdentity({ doi: "10.1234/x" })!);
    expect(result.kind).toBe("error");
  });

  it("无 doi → not_found（不外呼）", async () => {
    const { impl, urls } = routeFetch({});
    const resolver = new UnpaywallResolver({ http: makeHttp(impl), email: "team@example.org" });
    const result = await resolver.resolve(buildIdentity({ arxivId: "2401.12345" })!);
    expect(result).toEqual({ kind: "not_found" });
    expect(urls).toHaveLength(0);
  });
});

// ---- OpenAlexOaResolver（ADR 名 oa-url） ----

describe("OpenAlexOaResolver", () => {
  it("doi → works/doi:{doi} 查询；pdf_url + license → found", async () => {
    const { impl, urls } = routeFetch({
      "https://api.openalex.org/works/doi:": () =>
        jsonResponse({
          best_oa_location: {
            pdf_url: "https://repo.example.org/bitstream/123.pdf",
            license: "https://creativecommons.org/licenses/by/4.0/",
          },
        }),
    });
    const resolver = new OpenAlexOaResolver({ http: makeHttp(impl), mailto: "team@example.org" });
    const result = await resolver.resolve(buildIdentity({ doi: "10.5555/oa.paper" })!);
    expect(result).toEqual({
      kind: "found",
      url: "https://repo.example.org/bitstream/123.pdf",
      source: "oa-url",
      license: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(urls[0]).toContain("mailto=team%40example.org");
  });

  it("openalexId（无 doi）→ works/W… 查询", async () => {
    const { impl, urls } = routeFetch({
      "https://api.openalex.org/works/W": () => jsonResponse({ best_oa_location: { pdf_url: "https://x.org/a.pdf" } }),
    });
    const resolver = new OpenAlexOaResolver({ http: makeHttp(impl) });
    // openalexId 不是独立身份键（真实身份总伴随 doi / 指纹）；手工构造隔离测 resolver 分支
    const identity: SourceIdentity = { openalexId: "W1234567890", normalizedTitleFingerprint: "" };
    const result = await resolver.resolve(identity);
    expect(result).toEqual({ kind: "found", url: "https://x.org/a.pdf", source: "oa-url" });
    expect(urls[0]).toContain("/works/W1234567890");
  });

  it("best_oa_location 缺 pdf_url → not_found；404 → not_found", async () => {
    const missing = routeFetch({
      "https://api.openalex.org/": () => jsonResponse({ best_oa_location: { landing_page_url: "https://x.org/paper" } }),
    });
    const resolver = new OpenAlexOaResolver({ http: makeHttp(missing.impl) });
    expect(await resolver.resolve(buildIdentity({ doi: "10.1234/no-pdf" })!)).toEqual({ kind: "not_found" });

    const notFound = routeFetch({ "https://api.openalex.org/": () => jsonResponse({}, 404) });
    const resolver2 = new OpenAlexOaResolver({ http: makeHttp(notFound.impl) });
    expect(await resolver2.resolve(buildIdentity({ doi: "10.1234/gone" })!)).toEqual({ kind: "not_found" });
  });

  it("无 doi / openalexId → not_found（不外呼）", async () => {
    const { impl, urls } = routeFetch({});
    const resolver = new OpenAlexOaResolver({ http: makeHttp(impl) });
    expect(await resolver.resolve(buildIdentity({ url: "https://example.org/page" })!)).toEqual({
      kind: "not_found",
    });
    expect(urls).toHaveLength(0);
  });
});

// ---- ArxivPdfResolver ----

describe("ArxivPdfResolver", () => {
  it("arxivId → 确定性 PDF URL（去版本号）", async () => {
    const resolver = new ArxivPdfResolver();
    const result = await resolver.resolve(buildIdentity({ arxivId: "2401.12345v3" })!);
    expect(result).toEqual({ kind: "found", url: "https://arxiv.org/pdf/2401.12345", source: "arxiv" });
  });

  it("无 arxivId → not_found", async () => {
    const resolver = new ArxivPdfResolver();
    expect(await resolver.resolve(buildIdentity({ doi: "10.1234/x" })!)).toEqual({ kind: "not_found" });
  });
});

// ---- 链构建与默认装配 ----

describe("applicableFullTextResolvers", () => {
  const all = [
    new UnpaywallResolver({ http: makeHttp(async () => new Response("{}")), email: "a@b.c" }),
    new OpenAlexOaResolver({ http: makeHttp(async () => new Response("{}")) }),
    new ArxivPdfResolver(),
  ];

  it("仅 doi → [unpaywall, oa-url]（正式版 OA 优先）", () => {
    const chain = applicableFullTextResolvers(all, buildIdentity({ doi: "10.1234/a" })!);
    expect(chain.map((resolver) => resolver.name)).toEqual(["unpaywall", "oa-url"]);
  });

  it("doi + arxivId → 三链（arXiv 预印本兜底在后）", () => {
    const identity = buildIdentity({ doi: "10.1234/a", arxivId: "2401.00001" })!;
    const chain = applicableFullTextResolvers(all, identity);
    expect(chain.map((resolver) => resolver.name)).toEqual(["unpaywall", "oa-url", "arxiv"]);
  });

  it("仅 arxivId → [arxiv]；仅 openalexId → [oa-url]", () => {
    expect(
      applicableFullTextResolvers(all, buildIdentity({ arxivId: "2401.00002" })!).map((r) => r.name),
    ).toEqual(["arxiv"]);
    const openalexOnly: SourceIdentity = { openalexId: "W99", normalizedTitleFingerprint: "" };
    expect(applicableFullTextResolvers(all, openalexOnly).map((r) => r.name)).toEqual(["oa-url"]);
  });

  it("url-only 身份 → 空链（Web 候选不可自动解析）", () => {
    expect(applicableFullTextResolvers(all, buildIdentity({ url: "https://x.org/p" })!)).toEqual([]);
  });
});

describe("buildDefaultFullTextResolvers", () => {
  it("无 email → 不注册 unpaywall（降级不失败）", () => {
    const resolvers = buildDefaultFullTextResolvers({ http: makeHttp(async () => new Response("{}")) });
    expect(resolvers.map((resolver) => resolver.name)).toEqual(["oa-url", "arxiv"]);
  });

  it("有 email → 三实现", () => {
    const resolvers = buildDefaultFullTextResolvers({
      http: makeHttp(async () => new Response("{}")),
      email: "team@example.org",
    });
    expect(resolvers.map((resolver) => resolver.name)).toEqual(["unpaywall", "oa-url", "arxiv"]);
  });
});

// ---- 下载护栏 ----

describe("isPrivateOrLocalHost / assertDownloadableUrl", () => {
  it.each([
    "localhost",
    "db.localhost",
    "printer.local",
    "gateway.internal",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::5",
    "::ffff:127.0.0.1",
  ])("%s → 判内网拒绝", (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(true);
  });

  it.each(["arxiv.org", "api.unpaywall.org", "8.8.8.8", "example.edu"])("%s → 公网放行", (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(false);
  });

  it("http / userinfo / 非 443 端口 / 内网 https → FULLTEXT_DOWNLOAD_FAILED", () => {
    expect(() => assertDownloadableUrl("http://arxiv.org/pdf/1")).toThrow(BusinessError);
    expect(() => assertDownloadableUrl("https://user:pass@arxiv.org/pdf/1")).toThrow(BusinessError);
    expect(() => assertDownloadableUrl("https://arxiv.org:8443/pdf/1")).toThrow(BusinessError);
    expect(() => assertDownloadableUrl("https://192.168.0.1/paper.pdf")).toThrow(BusinessError);
    expect(() => assertDownloadableUrl("https://[fd12::1]/paper.pdf")).toThrow(BusinessError);
    expect(() => assertDownloadableUrl("not-a-url")).toThrow(BusinessError);
  });

  it("合法 https 公网 URL → 放行并返回 URL", () => {
    expect(assertDownloadableUrl("https://arxiv.org/pdf/2401.12345").hostname).toBe("arxiv.org");
  });
});

describe("downloadPdf", () => {
  it("成功：公网 https + %PDF- 魔数 → 字节 + 建议文件名", async () => {
    const { impl } = routeFetch({
      "https://publisher.org/oa/": () => pdfResponse(PDF_BYTES),
    });
    const result = await downloadPdf("https://publisher.org/oa/great-paper.pdf", { http: makeHttp(impl) });
    expect(result.bytes.equals(PDF_BYTES)).toBe(true);
    expect(result.fileName).toBe("great-paper.pdf");
    expect(result.finalUrl).toBe("https://publisher.org/oa/great-paper.pdf");
  });

  it("URL 末段不安全 / 非 .pdf → 回退 fulltext.pdf", async () => {
    const { impl } = routeFetch({ "https://publisher.org/": () => pdfResponse(PDF_BYTES) });
    const a = await downloadPdf("https://publisher.org/download?file=1", { http: makeHttp(impl) });
    expect(a.fileName).toBe("fulltext.pdf");
    const b = await downloadPdf("https://publisher.org/paper final v2.pdf", { http: makeHttp(impl) });
    expect(b.fileName).toBe("fulltext.pdf");
  });

  it("非 PDF 字节（HTML 付费墙）→ FULLTEXT_DOWNLOAD_FAILED", async () => {
    const { impl } = routeFetch({
      "https://publisher.org/": () =>
        new Response("<html><body>paywall</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });
    await expect(downloadPdf("https://publisher.org/oa/x.pdf", { http: makeHttp(impl) })).rejects.toMatchObject({
      code: "FULLTEXT_DOWNLOAD_FAILED",
    });
  });

  it("重定向逐跳跟随（每跳重新校验；合法公网跳转可达）", async () => {
    const { impl, urls } = routeFetch({
      "https://arxiv.org/pdf/2401.1": () =>
        new Response(null, { status: 302, headers: { location: "https://export.arxiv.org/pdf/2401.1" } }),
      "https://export.arxiv.org/": () => pdfResponse(PDF_BYTES),
    });
    const result = await downloadPdf("https://arxiv.org/pdf/2401.1", { http: makeHttp(impl) });
    expect(result.finalUrl).toBe("https://export.arxiv.org/pdf/2401.1");
    expect(urls).toHaveLength(2);
  });

  it("重定向到内网 → 拒绝；相对 Location 基于当前 URL 解析", async () => {
    const { impl } = routeFetch({
      "https://cdn.example.org/": () =>
        new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } }),
    });
    await expect(
      downloadPdf("https://cdn.example.org/paper.pdf", { http: makeHttp(impl) }),
    ).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED" });

    const relative = routeFetch({
      "https://cdn.example.org/v1/x.pdf": () =>
        new Response(null, { status: 302, headers: { location: "/v2/x.pdf" } }),
      "https://cdn.example.org/v2/": () => pdfResponse(PDF_BYTES),
    });
    const ok = await downloadPdf("https://cdn.example.org/v1/x.pdf", { http: makeHttp(relative.impl) });
    expect(ok.finalUrl).toBe("https://cdn.example.org/v2/x.pdf");
  });

  it("重定向超过 5 跳 → 拒绝", async () => {
    const { impl } = routeFetch({
      "https://hop.example.org/": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://hop.example.org/next" },
        }),
    });
    await expect(
      downloadPdf("https://hop.example.org/start.pdf", { http: makeHttp(impl) }),
    ).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED" });
  });

  it("content-length 超上限 → 拒绝（预检不读体）", async () => {
    const { impl } = routeFetch({
      "https://big.example.org/": () =>
        pdfResponse(PDF_BYTES, { "Content-Length": String(21 * 1024 * 1024) }),
    });
    await expect(
      downloadPdf("https://big.example.org/huge.pdf", { http: makeHttp(impl) }),
    ).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED" });
  });

  it("流式超限（content-length 缺失）→ 截断拒绝", async () => {
    const bigBody = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(64 * 1024, 0x61), // 64KB 无 content-length 声明
    ]);
    const { impl } = routeFetch({
      "https://sneaky.example.org/": () =>
        new Response(new Uint8Array(bigBody), { status: 200, headers: { "Content-Type": "application/pdf" } }),
    });
    await expect(
      downloadPdf("https://sneaky.example.org/x.pdf", {
        http: makeHttp(impl),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED" });
  });
});

// ---- ProviderHttpClient.fetchBytes（基建层） ----

describe("ProviderHttpClient.fetchBytes", () => {
  it("二进制往返 + contentType；不跟随重定向（3xx 携带 location 冒泡）", async () => {
    const { impl } = routeFetch({
      "https://ok.example.org/file": () => pdfResponse(PDF_BYTES),
      "https://redir.example.org/": () =>
        new Response(null, { status: 302, headers: { location: "https://ok.example.org/file" } }),
    });
    const http = makeHttp(impl);
    const ok = await http.fetchBytes({ name: "test-download" }, "https://ok.example.org/file");
    expect(ok.bytes.equals(PDF_BYTES)).toBe(true);
    expect(ok.contentType).toContain("application/pdf");

    const error = await http
      .fetchBytes({ name: "test-download" }, "https://redir.example.org/a.pdf")
      .then(
        () => {
          throw new Error("expected: 3xx 应以错误冒泡");
        },
        (caught: unknown) => caught as ProviderHttpError,
      );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.kind).toBe("http_error");
    expect(error.status).toBe(302);
    expect(error.location).toBe("https://ok.example.org/file");
  });

  it("临时失败重试语义与文本路径一致（一次 500 后成功）", async () => {
    let call = 0;
    const impl = async (_url: string | URL | Request): Promise<Response> => {
      call += 1;
      if (call === 1) {
        return new Response("boom", { status: 500 });
      }
      return pdfResponse(PDF_BYTES);
    };
    const http = new ProviderHttpClient({ fetchImpl: impl, defaultTimeoutMs: 2_000, defaultMaxRetries: 1 });
    const result = await http.fetchBytes({ name: "retry-download" }, "https://flaky.example.org/x.pdf");
    expect(result.bytes.equals(PDF_BYTES)).toBe(true);
    expect(call).toBe(2);
  });
});

// ---- FullTextResolver 契约形状（ADR §12 冻结） ----

describe("FullTextResolution 形状", () => {
  it("三态判别联合可被调用方穷尽处理", async () => {
    const outcomes: FullTextResolutionKinds = { found: 0, not_found: 0, error: 0 };
    const fake: FullTextResolver = {
      name: "fake",
      async resolve() {
        return { kind: "not_found" };
      },
    };
    const resolution = await fake.resolve(buildIdentity({ doi: "10.1/x" })!);
    outcomes[resolution.kind] += 1;
    expect(outcomes.not_found).toBe(1);
  });
});

type FullTextResolutionKinds = Record<"found" | "not_found" | "error", number>;
