/**
 * Survey Writing 确定性 Invariant / Metrics 测试（M11.2 §二十二-3）。
 *
 * 覆盖：悬空 refs blocking、fake citation key blocking、evidence_backed
 * synthesis 可回溯 blocking、跨节白名单漂移 warning、逐篇罗列游程 warning、
 * speculative 泄漏信号（强断言未来措辞 / speculative-only 来源）、
 * 文献 / family 覆盖 metrics。
 */

import { describe, expect, it } from "vitest";

import {
  evaluateSurveyWriting,
  renderSurveyMetricsLines,
} from "../../src/survey/writingInvariants.js";
import type { SurveyMatrixArtifact } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { Outline } from "../../src/manuscript/ManuscriptService.js";

const NOW = "2026-10-03T00:00:00.000Z";

const MATRIX: SurveyMatrixArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  taxonomy: {
    families: [
      { label: "tracking_association", description: "跟踪关联" },
      { label: "detection", description: "检测" },
    ],
  },
  entries: ["S-a", "S-b", "S-c", "S-d"].map((sourceId) => ({
    entryId: `M-${sourceId}`,
    sourceId,
    interpretationDepth: "fulltext" as const,
    methodFamily: sourceId === "S-d" ? "detection" : "tracking_association",
    anchors: [],
    status: "confirmed" as const,
    updatedAt: NOW,
  })),
};

function synItem(
  id: string,
  kind: SurveySynthesisItem["kind"],
  grounding: SurveySynthesisItem["groundingLevel"],
  sourceIds: string[],
  evidenceIds: string[] = [],
): SurveySynthesisItem {
  return {
    synthesisId: id,
    kind,
    claim: `claim ${id}`,
    groundingLevel: grounding,
    evidenceIds,
    sourceIds,
    derivedFrom: { entryIds: sourceIds.map((sourceId) => `M-${sourceId}`) },
    updatedAt: NOW,
  };
}

const SYNTHESIS: SurveySynthesisArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  matrixFingerprint: "fp",
  items: [
    synItem("SYN-aaaaaaaaaa", "consensus", "evidence_backed", ["S-a", "S-b"], ["E1", "E2"]),
    synItem("SYN-bbbbbbbbbb", "comparison", "evidence_backed", ["S-a", "S-c"], ["E1"]),
    synItem("SYN-cccccccccc", "research_gap", "literature_cited", ["S-b"]),
    synItem("SYN-dddddddddd", "future_direction", "speculative", ["S-d"]),
  ],
};

const EVIDENCE: EvidenceRecord[] = [
  {
    id: "E1",
    claim: "E1",
    source: { sourceId: "S-a", title: "Method A" },
    location: { chunk: "c1" },
    verificationStatus: "verified",
    supportStrength: "direct",
    createdBy: "test",
    createdAt: NOW,
  },
  {
    id: "E2",
    claim: "E2",
    source: { sourceId: "S-b", title: "Method B" },
    location: { chunk: "c2" },
    verificationStatus: "verified",
    supportStrength: "direct",
    createdBy: "test",
    createdAt: NOW,
  },
];

const BIB = [
  { key: "a2021method", sourceId: "S-a", title: "Method A" },
  { key: "b2022method", sourceId: "S-b", title: "Method B" },
  { key: "c2023method", sourceId: "S-c", title: "Method C" },
  { key: "d2024method", sourceId: "S-d", title: "Method D" },
];

function outlineWith(refs: Record<string, { synthesis?: string[]; literature?: string[] }>): Outline {
  return {
    title: "测试综述",
    sections: [
      {
        id: "introduction",
        file: "introduction.tex",
        title: "引言",
      },
      {
        id: "association",
        file: "association.tex",
        title: "数据关联方法",
        synthesisRefs: refs["association"]?.synthesis ?? ["SYN-aaaaaaaaaa", "SYN-bbbbbbbbbb"],
        literatureRefs: refs["association"]?.literature ?? ["M-S-a", "M-S-b", "M-S-c"],
      },
      {
        id: "gap",
        file: "gaps.tex",
        title: "研究空缺",
        synthesisRefs: refs["gap"]?.synthesis ?? ["SYN-cccccccccc"],
      },
      {
        id: "future",
        file: "future-directions.tex",
        title: "未来方向与展望",
        synthesisRefs: refs["future"]?.synthesis ?? ["SYN-dddddddddd"],
      },
    ],
  };
}

