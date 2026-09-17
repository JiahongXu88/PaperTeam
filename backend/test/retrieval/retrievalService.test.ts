/**
 * M6.4 RetrievalService 域层测试。
 *
 * 覆盖：provider optional（无 embedding 时 lexical 健康运行）/ hybrid RRF
 * 融合与确定性 / 双通道去重 / 无量纲相加 bug / dense 失败降级 / embedding
 * 缓存 identity / metadata filter / 项目隔离 / 生命周期（rebuild、增量失效、
 * 删除、重启 lazy 重建、并发、rebuild 中检索）/ EvidenceStore 零写入。
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { DeterministicEmbeddingProvider } from "../../src/retrieval/embedding.js";
import type { EmbeddingProvider } from "../../src/retrieval/types.js";
import { BusinessError } from "../../src/errors.js";
import { cleanupTempRoots, newRetrievalFixture } from "./fixtures.js";

afterAll(async () => {
  await cleanupTempRoots();
});

/** 计数委托（缓存命中断言用） */
class CountingProvider implements EmbeddingProvider {
  readonly name = "counting";
  readonly identity: string;
  readonly dimensions: number;
  documentEmbeds = 0;
  queryEmbeds = 0;
  private readonly delegate: EmbeddingProvider;

  constructor(delegate: EmbeddingProvider, identity?: string) {
    this.delegate = delegate;
    this.dimensions = delegate.dimensions;
    this.identity = identity ?? delegate.identity;
  }
  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    this.documentEmbeds += texts.length;
    return this.delegate.embedDocuments(texts, signal);
  }
  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    this.queryEmbeds += 1;
    return this.delegate.embedQuery(text, signal);
  }
}

/** 慢 chunker（rebuild 期间检索的并发测试用） */
class SlowChunker extends SourceChunker {
  delayMs: number = 0;
  override async chunkSource(...args: Parameters<SourceChunker["chunkSource"]>) {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return super.chunkSource(...args);
  }
}

const ALPHA_DOC = [
  "# Alpha Study",
  "",
  "We study alpha beta gamma tracking on MOT17 with ByteTrack, achieving MOTA 80.1.",
  "",
  "The data association cost combines motion and appearance cues with a two-stage association.",
  "",
  "# Other Topics",
  "",
  "Cooking recipes and unrelated filler content for diversity testing purposes only.",
].join("\n");

