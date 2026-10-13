/**
 * 综述候选相关性排序（M13.8）确定性测试：不含任何真实论文标题 / arXiv ID（全部虚构），
 * 验证排序逻辑而不是记住某几篇文献。
 */

import { describe, expect, it } from "vitest";

import type { CandidateSource } from "../../src/sources/CandidateStore.js";
import {
  buildQueryHitCounts,
  legacyRecencyOrder,
  rankSurveyCandidates,
  selectRecommendedCandidates,
  type SurveyRelevanceContext,
} from "../../src/survey/candidateRelevance.js";
import { recommendedSurveyCandidateIds } from "../../src/workflow/definitions.js";

let seq = 0;
function candidate(fields: Partial<CandidateSource> & { title: string }): CandidateSource {
  seq += 1;
  const id = fields.candidateId ?? `C${String(seq).padStart(3, "0")}`;
  const arxivId = fields.arxivId ?? `2401.${String(seq).padStart(5, "0")}`;
  return {
    candidateId: id,
    identity: { arxivId, normalizedTitleFingerprint: fields.title.toLowerCase().replace(/[^a-z0-9]+/g, "") },
    origin: "academic_search",
    provider: "arxiv",
    status: "pending_review",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    arxivId,
    query: "transformer multi-object tracking",
    ...fields,
  } as CandidateSource;
}

const context: SurveyRelevanceContext = {
  topic: "基于 Transformer 的端到端多目标跟踪方法综述",
  queries: [
    { kind: "academic", query: "transformer multi-object tracking survey" },
    { kind: "academic", query: "DETR multi-object tracking track query end-to-end" },
    { kind: "academic", query: "transformer data association multi-object tracking" },
    { kind: "academic", query: "end-to-end multi-object tracking joint detection and tracking training" },
    { kind: "web", query: "awesome multi-object tracking github" },
  ],
  taxonomyFamilies: [
    { label: "track_query_based", description: "以 track query 实现自回归端到端跟踪", subFamilies: ["autoregressive_track_query"] },
    { label: "transformer_association", description: "Transformer 作为数据关联模块", subFamilies: ["tracklet_matching"] },
    { label: "transformer_3d_mot", description: "面向 3D / 多相机的端到端 Transformer 跟踪" },
  ],
  yearFrom: 2020,
};

