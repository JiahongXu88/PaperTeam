/**
 * BenchmarkDiscoveryService（M12.1 A4）+ discoverAndFreeze 默认流程（A6）。
 *
 * 覆盖：venue resolved → SearchOptions 双发（venueSourceIds 给 OpenAlex 服务端
 * / venueNames 给其它 provider）、排序（citationCount 降序、缺数排尾）、
 * identity 去重、not_found 降级标记（venueDegraded + 关键词补偿，不静默）、
 * 入库恒 role=reference + citationCount/venue 落库、同身份 evidence 源升级
 * both、freeze artifact（sufficiency/requiresAttention 标记）、重复调用幂等
 * （alreadyFrozen，不改写冻结集合）、候选严重不足的 requiresAttention。
 * 全 fake（CannedProvider 记录 SearchOptions；种子注入 venueResolution）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService } from "../../src/sources/SourceImportService.js";
import { AcademicSearchService } from "../../src/search/academicSearchService.js";
import { BenchmarkDiscoveryService, buildBenchmarkQuery } from "../../src/search/benchmarkDiscoveryService.js";
import { VenueResolutionService, type VenueSeed } from "../../src/search/venueResolution.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { TargetBenchmarkService } from "../../src/target/TargetBenchmarkService.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "../../src/search/types.js";
import { buildIdentity } from "../../src/sources/identity.js";

const NOW = () => new Date("2026-10-07T10:00:00.000Z");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SEEDS: VenueSeed[] = [
  {
    canonicalId: "cvpr",
    displayName: "CVPR",
    aliases: ["CVPR", "IEEE/CVF Conference on Computer Vision and Pattern Recognition"],
    venueType: "conference",
    openalexSourceId: "S4210176548",
  },
];

/** 记录 SearchOptions 的 canned provider（真实 AcademicSearchService + fusion） */
class CannedProvider implements AcademicSearchProvider {
  readonly name = "openalex";
  readonly calls: Array<{ query: string; opts?: SearchOptions }> = [];
  constructor(private readonly behavior: (query: string, opts?: SearchOptions) => AcademicSearchResult[]) {}
  async search(query: string, opts?: SearchOptions): Promise<AcademicSearchResult[]> {
    this.calls.push({ query, opts });
    return this.behavior(query, opts);
  }
  healthSnapshot() {
    return { provider: this.name, state: "healthy" as const, circuit: "closed" as const, consecutiveFailures: 0 };
  }
}

function result(fields: {
  doi: string;
  title: string;
  year?: number;
  venue?: string;
  citationCount?: number;
}): AcademicSearchResult {
  const identity = buildIdentity({
    doi: fields.doi,
    title: fields.title,
    year: fields.year,
    authors: ["Alice Chen"],
  })!;
  return {
    identity,
    record: {
      provider: "openalex",
      recordId: fields.doi,
      title: fields.title,
      ...(fields.year !== undefined ? { year: fields.year } : {}),
      ...(fields.venue !== undefined ? { venue: fields.venue } : {}),
      doi: fields.doi,
      retrievedAt: NOW().toISOString(),
    },
    ...(fields.citationCount !== undefined ? { citationCount: fields.citationCount } : {}),
    relevance: { provider: "openalex", rank: 1 },
  };
}

function noLookupHttp() {
  // lookup 不应被触发（种子命中）；若触发则返回空结果（not_found 语义）
  const impl = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
  return new ProviderHttpClient({ fetchImpl: impl as typeof fetch, now: () => 1_000_000, sleep: async () => {}, defaultMaxRetries: 0 });
}

async function newStack(behavior: (query: string, opts?: SearchOptions) => AcademicSearchResult[]) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-benchmark-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("Benchmark Discovery 测试");
  const projectId = project.id;
  const sources = new SourceStore(projects);
  const candidates = new CandidateStore(projects);
  const imports = new SourceImportService({ projects, sources, candidates, log: () => {} });
  const provider = new CannedProvider(behavior);
  const academic = new AcademicSearchService({ providers: [provider] });
  const venues = new VenueResolutionService({ http: noLookupHttp(), seeds: SEEDS });
  const targets = new TargetBenchmarkService({
    projects,
    listSources: async () =>
      (await sources.list(projectId)).map((item) => ({
        sourceId: item.sourceId,
        sourceRole: item.sourceRole,
        status: item.status,
        ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
      })),
    now: NOW,
    log: () => {},
  });
  const service = new BenchmarkDiscoveryService({
    projects,
    academic,
    venues,
    candidates,
    imports,
    sources,
    targets,
    now: NOW,
    log: () => {},
  });
  return { projects, projectId, sources, candidates, service, provider, targets };
}

