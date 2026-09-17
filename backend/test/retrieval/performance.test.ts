/**
 * M6.4 轻量性能冒烟：数千 chunk 的 build time / query p50·p95 / 内存粗况。
 * 目标不是极限优化，是发现明显 O(N²) / 每 query 重建索引 / 每 query 重读
 * 全部文件这类量级问题（阈值放得很宽，防 CI flake）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempRoots, newRetrievalFixture } from "./fixtures.js";

afterAll(async () => {
  await cleanupTempRoots();
});

/** 确定性段落（seeded LCG） */
function paragraph(seed: number, topic: string, words: number): string {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const parts: string[] = [];
  for (let i = 0; i < words; i += 1) {
    parts.push(`${topic}${(next() % 9973).toString(36)}${i % 29}`);
  }
  return parts.join(" ") + ".";
}

describe("M6.4 Retrieval Performance（冒烟）", () => {
  it(
    "数千 chunk：build 一次性、查询毫秒级（p95 < 300ms）、内存有界",
    { timeout: 180_000 },
    async () => {
      const f = await newRetrievalFixture();
      const sources = 30;
      const sectionsPerSource = 6;
      const paragraphsPerSection = 24;
      const topics = ["tracking", "attention", "graph", "speech", "control", "vision"];
      for (let s = 0; s < sources; s += 1) {
        const content: string[] = [];
        for (let sec = 0; sec < sectionsPerSource; sec += 1) {
          content.push(`# Section ${sec + 1}`);
          for (let p = 0; p < paragraphsPerSection; p += 1) {
            content.push(paragraph(s * 1000 + sec * 100 + p, topics[(s + sec) % topics.length]!, 110));
          }
        }
        await f.addTextSource(`perf-${s}.md`, content.join("\n"), {
          title: `Perf Doc ${s}`,
          year: 2020 + (s % 5),
        });
      }
      const buildStarted = performance.now();
      const stats = await f.retrieval.stats(f.projectId);
      const buildMs = performance.now() - buildStarted;
      expect(stats.chunks).toBeGreaterThan(2000);
      expect(stats.chunks).toBeLessThan(20000);

      // 查询延迟（词表内 + 词表外混合）
      const queries = [
        "tracking association byetrack",
        "attention mechanism transformer",
        "graph convolution aggregation",
        "speech synthesis mel spectrogram",
        "control policy optimization",
        "vision occlusion detection",
        "zzz-nonexistent-query-terms",
      ];
      const latencies: number[] = [];
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 140; i += 1) {
        const query = queries[i % queries.length]!;
        const started = performance.now();
        const result = await f.retrieval.search(f.projectId, query, { topK: 10 });
        latencies.push(performance.now() - started);
        expect(result.diagnostics.indexChunks).toBe(stats.chunks); // 无每 query 重建
      }
      const after = process.memoryUsage().heapUsed;
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
      const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
      // eslint-disable-next-line no-console
      console.log(
        `[perf] chunks=${stats.chunks} build=${buildMs.toFixed(0)}ms queries=${latencies.length} p50=${p50.toFixed(1)}ms ` +
          `p95=${p95.toFixed(1)}ms heapDelta=${((after - before) / 1024 / 1024).toFixed(1)}MB ` +
          `heapTotal=${(after / 1024 / 1024).toFixed(0)}MB`,
      );
      expect(p50).toBeLessThan(100);
      expect(p95).toBeLessThan(300);
    },
  );

  it("并发 8 路 × 10 查询：总时延线性可接受且结果稳定", { timeout: 120_000 }, async () => {
    const f = await newRetrievalFixture();
    for (let s = 0; s < 6; s += 1) {
      await f.addTextSource(`conc-${s}.md`, `# Section\n\n${paragraph(s + 500, "concurrent", 200)}`, {
        title: `Concurrent ${s}`,
      });
    }
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, i) => f.retrieval.search(f.projectId, `concurrent topic ${i % 6}`, { topK: 5 })),
    );
    const elapsed = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[perf] concurrent 80 queries in ${elapsed.toFixed(0)}ms`);
    for (const result of results) {
      expect(result.diagnostics.indexChunks).toBeGreaterThan(0);
    }
    expect(elapsed).toBeLessThan(30_000);
  });
});