function evaluate(outline: Outline, files: Record<string, string>) {
  return evaluateSurveyWriting({
    outline,
    matrix: MATRIX,
    synthesis: SYNTHESIS,
    bibliography: BIB,
    evidence: EVIDENCE,
    files: Object.entries(files).map(([file, content]) => ({ file, content })),
  });
}

describe("evaluateSurveyWriting：blocking", () => {
  it("干净稿件：blockers 空 + 基础 metrics", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}\n\n背景介绍 \\cite{a2021method}。",
      "sections/association.tex":
        "\\section{数据关联}\n\n综合结论一 \\cite{a2021method,b2022method}。\n\n比较结论 \\cite{c2023method}。",
      "sections/gaps.tex": "\\section{研究空缺}\n\n已有文献指出 \\cite{b2022method} 的局限。",
      "sections/future-directions.tex": "\\section{展望}\n\n值得探索 \\cite{d2024method}。",
    });
    expect(result.blockers).toEqual([]);
    expect(result.metrics.totalLiterature).toBe(4);
    expect(result.metrics.citedLiterature).toBe(4);
    expect(result.metrics.literatureCoverage).toBe(1);
    expect(result.metrics.evidenceBackedTotal).toBe(2);
    expect(result.metrics.evidenceBackedUsed).toBe(2);
    expect(result.metrics.groundedSynthesisUsage).toBe(1);
    expect(result.metrics.multiKeyCiteCommands).toBe(1);
  });

  it("悬空 refs → dangling_refs blocking", () => {
    const result = evaluate(
      outlineWith({ association: { synthesis: ["SYN-aaaaaaaaaa", "SYN-nope12345"] } }),
      {
        "sections/introduction.tex": "\\section{引言}",
        "sections/association.tex": "\\section{数据关联}\n\n结论 \\cite{a2021method}。",
        "sections/gaps.tex": "\\section{研究空缺}",
        "sections/future-directions.tex": "\\section{展望}",
      },
    );
    expect(result.blockers.some((blocker) => blocker.code === "dangling_refs")).toBe(true);
  });

  it("fake citation key（不在 bibliography）→ fake_citation_key blocking", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      "sections/association.tex": "\\section{数据关联}\n\n编造引用 \\cite{madeup2020fake}。",
      "sections/gaps.tex": "\\section{研究空缺}",
      "sections/future-directions.tex": "\\section{展望}",
    });
    expect(
      result.blockers.some(
        (blocker) => blocker.code === "fake_citation_key" && blocker.detail.includes("madeup2020fake"),
      ),
    ).toBe(true);
  });

  it("evidence_backed synthesis 候选组全未引用 → synthesis_untraceable blocking", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      // association 只引 S-c 的 key：SYN-aaaaaaaaaa（a,b 候选）与 SYN-bbbbbbbbbb（a,c 候选）
      // —— bbbbbbbb 会被 c 覆盖；aaaaaaaaaa（a,b）全未引用 → untraceable
      "sections/association.tex": "\\section{数据关联}\n\n只引 C \\cite{c2023method}。",
      "sections/gaps.tex": "\\section{研究空缺}",
      "sections/future-directions.tex": "\\section{展望}",
    });
    const untraceable = result.blockers.filter((blocker) => blocker.code === "synthesis_untraceable");
    expect(untraceable).toHaveLength(1);
    expect(untraceable[0]!.detail).toContain("SYN-aaaaaaaaaa");
  });
});

