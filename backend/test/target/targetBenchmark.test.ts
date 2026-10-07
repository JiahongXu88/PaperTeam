/**
 * TargetBenchmarkService（M12.1 A5）+ selection 纯函数（M12.1 A6）单元测试。
 *
 * A5 覆盖：freeze 幂等 / get 容错区分未冻结与损坏（TARGET_BENCHMARK_
 * CORRUPTED）/ refresh revision+1 / exclude 同 revision 标记+指纹变化 /
 * addPaper refresh 语义 + role 守卫 / confirm 幂等 confirmedAt / 指纹确定性。
 * A6 覆盖：citationCount 降序选择 + 兜底排序 / 带内钳制 / inclusionReason /
 * sufficiency（insufficient 不静默）/ requiresAttention 四触发 / 正常流程零注意项。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  TargetBenchmarkService,
  benchmarkFingerprint,
  type BenchmarkSourceLike,
} from "../../src/target/TargetBenchmarkService.js";
import type { TargetBenchmarkPaper } from "../../src/target/types.js";
import {
  BENCHMARK_MAX_PAPERS,
  BENCHMARK_MIN_PAPERS,
  clampTargetCount,
  effectivePapers,
  selectRecommended,
} from "../../src/target/selection.js";

const NOW = () => new Date("2026-10-07T10:00:00.000Z");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function paper(overrides: Partial<TargetBenchmarkPaper> & { sourceId: string }): TargetBenchmarkPaper {
  return {
    identityKey: `doi:10.1000/${overrides.sourceId.toLowerCase()}`,
    provenance: { provider: "openalex", retrievedAt: NOW().toISOString(), queryUsed: "computer vision survey" },
    inclusionReason: "top-cited in venue corpus, rank #1, cited 100 times",
    venueRaw: "CVPR",
    hasFullText: false,
    ...overrides,
  };
}

async function newService(sources: BenchmarkSourceLike[] = []) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-target-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("Target Benchmark 测试");
  const service = new TargetBenchmarkService({
    projects,
    listSources: async () => sources,
    now: NOW,
    log: () => {},
  });
  return { projects, projectId: project.id, service };
}

const TARGET = {
  documentType: "survey",
  targetProfile: "top_journal",
  targetVenue: "CVPR",
  researchField: "computer vision",
};

describe("TargetBenchmarkService（A5）", () => {
  it("freeze：revision=0、papers 按 sourceId 排序、指纹确定性；二次 freeze 幂等原样返回", async () => {
    const { projectId, service } = await newService();
    const frozen = await service.freeze(projectId, {
      target: TARGET,
      papers: [paper({ sourceId: "S002", citationCount: 50 }), paper({ sourceId: "S001", citationCount: 100 })],
    });
    expect(frozen.revision).toBe(0);
    expect(frozen.papers.map((p) => p.sourceId)).toEqual(["S001", "S002"]);
    expect(frozen.fingerprint).toBe(benchmarkFingerprint(frozen.papers));
    // 幂等：不同输入再 freeze → 返回既有 artifact，不重写
    const again = await service.freeze(projectId, { target: TARGET, papers: [paper({ sourceId: "S009" })] });
    expect(again).toEqual(frozen);
    expect(again.papers).toHaveLength(2);
  });

  it("get：未冻结 → null（ENOENT 与损坏可区分）；损坏 JSON → TARGET_BENCHMARK_CORRUPTED", async () => {
    const { projects, projectId, service } = await newService();
    expect(await service.get(projectId)).toBeNull();
    await service.freeze(projectId, { target: TARGET, papers: [paper({ sourceId: "S001" })] });
    await writeFile(join(projects.researchDir(projectId), "target-benchmark.json"), "{ not-json", "utf8");
    await expect(service.get(projectId)).rejects.toMatchObject({ code: "TARGET_BENCHMARK_CORRUPTED" });
    // 未来 schemaVersion 同样拒绝降级解读
    await writeFile(
      join(projects.researchDir(projectId), "target-benchmark.json"),
      JSON.stringify({ schemaVersion: 99, papers: [] }),
      "utf8",
    );
    await expect(service.get(projectId)).rejects.toMatchObject({ code: "TARGET_BENCHMARK_CORRUPTED" });
  });

  it("refresh：未冻结 → INVALID_REQUEST；已冻结 → revision+1 + 指纹变化", async () => {
    const { projectId, service } = await newService();
    await expect(service.refresh(projectId, { target: TARGET, papers: [] })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const frozen = await service.freeze(projectId, { target: TARGET, papers: [paper({ sourceId: "S001" })] });
    const refreshed = await service.refresh(projectId, {
      target: TARGET,
      papers: [paper({ sourceId: "S001" }), paper({ sourceId: "S002" })],
    });
    expect(refreshed.revision).toBe(1);
    expect(refreshed.fingerprint).not.toBe(frozen.fingerprint);
    expect(refreshed.createdAt).toBe(frozen.createdAt); // 创建时间不随 refresh 变
  });

  it("exclude：同 revision 标记 excluded、指纹变化、幂等；未知条目 → NOT_FOUND", async () => {
    const { projectId, service } = await newService();
    const frozen = await service.freeze(projectId, {
      target: TARGET,
      papers: [paper({ sourceId: "S001" }), paper({ sourceId: "S002" })],
    });
    const excluded = await service.exclude(projectId, "S002", "作者裁决：与主题不相关");
    expect(excluded.revision).toBe(frozen.revision); // 同 revision 内剔除标记
    expect(excluded.papers.find((p) => p.sourceId === "S002")?.excluded).toMatchObject({
      reason: "作者裁决：与主题不相关",
    });
    expect(excluded.fingerprint).not.toBe(frozen.fingerprint); // 有效语料变 → 指纹变
    // 幂等：同理由再 exclude → 原样
    const again = await service.exclude(projectId, "S002", "作者裁决：与主题不相关");
    expect(again.updatedAt).toBe(excluded.updatedAt);
    await expect(service.exclude(projectId, "S999", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.exclude(projectId, "S001", "   ")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // 有效条目视图排除 excluded
    expect(effectivePapers(excluded.papers).map((p) => p.sourceId)).toEqual(["S001"]);
  });

  it("addPaper：refresh 语义 revision+1；evidence 源拒绝；库外源 404；幂等", async () => {
    const { projectId, service } = await newService([
      { sourceId: "S100", sourceRole: "reference", status: "metadata_only", identityKey: "doi:10.1000/s100" },
      { sourceId: "S101", sourceRole: "evidence", status: "available", fileName: "a.pdf", identityKey: "doi:10.1000/s101" },
    ]);
    const frozen = await service.freeze(projectId, { target: TARGET, papers: [paper({ sourceId: "S001" })] });
    const added = await service.addPaper(projectId, { sourceId: "S100", citationCount: 7, venueRaw: "ICCV" });
    expect(added.revision).toBe(frozen.revision + 1);
    expect(added.papers.find((p) => p.sourceId === "S100")).toMatchObject({
      citationCount: 7,
      venueRaw: "ICCV",
      hasFullText: false,
      inclusionReason: "manual add（作者/用户显式追加）",
    });
    // 幂等：再 add 同一 sourceId → 原样（不加 revision）
    const again = await service.addPaper(projectId, { sourceId: "S100" });
    expect(again.revision).toBe(added.revision);
    // 隔离红线：evidence 源不得追加进 benchmark 语料
    await expect(service.addPaper(projectId, { sourceId: "S101" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(service.addPaper(projectId, { sourceId: "S999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("confirm：首次写 confirmedAt，重复幂等（时间戳/revision 不动）", async () => {
    const { projectId, service } = await newService();
    const frozen = await service.freeze(projectId, { target: TARGET, papers: [paper({ sourceId: "S001" })] });
    expect(frozen.confirmedAt).toBeUndefined();
    const confirmed = await service.confirm(projectId);
    expect(confirmed.confirmedAt).toBe(NOW().toISOString());
    const again = await service.confirm(projectId);
    expect(again.confirmedAt).toBe(confirmed.confirmedAt);
    expect(again.updatedAt).toBe(confirmed.updatedAt);
    expect(again.revision).toBe(confirmed.revision);
  });

  it("指纹确定性：行序无关；citationCount/venue/excluded 参与指纹", () => {
    const a = [paper({ sourceId: "S001", citationCount: 10 }), paper({ sourceId: "S002", citationCount: 20 })];
    const b = [paper({ sourceId: "S002", citationCount: 20 }), paper({ sourceId: "S001", citationCount: 10 })];
    expect(benchmarkFingerprint(a)).toBe(benchmarkFingerprint(b));
    const changedCount = [paper({ sourceId: "S001", citationCount: 11 }), paper({ sourceId: "S002", citationCount: 20 })];
    expect(benchmarkFingerprint(a)).not.toBe(benchmarkFingerprint(changedCount));
    const excludedVariant = [paper({ sourceId: "S001", citationCount: 10, excluded: { reason: "r", at: NOW().toISOString() } }), paper({ sourceId: "S002", citationCount: 20 })];
    expect(benchmarkFingerprint(a)).not.toBe(benchmarkFingerprint(excludedVariant));
  });
});

describe("selectRecommended（A6）", () => {
  const candidate = (id: string, citationCount?: number, fusedScore = 0.5) => ({
    title: `Paper ${id}`,
    citationCount,
    fusedScore,
  });

  it("citationCount 降序取前 N（缺数排尾）；inclusionReason 带名次与引用数", () => {
    const candidates = [
      candidate("low", 5),
      candidate("high", 500),
      candidate("mid", 100),
      candidate("nodata"),
      candidate("high2", 500),
    ];
    // target 被钳制在 [min,max] 内；测截断用 min:2 覆盖（产品默认 8–15）
    const { selected, selection } = selectRecommended(candidates, { min: 2, target: 3, now: NOW });
    expect(selected.map((c) => c.title)).toEqual(["Paper high", "Paper high2", "Paper mid"]);
    expect(selected[0]!.inclusionReason).toBe("top-cited in venue corpus, rank #1, cited 500 times");
    expect(selection.targetCount).toBe(3);
    expect(selection.selectedAt).toBe(NOW().toISOString());
  });

  it("带内钳制：target 钳到 [8,15]；选中 ≥8 → sufficient、零 requiresAttention（正常流程不暂停）", () => {
    expect(clampTargetCount({})).toEqual({ min: 8, target: 12, max: 15 });
    expect(clampTargetCount({ target: 99 })).toEqual({ min: 8, target: 15, max: 15 });
    expect(clampTargetCount({ target: 2 })).toEqual({ min: 8, target: 8, max: 15 });
    const candidates = Array.from({ length: 20 }, (_, i) => candidate(`p${i}`, 100 - i));
    const { selected, selection } = selectRecommended(candidates, { now: NOW });
    expect(selected).toHaveLength(12);
    expect(selection.sufficiency).toBe("sufficient");
    expect(selection.reason).toBeUndefined();
    expect(selection.requiresAttention).toEqual([]);
  });

  it("候选不足：≥5 但 <8 → insufficient（带 reason），不触发 severely 注意项", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`p${i}`, 100 - i));
    const { selected, selection } = selectRecommended(candidates, { now: NOW });
    expect(selected).toHaveLength(6);
    expect(selection.sufficiency).toBe("insufficient");
    expect(selection.reason).toContain("候选不足");
    expect(selection.requiresAttention).toEqual([]); // 6 ≥ 5：不是严重不足
  });

  it("严重不足（<5）/ venue ambiguous / venue not_found / 空结果 → requiresAttention 触发", () => {
    const few = selectRecommended([candidate("a", 1), candidate("b", 2)], { now: NOW });
    expect(few.selection.sufficiency).toBe("insufficient");
    expect(few.selection.requiresAttention.some((note) => note.startsWith("severely_insufficient_corpus"))).toBe(true);

    const ambiguous = selectRecommended(Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, i)), {
      context: { venueStatus: "ambiguous", totalResults: 10 },
      now: NOW,
    });
    expect(ambiguous.selection.requiresAttention.some((note) => note.startsWith("venue_resolution_ambiguous"))).toBe(true);

    const notFound = selectRecommended(Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, i)), {
      context: { venueStatus: "not_found", totalResults: 10 },
      now: NOW,
    });
    expect(notFound.selection.requiresAttention.some((note) => note.startsWith("venue_resolution_not_found"))).toBe(true);

    const empty = selectRecommended([], { context: { venueStatus: "resolved", totalResults: 0 }, now: NOW });
    expect(empty.selection.sufficiency).toBe("insufficient");
    expect(empty.selection.requiresAttention.some((note) => note.startsWith("empty_search_results"))).toBe(true);
    expect(empty.selection.requiresAttention.some((note) => note.startsWith("severely_insufficient_corpus"))).toBe(true);
  });

  it("并列 citationCount：融合分兜底、再按标题稳定排序；min/max 常量锁定 8/15", () => {
    expect(BENCHMARK_MIN_PAPERS).toBe(8);
    expect(BENCHMARK_MAX_PAPERS).toBe(15);
    const { selected } = selectRecommended(
      [
        { title: "Beta", citationCount: 10, fusedScore: 0.2 },
        { title: "Alpha", citationCount: 10, fusedScore: 0.9 },
        { title: "Gamma", citationCount: 10, fusedScore: 0.9 },
      ],
      { target: 3, now: NOW },
    );
    expect(selected.map((c) => c.title)).toEqual(["Alpha", "Gamma", "Beta"]);
  });
});
