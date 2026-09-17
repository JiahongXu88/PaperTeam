/**
 * M6.4 Retrieval Benchmark（固定 fixture + Recall@K / MRR / source·section·page
 * hit rate + lexical vs hybrid A/B + 可重复性）。
 *
 * 边界（如实记录，不粉饰）：
 * - dense 通道用 DeterministicEmbeddingProvider（token 哈希袋）——语义能力
 *   ≈ 词重叠。hybrid 数字验证的是「融合机制」，**不代表真实 embedding 的
 *   语义召回**；真实 provider 的语义 benchmark 属后续节点（无 vendor 接入）。
 * - 语义型（跨语言无词重叠）查询按当前能力如实计入（预期低命中，不据此
 *   宣称 dense 已具备语义 bridging，也不调数据让 hybrid 获胜）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { DeterministicEmbeddingProvider } from "../../src/retrieval/embedding.js";
import type { RetrievalResult } from "../../src/retrieval/types.js";
import { cleanupTempRoots, fakeExtraction, FakePdfParser, newRetrievalFixture } from "./fixtures.js";

afterAll(async () => {
  await cleanupTempRoots();
});

// ---- 固定语料（确定性生成；学术内容为自造示例，非真实论文搬运）----

/** 确定性 filler（seeded LCG——同 seed 恒同输出） */
function filler(seed: number, count: number, prefix: string): string {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(`${prefix}${(next() % 997).toString(36)}${i % 13}`);
  }
  return words.join(" ");
}

function sectionBody(sentences: string[], seed: number): string {
  // 每句后接确定性 filler，把 section 撑到多 chunk 规模
  return sentences.map((sentence, index) => `${sentence} ${filler(seed + index, 40, "f")}.`).join("\n\n");
}