describe("evaluateSurveyWriting：warnings / metrics", () => {
  it("跨节白名单漂移（引了 bibliography 内但不属于本节契约的 key）→ warning", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      // d2024method 只属于 future 节契约；association 引用 = 跨节漂移
      "sections/association.tex": "\\section{数据关联}\n\n跨节引用 \\cite{a2021method,d2024method}。",
      "sections/gaps.tex": "\\section{研究空缺}",
      "sections/future-directions.tex": "\\section{展望}",
    });
    expect(
      result.warnings.some((warning) => warning.includes("d2024method") && warning.includes("契约之外")),
    ).toBe(true);
    expect(result.blockers.filter((blocker) => blocker.code === "fake_citation_key")).toEqual([]);
  });

  it("连续单 key 段落游程（≥3 段每段 1 个不同 key）→ 罗列 warning + listingRuns", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      "sections/association.tex": [
        "\\section{数据关联}",
        "",
        "论文甲做了工作 \\cite{a2021method}。",
        "",
        "论文乙做了工作 \\cite{b2022method}。",
        "",
        "论文丙做了工作 \\cite{c2023method}。",
      ].join("\n"),
      "sections/gaps.tex": "\\section{研究空缺}",
      "sections/future-directions.tex": "\\section{展望}",
    });
    expect(result.metrics.listingRuns).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("游程"))).toBe(true);
  });

  it("非展望章节强断言未来措辞 → speculative 泄漏信号 warning", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      "sections/association.tex": "\\section{数据关联}\n\n该技术必将彻底改变领域 \\cite{a2021method,b2022method}。",
      "sections/gaps.tex": "\\section{研究空缺}",
      "sections/future-directions.tex": "\\section{展望}\n\n必将在这里是允许的展望语气。",
    });
    expect(result.metrics.speculativeLeakSignals).toBe(1);
    expect(result.sections.find((section) => section.sectionId === "future")!.strongFutureHits).toBe(0);
  });

  it("speculative-only 来源被既定结论章节引用 → 泄漏 warning", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      // gap 节（非 future）引用 S-d（只由 speculative synthesis 支撑）
      "sections/association.tex": "\\section{数据关联}\n\n结论 \\cite{a2021method,b2022method,c2023method}。",
      "sections/gaps.tex": "\\section{研究空缺}\n\n局限 \\cite{d2024method}。",
      "sections/future-directions.tex": "\\section{展望}",
    });
    expect(
      result.warnings.some((warning) => warning.includes("speculative synthesis 支撑")),
    ).toBe(true);
  });

  it("family 覆盖：≥3 篇的家族全未被引用 → warning + familyCoverage 明细", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}",
      "sections/association.tex": "\\section{数据关联}\n\n结论 \\cite{a2021method,b2022method,c2023method}。",
      "sections/gaps.tex": "\\section{研究空缺}\n\n局限 \\cite{b2022method}。",
      // S-d（detection 家族唯一成员，家族 <3 不告警；这里 detection 只有 1 篇）——改验 familyCoverage 存在
      "sections/future-directions.tex": "\\section{展望}\n\n方向 \\cite{d2024method}。",
    });
    expect(result.metrics.familyCoverage.length).toBe(2);
    expect(result.metrics.familyCoverage.find((family) => family.label === "tracking_association")).toMatchObject({
      cited: 3,
      total: 3,
    });
  });

  it("renderSurveyMetricsLines 输出确定性 digest 行", () => {
    const result = evaluate(outlineWith({}), {
      "sections/introduction.tex": "\\section{引言}\n\n背景 \\cite{a2021method}。",
      "sections/association.tex": "\\section{数据关联}\n\n结论 \\cite{a2021method,b2022method,c2023method}。",
      "sections/gaps.tex": "\\section{研究空缺}\n\n局限 \\cite{b2022method}。",
      "sections/future-directions.tex": "\\section{展望}\n\n方向 \\cite{d2024method}。",
    });
    const lines = renderSurveyMetricsLines(result);
    expect(lines.some((line) => line.includes("文献覆盖：4/4"))).toBe(true);
    expect(lines.some((line) => line.includes("evidence_backed synthesis 可回溯：2/2"))).toBe(true);
    expect(lines.some((line) => line.includes("家族覆盖"))).toBe(true);
  });
});
