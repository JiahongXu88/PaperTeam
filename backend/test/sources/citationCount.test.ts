/**
 * citationCount 持久化回归（M12.1 A3，补 G3）：
 * 检索结果（fusion max 合并后）→ saveAcademicCandidates → CandidateStore 落
 * citationCount → promoteCandidate → SourceStore 条目 metadata.citationCount
 * 保留；老项目（无该字段）加载不受影响；metadataMerge 不降级覆盖（resolved
 * 级快照不被 inferred promotion 改写）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService } from "../../src/sources/SourceImportService.js";
import { ResearchDiscoveryService } from "../../src/search/researchDiscoveryService.js";
import { AcademicSearchService } from "../../src/search/academicSearchService.js";
import type { AcademicSearchProvider, AcademicSearchResult } from "../../src/search/types.js";
import { buildIdentity } from "../../src/sources/identity.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject() {
  const root = await mkdtemp(join(tmpdir(), "paperteam-cite-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("citationCount 持久化测试");
  return { projects, projectId: project.id };
}

function fusedLike(fields: {
  doi: string;
  title: string;
  year?: number;
  venue?: string;
  citationCount?: number;
}): AcademicSearchResult {
  const identity = buildIdentity({ doi: fields.doi, title: fields.title, year: fields.year, authors: ["Alice Chen"] })!;
  return {
    identity,
    record: {
      provider: "openalex",
      recordId: fields.doi,
      title: fields.title,
      ...(fields.year !== undefined ? { year: fields.year } : {}),
      ...(fields.venue !== undefined ? { venue: fields.venue } : {}),
      doi: fields.doi,
      retrievedAt: "2026-10-07T00:00:00Z",
    },
    ...(fields.citationCount !== undefined ? { citationCount: fields.citationCount } : {}),
    relevance: { provider: "openalex", rank: 1 },
  };
}

/** 单 provider fake（真实 AcademicSearchService + fusion 全链） */
class CannedProvider implements AcademicSearchProvider {
  readonly name = "openalex";
  constructor(private readonly results: AcademicSearchResult[]) {}
  async search(): Promise<AcademicSearchResult[]> {
    return this.results;
  }
  healthSnapshot() {
    return { provider: this.name, state: "healthy" as const, circuit: "closed" as const, consecutiveFailures: 0 };
  }
}

function stack(projects: ProjectStore, results: AcademicSearchResult[]) {
  const sources = new SourceStore(projects);
  const candidates = new CandidateStore(projects);
  const imports = new SourceImportService({ projects, sources, candidates });
  const discovery = new ResearchDiscoveryService({
    academic: new AcademicSearchService({ providers: [new CannedProvider(results)] }),
    web: { search: async () => ({ results: [], diagnostics: { providers: [], rawResultCount: 0, fusedResultCount: 0 } }), healthSnapshots: () => [] } as never,
    candidates,
  });
  return { sources, candidates, imports, discovery };
}