const CORPUS: Array<{ fileName: string; title: string; year: number; content: string }> = [
  {
    fileName: "mot-survey.md",
    title: "A Survey of Multi-Object Tracking",
    year: 2023,
    content: [
      "# Introduction",
      sectionBody(
        [
          "Multi-object tracking requires detecting objects and associating them across frames.",
          "The tracking-by-detection paradigm dominates recent benchmarks.",
          "Challenges include occlusion, crowded scenes, and camera motion.",
        ],
        11,
      ),
      "# Method",
      sectionBody(
        [
          "ByteTrack keeps low-confidence detections as candidates for occluded objects.",
          "The data association step uses IoU overlap and Kalman filter motion prediction.",
          "SORT applies匈牙利 assignment while DeepSORT adds an appearance embedding.",
          "Compared with the MRG-DTM baseline our two-stage association is simpler.",
        ],
        22,
      ),
      "# Experiments",
      sectionBody(
        [
          "We evaluate on MOT17 and MOT20 with MOTA, IDF1 and HOTA metrics.",
          "ByteTrack reaches MOTA 80.3 on MOT17 test set.",
          "Ablations show association quality drives IDF1 more than detector strength.",
        ],
        33,
      ),
      "# Conclusion",
      sectionBody(["Simple association rules remain competitive with complex pipelines."], 44),
    ].join("\n"),
  },
  {
    fileName: "detr.md",
    title: "Detection with Transformers",
    year: 2022,
    content: [
      "# Introduction",
      sectionBody(
        [
          "DETR frames object detection as a set prediction problem.",
          "Transformers remove the need for hand-designed anchors and NMS.",
        ],
        55,
      ),
      "# Method",
      sectionBody(
        [
          "Deformable attention attends to sparse sampling locations around reference points.",
          "The bipartite matching loss assigns predictions to ground truth objects.",
          "Multi-scale features improve small object detection significantly.",
        ],
        66,
      ),
      "# Experiments",
      sectionBody(
        [
          "On COCO, deformable DETR achieves 44 AP with faster convergence.",
          "AP improvements are largest for small and medium objects.",
        ],
        77,
      ),
    ].join("\n"),
  },
  {
    fileName: "gnn.md",
    title: "Graph Neural Networks for Citation Analysis",
    year: 2021,
    content: [
      "# Introduction",
      sectionBody(["Graph neural networks learn representations by message passing."], 88),
      "# Method",
      sectionBody(
        [
          "Graph convolution aggregates neighbor features at each layer.",
          "Attention weights can replace fixed normalization in aggregation.",
        ],
        99,
      ),
      "# Experiments",
      sectionBody(
        [
          "On the Cora citation network node classification reaches 82 accuracy.",
          "The Citeseer and Pubmed datasets show consistent trends.",
        ],
        111,
      ),
    ].join("\n"),
  },
  {
    fileName: "zh-tracking.md",
    title: "基于深度学习的多目标跟踪方法研究",
    year: 2024,
    content: [
      "# 引言",
      sectionBody(
        [
          "多目标跟踪需要在连续视频帧中检测并关联目标实例。",
          "遮挡与密集场景是数据关联的主要难点。",
        ],
        122,
      ),
      "# 方法",
      sectionBody(
        [
          "本文采用卡尔曼滤波预测目标运动，并结合外观特征进行数据关联。",
          "关联代价矩阵融合运动距离与表观相似度两 部分。",
        ],
        133,
      ),
      "# 实验与分析",
      sectionBody(
        [
          "实验表明所提数据关联策略显著提升跟踪精度。",
          "在公开数据集上的消融实验验证了运动模型的有效性。",
        ],
        144,
      ),
      "# 结论",
      sectionBody(["本文验证了简单关联规则在中文场景语料下的有效性。"], 155),
    ].join("\n"),
  },
  {
    fileName: "tts.md",
    title: "Neural Speech Synthesis",
    year: 2020,
    content: [
      "# Introduction",
      sectionBody(["Neural speech synthesis generates mel-spectrograms autoregressively."], 166),
      "# Method",
      sectionBody(
        ["Tacotron predicts spectrogram frames from character embeddings.", "Attention aligns text and audio features during training."],
        177,
      ),
      "# Experiments",
      sectionBody(["Subjective MOS scores reach 4.1 in listening tests."], 188),
    ].join("\n"),
  },
  {
    fileName: "rl.md",
    title: "Proximal Policy Optimization",
    year: 2019,
    content: [
      "# Introduction",
      sectionBody(["Policy gradient methods train agents directly from environment rewards."], 199),
      "# Method",
      sectionBody(["PPO clips the probability ratio to bound policy updates per batch."], 211),
      "# Experiments",
      sectionBody(["PPO matches full trust-region performance on Atari and MuJoCo at lower cost."], 222),
    ].join("\n"),
  },
];

interface BenchmarkQuery {
  query: string;
  expectedSourceId: string;
  expectedSection?: string;
  kind: "exact" | "en" | "zh" | "mixed" | "semantic";
}

const QUERIES: BenchmarkQuery[] = [
  // exact term（lexical 擅长）
  { query: "ByteTrack", expectedSourceId: "S001", expectedSection: "Method", kind: "exact" },
  { query: "MOT17", expectedSourceId: "S001", expectedSection: "Experiments", kind: "exact" },
  { query: "MOTA", expectedSourceId: "S001", expectedSection: "Experiments", kind: "exact" },
  { query: "MRG-DTM baseline", expectedSourceId: "S001", kind: "exact" },
  { query: "deformable attention", expectedSourceId: "S002", expectedSection: "Method", kind: "exact" },
  { query: "DETR", expectedSourceId: "S002", kind: "exact" },
  { query: "Cora citation network", expectedSourceId: "S003", expectedSection: "Experiments", kind: "exact" },
  { query: "Tacotron", expectedSourceId: "S005", expectedSection: "Method", kind: "exact" },
  { query: "PPO", expectedSourceId: "S006", kind: "exact" },
  { query: "Kalman filter", expectedSourceId: "S001", kind: "exact" },
  // 英文自然语言
  { query: "how are objects associated across frames", expectedSourceId: "S001", expectedSection: "Introduction", kind: "en" },
  { query: "set prediction without anchors", expectedSourceId: "S002", kind: "en" },
  { query: "listening test subjective scores", expectedSourceId: "S005", kind: "en" },
  // 中文
  { query: "多目标跟踪 数据关联", expectedSourceId: "S004", expectedSection: "方法", kind: "zh" },
  { query: "卡尔曼滤波 外观特征", expectedSourceId: "S004", expectedSection: "方法", kind: "zh" },
  { query: "跟踪精度 消融实验", expectedSourceId: "S004", expectedSection: "实验与分析", kind: "zh" },
  { query: "遮挡 密集场景", expectedSourceId: "S004", kind: "zh" },
  // 混合
  { query: "ByteTrack 数据关联", expectedSourceId: "S001", kind: "mixed" },
  { query: "MOT17 benchmark MOT20", expectedSourceId: "S001", expectedSection: "Experiments", kind: "mixed" },
  // 语义型（跨语言、无词重叠——当前 lexical 与 mock dense 都无法 bridge，如实计入）
  { query: "车辆与行人检测", expectedSourceId: "S001", kind: "semantic" },
  { query: "语音合成模型", expectedSourceId: "S005", kind: "semantic" },
];

