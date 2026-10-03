/**
 * SurveySectionWritingContext 纯函数测试（M11.2 §二十二-1）。
 *
 * 覆盖：refs 投影正确、悬空 refs 识别、evidence/source→key 绑定、
 * speculative 分类（future 语境）、多源引用候选组、framing 节全库白名单、
 * 渲染行（synthesis / literature）。
 */

import { describe, expect, it } from "vitest";

import {
  buildSurveySectionContext,
  renderSectionLiteratureLines,
  renderSectionSynthesisLines,
} from "../../src/survey/sectionContext.js";
import type { SurveyMatrixArtifact } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact } from "../../src/survey/synthesisTypes.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { OutlineSection } from "../../src/manuscript/ManuscriptService.js";

const NOW = "2026-10-03T00:00:00.000Z";

function matrix(entries: Array<{ sourceId: string; family?: string; depth?: "fulltext" | "abstract_only" }>): SurveyMatrixArtifact {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    taxonomy: {
      families: [
        { label: "tracking_association", description: "跟踪关联", subFamilies: ["motion_based", "joint"] },
        { label: "detection", description: "检测" },
      ],
    },
    entries: entries.map((entry) => ({
      entryId: `M-${entry.sourceId}`,
      sourceId: entry.sourceId,
      interpretationDepth: entry.depth ?? "fulltext",
      ...(entry.family !== undefined ? { methodFamily: entry.family } : {}),
      anchors: [],
      status: "confirmed",
      updatedAt: NOW,
    })),
  };
}

function synthesis(items: Array<{
  id: string;
  kind: SurveySynthesisArtifact["items"][number]["kind"];
  claim: string;
  grounding: SurveySynthesisArtifact["items"][number]["groundingLevel"];
  sourceIds: string[];
  evidenceIds?: string[];
}>): SurveySynthesisArtifact {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    matrixFingerprint: "fp",
    items: items.map((item) => ({
      synthesisId: item.id,
      kind: item.kind,
      claim: item.claim,
      groundingLevel: item.grounding,
      evidenceIds: item.evidenceIds ?? [],
      sourceIds: item.sourceIds,
      derivedFrom: { entryIds: item.sourceIds.map((sourceId) => `M-${sourceId}`) },
      updatedAt: NOW,
    })),
  };
}

function evidence(id: string, sourceId: string, title: string): EvidenceRecord {
  return {
    id,
    claim: `${id} 的核验断言`,
    source: { sourceId, title, year: 2021 },
    location: { chunk: `chunk-${id}` },
    verificationStatus: "verified",
    supportStrength: "direct",
    createdBy: "test",
    createdAt: NOW,
  };
}

const BIB = [
  { key: "authora2021method", sourceId: "S-a", title: "Method A" },
  { key: "authorb2022method", sourceId: "S-b", title: "Method B" },
  { key: "authorc2023method", sourceId: "S-c", title: "Method C" },
];

