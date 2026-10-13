/**
 * M13 Final Closure（A3）：Planning → Writing 边界的 partial keyPoint 守卫。
 * 真实样本（M13.7.11 §6）：真实 Planner 把 partial E012「G 与寿命倍数可直接比较」写成
 * keyPoint「寿命增益维度的直接可比性（G 与寿命倍数）」。
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { Outline } from "../../src/manuscript/ManuscriptService.js";
import {
  PARTIAL_KEYPOINT_MARKER,
  annotateOutlinePartialKeyPoints,
  matchPartialKeyPoint,
} from "../../src/writer/partialKeyPoints.js";

function evidence(input: Partial<EvidenceRecord> & { id: string; claim: string }): EvidenceRecord {
  return {
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    source: { sourceId: `S-${input.id}`, title: `Paper ${input.id}`, year: 2024 },
    location: { chunk: `${input.id}:ABS:0001:deadbeef00` },
    createdBy: "test",
    createdAt: "2026-10-13T00:00:00Z",
    ...input,
  } as EvidenceRecord;
}

const POOL: EvidenceRecord[] = [
  evidence({ id: "E005", claim: "码距每增 2 逻辑错误率被抑制 Λ=2.14±0.02，101 比特距离 7 码每周期错误率 0.143%±0.003%" }),
  evidence({ id: "E006", claim: "该逻辑存储器突破盈亏平衡，寿命超最佳物理比特 2.4±0.3 倍" }),
  evidence({ id: "E008", claim: "实时纠错实验展示完全稳定且经纠错的逻辑量子比特，相干增益 G=2.27±0.07" }),
  evidence({ id: "E011", supportStrength: "partial", claim: "表面码实验已经达到大规模容错量子算法所需的逻辑错误率。" }),
  evidence({ id: "E012", supportStrength: "partial", claim: "相干增益 G = 2.27 与表面码的 2.4 倍寿命提升是同一指标，可直接比较两条路线的纠错效果。" }),
];

describe("matchPartialKeyPoint", () => {
  it("真实样本：Planner 把 E012 写成比较维度 → 命中 E012", () => {
    const hit = matchPartialKeyPoint("寿命增益维度的直接可比性（相干增益 G 与寿命倍数可直接比较）", POOL);
    expect(hit?.record.id).toBe("E012");
  });

  it("要点本身已是拒绝 / 不确定性口径 → 不标（Planner 用 partial 提问是合法的）", () => {
    expect(matchPartialKeyPoint("相干增益 G 与寿命倍数是否可直接比较尚不能判断", POOL)).toBeNull();
    expect(matchPartialKeyPoint("两条路线的指标口径不同，不支持整体性能排序", POOL)).toBeNull();
  });

  it("有 direct 支撑的事实要点不被 partial 误标（表面码 2.4 倍突破盈亏平衡 ← E006）", () => {
    expect(matchPartialKeyPoint("表面码逻辑存储器突破盈亏平衡，寿命超最佳物理比特 2.4 倍", POOL)).toBeNull();
  });

  it("与任何 partial 记录词面不重合的要点 → 不标", () => {
    expect(matchPartialKeyPoint("介绍超导量子比特的基本门操作与读出", POOL)).toBeNull();
  });

  it("通用短语重合（「两条路线的」）不足以触发：精度优先；逐字搬运 partial 命题片段则命中（可接受的口径提示）", () => {
    expect(matchPartialKeyPoint("界定两条路线的范围", POOL)).toBeNull();
    expect(matchPartialKeyPoint("比较两条路线的纠错效果", POOL)?.record.id).toBe("E012");
  });

  it("已知局限（记录为测试）：Planner 改写后的维度名复述 partial 命题不会被标注", () => {
    expect(matchPartialKeyPoint("寿命增益维度的直接可比性（G 与寿命倍数）", POOL)).toBeNull();
  });

  it("E011 型：Planner 把「已达到容错所需逻辑错误率」写成结论 → 命中 E011", () => {
    expect(matchPartialKeyPoint("表面码实验已达到大规模容错量子算法所需的逻辑错误率", POOL)?.record.id).toBe("E011");
  });
});

describe("annotateOutlinePartialKeyPoints", () => {
  const outline: Outline = {
    title: "t",
    sections: [
      { id: "introduction", file: "introduction.tex", title: "引言", keyPoints: ["界定两条路线的范围"] },
      {
        id: "comparison",
        file: "comparison.tex",
        title: "比较",
        keyPoints: ["寿命增益维度的直接可比性（相干增益 G 与寿命倍数可直接比较）", "表面码寿命超最佳物理比特 2.4 倍"],
      },
    ],
  } as Outline;

  it("只标注命中的要点，返回副本，原 outline 不变，标注清单可审计", () => {
    const { outline: annotated, annotations } = annotateOutlinePartialKeyPoints(outline, POOL);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({ sectionId: "comparison", keyPointIndex: 0, evidenceId: "E012" });
    expect(annotated.sections[1]?.keyPoints?.[0]).toContain(PARTIAL_KEYPOINT_MARKER);
    expect(annotated.sections[1]?.keyPoints?.[0]).toContain("E012");
    expect(annotated.sections[1]?.keyPoints?.[1]).toBe("表面码寿命超最佳物理比特 2.4 倍");
    expect(annotated.sections[0]).toBe(outline.sections[0]);
    expect(outline.sections[1]?.keyPoints?.[0]).not.toContain(PARTIAL_KEYPOINT_MARKER);
  });

  it("幂等：对已标注的大纲再标注不重复", () => {
    const once = annotateOutlinePartialKeyPoints(outline, POOL).outline;
    const twice = annotateOutlinePartialKeyPoints(once, POOL);
    expect(twice.annotations).toHaveLength(0);
    expect(twice.outline).toBe(once);
  });

  it("无 partial 记录 → 原对象直接返回", () => {
    const direct = POOL.filter((record) => record.supportStrength === "direct");
    const result = annotateOutlinePartialKeyPoints(outline, direct);
    expect(result.outline).toBe(outline);
    expect(result.annotations).toEqual([]);
  });
});