interface Metrics {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  sectionHitRate: number | null;
  exactRecallAt5: number;
}

function evaluate(results: RetrievalResult[], queries: BenchmarkQuery[]): Metrics {
  const ks = [1, 5, 10];
  const hits = new Map<number, number>();
  for (const k of ks) {
    hits.set(k, 0);
  }
  let reciprocalSum = 0;
  let sectionHits = 0;
  let sectionQueries = 0;
  let exactHits5 = 0;
  let exactTotal = 0;
  queries.forEach((q, index) => {
    const sources = results[index]!.results.map((entry) => entry.chunk.sourceId);
    const ranks = sources.map((sourceId, rank) => ({ sourceId, rank: rank + 1 }));
    const first = ranks.find((entry) => entry.sourceId === q.expectedSourceId);
    for (const k of ks) {
      if (ranks.some((entry) => entry.sourceId === q.expectedSourceId && entry.rank <= k)) {
        hits.set(k, (hits.get(k) ?? 0) + 1);
      }
    }
    reciprocalSum += first !== undefined ? 1 / first.rank : 0;
    if (q.kind === "exact") {
      exactTotal += 1;
      if (ranks.some((entry) => entry.sourceId === q.expectedSourceId && entry.rank <= 5)) {
        exactHits5 += 1;
      }
    }
    if (q.expectedSection !== undefined) {
      sectionQueries += 1;
      const sectionMatch = results[index]!.results.some(
        (entry) =>
          entry.chunk.sourceId === q.expectedSourceId &&
          entry.chunk.sectionTitle.toLowerCase().startsWith(q.expectedSection!.toLowerCase()),
      );
      if (sectionMatch) {
        sectionHits += 1;
      }
    }
  });
  const total = queries.length;
  return {
    recallAt1: (hits.get(1) ?? 0) / total,
    recallAt5: (hits.get(5) ?? 0) / total,
    recallAt10: (hits.get(10) ?? 0) / total,
    mrr: reciprocalSum / total,
    sectionHitRate: sectionQueries > 0 ? sectionHits / sectionQueries : null,
    exactRecallAt5: exactTotal > 0 ? exactHits5 / exactTotal : 1,
  };
}

async function buildBenchmark(options: { embedding?: boolean } = {}) {
  const f = await newRetrievalFixture(
    options.embedding ? { embedding: new DeterministicEmbeddingProvider() } : {},
  );
  for (const doc of CORPUS) {
    await f.addTextSource(doc.fileName, doc.content, { title: doc.title, year: doc.year });
  }
  return f;
}

async function runAll(f: Awaited<ReturnType<typeof buildBenchmark>>) {
  const results: RetrievalResult[] = [];
  for (const q of QUERIES) {
    results.push(await f.retrieval.search(f.projectId, q.query, { topK: 10 }));
  }
  return results;
}