describe("buildSurveySectionContext", () => {
  const baseMatrix = matrix([
    { sourceId: "S-a", family: "tracking_association" },
    { sourceId: "S-b", family: "tracking_association" },
    { sourceId: "S-c", family: "detection" },
  ]);
  const baseSynthesis = synthesis([
    {
      id: "SYN-aaaaaaaaaa",
      kind: "consensus",
      claim: "低分检测参与二次关联可减少身份切换",
      grounding: "evidence_backed",
      sourceIds: ["S-a", "S-b", "S-c"],
      evidenceIds: ["E1", "E2"],
    },
    {
      id: "SYN-bbbbbbbbbb",
      kind: "future_direction",
      claim: "端到端可学习的关联框架值得探索",
      grounding: "speculative",
      sourceIds: ["S-c"],
    },
  ]);
  const baseEvidence = [evidence("E1", "S-a", "Method A"), evidence("E2", "S-b", "Method B")];

  it("core 节：refs 投影 / evidence 绑定 / 多源引用候选组", () => {
    const section: OutlineSection = {
      id: "association",
      file: "association.tex",
      title: "数据关联方法",
      synthesisRefs: ["SYN-aaaaaaaaaa"],
      literatureRefs: ["M-S-a", "M-S-b", "M-S-c"],
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB,
      evidence: baseEvidence,
      yearBySource: new Map([["S-a", 2021], ["S-b", 2022], ["S-c", 2023]]),
      titleBySource: new Map([["S-a", "Method A"], ["S-b", "Method B"], ["S-c", "Method C"]]),
    });
    expect(context.sectionContext).toBe("core");
    expect(context.speculativeAllowed).toBe(false);
    expect(context.danglingSynthesisRefs).toEqual([]);
    expect(context.synthesis).toHaveLength(1);
    const item = context.synthesis[0]!;
    // 多源候选：E1/E2 的 evidence key + sourceIds 的文献 key 全并入候选组
    expect(item.evidenceKeys).toEqual(["authora2021method", "authorb2022method"]);
    expect(item.literatureKeys).toEqual(["authora2021method", "authorb2022method", "authorc2023method"]);
    expect(item.citationCandidates).toEqual([
      "authora2021method",
      "authorb2022method",
      "authorc2023method",
    ]);
    expect(context.evidenceBackedKeys).toEqual(["authora2021method", "authorb2022method"]);
    expect(context.evidence.map((record) => record.id).sort()).toEqual(["E1", "E2"]);
    expect(context.allowedCitationKeys).toEqual([
      "authora2021method",
      "authorb2022method",
      "authorc2023method",
    ]);
    expect(context.danglingLiteratureRefs).toEqual([]);
    expect(context.warnings).toEqual([]);
  });

  it("future 节：speculativeAllowed=true；speculative synthesis 进入投影", () => {
    const section: OutlineSection = {
      id: "future",
      file: "future-directions.tex",
      title: "未来方向与展望",
      synthesisRefs: ["SYN-bbbbbbbbbb"],
      literatureRefs: ["M-S-c"],
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB,
      evidence: baseEvidence,
    });
    expect(context.sectionContext).toBe("future");
    expect(context.speculativeAllowed).toBe(true);
    expect(context.synthesis[0]!.groundingLevel).toBe("speculative");
    expect(context.synthesis[0]!.evidenceKeys).toEqual([]);
  });

  it("悬空 refs：synthesisRefs / literatureRefs 分别识别（fail-closed 输入）", () => {
    const section: OutlineSection = {
      id: "association",
      file: "association.tex",
      title: "数据关联方法",
      synthesisRefs: ["SYN-doesnotexi"],
      literatureRefs: ["M-S-a", "M-S-zzz"],
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB,
      evidence: baseEvidence,
    });
    expect(context.danglingSynthesisRefs).toEqual(["SYN-doesnotexi"]);
    expect(context.danglingLiteratureRefs).toEqual(["M-S-zzz"]);
  });

  it("framing 节（无 refs）：白名单 = 整个 bibliography", () => {
    const section: OutlineSection = {
      id: "introduction",
      file: "introduction.tex",
      title: "引言",
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB,
      evidence: baseEvidence,
    });
    expect(context.sectionContext).toBe("framing");
    expect(context.synthesis).toEqual([]);
    expect(context.allowedCitationKeys).toEqual([
      "authora2021method",
      "authorb2022method",
      "authorc2023method",
    ]);
  });

  it("evidence_backed 但 evidenceIds 不在池内 → 降级 warning（不静默当有证据）", () => {
    const section: OutlineSection = {
      id: "association",
      file: "association.tex",
      title: "数据关联方法",
      synthesisRefs: ["SYN-aaaaaaaaaa"],
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB,
      evidence: [], // formal 池为空
    });
    expect(context.synthesis[0]!.evidenceKeys).toEqual([]);
    expect(context.evidence).toEqual([]);
    expect(context.warnings.some((warning) => warning.includes("SYN-aaaaaaaaaa"))).toBe(true);
  });

  it("文献无 bibliography 条目 → citationKey=null + warning（不可 \\cite）", () => {
    const section: OutlineSection = {
      id: "association",
      file: "association.tex",
      title: "数据关联方法",
      literatureRefs: ["M-S-c"],
    };
    const context = buildSurveySectionContext({
      section,
      matrix: baseMatrix,
      synthesis: baseSynthesis,
      bibliography: BIB.slice(0, 2), // S-c 无条目
      evidence: baseEvidence,
    });
    const literature = context.literature.find((item) => item.entryId === "M-S-c")!;
    expect(literature.citationKey).toBeNull();
    expect(context.warnings.some((warning) => warning.includes("M-S-c"))).toBe(true);
    expect(context.allowedCitationKeys).not.toContain("authorc2023method");
  });
});

describe("renderSection*Lines", () => {
  it("synthesis 行携带 grounding 措辞纪律与引用候选组；literature 行携带 key", () => {
    const context = buildSurveySectionContext({
      section: {
        id: "association",
        file: "association.tex",
        title: "数据关联方法",
        synthesisRefs: ["SYN-aaaaaaaaaa", "SYN-bbbbbbbbbb"],
        literatureRefs: ["M-S-a"],
      },
      matrix: matrix([{ sourceId: "S-a", family: "tracking_association" }, { sourceId: "S-c" }]),
      synthesis: synthesis([
        {
          id: "SYN-aaaaaaaaaa",
          kind: "consensus",
          claim: "共识结论",
          grounding: "evidence_backed",
          sourceIds: ["S-a", "S-c"],
        },
        {
          id: "SYN-bbbbbbbbbb",
          kind: "future_direction",
          claim: "未来方向",
          grounding: "speculative",
          sourceIds: ["S-c"],
        },
      ]),
      bibliography: BIB,
      evidence: [evidence("E1", "S-a", "Method A")],
    });
    const synthesisLines = renderSectionSynthesisLines(context).join("\n");
    expect(synthesisLines).toContain("[SYN-aaaaaaaaaa]");
    expect(synthesisLines).toContain("grounding=evidence_backed");
    expect(synthesisLines).toContain("grounding=speculative");
    expect(synthesisLines).toContain("值得探索"); // speculative 措辞纪律
    expect(synthesisLines).toContain("\\cite 可多 key 并列");
    const literatureLines = renderSectionLiteratureLines(context).join("\n");
    expect(literatureLines).toContain("M-S-a");
    expect(literatureLines).toContain("cite: authora2021method");
  });

  it("无 synthesis 的节渲染占位说明（不假装有依据）", () => {
    const context = buildSurveySectionContext({
      section: { id: "introduction", file: "introduction.tex", title: "引言" },
      matrix: matrix([{ sourceId: "S-a" }]),
      synthesis: synthesis([]),
      bibliography: BIB,
      evidence: [],
    });
    expect(renderSectionSynthesisLines(context)).toHaveLength(1);
    expect(renderSectionSynthesisLines(context)[0]).toContain("没有绑定 synthesis");
  });
});
