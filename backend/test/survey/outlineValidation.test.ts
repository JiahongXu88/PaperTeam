/**
 * M11.1.3 Survey Outline 确定性契约校验规则矩阵：
 * blocking（dangling refs / speculative 泄漏 / paper-by-paper 退化 / unsupported
 * gap / future）与 warnings（覆盖与平衡）逐条锁死。
 */

import { describe, expect, it } from "vitest";

import type { Outline, OutlineSection } from "../../src/manuscript/ManuscriptService.js";
import {
  classifySurveySection,
  validateSurveyOutline,
} from "../../src/survey/outlineValidation.js";
import type { SurveyMatrixArtifact, SurveyMatrixEntry } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";

function section(partial: Partial<OutlineSection> & { id: string }): OutlineSection {
  return {
    file: `${partial.id}.tex`,
    title: partial.id,
    ...partial,
  };
}

function outline(sections: OutlineSection[]): Outline {
  return { title: "测试综述", sections };
}

function entry(entryId: string, overrides: Partial<SurveyMatrixEntry> = {}): SurveyMatrixEntry {
  return {
    entryId,
    sourceId: entryId.replace(/^M-/, ""),
    interpretationDepth: "fulltext",
    anchors: [],
    status: "draft",
    updatedAt: "2026-10-03T00:00:00.000Z",
    methodFamily: "tracking_association",
    ...overrides,
  };
}

function synthesis(
  synthesisId: string,
  kind: SurveySynthesisItem["kind"],
  groundingLevel: SurveySynthesisItem["groundingLevel"],
  entryIds: string[],
): SurveySynthesisItem {
  return {
    synthesisId,
    kind,
    claim: `claim of ${synthesisId}`,
    groundingLevel,
    evidenceIds: [],
    sourceIds: entryIds.map((id) => id.replace(/^M-/, "")),
    derivedFrom: { entryIds },
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
}

function matrix(entries: SurveyMatrixEntry[]): SurveyMatrixArtifact {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-03T00:00:00.000Z",
    taxonomy: { families: [{ label: "tracking_association", description: "关联方法" }] },
    entries,
  };
}

function synthesisArtifact(items: SurveySynthesisItem[]): SurveySynthesisArtifact {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-03T00:00:00.000Z",
    matrixFingerprint: "f",
    items,
  };
}

/** 6 篇文献 + 七类各 1 条 synthesis 的标准夹具 */
function standardInputs(): { matrix: SurveyMatrixArtifact; synthesis: SurveySynthesisArtifact } {
  const entries = Array.from({ length: 6 }, (_, index) => entry(`M-S00${index + 1}`));
  const items = [
    synthesis("SYN-aaaaaaaaaa", "taxonomy", "literature_cited", ["M-S001", "M-S002", "M-S003"]),
    synthesis("SYN-bbbbbbbbbb", "trend", "evidence_backed", ["M-S001", "M-S002"]),
    synthesis("SYN-cccccccccc", "comparison", "literature_cited", ["M-S002", "M-S003"]),
    synthesis("SYN-dddddddddd", "consensus", "literature_cited", ["M-S001", "M-S004", "M-S005"]),
    synthesis("SYN-eeeeeeeeee", "research_gap", "literature_cited", ["M-S004", "M-S006"]),
    synthesis("SYN-ffffffffff", "future_direction", "cited" as never, ["M-S001"]),
    synthesis("SYN-0101010101", "future_direction", "speculative", ["M-S002", "M-S003"]),
  ];
  items[5]!.groundingLevel = "evidence_backed";
  return { matrix: matrix(entries), synthesis: synthesisArtifact(items) };
}

