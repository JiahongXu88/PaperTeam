/**
 * M6.4 lexical index 测试：BM25 行为 / 中英文 / topK / predicate / 确定性 /
 * source 级增删（df 递减）/ 余弦。
 */

import { describe, expect, it } from "vitest";

import { LexicalIndex, cosineSimilarity } from "../../src/retrieval/lexicalIndex.js";
import type { SourceChunk } from "../../src/retrieval/types.js";

function chunkOf(sourceId: string, ordinal: number, sectionId: string, text: string): SourceChunk {
  return {
    chunkId: `${sourceId}:${sectionId}:${String(ordinal).padStart(4, "0")}:abc${ordinal}def01`,
    projectId: "p1",
    sourceId,
    sectionId,
    sectionTitle: sectionId,
    ordinal,
    text,
    charCount: text.length,
    tokenCount: text.length,
    contentHash: "x".repeat(10),
    generatedAt: "2026-09-17T00:00:00Z",
  };
}

describe("M6.4 LexicalIndex（BM25）", () => {
  it("精确术语命中（稀有词排序高于常见词）", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [
      chunkOf("S001", 1, "SEC01", "ByteTrack introduces a simple yet effective association approach."),
      chunkOf("S001", 2, "SEC01", "The model uses attention and the model is evaluated on many tasks."),
    ]);
    const hits = index.search("ByteTrack", { topN: 5 });
    expect(hits[0]!.chunkId).toContain("0001");
  });

  it("中文查询命中中文 chunk（bigram 通道）", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [
      chunkOf("S001", 1, "SEC01", "本文提出一种基于深度学习的多目标跟踪数据关联方法。"),
      chunkOf("S001", 2, "SEC01", "我们在图像分类任务上进行了大量实验。"),
    ]);
    const hits = index.search("数据关联", { topN: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunkId).toContain("0001");
  });

  it("中英混合查询", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [
      chunkOf("S001", 1, "SEC01", "We evaluate ByteTrack on the MOT17 benchmark with 数据关联 improvements."),
      chunkOf("S001", 2, "SEC01", "An unrelated paragraph about cooking recipes."),
    ]);
    const hits = index.search("ByteTrack 数据关联", { topN: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.chunkId).toContain("0001");
  });

  it("topN 截断", () => {
    const index = new LexicalIndex();
    index.addSource(
      "S001",
      Array.from({ length: 20 }, (_, i) => chunkOf("S001", i + 1, "SEC01", `tracking tracking chunk number ${i + 1}`)),
    );
    const hits = index.search("tracking", { topN: 5 });
    expect(hits.length).toBe(5);
  });

  it("predicate（metadata filter）在打分前生效", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [chunkOf("S001", 1, "SEC01", "tracking evaluation content")]);
    index.addSource("S002", [chunkOf("S002", 1, "SEC01", "tracking evaluation content too")]);
    const filtered = index.search("tracking", {
      topN: 10,
      predicate: (chunk) => chunk.sourceId === "S002",
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.chunkId.startsWith("S002")).toBe(true);
  });

  it("确定性排序：同分并列按 chunkId 字典序", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [chunkOf("S001", 2, "SEC01", "identical text alpha")]);
    index.addSource("S002", [chunkOf("S002", 1, "SEC01", "identical text alpha")]);
    const first = index.search("identical", { topN: 10 });
    const second = index.search("identical", { topN: 10 });
    expect(first).toEqual(second);
    expect(first[0]!.chunkId < first[1]!.chunkId).toBe(true);
  });

  it("removeSource 后 df 递减（该词在剩余库中重新变得有区分度）且无幽灵命中", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [chunkOf("S001", 1, "SEC01", "byetrack byetrack unique words here")]);
    index.addSource("S002", [chunkOf("S002", 1, "SEC01", "byetrack byetrack other text")]);
    expect(index.size).toBe(2);
    index.removeSource("S001");
    expect(index.size).toBe(1);
    const hits = index.search("unique", { topN: 10 });
    expect(hits.length).toBe(0); // S001 已移除
    const remaining = index.search("byetrack", { topN: 10 });
    expect(remaining.length).toBe(1);
  });

  it("空查询 / 无命中 → 空结果", () => {
    const index = new LexicalIndex();
    index.addSource("S001", [chunkOf("S001", 1, "SEC01", "content")]);
    expect(index.search("", { topN: 5 })).toEqual([]);
    expect(index.search("nonexistentterm", { topN: 5 })).toEqual([]);
  });
});

describe("M6.4 cosineSimilarity", () => {
  it("同向 = 1，正交 = 0，反向 = -1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0]);
    const c = new Float32Array([0, 1]);
    const d = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 5);
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1, 5);
  });

  it("零向量 → 0（不产生 NaN）", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});
