/**
 * M13.7.10 Section-aware Evidence Allocation 测试：
 * - 不同章节收到不同的正式 Evidence（develop 按相关性、compare 全池、framing / conclude 空）；
 * - 未核验 / 缺锚点 / 未知 ID 不进入任何章节；规划者 pinned 命不中时逐条拒绝并给出原因；
 * - 覆盖兜底：池中每条正式记录至少落到一个 develop 节（无 develop 时落到 compare）；
 * - partial 只进相关 develop 与 compare；framing / conclude 不拿 partial；
 * - 共享真正相关的 Evidence 允许重复，不强制互斥；
 * - 证据不足的 develop 节有 evidence_insufficient 诊断；
 * - 确定性：同输入恒同结果；projectAllocatedEvidence 保持分配顺序。
 */
import { describe, expect, it } from "vitest";

import { allocateSectionEvidence, projectAllocatedEvidence } from "../../src/evidence/sectionEvidenceAllocation.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { Outline } from "../../src/manuscript/ManuscriptService.js";
import { resolveArgumentUnits } from "../../src/writer/argumentUnit.js";

const NOW = "2026-10-12T00:00:00.000Z";

function record(id: string, claim: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id,
    claim,
    quote: claim,
    source: { sourceId: "S001", title: "Surface code paper" },
    location: { chunk: `S001:abstract:${id}` },
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    createdBy: "test",
    createdAt: NOW,
    ...overrides,
  };
}

const OUTLINE: Outline = {
  title: "超导量子纠错实验综述",
  sections: [
    { id: "introduction", file: "introduction.tex", title: "引言", keyPoints: ["界定范围"] },
    { id: "surface", file: "surface.tex", title: "表面码逻辑量子比特的规模扩展", keyPoints: ["距离 5 码略优于距离 3 码；Λ=2.14；实时解码延迟 63 µs"] },
    { id: "breakeven", file: "breakeven.tex", title: "突破盈亏平衡的逻辑量子比特实验", keyPoints: ["相干增益 G=2.27；微波腔光子数态编码；寿命提升 16%"] },
    { id: "comparison", file: "comparison.tex", title: "综合比较与局限性", keyPoints: ["编码载体与规模；指标口径"] },
    { id: "conclusion", file: "conclusion.tex", title: "结论与展望", keyPoints: ["两条路线的关系"] },
  ],
};

const EVIDENCE: EvidenceRecord[] = [
  record("E001", "表面码：距离 5 码略优于距离 3 码集合，每周期逻辑错误 2.914% 对 3.028%"),
  record("E002", "表面码：距离 7 码阈值以下，Λ=2.14±0.02，101 比特"),
  record("E003", "表面码：实时解码平均延迟 63 µs，周期 1.1 µs"),
  record("E004", "盈亏平衡：相干增益 G=2.27±0.07，无模型强化学习", { source: { sourceId: "S002", title: "Breakeven paper" }, location: { chunk: "S002:abstract:E004" } }),
  record("E005", "盈亏平衡：微波腔光子数态编码，寿命提升约 16%", { source: { sourceId: "S003", title: "Breakeven cavity paper" }, location: { chunk: "S003:abstract:E005" } }),
  record("E006", "表面码已达到大规模容错所需的逻辑错误率", { supportStrength: "partial" }),
  record("E007", "一条与任何章节标题 / 要点都不重合的孤立记录", { source: { sourceId: "S004", title: "Unrelated" }, location: { chunk: "S004:c:E007" } }),
  record("E008", "未核验的表面码记录", { verificationStatus: "unverified" }),
  record("E009", "缺锚点的表面码记录 Λ=2.14", { location: { section: "Abstract" } as EvidenceRecord["location"] }),
];

