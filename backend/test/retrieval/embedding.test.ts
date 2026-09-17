/**
 * M6.4 EmbeddingProvider 测试：确定性 / cosine 排序 / 失败注入 / optional 语义
 * （provider 缺省时 lexical-only 健康性在 retrievalService.test 覆盖）。
 */

import { describe, expect, it } from "vitest";

import { DeterministicEmbeddingProvider } from "../../src/retrieval/embedding.js";
import { cosineSimilarity } from "../../src/retrieval/lexicalIndex.js";

describe("M6.4 DeterministicEmbeddingProvider", () => {
  it("同文本恒同向量（跨实例、跨进程语义）", async () => {
    const a = new DeterministicEmbeddingProvider();
    const b = new DeterministicEmbeddingProvider();
    const va = (await a.embedDocuments(["ByteTrack data association"]))[0]!;
    const vb = (await b.embedDocuments(["ByteTrack data association"]))[0]!;
    expect(Array.from(va)).toEqual(Array.from(vb));
  });

  it("词重叠越高 cosine 越高（语义 ≈ 词重叠的机制能力）", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const query = await provider.embedQuery("multi object tracking with byetrack");
    const near = (await provider.embedDocuments(["byetrack for multi object tracking"]))[0]!;
    const far = (await provider.embedDocuments(["cooking italian pasta recipes tonight"]))[0]!;
    const nearScore = cosineSimilarity(query, near);
    const farScore = cosineSimilarity(query, far);
    expect(nearScore).toBeGreaterThan(farScore);
    expect(nearScore).toBeGreaterThan(0.3);
  });

  it("identity 含 provider+维度信息；identity 变化 = 缓存失效信号", () => {
    const a = new DeterministicEmbeddingProvider();
    const b = new DeterministicEmbeddingProvider({ identity: "deterministic-hash:fnv1a:256:v2" });
    expect(a.identity).not.toBe(b.identity);
    expect(a.identity).toContain("256");
  });

  it("维度一致且向量已归一化", async () => {
    const provider = new DeterministicEmbeddingProvider({ dimensions: 128 });
    const vectors = await provider.embedDocuments(["some text", "other text"]);
    expect(vectors.length).toBe(2);
    for (const vector of vectors) {
      expect(vector.length).toBe(128);
      let norm = 0;
      for (let i = 0; i < vector.length; i += 1) {
        norm += vector[i]! * vector[i]!;
      }
      expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    }
  });

  it("失败注入 → 抛错（供 degradation 链路测试）", async () => {
    const provider = new DeterministicEmbeddingProvider({ failMode: () => true });
    await expect(provider.embedDocuments(["x"])).rejects.toThrow(/injected failure/);
    await expect(provider.embedQuery("x")).rejects.toThrow(/injected failure/);
  });

  it("空 token 文本 → 零向量（不抛错）", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const vector = (await provider.embedDocuments(["!!!"]))[0]!;
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      norm += vector[i]! * vector[i]!;
    }
    expect(norm).toBe(0);
  });
});