const TARGET = {
  documentType: "survey",
  targetProfile: "top_journal",
  targetVenue: "CVPR",
  researchField: "computer vision",
};

describe("BenchmarkDiscoveryService.discover（A4）", () => {
  it("venue resolved：SearchOptions 双发（venueSourceIds + venueNames）；query 确定性拼装", async () => {
    const { projectId, service, provider } = await newStack(() => []);
    const discovery = await service.discover(projectId, { target: TARGET });
    expect(discovery.venueResolution).toMatchObject({
      status: "resolved",
      openalexSourceId: "S4210176548",
    });
    expect(discovery.venueDegraded).toBe(false);
    expect(discovery.query).toBe("computer vision survey");
    const opts = provider.calls[0]!.opts!;
    expect(opts.venueSourceIds).toEqual(["S4210176548"]);
    expect(opts.venueNames).toContain("CVPR");
    expect(opts.venueNames).toContain("IEEE/CVF Conference on Computer Vision and Pattern Recognition");
  });

  it("排序：citationCount 降序为主、缺数排尾、融合分兜底；identity 去重", async () => {
    const dup = result({ doi: "10.1000/dup", title: "Duplicated Paper", citationCount: 999 });
    const { projectId, service } = await newStack(() => [
      result({ doi: "10.1000/low", title: "Low Cited", citationCount: 5, venue: "CVPR" }),
      result({ doi: "10.1000/high", title: "High Cited", citationCount: 500, venue: "CVPR" }),
      result({ doi: "10.1000/nodata", title: "No Citation Data", venue: "CVPR" }),
      dup,
      { ...dup }, // 同身份重复 → fusion 去重
    ]);
    const discovery = await service.discover(projectId, { target: TARGET });
    // 同身份两条 collapse 成一条（共 4 个唯一身份）；排序：999 > 500 > 5 > 缺数排尾
    expect(discovery.candidates.map((c) => c.title)).toEqual([
      "Duplicated Paper",
      "High Cited",
      "Low Cited",
      "No Citation Data",
    ]);
    expect(discovery.candidates[1]!.venueRaw).toBe("CVPR");
    expect(discovery.candidates[1]!.citationCount).toBe(500);
  });

  it("not_found 降级：venueDegraded=true + venue 原文进关键词 + requiresAttention 事实可见（不静默）", async () => {
    const { projectId, service, provider } = await newStack(() => []);
    const discovery = await service.discover(projectId, {
      target: { ...TARGET, targetVenue: "Journal of Nowhere" }, // 种子未命中 + lookup 空 → not_found
    });
    expect(discovery.venueResolution).toMatchObject({ status: "not_found" });
    expect(discovery.venueDegraded).toBe(true);
    expect(discovery.query).toContain("Journal of Nowhere");
    const opts = provider.calls[0]!.opts!;
    expect(opts.venueSourceIds).toBeUndefined(); // 降级：无服务端过滤
    expect(opts.venueNames).toBeUndefined();
  });

  it("无 researchField → INVALID_REQUEST；survey 语义词与年份窗拼装", async () => {
    const { projectId, service, provider } = await newStack(() => []);
    await expect(
      service.discover(projectId, { target: { documentType: "survey", targetProfile: "top_journal" } }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await service.discover(projectId, {
      target: { documentType: "research_article", targetProfile: "core_journal", researchField: "object tracking", timeWindow: { from: 2020, to: 2024 } },
    });
    expect(provider.calls[0]!.query).toBe("object tracking"); // 非 survey 类不拼语义词
    expect(provider.calls[0]!.opts).toMatchObject({ yearFrom: 2020, yearTo: 2024 });
    expect(buildBenchmarkQuery({ researchField: "  vision ", documentType: "综述" })).toBe("vision survey");
  });
});

describe("discoverAndFreeze（A4+A5+A6 默认流程，不强制暂停）", () => {
  function corpus(n: number) {
    return Array.from({ length: n }, (_, i) =>
      result({
        doi: `10.1000/bench-${i}`,
        title: `Benchmark Paper ${i}`,
        year: 2023,
        venue: "CVPR",
        citationCount: (n - i) * 10,
      }),
    );
  }

  it("一键流程：入库 role=reference + citationCount 落库 + freeze revision=0 + sufficiency 标记", async () => {
    const { projectId, sources, service } = await newStack(() => corpus(14));
    const outcome = await service.discoverAndFreeze(projectId, { target: TARGET });
    expect(outcome.alreadyFrozen).toBe(false);
    expect(outcome.savedSourceIds).toHaveLength(12); // 默认目标 12
    expect(outcome.selection.selection.sufficiency).toBe("sufficient");
    expect(outcome.selection.selection.requiresAttention).toEqual([]);
    // 全部条目 role=reference；citationCount/venue 落库
    for (const sourceId of outcome.savedSourceIds) {
      const item = await sources.get(projectId, sourceId);
      expect(item?.sourceRole).toBe("reference");
    }
    const top = await sources.get(projectId, outcome.savedSourceIds[0]!);
    expect(top?.metadata.citationCount).toBe(140); // 排序第一位 = 最高引用
    expect(top?.metadata.venue).toBe("CVPR");
    // artifact 冻结语义
    expect(outcome.artifact.revision).toBe(0);
    expect(outcome.artifact.papers).toHaveLength(12);
    expect(outcome.artifact.papers[0]).toMatchObject({
      citationCount: 140,
      venueRaw: "CVPR",
      hasFullText: false,
      inclusionReason: "top-cited in venue corpus, rank #1, cited 140 times",
    });
    expect(outcome.artifact.selection?.sufficiency).toBe("sufficient");
  });

  it("重复调用幂等：alreadyFrozen=true，冻结集合不改写（resume ≠ refresh）", async () => {
    const { projectId, service } = await newStack(() => corpus(14));
    const first = await service.discoverAndFreeze(projectId, { target: TARGET });
    const second = await service.discoverAndFreeze(projectId, { target: TARGET });
    expect(second.alreadyFrozen).toBe(true);
    expect(second.artifact.fingerprint).toBe(first.artifact.fingerprint);
    expect(second.artifact.revision).toBe(0);
    expect(second.artifact.papers).toHaveLength(first.artifact.papers.length);
  });

  it("同身份既有 evidence 源 → 升级 both（不降级用户证据角色）", async () => {
    const { projectId, sources, service } = await newStack(() => [
      result({ doi: "10.1000/bench-0", title: "Benchmark Paper 0", citationCount: 500, venue: "CVPR" }),
      ...corpus(9).slice(1),
    ]);
    // 预置同身份 evidence 条目（用户先入库的证据）
    const existing = await sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      sourceRole: "evidence",
      metadata: { doi: "10.1000/bench-0", title: "Benchmark Paper 0" },
      identity: buildIdentity({ doi: "10.1000/bench-0", title: "Benchmark Paper 0" }),
    });
    const outcome = await service.discoverAndFreeze(projectId, { target: TARGET });
    expect(outcome.upgradedToBoth.map((u) => u.sourceId)).toEqual([existing.sourceId]);
    const after = await sources.get(projectId, existing.sourceId);
    expect(after?.sourceRole).toBe("both");
    // 语料行仍引用该 sourceId
    expect(outcome.artifact.papers.some((p) => p.sourceId === existing.sourceId)).toBe(true);
  });

  it("候选严重不足（3 篇）：仍完成冻结（不强制暂停），insufficient + severely 注意项标记", async () => {
    const { projectId, service } = await newStack(() => corpus(3));
    const outcome = await service.discoverAndFreeze(projectId, { target: TARGET });
    expect(outcome.savedSourceIds).toHaveLength(3);
    expect(outcome.selection.selection.sufficiency).toBe("insufficient");
    expect(outcome.selection.selection.reason).toContain("候选不足");
    expect(
      outcome.selection.selection.requiresAttention.some((note) => note.startsWith("severely_insufficient_corpus")),
    ).toBe(true);
    expect(outcome.artifact.papers).toHaveLength(3);
    expect(outcome.artifact.selection?.sufficiency).toBe("insufficient");
  });

  it("空检索结果：零入库、语料冻结空集合 + empty_search_results 注意项", async () => {
    const { projectId, service } = await newStack(() => []);
    const outcome = await service.discoverAndFreeze(projectId, { target: TARGET });
    expect(outcome.savedSourceIds).toEqual([]);
    expect(outcome.artifact.papers).toEqual([]);
    expect(
      outcome.selection.selection.requiresAttention.some((note) => note.startsWith("empty_search_results")),
    ).toBe(true);
  });
});