/** 合法的 taxonomy 组织大纲（退化对照） */
function validOutline(): Outline {
  const all = ["M-S001", "M-S002", "M-S003", "M-S004", "M-S005", "M-S006"];
  return outline([
    section({ id: "introduction", title: "引言" }),
    section({
      id: "taxonomy",
      title: "方法分类",
      synthesisRefs: ["SYN-aaaaaaaaaa"],
      literatureRefs: all,
    }),
    section({
      id: "trends",
      title: "演进与比较",
      synthesisRefs: ["SYN-bbbbbbbbbb", "SYN-cccccccccc"],
      literatureRefs: all,
    }),
    section({
      id: "gaps",
      title: "研究空缺",
      synthesisRefs: ["SYN-eeeeeeeeee"],
      literatureRefs: all,
    }),
    section({
      id: "future-directions",
      title: "未来方向",
      synthesisRefs: ["SYN-ffffffffff", "SYN-0101010101", "SYN-eeeeeeeeee"],
      literatureRefs: all,
    }),
    section({ id: "conclusion", title: "结论" }),
  ]);
}

describe("validateSurveyOutline：blocking 规则", () => {
  it("合法 taxonomy 组织大纲：零 blocking", () => {
    const input = standardInputs();
    const result = validateSurveyOutline(validOutline(), input);
    expect(result.blocking).toEqual([]);
    expect(result.summary.sections).toEqual({ total: 6, framing: 2, future: 1, gap: 1, core: 2 });
    expect(result.summary.synthesisCoverage).toBeCloseTo(6 / 7);
    expect(result.summary.literatureCoverage).toBe(1);
  });

  it("Rule 2：悬空 synthesisRef → blocking", () => {
    const input = standardInputs();
    const bad = validOutline();
    (bad.sections[1] as OutlineSection).synthesisRefs = ["SYN-aaaaaaaaaa", "SYN-doesnotex"];
    const result = validateSurveyOutline(bad, input);
    expect(result.blocking.some((error) => error.includes("SYN-doesnotex") && error.includes("taxonomy"))).toBe(true);
  });

  it("Rule 3：悬空 literatureRef → blocking", () => {
    const input = standardInputs();
    const bad = validOutline();
    (bad.sections[1] as OutlineSection).literatureRefs = ["M-S001", "M-S999"];
    const result = validateSurveyOutline(bad, input);
    expect(result.blocking.some((error) => error.includes("M-S999"))).toBe(true);
  });

  it("Rule 4：core section 缺 synthesisRefs → blocking（Introduction/Conclusion 豁免）", () => {
    const input = standardInputs();
    const bad = validOutline();
    delete (bad.sections[1] as OutlineSection).synthesisRefs;
    const result = validateSurveyOutline(bad, input);
    expect(result.blocking.some((error) => error.includes("taxonomy") && error.includes("synthesisRefs"))).toBe(true);
    // framing 无 refs 不触发
    expect(result.blocking.every((error) => !error.includes("introduction") && !error.includes("conclusion"))).toBe(true);
  });

  it("Rule 5：speculative 进 taxonomy 主干 / consensus 章节 → blocking；进 future → 合法", () => {
    const input = standardInputs();
    // speculative future 引用绑到 taxonomy 分类章节
    const bad = validOutline();
    (bad.sections[1] as OutlineSection).synthesisRefs = ["SYN-aaaaaaaaaa", "SYN-0101010101"];
    const result = validateSurveyOutline(bad, input);
    expect(
      result.blocking.some((error) => error.includes("SYN-0101010101") && error.includes("speculative")),
    ).toBe(true);

    // 同一条 speculative 在 future 章节合法（合法大纲即包含该情形，零 blocking）
    const ok = validateSurveyOutline(validOutline(), input);
    expect(ok.blocking).toEqual([]);
  });

  it("Rule 5：speculative 进 consensus 命名章节 → blocking", () => {
    const input = standardInputs();
    const withConsensus = validOutline();
    withConsensus.sections.splice(3, 0, section({
      id: "consensus",
      title: "研究共识",
      synthesisRefs: ["SYN-dddddddddd", "SYN-0101010101"],
      literatureRefs: ["M-S001", "M-S004", "M-S005"],
    }));
    const result = validateSurveyOutline(withConsensus, input);
    expect(result.blocking.some((error) => error.includes("consensus") && error.includes("speculative"))).toBe(true);
  });

  it("Rule 6：gap 章节绑非 research_gap synthesis → blocking；无 refs 的自造 gap → blocking", () => {
    const input = standardInputs();
    const foreign = validOutline();
    (foreign.sections[3] as OutlineSection).synthesisRefs = ["SYN-eeeeeeeeee", "SYN-bbbbbbbbbb"];
    expect(
      validateSurveyOutline(foreign, input).blocking.some(
        (error) => error.includes("gaps") && error.includes("research_gap"),
      ),
    ).toBe(true);

    const selfMade = validOutline();
    delete (selfMade.sections[3] as OutlineSection).synthesisRefs;
    expect(
      validateSurveyOutline(selfMade, input).blocking.some(
        (error) => error.includes("gaps") && error.includes("synthesisRefs"),
      ),
    ).toBe(true);
  });

  it("Rule 7：future 章节无 refs → blocking；cited/inferred future 均可进 future", () => {
    const input = standardInputs();
    const empty = validOutline();
    delete (empty.sections[4] as OutlineSection).synthesisRefs;
    expect(
      validateSurveyOutline(empty, input).blocking.some(
        (error) => error.includes("future") && error.includes("synthesisRefs"),
      ),
    ).toBe(true);
    // 合法大纲的 future 章节同时含 evidence_backed cited future 与 speculative
    // inferred future（不抹平——两者都以 refs 形式进入，不复制 groundingLevel）
    const ok = validateSurveyOutline(validOutline(), input);
    expect(ok.blocking).toEqual([]);
  });

  it("Rule 1：8 篇文献 7 节、每正文节 1 篇 → paper-by-paper 退化 blocking", () => {
    const entries = Array.from({ length: 8 }, (_, index) => entry(`M-S00${index + 1}`));
    const items = [
      synthesis("SYN-aaaaaaaaaa", "taxonomy", "literature_cited", ["M-S001", "M-S002", "M-S003"]),
      synthesis("SYN-eeeeeeeeee", "research_gap", "literature_cited", ["M-S008"]),
      synthesis("SYN-ffffffffff", "future_direction", "speculative", ["M-S007"]),
    ];
    const degenerate = outline([
      section({ id: "introduction", title: "引言" }),
      section({ id: "paper-a", title: "论文 A 方法", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S001"] }),
      section({ id: "paper-b", title: "论文 B 方法", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S002"] }),
      section({ id: "paper-c", title: "论文 C 方法", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S003"] }),
      section({ id: "paper-d", title: "论文 D 方法", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S004"] }),
      section({ id: "paper-e", title: "论文 E 方法", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S005"] }),
      section({ id: "conclusion", title: "结论" }),
    ]);
    const result = validateSurveyOutline(degenerate, { matrix: matrix(entries), synthesis: synthesisArtifact(items) });
    expect(result.blocking.some((error) => error.includes("逐篇"))).toBe(true);
  });

  it("Rule 1 不误伤：文献 <5 篇时逐篇结构不触发（小 corpus 可能是真实结构）", () => {
    const entries = [entry("M-S001"), entry("M-S002"), entry("M-S003")];
    const items = [synthesis("SYN-aaaaaaaaaa", "taxonomy", "literature_cited", ["M-S001", "M-S002", "M-S003"])];
    const small = outline([
      section({ id: "introduction", title: "引言" }),
      section({ id: "motion", title: "运动关联", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S001"] }),
      section({ id: "appearance", title: "外观关联", synthesisRefs: ["SYN-aaaaaaaaaa"], literatureRefs: ["M-S002"] }),
      section({ id: "conclusion", title: "结论" }),
    ]);
    const result = validateSurveyOutline(small, { matrix: matrix(entries), synthesis: synthesisArtifact(items) });
    expect(result.blocking.every((error) => !error.includes("逐篇"))).toBe(true);
  });
});

describe("validateSurveyOutline：warnings（覆盖 / 平衡，不阻断）", () => {
  it("family 失衡 ≥60% → warning 而非 blocking", () => {
    const input = standardInputs();
    const entries = input.matrix.entries.map((item, index) =>
      index < 4 ? item : entry(item.entryId, { methodFamily: "re_identification" }),
    );
    const result = validateSurveyOutline(validOutline(), { ...input, matrix: matrix(entries) });
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("失衡"))).toBe(true);
  });

  it("unclassified 存在 → warning", () => {
    const input = standardInputs();
    const entries = input.matrix.entries.map((item, index) =>
      index === 5 ? entry(item.entryId, { methodFamily: undefined }) : item,
    );
    const result = validateSurveyOutline(validOutline(), { ...input, matrix: matrix(entries) });
    expect(result.warnings.some((warning) => warning.includes("unclassified"))).toBe(true);
  });

  it("abstract_only 占比 ≥50% → warning", () => {
    const input = standardInputs();
    const entries = input.matrix.entries.map((item, index) =>
      index < 3 ? entry(item.entryId, { interpretationDepth: "abstract_only" }) : item,
    );
    const result = validateSurveyOutline(validOutline(), { ...input, matrix: matrix(entries) });
    expect(result.warnings.some((warning) => warning.includes("abstract_only"))).toBe(true);
  });

  it("literatureRefs 覆盖 <50%（≥6 篇时）→ warning", () => {
    const input = standardInputs();
    const partial = validOutline();
    for (const item of partial.sections) {
      if (item.literatureRefs !== undefined) {
        item.literatureRefs = ["M-S001", "M-S002"];
      }
    }
    const result = validateSurveyOutline(partial, input);
    expect(result.warnings.some((warning) => warning.includes("覆盖率低"))).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("分类章节未绑 taxonomy synthesis → warning", () => {
    const input = standardInputs();
    const bad = validOutline();
    (bad.sections[1] as OutlineSection).synthesisRefs = ["SYN-bbbbbbbbbb"]; // 分类章只绑 trend
    const result = validateSurveyOutline(bad, input);
    expect(result.warnings.some((warning) => warning.includes("taxonomy synthesis"))).toBe(true);
  });

  it("future 章节混入 trend 等非 future/gap synthesis → warning（不阻断）", () => {
    const input = standardInputs();
    const mixed = validOutline();
    (mixed.sections[4] as OutlineSection).synthesisRefs = [
      "SYN-ffffffffff",
      "SYN-0101010101",
      "SYN-bbbbbbbbbb",
    ];
    const result = validateSurveyOutline(mixed, input);
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("展望章节"))).toBe(true);
  });

  it("单一年份 corpus（≥5 篇）→ warning；年份多元化后不触发", () => {
    const input = standardInputs();
    const yearBySource = new Map(input.matrix.entries.map((item) => [item.sourceId, 2022]));
    const result = validateSurveyOutline(validOutline(), { ...input, yearBySource });
    expect(result.warnings.some((warning) => warning.includes("年份单一"))).toBe(true);

    const spread = new Map([
      ["S001", 2016],
      ["S002", 2017],
      ["S003", 2019],
      ["S004", 2020],
      ["S005", 2021],
      ["S006", 2022],
    ]);
    const spreadResult = validateSurveyOutline(validOutline(), { ...input, yearBySource: spread });
    expect(spreadResult.warnings.every((warning) => !warning.includes("年份单一"))).toBe(true);
  });
});

describe("classifySurveySection：语境分类", () => {
  it("framing / future / gap / core 的次序与关键词", () => {
    expect(classifySurveySection(section({ id: "introduction", title: "引言" }))).toBe("framing");
    expect(classifySurveySection(section({ id: "conclusion", title: "Conclusion" }))).toBe("framing");
    expect(classifySurveySection(section({ id: "future", title: "Future Directions" }))).toBe("future");
    expect(classifySurveySection(section({ id: "outlook", title: "展望" }))).toBe("future");
    expect(classifySurveySection(section({ id: "limitations", title: "Limitations and Research Gaps" }))).toBe("gap");
    expect(classifySurveySection(section({ id: "open-issues", title: "开放问题" }))).toBe("gap");
    expect(classifySurveySection(section({ id: "taxonomy", title: "方法分类" }))).toBe("core");
  });

  it("「Conclusion and Future Directions」混合标题按 future 处理（speculative 合法去处）", () => {
    expect(classifySurveySection(section({ id: "conclusion-future", title: "Conclusion and Future Directions" }))).toBe(
      "future",
    );
  });
});