describe("rankSurveyCandidates", () => {
  it("主题相关性优先于年份：核心短语命中的 2021 年文献排在外围 2026 年文献之前；外围 / 无摘要如实标注", () => {
    const relevantOld = candidate({ candidateId: "C101", title: "Query-Based End-to-End Multi-Object Tracking with Transformers", year: 2021, snippetOrAbstract: "We propose track queries that propagate detections across frames for end-to-end multi-object tracking." });
    const peripheralNew = candidate({ candidateId: "C102", title: "Multi-Modal Single Object Tracking with Thermal and Event Cameras", year: 2026, snippetOrAbstract: "Single object tracking across RGB, thermal and event modalities." });
    const noAbstract = candidate({ candidateId: "C103", title: "A Note on Smart City Sensing", year: 2025, snippetOrAbstract: undefined });
    const association = candidate({ candidateId: "C104", title: "Learning Tracklet Matching for Data Association in Multi-Object Tracking", year: 2022, snippetOrAbstract: "A transformer association module matches tracklets to detections." });
    const ranked = rankSurveyCandidates([peripheralNew, noAbstract, relevantOld, association], context);
    expect(ranked.map((entry) => entry.candidateId).slice(0, 2)).toEqual(expect.arrayContaining(["C101", "C104"]));
    expect(ranked[0]!.candidateId).toBe("C101");
    const byId = Object.fromEntries(ranked.map((entry) => [entry.candidateId, entry]));
    expect(byId["C101"]!.relevance).toBe("high");
    expect(byId["C101"]!.signals.matchedPhrases).toContain("multi object tracking");
    expect(byId["C101"]!.signals.familyMatches).toContain("track_query_based");
    expect(byId["C104"]!.signals.familyMatches).toContain("transformer_association");
    expect(byId["C102"]!.relevance).toBe("low");
    expect(byId["C102"]!.reasons.join(" ")).toContain("外围");
    expect(byId["C103"]!.relevance).toBe("uncertain");
    expect(byId["C103"]!.reasons.join(" ")).toContain("无法确认相关性");
    expect(ranked.indexOf(byId["C102"]!)).toBeLessThan(ranked.indexOf(byId["C103"]!));
  });

  it("多查询命中提升排序；标题完全相同的重复候选标记 nearDuplicateOf 且不进推荐集；系列论文（Method 1/2）不算重复", () => {
    const a = candidate({ candidateId: "C201", title: "Transformer Multi-Object Tracking via Track Queries", year: 2023, snippetOrAbstract: "end-to-end multi-object tracking" });
    const b = candidate({ candidateId: "C202", title: "Transformer Multi-Object Tracking via Track Queries", year: 2023, snippetOrAbstract: "end-to-end multi-object tracking" });
    const series = [1, 2].map((n) => candidate({ candidateId: `C21${n}`, title: `Multi-Object Tracking Association Method ${n}`, year: 2020 + n, snippetOrAbstract: "association" }));
    expect(rankSurveyCandidates(series, context).every((entry) => entry.signals.nearDuplicateOf === undefined)).toBe(true);
    const c = candidate({ candidateId: "C203", title: "Joint Detection and Tracking Training for Multi-Object Tracking", year: 2022, snippetOrAbstract: "joint detection and tracking training" });
    const hits = new Map<string, number>([[`arxiv:${c.arxivId}`, 3], [`arxiv:${a.arxivId}`, 1], [`arxiv:${b.arxivId}`, 1]]);
    const ranked = rankSurveyCandidates([a, b, c], { ...context, queryHits: hits });
    const byId = Object.fromEntries(ranked.map((entry) => [entry.candidateId, entry]));
    expect(byId["C203"]!.signals.queryHits).toBe(3);
    expect(byId["C203"]!.reasons.join(" ")).toContain("3 条检索词");
    expect(byId["C202"]!.signals.nearDuplicateOf ?? byId["C201"]!.signals.nearDuplicateOf).toBeDefined();
    const selection = selectRecommendedCandidates([a, b, c], ranked);
    expect(selection.basis).toBe("topic_relevance_v1");
    expect(selection.nearDuplicatesSuppressed).toBe(1);
    expect(selection.candidateIds).toHaveLength(2);
    expect(selection.candidateIds).toContain("C203");
  });

  it("方法家族覆盖：每个家族的最高分候选先入选，再按分数填满；familyCoverage 可解释", () => {
    const titles = [
      "Autoregressive Track Queries for Crowded Multi-Object Tracking",
      "Memory-Augmented Track Query Propagation in Long Videos",
      "Decoupled Detection and Track Query Refinement for Multi-Object Tracking",
      "Sparse Track Queries with Occlusion-Aware Decoding",
      "Track Query Denoising for Stable End-to-End Multi-Object Tracking",
      "Hierarchical Track Queries across Camera Views",
    ];
    const many: CandidateSource[] = titles.map((title, index) =>
      candidate({ candidateId: `C3${index}0`, title, year: 2024, snippetOrAbstract: `track query based multi-object tracking with transformers (${index})` }),
    );
    const threeD = candidate({ candidateId: "C390", title: "Multi-Camera 3D Multi-Object Tracking with Transformers", year: 2021, snippetOrAbstract: "3d multi-object tracking transformer for autonomous driving cameras" });
    const ranked = rankSurveyCandidates([...many, threeD], context);
    const selection = selectRecommendedCandidates([...many, threeD], ranked, { max: 3, familyOrder: ["track_query_based", "transformer_association", "transformer_3d_mot"] });
    expect(selection.candidateIds).toHaveLength(3);
    expect(selection.candidateIds).toContain("C390");
    expect(selection.familyCoverage["transformer_3d_mot"]).toBe(1);
    expect(selection.familyCoverage["track_query_based"]).toBeGreaterThanOrEqual(1);
  });

  it("无上下文：全部 uncertain → 旧口径回退（学术形态优先、年份降序），basis 如实标注", () => {
    const newer = candidate({ candidateId: "C401", title: "Anything Recent", year: 2025 });
    const older = candidate({ candidateId: "C402", title: "Anything Older", year: 2019 });
    const ranked = rankSurveyCandidates([older, newer], {});
    expect(ranked.every((entry) => entry.relevance === "uncertain")).toBe(true);
    const selection = selectRecommendedCandidates([older, newer], ranked);
    expect(selection.basis).toBe("recency_fallback");
    expect(selection.candidateIds).toEqual(["C401", "C402"]);
    expect(legacyRecencyOrder([older, newer]).map((entry) => entry.candidateId)).toEqual(["C401", "C402"]);
    // definitions 的导出：无上下文 = 旧行为；有上下文 = 相关性
    expect(recommendedSurveyCandidateIds([older, newer])).toEqual(["C401", "C402"]);
  });

  it("有上下文时全部候选外围 → 回退旧口径而不是空推荐集（并保留 low 标注）", () => {
    const p1 = candidate({ candidateId: "C501", title: "Protein Folding with Diffusion", year: 2024, snippetOrAbstract: "biology" });
    const p2 = candidate({ candidateId: "C502", title: "Graph Neural Networks for Traffic", year: 2023, snippetOrAbstract: "traffic forecasting" });
    const ranked = rankSurveyCandidates([p1, p2], context);
    expect(ranked.every((entry) => entry.relevance === "low")).toBe(true);
    const selection = selectRecommendedCandidates([p1, p2], ranked);
    expect(selection.basis).toBe("recency_fallback");
    expect(selection.candidateIds).toEqual(["C501", "C502"]);
    expect(selection.counts.low).toBe(2);
  });

  it("同义写法：\"Multiple Object Tracking with Transformer\" 命中核心短语 multi object tracking（不因写法差异判为外围）", () => {
    const multiple = candidate({ candidateId: "C701", title: "Multiple Object Tracking with Transformer", year: 2020, snippetOrAbstract: "a transformer based tracker for multiple object tracking" });
    const ranked = rankSurveyCandidates([multiple], context);
    expect(ranked[0]!.signals.matchedPhrases).toContain("multi object tracking");
    expect(ranked[0]!.relevance).toBe("high");
  });

  it("排序确定性：相同输入两次调用逐字节一致；年份范围前不剔除只降权", () => {
    const old = candidate({ candidateId: "C601", title: "Early Transformer Multi-Object Tracking", year: 2017, snippetOrAbstract: "multi-object tracking with transformers" });
    const inRange = candidate({ candidateId: "C602", title: "Transformer Multi-Object Tracking Revisited", year: 2022, snippetOrAbstract: "multi-object tracking with transformers revisited" });
    const first = JSON.stringify(rankSurveyCandidates([old, inRange], context));
    const second = JSON.stringify(rankSurveyCandidates([inRange, old], context));
    expect(first).toBe(second);
    const ranked = rankSurveyCandidates([old, inRange], context);
    expect(ranked[0]!.candidateId).toBe("C602");
    expect(ranked.find((entry) => entry.candidateId === "C601")!.relevance).not.toBe("uncertain");
  });
});

describe("buildQueryHitCounts", () => {
  it("只统计 executed 的 academic 条目；同一身份跨查询计数；web 条目与无身份快照忽略", () => {
    const identity = { arxivId: "2401.00001", normalizedTitleFingerprint: "x" };
    const counts = buildQueryHitCounts(
      [
        { kind: "academic", status: "executed", query: "q1", planId: "plan-1", resultSnapshot: [{ kind: "academic", identity }] },
        { kind: "academic", status: "executed", query: "q2", planId: "plan-1", resultSnapshot: [{ kind: "academic", identity }, { kind: "academic", identity }] },
        { kind: "academic", status: "failed", query: "q3", planId: "plan-1", resultSnapshot: [{ kind: "academic", identity }] },
        { kind: "web", status: "executed", query: "w1", planId: "plan-1", resultSnapshot: [{ kind: "web" }] },
        { kind: "academic", status: "executed", query: "q4", planId: "plan-0", resultSnapshot: [{ kind: "academic", identity }] },
      ],
      "plan-1",
    );
    expect(counts.get("arxiv:2401.00001")).toBe(2);
  });
});