describe("M6.4 RetrievalService：provider optional（红线）", () => {
  it("无 EmbeddingProvider → lexical 检索健康可用，mode=lexical", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC, { title: "Alpha Study" });
    const result = await f.retrieval.search(f.projectId, "ByteTrack MOT17");
    expect(result.mode).toBe("lexical");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.channels).toEqual(["lexical"]);
  });

  it("无 provider 时显式 hybrid → EMBEDDING_UNAVAILABLE（显式请求不静默降级）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await expect(f.retrieval.search(f.projectId, "alpha", { mode: "hybrid" })).rejects.toMatchObject({
      code: "EMBEDDING_UNAVAILABLE",
    });
  });

  it("stats：无 provider → lexical-only、无 vectors 字段", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    const stats = await f.retrieval.stats(f.projectId);
    expect(stats.mode).toBe("lexical");
    expect(stats.vectors).toBeUndefined();
    expect(stats.sources.indexed).toBe(1);
    expect(stats.chunks).toBeGreaterThan(0);
  });

  it("空项目检索 → 空结果（不是错误）；不存在的项目 → 404", async () => {
    const f = await newRetrievalFixture();
    const empty = await f.retrieval.search(f.projectId, "anything");
    expect(empty.results).toEqual([]);
    await expect(f.retrieval.search("no-such-project", "x")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("M6.4 RetrievalService：hybrid 融合", () => {
  it("双通道命中合并为单条（channels 双标记），RRF 分数有界（无量纲相加 bug 不存在）", async () => {
    const f = await newRetrievalFixture({ embedding: new DeterministicEmbeddingProvider() });
    await f.addTextSource("alpha.md", ALPHA_DOC, { title: "Alpha" });
    await f.addTextSource(
      "filler.md",
      ["# Filler", "", "beta delta epsilon zeta content about language models and cooking.", "", "More unrelated text here about gardening tools."].join("\n"),
      { title: "Filler" },
    );
    const result = await f.retrieval.search(f.projectId, "alpha beta gamma tracking");
    expect(result.mode).toBe("hybrid");
    expect(result.results.length).toBeGreaterThan(0);
    const top = result.results[0]!;
    expect(top.channels).toContain("lexical");
    expect(top.chunk.text).toContain("alpha beta gamma tracking");
    // RRF 上界：两通道都排第一 = 2/(60+1)
    for (const entry of result.results) {
      expect(Number.isFinite(entry.score.fused)).toBe(true);
      expect(entry.score.fused).toBeLessThanOrEqual(2 / 61 + 1e-9);
      expect(entry.score.fused).toBeGreaterThan(0);
    }
  });

  it("确定性：同查询两次 → 逐字段一致", async () => {
    const f = await newRetrievalFixture({ embedding: new DeterministicEmbeddingProvider() });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    const first = await f.retrieval.search(f.projectId, "data association cost");
    const second = await f.retrieval.search(f.projectId, "data association cost");
    expect(second).toEqual(first);
  });

  it("embedding 查询失败 → 降级 lexical + diagnostics.denseNote（不 fail）", async () => {
    const failing = new DeterministicEmbeddingProvider({ failMode: () => true });
    const f = await newRetrievalFixture({ embedding: failing });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    const result = await f.retrieval.search(f.projectId, "alpha beta");
    expect(result.mode).toBe("lexical");
    expect(result.diagnostics.denseNote).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("force lexical（mode=lexical）→ 不触发 embedding 查询", async () => {
    const counting = new CountingProvider(new DeterministicEmbeddingProvider());
    const f = await newRetrievalFixture({ embedding: counting });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    const before = counting.queryEmbeds;
    const result = await f.retrieval.search(f.projectId, "alpha beta", { mode: "lexical" });
    expect(result.mode).toBe("lexical");
    expect(counting.queryEmbeds).toBe(before);
  });
});

describe("M6.4 RetrievalService：embedding 缓存 identity", () => {
  it("首次索引嵌入全部 chunk；重启后（新实例）零嵌入（缓存命中）", async () => {
    const counting = new CountingProvider(new DeterministicEmbeddingProvider());
    const f = await newRetrievalFixture({ embedding: counting });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const firstRound = counting.documentEmbeds;
    expect(firstRound).toBeGreaterThan(0);
    // 重启：同一 workspace 全新实例（projects/sources/chunkStore/retrieval 全新）
    const projects2 = new ProjectStore({ root: f.root });
    const sources2 = new SourceStore(projects2);
    const counting2 = new CountingProvider(new DeterministicEmbeddingProvider());
    const retrieval2 = new RetrievalService({
      projects: projects2,
      sources: sources2,
      chunker: new SourceChunker(),
      chunkStore: new ChunkStore(projects2),
      embedding: counting2,
      log: () => {},
    });
    const result = await retrieval2.search(f.projectId, "alpha");
    expect(result.mode).toBe("hybrid");
    expect(counting2.documentEmbeds).toBe(0); // 全部缓存命中
  });

  it("provider identity 变化（模拟换模型）→ 旧向量失效、全量重嵌", async () => {
    const f = await newRetrievalFixture({ embedding: new DeterministicEmbeddingProvider() });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const projects2 = new ProjectStore({ root: f.root });
    const countingV2 = new CountingProvider(
      new DeterministicEmbeddingProvider(),
      "deterministic-hash:fnv1a:256:model-v2",
    );
    const retrieval2 = new RetrievalService({
      projects: projects2,
      sources: new SourceStore(projects2),
      chunker: new SourceChunker(),
      chunkStore: new ChunkStore(projects2),
      embedding: countingV2,
      log: () => {},
    });
    const result = await retrieval2.search(f.projectId, "alpha");
    expect(result.mode).toBe("hybrid");
    expect(countingV2.documentEmbeds).toBeGreaterThan(0); // 旧缓存不被误用
  });

  it("rebuild 未变化的 source → 零重嵌；新增 source → 只嵌入新增部分", async () => {
    const counting = new CountingProvider(new DeterministicEmbeddingProvider());
    const f = await newRetrievalFixture({ embedding: counting });
    await f.addTextSource("a.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const baseline = counting.documentEmbeds;
    expect(baseline).toBeGreaterThan(0);
    // 未变化的 source 重建：chunk contentHash 未变 → 向量缓存命中
    await f.retrieval.rebuildSource(f.projectId, "S001");
    expect(counting.documentEmbeds).toBe(baseline);
    // 新增 source：只有新 source 的 chunk 被嵌入
    await f.addTextSource(
      "b.md",
      ["# B Doc", "", "beta beta beta content about another topic entirely with delta terms."].join("\n"),
    );
    await f.retrieval.search(f.projectId, "beta delta");
    expect(counting.documentEmbeds).toBeGreaterThan(baseline);
    // 新 source 嵌入量远小于全库两倍（缓存对旧 source 仍然命中）
    expect(counting.documentEmbeds - baseline).toBeLessThan(baseline);
  });
});

describe("M6.4 RetrievalService：metadata filter 与校验", () => {
  it("sourceIds / section / sourceRole / year 过滤生效", async () => {
    const f = await newRetrievalFixture();
    const a = await f.addTextSource("alpha.md", ALPHA_DOC, { title: "Alpha", year: 2023, sourceRole: "evidence" });
    await f.addTextSource(
      "method2.md",
      ["# Method", "", "association method details for the second paper on association.", "", "# Results", "", "MOTA improvements reported."].join("\n"),
      { title: "Second", year: 2021, sourceRole: "reference" },
    );
    const bySource = await f.retrieval.search(f.projectId, "association", {
      filter: { sourceIds: [a.sourceId] },
    });
    expect(bySource.results.length).toBeGreaterThan(0);
    for (const entry of bySource.results) {
      expect(entry.chunk.sourceId).toBe(a.sourceId);
    }
    const byRole = await f.retrieval.search(f.projectId, "association", {
      filter: { sourceRole: "reference" },
    });
    for (const entry of byRole.results) {
      expect(entry.source.sourceRole).not.toBe("evidence");
    }
    const byYear = await f.retrieval.search(f.projectId, "association", {
      filter: { yearFrom: 2023 },
    });
    for (const entry of byYear.results) {
      expect(entry.source.year).toBe(2023);
    }
    const bySection = await f.retrieval.search(f.projectId, "MOTA improvements", {
      filter: { section: "results" },
    });
    expect(bySection.results.length).toBeGreaterThan(0);
    for (const entry of bySection.results) {
      expect(entry.chunk.sectionTitle.toLowerCase().startsWith("results")).toBe(true);
    }
  });

  it("非法 filter → INVALID_RETRIEVAL_FILTER；非法 topK → INVALID_REQUEST", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await expect(
      f.retrieval.search(f.projectId, "x", { filter: { sourceIds: ["bogus"] } as never }),
    ).rejects.toMatchObject({ code: "INVALID_RETRIEVAL_FILTER" });
    await expect(
      f.retrieval.search(f.projectId, "x", { filter: { yearFrom: 999999 } }),
    ).rejects.toMatchObject({ code: "INVALID_RETRIEVAL_FILTER" });
    await expect(f.retrieval.search(f.projectId, "x", { topK: 0 })).rejects.toBeInstanceOf(BusinessError);
    await expect(f.retrieval.search(f.projectId, "")).rejects.toBeInstanceOf(BusinessError);
  });
});

describe("M6.4 RetrievalService：项目隔离（硬要求）", () => {
  it("Project A 查询绝不命中 Project B 的 chunk（即使 sourceId 相同）", async () => {
    const f = await newRetrievalFixture();
    const projectB = await f.projects.create("项目 B");
    await f.addTextSource("alpha.md", ALPHA_DOC, { title: "Alpha A" });
    await f.sources.add(projectB.id, {
      fileName: "alpha.md",
      content: Buffer.from(
        ["# Secret B", "", "Project B exclusive confidential zanzibar umbrella content."].join("\n"),
        "utf8",
      ),
      metadata: { title: "Alpha B" },
    });
    // 两项目 S001 同名——隔离不依赖 id 唯一性
    const resultA = await f.retrieval.search(f.projectId, "zanzibar umbrella confidential");
    expect(resultA.results).toEqual([]);
    const resultB = await f.retrieval.search(projectB.id, "zanzibar umbrella confidential");
    expect(resultB.results.length).toBeGreaterThan(0);
    expect(resultB.results[0]!.chunk.projectId).toBe(projectB.id);
    // 反向
    const aOnly = await f.retrieval.search(f.projectId, "ByteTrack MOT17");
    expect(aOnly.results.length).toBeGreaterThan(0);
    for (const entry of aOnly.results) {
      expect(entry.chunk.text).not.toContain("zanzibar");
    }
    const bOnly = await f.retrieval.search(projectB.id, "ByteTrack MOT17");
    expect(bOnly.results).toEqual([]);
  });
});

describe("M6.4 RetrievalService：生命周期（Index = Derived State）", () => {
  it("删除全部 derived 产物 → rebuild 恢复同等检索结果", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.addTextSource(
      "b.md",
      ["# B", "", "Second document about evaluation protocols and metrics."].join("\n"),
    );
    const before = await f.retrieval.search(f.projectId, "ByteTrack association");
    expect(before.results.length).toBeGreaterThan(0);
    const chunkIds = before.results.map((entry) => entry.chunk.chunkId);
    // 删除全部 derived 产物
    await f.chunkStore.removeAll(f.projectId);
    expect(existsSync(join(f.root, f.projectId, "sources", "chunks"))).toBe(false);
    // 显式 rebuild
    const report = await f.retrieval.rebuild(f.projectId);
    expect(report.chunks).toBeGreaterThan(0);
    expect(report.sources.every((outcome) => outcome.status === "indexed")).toBe(true);
    const after = await f.retrieval.search(f.projectId, "ByteTrack association");
    expect(after.results.map((entry) => entry.chunk.chunkId)).toEqual(chunkIds);
    expect(after.results[0]!.chunk.text).toEqual(before.results[0]!.chunk.text);
  });

  it("增量失效：A 未变（chunk 不重建）、B 内容变化（旧 chunk 不再命中、新 chunk 生效）", async () => {
    const f = await newRetrievalFixture();
    const a = await f.addTextSource("a.md", ALPHA_DOC);
    const b = await f.addTextSource(
      "b.md",
      ["# B Doc", "", "quokka habitat analysis baseline content for incremental testing."].join("\n"),
    );
    await f.retrieval.search(f.projectId, "quokka");
    const aChunkFile = join(f.root, f.projectId, "sources", "chunks", `${a.sourceId}.jsonl`);
    const aContentBefore = await readFile(aChunkFile, "utf8");
    // B 内容变化：删除并重新上传新内容（contentHash 变化）
    await f.sources.remove(f.projectId, b.sourceId);
    await f.sources.add(f.projectId, {
      fileName: "b.md",
      content: Buffer.from(
        ["# B Doc v2", "", "wallaby foraging behavior fully revised content with new findings."].join("\n"),
        "utf8",
      ),
    });
    // A 的 chunk 文件原样未动（未重新生成）
    expect(await readFile(aChunkFile, "utf8")).toBe(aContentBefore);
    // 新内容可检索；旧内容（quokka）不再命中
    const fresh = await f.retrieval.search(f.projectId, "wallaby foraging");
    expect(fresh.results.length).toBeGreaterThan(0);
    const stale = await f.retrieval.search(f.projectId, "quokka");
    expect(stale.results).toEqual([]);
  });

  it("删除 source → 不再命中（幽灵 chunk = 0），其他 source 不受影响", async () => {
    const f = await newRetrievalFixture();
    const a = await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.addTextSource(
      "b.md",
      ["# Keep", "", "This document survives with kappa lambda content."].join("\n"),
    );
    await f.retrieval.search(f.projectId, "kappa");
    await f.sources.remove(f.projectId, a.sourceId);
    await f.retrieval.invalidateSource(f.projectId, a.sourceId);
    const ghost = await f.retrieval.search(f.projectId, "ByteTrack MOT17 alpha");
    expect(ghost.results).toEqual([]);
    const kept = await f.retrieval.search(f.projectId, "kappa lambda");
    expect(kept.results.length).toBeGreaterThan(0);
    // 磁盘产物清理
    expect(existsSync(join(f.root, f.projectId, "sources", "chunks", `${a.sourceId}.jsonl`))).toBe(false);
  });

  it("重启语义：全新服务实例 lazy 重建检索能力（无需用户重传论文）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const projects2 = new ProjectStore({ root: f.root });
    const retrieval2 = new RetrievalService({
      projects: projects2,
      sources: new SourceStore(projects2),
      chunker: new SourceChunker(),
      chunkStore: new ChunkStore(projects2),
      log: () => {},
    });
    const result = await retrieval2.search(f.projectId, "ByteTrack MOT17");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("chunk 文件损坏 → 自愈重建（不把损坏当空库）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const file = join(f.root, f.projectId, "sources", "chunks", "S001.jsonl");
    await writeFile(file, "{corrupted!!!", "utf8");
    const healed = await f.retrieval.search(f.projectId, "ByteTrack");
    expect(healed.results.length).toBeGreaterThan(0);
  });

  it("manifest 损坏 → 自愈全量重建", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    await writeFile(join(f.root, f.projectId, "sources", "chunks", "index.json"), "not json", "utf8");
    const healed = await f.retrieval.search(f.projectId, "ByteTrack");
    expect(healed.results.length).toBeGreaterThan(0);
  });

  it("metadata-only source 重建 → SOURCE_NOT_INDEXABLE（422）；整库 rebuild 不抛", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.sources.addRecord(f.projectId, {
      sourceType: "doi",
      metadata: { title: "Metadata only", doi: "10.1/only" },
    });
    await expect(f.retrieval.rebuildSource(f.projectId, "S002")).rejects.toMatchObject({
      code: "SOURCE_NOT_INDEXABLE",
    });
    const report = await f.retrieval.rebuild(f.projectId);
    const outcomes = report.sources;
    expect(outcomes.find((o) => o.sourceId === "S002")?.status).toBe("skipped");
    expect(outcomes.find((o) => o.sourceId === "S001")?.status).toBe("indexed");
  });

  it("并发检索互不污染（同结果）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    const queries = ["alpha beta", "ByteTrack", "association", "MOT17", "cooking"];
    const rounds = await Promise.all(
      Array.from({ length: 20 }, (_, i) => f.retrieval.search(f.projectId, queries[i % queries.length]!)),
    );
    // 相同 query 的结果完全一致
    for (let i = 0; i < rounds.length; i += 1) {
      for (let j = i + 1; j < rounds.length; j += 1) {
        if (queries[i % queries.length] === queries[j % queries.length]) {
          expect(rounds[j]!.results.map((r) => r.chunk.chunkId)).toEqual(
            rounds[i]!.results.map((r) => r.chunk.chunkId),
          );
        }
      }
    }
  });

  it("rebuild 进行中检索：不损坏、不悬挂（旧快照或新快照均可）", async () => {
    const counting = new CountingProvider(new DeterministicEmbeddingProvider());
    const f = await newRetrievalFixture({ embedding: counting });
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha");
    const slow = new SlowChunker();
    slow.delayMs = 40;
    const slowService = new RetrievalService({
      projects: f.projects,
      sources: f.sources,
      chunker: slow,
      chunkStore: f.chunkStore,
      embedding: counting,
      log: () => {},
    });
    const rebuildPromise = slowService.rebuild(f.projectId);
    const searches = await Promise.all([
      slowService.search(f.projectId, "ByteTrack"),
      slowService.search(f.projectId, "association"),
      slowService.search(f.projectId, "cooking"),
    ]);
    await rebuildPromise;
    for (const result of searches) {
      expect(result.diagnostics.indexChunks).toBeGreaterThan(0);
    }
  });
});

describe("M6.4 RetrievalService：EvidenceStore 零写入（红线）", () => {
  it("search / rebuild / stats 前后 evidence.jsonl 不存在", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("alpha.md", ALPHA_DOC);
    await f.retrieval.search(f.projectId, "alpha beta");
    await f.retrieval.rebuild(f.projectId);
    await f.retrieval.stats(f.projectId);
    const evidence = new EvidenceStore(f.projects);
    expect(await evidence.list(f.projectId)).toEqual([]);
    expect(existsSync(join(f.root, f.projectId, "evidence", "evidence.jsonl"))).toBe(false);
  });
});