describe("M6.4 Retrieval Benchmark", () => {
  it("lexical-only：固定语料 + 22 queries 的 Recall@K / MRR / section hit", async () => {
    const f = await buildBenchmark();
    const results = await runAll(f);
    const metrics = evaluate(results, QUERIES);
    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] lexical  R@1=${metrics.recallAt1.toFixed(2)} R@5=${metrics.recallAt5.toFixed(2)} ` +
        `R@10=${metrics.recallAt10.toFixed(2)} MRR=${metrics.mrr.toFixed(2)} ` +
        `sectionHit=${metrics.sectionHitRate?.toFixed(2) ?? "n/a"} exactR@5=${metrics.exactRecallAt5.toFixed(2)}`,
    );
    // 真实质量下限（宽松防 flake）：exact-term 查询 R@5 ≥ 0.9；整体 R@10 ≥ 0.6
    expect(metrics.exactRecallAt5).toBeGreaterThanOrEqual(0.9);
    expect(metrics.recallAt10).toBeGreaterThanOrEqual(0.6);
    expect(metrics.mrr).toBeGreaterThan(0.4);
  });

  it("hybrid（deterministic mock dense）：机制验证 + 与 lexical 如实对比", async () => {
    const f = await buildBenchmark({ embedding: true });
    const results = await runAll(f);
    for (const result of results) {
      expect(result.mode).toBe("hybrid");
    }
    const metrics = evaluate(results, QUERIES);
    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] hybrid   R@1=${metrics.recallAt1.toFixed(2)} R@5=${metrics.recallAt5.toFixed(2)} ` +
        `R@10=${metrics.recallAt10.toFixed(2)} MRR=${metrics.mrr.toFixed(2)} ` +
        `sectionHit=${metrics.sectionHitRate?.toFixed(2) ?? "n/a"} exactR@5=${metrics.exactRecallAt5.toFixed(2)} ` +
        `（mock dense ≈ 词重叠：验证融合机制，不代表真实语义召回）`,
    );
    // 机制下限：hybrid 在 exact-term 上同样可用（融合不破坏 lexical 结果）
    expect(metrics.exactRecallAt5).toBeGreaterThanOrEqual(0.9);
  });

  it("可重复性：同语料两轮（含全新服务实例）指标完全一致", async () => {
    const f = await buildBenchmark();
    const first = evaluate(await runAll(f), QUERIES);
    // 全新实例（模拟重启 + lazy rebuild；chunk 重建确定性 → 指标一致）
    const projects2 = new ProjectStore({ root: f.root });
    const retrieval2 = new RetrievalService({
      projects: projects2,
      sources: new SourceStore(projects2),
      chunker: new SourceChunker(),
      chunkStore: new ChunkStore(projects2),
      log: () => {},
    });
    const secondResults: RetrievalResult[] = [];
    for (const q of QUERIES) {
      secondResults.push(await retrieval2.search(f.projectId, q.query, { topK: 10 }));
    }
    const second = evaluate(secondResults, QUERIES);
    expect(second).toEqual(first);
  });

  it("页级 ground truth（fake pymupdf parser 注入的 PDF source）", async () => {
    const extraction = fakeExtraction({
      pageCount: 4,
      toc: [
        [1, "Introduction", 1],
        [1, "Method", 2],
        [1, "Experiments", 3],
      ],
      blocks: [
        { page: 1, text: `Intro on visual grounding. ${filler(301, 30, "g")}` },
        { page: 2, text: `Visual grounding method with cross-modal attention. ${filler(302, 30, "g")}` },
        { page: 3, text: `Grounding experiments report accuracy at k. ${filler(303, 30, "g")}` },
      ],
    });
    const f = await newRetrievalFixture({ parser: new FakePdfParser({ "S001-ground.pdf": extraction }) });
    await f.sources.add(f.projectId, {
      fileName: "ground.pdf",
      content: Buffer.from("%PDF-1.4 fake"),
      metadata: { title: "Visual Grounding" },
    });
    const result = await f.retrieval.search(f.projectId, "cross-modal attention grounding", { topK: 5 });
    expect(result.results.length).toBeGreaterThan(0);
    const methodHit = result.results.find(
      (entry) => entry.chunk.sectionTitle === "Method" && entry.chunk.pageStart === 2,
    );
    expect(methodHit).toBeDefined();
    expect(methodHit!.chunk.pageStart).toBe(2);
  });
});
