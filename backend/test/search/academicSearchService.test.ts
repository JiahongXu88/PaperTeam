/**
 * AcademicSearchService + 融合去重单元测试（M6.3；指令 §42）。
 *
 * 用 fake AcademicSearchProvider 精确控制结果与失败，不访问公网。
 * 覆盖：单源成功 / primary 失败 fallback / partial / 全失败 / DOI·arXiv 去重 /
 * 互补元数据合并 / preprint-正式版不 collapse / 确定性 RRF / limit / 超时隔离 /
 * 健康状态反映。
 */

import { describe, expect, it } from "vitest";

import { AcademicSearchService } from "../../src/search/academicSearchService.js";
import { buildIdentity, type SourceIdentity } from "../../src/sources/identity.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "../../src/search/types.js";
import { ProviderHttpError } from "../../src/search/providerHttp.js";
import type { ProviderHealthSnapshot } from "../../src/search/providerHttp.js";

function makeResult(
  provider: string,
  rank: number,
  fields: { doi?: string; arxivId?: string; title: string; year?: number; abstract?: string; authors?: string[] },
): AcademicSearchResult {
  const identity: SourceIdentity = buildIdentity({
    ...(fields.doi !== undefined ? { doi: fields.doi } : {}),
    ...(fields.arxivId !== undefined ? { arxivId: fields.arxivId } : {}),
    title: fields.title,
    ...(fields.authors !== undefined ? { authors: fields.authors } : {}),
    ...(fields.year !== undefined ? { year: fields.year } : {}),
  })!;
  return {
    identity,
    record: {
      provider: provider as "openalex",
      recordId: `${provider}-${rank}`,
      title: fields.title,
      ...(fields.authors !== undefined ? { authors: fields.authors } : {}),
      ...(fields.year !== undefined ? { year: fields.year } : {}),
      ...(fields.doi !== undefined ? { doi: fields.doi } : {}),
      ...(fields.arxivId !== undefined ? { arxivId: fields.arxivId } : {}),
      ...(fields.abstract !== undefined ? { abstract: fields.abstract } : {}),
      retrievedAt: "2026-09-16T00:00:00Z",
    },
    relevance: { provider, rank },
  };
}

class FakeProvider implements AcademicSearchProvider {
  healthState: ProviderHealthSnapshot = {
    provider: "x",
    state: "healthy",
    circuit: "closed",
    consecutiveFailures: 0,
  };
  calls = 0;
  behavior: (query: string, opts?: SearchOptions) => Promise<AcademicSearchResult[]>;

  constructor(
    readonly name: string,
    behavior: (query: string, opts?: SearchOptions) => Promise<AcademicSearchResult[]>,
  ) {
    this.behavior = behavior;
  }

  async search(query: string, opts?: SearchOptions): Promise<AcademicSearchResult[]> {
    this.calls += 1;
    return this.behavior(query, opts);
  }

  healthSnapshot(): ProviderHealthSnapshot {
    return { ...this.healthState, provider: this.name };
  }

  static failing(name: string, kind: "timeout" | "rate_limited" | "network_error" = "timeout"): FakeProvider {
    const provider = new FakeProvider(name, async () => {
      throw new ProviderHttpError(kind, name, `[${name}] simulated ${kind}`);
    });
    provider.healthState = {
      provider: name,
      state: kind === "rate_limited" ? "rate_limited" : "unavailable",
      circuit: "closed",
      consecutiveFailures: 3,
    };
    return provider;
  }
}

function service(providers: AcademicSearchProvider[]) {
  return new AcademicSearchService({ providers, concurrency: 4 });
}

