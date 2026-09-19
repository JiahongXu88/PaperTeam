/**
 * ResearchDiscoveryService 检索缓存 + saveCandidatesFromCache 护栏测试（M7.1a P-B）。
 *
 * 覆盖：检索 → 按下标回放保存 → CandidateStore 可查询；query 不一致 / 未检索 /
 * TTL 过期 / LRU 覆盖 → 结构化 SEARCH_CACHE_MISS；越界与空下标 → INVALID_REQUEST；
 * 单次 >25 硬帽；保存 touch 维持 LRU 新鲜度；项目隔离；web 回放；
 * 与 HTTP saveAsCandidates 路径汇聚同一落盘（identityKey 判重只合并不重复）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { buildIdentity } from "../../src/sources/identity.js";
import { ResearchDiscoveryService } from "../../src/search/researchDiscoveryService.js";
import type { AcademicSearchService, AcademicSearchResponse } from "../../src/search/academicSearchService.js";
import type { FusedAcademicResult } from "../../src/search/fusion.js";
import type { WebSearchResult } from "../../src/search/types.js";
import type { WebSearchService, WebSearchResponse } from "../../src/search/webSearchService.js";

function fusedResult(n: number): FusedAcademicResult {
  const doi = `10.1234/cache-${n}`;
  return {
    identity: buildIdentity({ doi, title: `Cached Paper ${n}` })!,
    record: {
      provider: "openalex",
      recordId: `W${1000 + n}`,
      title: `Cached Paper ${n}`,
      authors: ["Alice Chen"],
      year: 2023 + (n % 2),
      doi,
      abstract: `Abstract of cached paper ${n}.`,
      retrievedAt: "2026-09-19T00:00:00Z",
    },
    citationCount: n,
    score: 1 - n * 0.01,
    sources: [{ provider: "openalex", rank: n + 1 }],
  };
}

function webResult(n: number): WebSearchResult {
  return {
    url: `https://example.com/page-${n}`,
    title: `Web Lead ${n}`,
    snippet: `Snippet ${n}`,
    engines: ["bing"],
    score: 1 - n * 0.01,
    provider: "searxng",
  };
}

function fakeAcademic(results: FusedAcademicResult[]): AcademicSearchService {
  return {
    search: async (): Promise<AcademicSearchResponse> => ({
      status: "success",
      results,
      diagnostics: { providers: [], rawResultCount: results.length, fusedResultCount: results.length },
    }),
    healthSnapshots: () => [],
  } as unknown as AcademicSearchService;
}

function fakeWeb(results: WebSearchResult[]): WebSearchService {
  return {
    search: async (): Promise<WebSearchResponse> => ({
      status: "success",
      results,
      diagnostics: { providers: [], rawResultCount: results.length, fusedResultCount: results.length },
    }),
    healthSnapshots: () => [],
  } as unknown as WebSearchService;
}

let root: string;
let projects: ProjectStore;
let candidates: CandidateStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "paperteam-cache-"));
  projects = new ProjectStore({ root });
  candidates = new CandidateStore(projects);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function createService(
  academicResults: FusedAcademicResult[] = [fusedResult(0), fusedResult(1)],
  webResults: WebSearchResult[] = [webResult(0), webResult(1)],
): ResearchDiscoveryService {
  return new ResearchDiscoveryService({
    academic: fakeAcademic(academicResults),
    web: fakeWeb(webResults),
    candidates,
  });
}

async function createProject(title: string): Promise<string> {
  return (await projects.create(title)).id;
}

function expectBusinessError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`期望抛出 ${code}，实际成功返回`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(BusinessError);
      expect((error as BusinessError).code).toBe(code);
    },
  );
}

describe("检索缓存 + saveCandidatesFromCache（M7.1a P-B）", () => {
  it("检索 → 按下标保存 → CandidateStore 可查询（provenance 齐全）", async () => {
    const projectId = await createProject("cache-save");
    const service = createService();
    const response = await service.academicSearch("multi-agent survey", {}, projectId);
    expect(response.results).toHaveLength(2);

    const saved = await service.saveCandidatesFromCache(projectId, "academic", "multi-agent survey", [0, 1]);
    expect(saved.saved).toHaveLength(2);
    expect(saved.mergedExisting).toEqual([]);

    const list = await candidates.list(projectId);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      origin: "academic_search",
      provider: "openalex",
      title: "Cached Paper 0",
      doi: "10.1234/cache-0",
      query: "multi-agent survey",
      status: "pending_review",
    });
  });

  it("web 检索同样可回放保存（origin=web_search，URL 为身份键）", async () => {
    const projectId = await createProject("cache-web");
    const service = createService();
    await service.webSearch("agent survey", {}, projectId);
    const saved = await service.saveCandidatesFromCache(projectId, "web", "agent survey", [0]);
    expect(saved.saved).toHaveLength(1);
    const list = await candidates.list(projectId);
    expect(list[0]).toMatchObject({
      origin: "web_search",
      provider: "searxng",
      title: "Web Lead 0",
      url: "https://example.com/page-0",
      query: "agent survey",
    });
  });

  it("未检索过 / query 不一致 → 结构化 SEARCH_CACHE_MISS", async () => {
    const projectId = await createProject("cache-miss");
    const service = createService();
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "academic", "never searched", [0]),
      "SEARCH_CACHE_MISS",
    );
    await service.academicSearch("exact query", {}, projectId);
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "academic", "EXACT query", [0]), // 大小写不同也算不一致
      "SEARCH_CACHE_MISS",
    );
    // academic 的缓存不能给 web 用（kind 隔离）
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "web", "exact query", [0]),
      "SEARCH_CACHE_MISS",
    );
  });

  it("TTL 过期（>10 分钟）→ miss；未过期可用", async () => {
    const projectId = await createProject("cache-ttl");
    const service = createService();
    await service.academicSearch("fresh query", {}, projectId);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    vi.setSystemTime(new Date(Date.now() + 9 * 60_000));
    const stillFresh = await service.saveCandidatesFromCache(projectId, "academic", "fresh query", [0]);
    expect(stillFresh.saved).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000)); // 累计 > 10 分钟
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "academic", "fresh query", [1]),
      "SEARCH_CACHE_MISS",
    );
  });

  it("LRU ≤5：第 6 个不同 query 挤掉最旧；保存会 touch 维持新鲜度", async () => {
    const projectId = await createProject("cache-lru");
    const service = createService();
    for (let i = 0; i < 5; i += 1) {
      await service.academicSearch(`query-${i}`, {}, projectId);
    }
    // touch：保存 query-0，使其回到 MRU
    const touched = await service.saveCandidatesFromCache(projectId, "academic", "query-0", [0]);
    expect(touched.saved).toHaveLength(1);
    // 第 6 个不同 query：最久未使用的 query-1 被淘汰
    await service.academicSearch("query-5", {}, projectId);
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "academic", "query-1", [0]),
      "SEARCH_CACHE_MISS",
    );
    // query-0 因 touch 幸存；query-5 是最新
    for (const query of ["query-0", "query-5"]) {
      const saved = await service.saveCandidatesFromCache(projectId, "academic", query, [1]);
      expect([...saved.saved, ...saved.mergedExisting]).toHaveLength(1);
    }
  });

  it("越界 / 空下标 → INVALID_REQUEST", async () => {
    const projectId = await createProject("cache-index");
    const service = createService();
    await service.academicSearch("bounds", {}, projectId);
    await expectBusinessError(service.saveCandidatesFromCache(projectId, "academic", "bounds", [99]), "INVALID_REQUEST");
    await expectBusinessError(service.saveCandidatesFromCache(projectId, "academic", "bounds", []), "INVALID_REQUEST");
  });

  it("单次保存 >25 条 → INVALID_REQUEST 硬帽", async () => {
    const projectId = await createProject("cache-cap");
    const service = createService(
      Array.from({ length: 30 }, (_, n) => fusedResult(n)),
    );
    await service.academicSearch("cap query", {}, projectId);
    await expectBusinessError(
      service.saveCandidatesFromCache(projectId, "academic", "cap query", Array.from({ length: 26 }, (_, n) => n)),
      "INVALID_REQUEST",
    );
    // 恰好 25 条：允许
    const saved = await service.saveCandidatesFromCache(
      projectId,
      "academic",
      "cap query",
      Array.from({ length: 25 }, (_, n) => n),
    );
    expect(saved.saved).toHaveLength(25);
  });

  it("项目隔离：A 项目检索的缓存不能在 B 项目回放", async () => {
    const projectA = await createProject("cache-iso-a");
    const projectB = await createProject("cache-iso-b");
    const service = createService();
    await service.academicSearch("iso query", {}, projectA);
    await expectBusinessError(
      service.saveCandidatesFromCache(projectB, "academic", "iso query", [0]),
      "SEARCH_CACHE_MISS",
    );
    expect(await candidates.list(projectB)).toHaveLength(0);
  });

  it("与 HTTP saveAsCandidates 汇聚同一落盘：同身份只合并不重复", async () => {
    const projectId = await createProject("cache-converge");
    const service = createService();
    const response = await service.academicSearch("converge query", {}, projectId);
    // HTTP 路径（httpServer 直接调用的保存函数）
    await service.saveAcademicCandidates(projectId, "converge query", response.results, [0]);
    // Agent 工具路径（缓存回放）
    const replay = await service.saveCandidatesFromCache(projectId, "academic", "converge query", [0, 1]);
    expect(replay.saved).toHaveLength(1); // 只有 #1 是新的
    expect(replay.mergedExisting).toEqual([0]); // #0 经 identityKey 判重合并
    expect(await candidates.list(projectId)).toHaveLength(2);
  });
});