describe("allocateSectionEvidence", () => {
  it("不同章节收到不同的正式 Evidence；framing / conclude 为空；compare 拿全池；非正式记录不进入任何章节", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const result = allocateSectionEvidence({ outline: OUTLINE, units, evidence: EVIDENCE });
    const byId = Object.fromEntries(result.sections.map((section) => [section.sectionId, section]));
    expect(result.formalIds).toEqual(["E001", "E002", "E003", "E004", "E005", "E006", "E007"]);
    expect(result.excludedNonFormal).toBe(2);
    expect(byId["introduction"]!.evidenceIds).toEqual([]);
    expect(byId["conclusion"]!.evidenceIds).toEqual([]);
    expect(byId["surface"]!.evidenceIds).toEqual(expect.arrayContaining(["E001", "E002", "E003"]));
    expect(byId["surface"]!.evidenceIds).not.toContain("E004");
    expect(byId["surface"]!.evidenceIds).not.toContain("E005");
    expect(byId["breakeven"]!.evidenceIds).toEqual(expect.arrayContaining(["E004", "E005"]));
    expect(byId["breakeven"]!.evidenceIds).not.toContain("E001");
    expect(byId["comparison"]!.evidenceIds).toHaveLength(7);
    for (const section of result.sections) {
      expect(section.evidenceIds).not.toContain("E008");
      expect(section.evidenceIds).not.toContain("E009");
    }
    expect(byId["surface"]!.evidenceIds).not.toEqual(byId["breakeven"]!.evidenceIds);
  });

  it("覆盖兜底：孤立记录落到某个 develop 节并被标记 coverageAdded；unassigned 为空", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const result = allocateSectionEvidence({ outline: OUTLINE, units, evidence: EVIDENCE });
    const owners = result.sections.filter((section) => section.role === "develop" && section.evidenceIds.includes("E007"));
    expect(owners).toHaveLength(1);
    expect(owners[0]!.coverageAdded).toEqual(["E007"]);
    expect(owners[0]!.diagnostics.some((line) => line.includes("覆盖兜底"))).toBe(true);
    expect(result.unassigned).toEqual([]);
  });

  it("partial 记录：相关 develop 节与 compare 节拿到，framing / conclude 不拿", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const result = allocateSectionEvidence({ outline: OUTLINE, units, evidence: EVIDENCE });
    const byId = Object.fromEntries(result.sections.map((section) => [section.sectionId, section]));
    expect(byId["surface"]!.partialIds).toEqual(["E006"]);
    expect(byId["comparison"]!.partialIds).toEqual(["E006"]);
    expect(byId["introduction"]!.partialIds).toEqual([]);
    expect(byId["conclusion"]!.partialIds).toEqual([]);
  });

  it("规划者 pinned：命中 formal 池的保留；未知 / 非正式逐条拒绝并给出原因；framing 的 pinned 有界", () => {
    const outline = structuredClone(OUTLINE);
    outline.sections[2]!.argument = { evidenceIds: ["E001", "E008", "E009", "E999"] };
    outline.sections[0]!.argument = { evidenceIds: ["E001", "E002", "E003", "E004", "E005"] };
    const units = resolveArgumentUnits({ outline });
    const result = allocateSectionEvidence({ outline, units, evidence: EVIDENCE });
    const breakeven = result.sections.find((section) => section.sectionId === "breakeven")!;
    expect(breakeven.pinned).toEqual(["E001"]);
    expect(breakeven.evidenceIds[0]).toBe("E001");
    expect(breakeven.pinnedRejected).toEqual([
      { id: "E008", reason: "not_formal" },
      { id: "E009", reason: "not_formal" },
      { id: "E999", reason: "unknown" },
    ]);
    expect(breakeven.diagnostics.some((line) => line.includes("E999(unknown)"))).toBe(true);
    const intro = result.sections.find((section) => section.sectionId === "introduction")!;
    expect(intro.evidenceIds).toEqual(["E001", "E002", "E003", "E004"]);
    expect(intro.diagnostics[0]).toContain("超出 4 条上限");
  });

  it("共享：两个 develop 节要点都提到同一事实时允许同时拿到（不强制互斥）", () => {
    const outline = structuredClone(OUTLINE);
    outline.sections[2]!.keyPoints = ["相干增益 G=2.27；与表面码的实时解码延迟 63 µs 对照"];
    const units = resolveArgumentUnits({ outline });
    const result = allocateSectionEvidence({ outline, units, evidence: EVIDENCE });
    const surface = result.sections.find((section) => section.sectionId === "surface")!;
    const breakeven = result.sections.find((section) => section.sectionId === "breakeven")!;
    expect(surface.evidenceIds).toContain("E003");
    expect(breakeven.evidenceIds).toContain("E003");
  });

  it("证据不足的 develop 节：evidence_insufficient 诊断，不凭空填充", () => {
    const outline = structuredClone(OUTLINE);
    outline.sections.splice(3, 0, { id: "decoder", file: "decoder.tex", title: "译码器硬件实现", keyPoints: ["FPGA 流水线"] });
    const units = resolveArgumentUnits({ outline });
    const result = allocateSectionEvidence({ outline, units, evidence: EVIDENCE.filter((record) => record.id !== "E007") });
    const decoder = result.sections.find((section) => section.sectionId === "decoder")!;
    expect(decoder.role).toBe("develop");
    expect(decoder.evidenceIds.length).toBeLessThan(2);
    expect(decoder.diagnostics.some((line) => line.startsWith("evidence_insufficient"))).toBe(true);
  });

  it("没有 develop 节时覆盖兜底落到 compare；compare 也没有时如实列入 unassigned", () => {
    const outline: Outline = {
      title: "x",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言" },
        { id: "comparison", file: "comparison.tex", title: "综合比较" },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    };
    const units = resolveArgumentUnits({ outline });
    const result = allocateSectionEvidence({ outline, units, evidence: EVIDENCE });
    expect(result.unassigned).toEqual([]);
    expect(result.sections[1]!.evidenceIds).toHaveLength(7);
    const noCompare: Outline = { title: "x", sections: [{ id: "introduction", file: "introduction.tex", title: "引言" }, { id: "conclusion", file: "conclusion.tex", title: "结论" }] };
    const result2 = allocateSectionEvidence({ outline: noCompare, units: resolveArgumentUnits({ outline: noCompare }), evidence: EVIDENCE });
    expect(result2.unassigned).toHaveLength(7);
  });

  it("确定性 + 投影保持分配顺序", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const a = allocateSectionEvidence({ outline: OUTLINE, units, evidence: EVIDENCE });
    const b = allocateSectionEvidence({ outline: OUTLINE, units, evidence: [...EVIDENCE].reverse() });
    expect(a.sections.map((section) => [...section.evidenceIds].sort())).toEqual(b.sections.map((section) => [...section.evidenceIds].sort()));
    expect(a).toEqual(allocateSectionEvidence({ outline: OUTLINE, units, evidence: EVIDENCE }));
    const projected = projectAllocatedEvidence(a.sections[1]!, EVIDENCE);
    expect(projected.map((record) => record.id)).toEqual(a.sections[1]!.evidenceIds);
  });
});