describe("AcademicSearchService", () => {
  it("1. OpenAlex only 成功：status=success", async () => {
    const openalex = new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, { title: "Paper A", doi: "10.1000/a", year: 2023, authors: ["Alice Chen"] }),
    ]);
    const response = await service([openalex]).search("topic");
    expect(response.status).toBe("success");
    expect(response.results).toHaveLength(1);
    expect(response.diagnostics.providers).toEqual([
      expect.objectContaining({ provider: "openalex", outcome: "ok", resultCount: 1 }),
    ]);
  });

  it("2. primary 失败 + fallback 成功：整体成功且不拖垮", async () => {
    const openalex = FakeProvider.failing("openalex");
    const s2 = new FakeProvider("semantic-scholar", async () => [
      makeResult("semantic-scholar", 1, { title: "Fallback Hit", doi: "10.2000/b", year: 2024 }),
    ]);
    const response = await service([openalex, s2]).search("topic");
    expect(response.status).toBe("partial");
    expect(response.results[0]!.record.title).toBe("Fallback Hit");
    expect(response.diagnostics.providers.map((p) => [p.provider, p.outcome])).toEqual([
      ["openalex", "failed"],
      ["semantic-scholar", "ok"],
    ]);
  });

  it("3. partial：部分 provider 失败时如实标注", async () => {
    const ok = new FakeProvider("openalex", async () => [makeResult("openalex", 1, { title: "A", doi: "10.1000/a" })]);
    const bad = FakeProvider.failing("arxiv");
    const response = await service([ok, bad]).search("topic");
    expect(response.status).toBe("partial");
    expect(response.diagnostics.providers.find((p) => p.provider === "arxiv")?.error?.kind).toBe("timeout");
  });

  it("4. 全部失败：结构化失败（不伪造空结果）", async () => {
    const response = service([
      FakeProvider.failing("openalex", "timeout"),
      FakeProvider.failing("semantic-scholar", "rate_limited"),
    ]).search("topic");
    await expect(response).rejects.toMatchObject({
      code: "SEARCH_ALL_PROVIDERS_FAILED",
      message: expect.stringContaining("semantic-scholar:rate_limited"),
    });
  });

  it("5. 跨 provider 同 DOI 合并为一条（metadata 互补）", async () => {
    const openalex = new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, {
        title: "Same Paper",
        doi: "10.9999/same",
        year: 2021,
        authors: ["Ada Lovelace"],
      }),
    ]);
    const s2 = new FakeProvider("semantic-scholar", async () => [
      makeResult("semantic-scholar", 2, {
        title: "Same Paper",
        doi: "https://doi.org/10.9999/SAME", // 前缀 + 大小写归一到同一键
        year: 2021,
        abstract: "The abstract only S2 has.",
      }),
    ]);
    const response = await service([openalex, s2]).search("topic");
    expect(response.diagnostics.rawResultCount).toBe(2);
    expect(response.results).toHaveLength(1); // 同 DOI 去重
    const fused = response.results[0]!;
    // 互补合并：S2 的 abstract 填补空缺；openalex（更强权重）的记录为基座
    expect(fused.record.abstract).toBe("The abstract only S2 has.");
    expect(fused.record.authors).toEqual(["Ada Lovelace"]);
    expect(fused.sources).toHaveLength(2);
    expect(fused.score).toBeCloseTo(1.0 / 61 + 0.9 / 62, 10);
  });

  it("6. 同 arXiv ID 跨源合并（版本号剥离）", async () => {
    const arxiv = new FakeProvider("arxiv", async () => [
      makeResult("arxiv", 1, { title: "Preprint Work", arxivId: "2401.12345v2" }),
    ]);
    const s2 = new FakeProvider("semantic-scholar", async () => [
      makeResult("semantic-scholar", 1, { title: "Preprint Work", arxivId: "arXiv:2401.12345" }),
    ]);
    const response = await service([arxiv, s2]).search("topic");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.identity.arxivId).toBe("2401.12345");
  });

  it("7. 缺失字段不覆盖有效字段（只有空缺才补）", async () => {
    const openalex = new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, { title: "T", doi: "10.1000/x", year: 2020, abstract: "real abstract" }),
    ]);
    const aminer = new FakeProvider("aminer", async () => [
      makeResult("aminer", 1, { title: "T", doi: "10.1000/x", year: 2020 }), // 无摘要
    ]);
    const response = await service([openalex, aminer]).search("topic");
    expect(response.results[0]!.record.abstract).toBe("real abstract"); // 空缺不覆盖
  });

  it("8. preprint（arXiv 键）与正式版（DOI 键）不 collapse：两条独立结果", async () => {
    const arxiv = new FakeProvider("arxiv", async () => [
      makeResult("arxiv", 1, { title: "Same Work Preprint", arxivId: "2401.00001", year: 2024 }),
    ]);
    const openalex = new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, { title: "Same Work Published", doi: "10.9000/conf", year: 2025 }),
    ]);
    const response = await service([arxiv, openalex]).search("topic");
    expect(response.results).toHaveLength(2);
    expect(response.results.map((r) => r.record.title).sort()).toEqual([
      "Same Work Preprint",
      "Same Work Published",
    ]);
  });

  it("9. 确定性 RRF 顺序：双源一致高位 > 单源；同分输入顺序稳定", async () => {
    const both = buildBothProviders();
    const response1 = await service(both).search("topic");
    const response2 = await service(buildBothProviders()).search("topic");
    expect(response1.results.map((r) => r.record.title)).toEqual(
      response2.results.map((r) => r.record.title),
    );
    // 双源命中（DOI 一致）得分 = 1/61 + 0.9/62 > 单源 1/61 → 排第一
    expect(response1.results[0]!.record.title).toBe("Hit By Both");
    expect(response1.results[0]!.sources).toHaveLength(2);
  });

  it("10. limit：融合后截断到请求条数", async () => {
    const openalex = new FakeProvider("openalex", async () =>
      [1, 2, 3, 4, 5].map((rank) => makeResult("openalex", rank, { title: `P${rank}`, doi: `10.1000/p${rank}` })),
    );
    const response = await service([openalex]).search("topic", { limit: 3 });
    expect(response.results).toHaveLength(3);
    expect(response.diagnostics.fusedResultCount).toBe(3);
  });

  it("11. timeout isolation：慢 provider 抛超时不影响快 provider 返回", async () => {
    const slow = new FakeProvider("slow-source", async () => {
      throw new ProviderHttpError("timeout", "slow-source", "timeout after 1ms");
    });
    const fast = new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, { title: "Fast", doi: "10.1000/fast" }),
    ]);
    const response = await service([slow, fast]).search("topic");
    expect(response.status).toBe("partial");
    expect(response.results[0]!.record.title).toBe("Fast");
  });

  it("12. 健康状态反映：诊断 + healthSnapshots 可观测", async () => {
    const openalex = new FakeProvider("openalex", async () => []);
    openalex.healthState = { provider: "openalex", state: "degraded", circuit: "closed", consecutiveFailures: 1, lastError: "slow" };
    const svc = service([openalex]);
    const response = await svc.search("topic");
    expect(response.status).toBe("success"); // degraded 不等于失败
    expect(svc.healthSnapshots()[0]).toMatchObject({ provider: "openalex", state: "degraded" });
  });

  it("未配置 provider：结构化 SEARCH_PROVIDER_NOT_CONFIGURED", async () => {
    await expect(service([]).search("topic")).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_NOT_CONFIGURED",
    });
  });
});

function buildBothProviders(): AcademicSearchProvider[] {
  const mk = () => [
    new FakeProvider("openalex", async () => [
      makeResult("openalex", 1, { title: "Hit By Both", doi: "10.1000/both", year: 2024 }),
      makeResult("openalex", 2, { title: "OpenAlex Only", doi: "10.1000/oa", year: 2024 }),
    ]),
    new FakeProvider("semantic-scholar", async () => [
      makeResult("semantic-scholar", 1, { title: "Hit By Both", doi: "10.1000/both", year: 2024 }),
      makeResult("semantic-scholar", 2, { title: "S2 Only", doi: "10.1000/s2", year: 2024 }),
    ]),
  ];
  return mk();
}