describe("citationCount 持久化（A3）", () => {
  it("search → saveAsCandidates → promote → SourceStore.metadata.citationCount 保留", async () => {
    const { projects, projectId } = await newProject();
    const { sources, candidates, imports, discovery } = stack(projects, [
      fusedLike({ doi: "10.1000/tracking-survey", title: "Multi-Object Tracking Survey", year: 2023, venue: "IEEE TPAMI", citationCount: 1520 }),
      fusedLike({ doi: "10.1000/no-citations", title: "Paper Without Citation Data", year: 2024 }), // provider 未提供 → 无字段
    ]);
    const response = await discovery.academicSearch("object tracking survey", { limit: 5 }, projectId);
    expect(response.results[0]!.citationCount).toBe(1520);
    expect(response.results[1]!.citationCount).toBeUndefined();

    const saved = await discovery.saveAcademicCandidates(projectId, "object tracking survey", response.results, [0, 1]);
    expect(saved.saved[0]!.citationCount).toBe(1520);
    expect(saved.saved[1]!.citationCount).toBeUndefined();

    const promoted = await imports.promoteCandidate(projectId, saved.saved[0]!.candidateId, {
      sourceRole: "reference",
      selectionReason: "benchmark discovery",
    });
    expect(promoted.source.metadata.citationCount).toBe(1520);
    // 第二条（无引用数）入库后字段缺省，不伪造 0
    const promoted2 = await imports.promoteCandidate(projectId, saved.saved[1]!.candidateId);
    expect(promoted2.source.metadata.citationCount).toBeUndefined();

    // 重读 SourceStore（磁盘往返）仍在
    const reloaded = await sources.get(projectId, promoted.source.sourceId);
    expect(reloaded?.metadata.citationCount).toBe(1520);
    // 候选侧字段仍在（审计）
    const candidate = await candidates.get(projectId, saved.saved[0]!.candidateId);
    expect(candidate?.citationCount).toBe(1520);
  });

  it("同身份候选再发现：fillEmpty 只填空缺（首次快照不被后续覆盖）", async () => {
    const { projects, projectId } = await newProject();
    const first = stack(projects, [fusedLike({ doi: "10.1000/stable", title: "Stable Snapshot Paper", citationCount: 42 })]);
    const fused = (await first.discovery.academicSearch("q", { limit: 5 }, projectId)).results;
    const saved1 = await first.discovery.saveAcademicCandidates(projectId, "q", fused, [0]);
    // 第二次发现（provider 数据漂移到 99）：pending 候选已存在 → 合并只填空缺
    const secondStack = stack(projects, [fusedLike({ doi: "10.1000/stable", title: "Stable Snapshot Paper", citationCount: 99 })]);
    const second = await secondStack.discovery.saveAcademicCandidates(
      projectId,
      "q",
      (await secondStack.discovery.academicSearch("q", { limit: 5 }, projectId)).results,
      [0],
    );
    expect(second.mergedExisting).toEqual([0]);
    expect(second.saved).toHaveLength(0);
    expect(saved1.saved[0]!.citationCount).toBe(42);
    expect(second.mergedExisting).toEqual([0]);
  });

  it("metadataMerge 不降级覆盖：resolved 级快照不被 inferred promotion 改写", async () => {
    const { projects, projectId } = await newProject();
    const { imports, sources } = stack(projects, []);
    // 既有条目：resolver resolved 级写入 citationCount=100
    const existing = await sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      metadata: {
        doi: "10.1000/resolved-count",
        title: "Resolved Snapshot Paper",
        citationCount: 100,
      },
      metadataProvenance: "resolved",
    });
    // 同身份候选（inferred 级）携带漂移后的 999 → promotion merge 不得覆盖
    const driftedStack = stack(projects, [fusedLike({ doi: "10.1000/resolved-count", title: "Resolved Snapshot Paper", citationCount: 999 })]);
    const saved = await driftedStack.discovery.saveAcademicCandidates(
      projectId,
      "q",
      (await driftedStack.discovery.academicSearch("q", { limit: 5 }, projectId)).results,
      [0],
    );
    const promoted = await imports.promoteCandidate(projectId, saved.saved[0]!.candidateId, { sourceRole: "reference" });
    expect(promoted.created).toBe(false); // 同身份 → 既有条目 merge
    expect(promoted.source.sourceId).toBe(existing.sourceId);
    expect(promoted.source.metadata.citationCount).toBe(100); // 不降级覆盖
    expect(promoted.source.metadataProvenance).toBe("resolved");
  });

  it("老数据兼容：无 citationCount 的候选 / 条目照常加载（additive optional）", async () => {
    const { projects, projectId } = await newProject();
    const { sources, candidates } = stack(projects, []);
    const record = await sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      metadata: { doi: "10.1000/legacy", title: "Legacy Paper" },
    });
    expect(record.metadata.citationCount).toBeUndefined();
    const added = await candidates.add(projectId, {
      doi: "10.1000/legacy-2",
      title: "Legacy Candidate",
      identity: buildIdentity({ doi: "10.1000/legacy-2", title: "Legacy Candidate" }),
    });
    expect(added.created).toBe(true);
    const listed = await candidates.list(projectId);
    expect(listed).toHaveLength(1);
    // 脏值（负数 / 非整数）被 sanitize 丢弃，不落库
    const dirty = await sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      metadata: { doi: "10.1000/dirty", title: "Dirty", citationCount: -5 },
    });
    expect(dirty.metadata.citationCount).toBeUndefined();
  });
});
