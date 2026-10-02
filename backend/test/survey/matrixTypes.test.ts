/**
 * M11.1.1 Survey Matrix 类型层单元测试（纯函数，无 IO）：
 * schema 解析 / taxonomy 校验 / 列表归一 / 长度截断 / 空输出 fail-closed。
 */

import { describe, expect, it } from "vitest";

import { AgentRunFailedError } from "../../src/errors.js";
import {
  COMPARED_METHODS_MAX,
  DEFAULT_SURVEY_TAXONOMY,
  KEY_FINDINGS_MAX,
  SURVEY_FIELD_LIMITS,
  UNCLASSIFIED_FAMILY,
  matrixEntryId,
  normalizeComparedMethods,
  normalizeTaxonomy,
  parseMatrixEntryOutput,
  type SurveyTaxonomy,
} from "../../src/survey/matrixTypes.js";

const TAXONOMY: SurveyTaxonomy = {
  families: [
    {
      label: "tracking_association",
      description: "多目标跟踪关联",
      subFamilies: ["motion_based", "appearance_based"],
    },
    { label: "re_identification", description: "重识别" },
    { label: "survey", description: "综述" },
  ],
};

function parse(
  parsed: Record<string, unknown>,
  depth: "fulltext" | "abstract_only" = "fulltext",
  taxonomy: SurveyTaxonomy = TAXONOMY,
) {
  return parseMatrixEntryOutput({
    sourceId: "S001",
    interpretationDepth: depth,
    parsed,
    taxonomy,
    updatedAt: "2026-10-02T08:00:00.000Z",
  });
}

describe("matrixEntryId", () => {
  it("是 sourceId 的确定性纯函数", () => {
    expect(matrixEntryId("S001")).toBe("M-S001");
    expect(matrixEntryId("S012")).toBe("M-S012");
    expect(matrixEntryId("S001")).toBe(matrixEntryId("S001"));
  });
});

describe("normalizeTaxonomy", () => {
  it("接受合法词表并保留 subFamilies", () => {
    const normalized = normalizeTaxonomy(TAXONOMY);
    expect(normalized.families.map((family) => family.label)).toEqual([
      "tracking_association",
      "re_identification",
      "survey",
    ]);
    expect(normalized.families[0]?.subFamilies).toEqual(["motion_based", "appearance_based"]);
  });

  it("去重标签、剔除空标签与保留值 unclassified", () => {
    const normalized = normalizeTaxonomy({
      families: [
        { label: "a", description: "x" },
        { label: "a", description: "dup" },
        { label: "  ", description: "blank" },
        { label: UNCLASSIFIED_FAMILY, description: "reserved" },
        { label: "b", description: "y" },
      ],
    });
    expect(normalized.families.map((family) => family.label)).toEqual(["a", "b"]);
  });

  it("空 families / 全部无效 → fail-closed", () => {
    expect(() => normalizeTaxonomy({ families: [] })).toThrow(AgentRunFailedError);
    expect(() => normalizeTaxonomy({ families: [{ label: "", description: "" }] } as never)).toThrow(
      AgentRunFailedError,
    );
  });

  it("缺省词表自检：不包含保留值且非空", () => {
    const normalized = normalizeTaxonomy(DEFAULT_SURVEY_TAXONOMY);
    expect(normalized.families.length).toBeGreaterThanOrEqual(5);
    expect(normalized.families.some((family) => family.label === UNCLASSIFIED_FAMILY)).toBe(false);
  });
});

describe("parseMatrixEntryOutput", () => {
  it("合法 fulltext 输出：字段 / taxonomy 标签 / anchors 形状全部接受", () => {
    const { entry, issues } = parse({
      researchProblem: "多目标跟踪中的关联精度问题",
      methodFamily: "tracking_association",
      subFamily: "motion_based",
      mainIdea: "低分检测框参与二次关联以减少漏检。",
      strength: "无需外观模型即可降低 IDSW。",
      limitation: "低照度下检测质量主导效果。",
      comparedMethods: ["SORT", "DeepSORT"],
      keyFindings: ["MOT17 上 IDSW 下降 40%", "FPS 保持实时"],
      anchors: [{ field: "mainIdea", chunkIds: ["S001:sec1:0001:0123456789"] }],
    });
    expect(issues).toEqual([]);
    expect(entry.entryId).toBe("M-S001");
    expect(entry.sourceId).toBe("S001");
    expect(entry.interpretationDepth).toBe("fulltext");
    expect(entry.methodFamily).toBe("tracking_association");
    expect(entry.subFamily).toBe("motion_based");
    expect(entry.comparedMethods).toEqual(["SORT", "DeepSORT"]);
    expect(entry.keyFindings?.length).toBe(2);
    expect(entry.anchors).toEqual([
      { field: "mainIdea", chunkIds: ["S001:sec1:0001:0123456789"] },
    ]);
    expect(entry.status).toBe("draft");
  });

  it("taxonomy 非法标签 fail-closed → unclassified + issue 记录原始提案（不静默扩表）", () => {
    const { entry, issues } = parse({
      mainIdea: "某方法",
      methodFamily: "quantum_flux_matching",
    });
    expect(entry.methodFamily).toBe(UNCLASSIFIED_FAMILY);
    const issue = issues.find((item) => item.code === "method_family_not_in_taxonomy");
    expect(issue).toBeDefined();
    expect(issue?.proposed).toBe("quantum_flux_matching");
  });

  it("模型自报 unclassified 属合法值（不产生 issue）", () => {
    const { entry, issues } = parse({ mainIdea: "x", methodFamily: "unclassified" });
    expect(entry.methodFamily).toBe(UNCLASSIFIED_FAMILY);
    expect(issues.find((item) => item.code === "method_family_not_in_taxonomy")).toBeUndefined();
  });

  it("subFamily 不在 family 列表 → 丢弃 + issue；在列表 → 保留", () => {
    const invalid = parse({
      mainIdea: "x",
      methodFamily: "tracking_association",
      subFamily: "kalman_magic",
    });
    expect(invalid.entry.subFamily).toBeUndefined();
    expect(invalid.issues.some((item) => item.code === "subfamily_not_in_taxonomy")).toBe(true);

    const valid = parse({
      mainIdea: "x",
      methodFamily: "tracking_association",
      subFamily: "appearance_based",
    });
    expect(valid.entry.subFamily).toBe("appearance_based");
  });

  it("keyFindings 超上限 → 截断到上限 + issue", () => {
    const { entry, issues } = parse({
      mainIdea: "x",
      keyFindings: ["a", "b", "c", "d", "e"],
    });
    expect(entry.keyFindings).toEqual(["a", "b", "c"]);
    expect(issues.some((item) => item.code === "key_findings_capped")).toBe(true);
    expect(KEY_FINDINGS_MAX).toBe(3);
  });

  it("comparedMethods 归一：trim / 大小写不敏感去重 / 空项剔除", () => {
    const { entry } = parse({
      mainIdea: "x",
      comparedMethods: ["ByteTrack", "bytetrack", "  OC-SORT  ", "", "DeepSORT"],
    });
    expect(entry.comparedMethods).toEqual(["ByteTrack", "OC-SORT", "DeepSORT"]);
  });

  it("normalizeComparedMethods 上限与空输入", () => {
    expect(normalizeComparedMethods(undefined)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, index) => `method${index}`);
    expect(normalizeComparedMethods(many).length).toBe(COMPARED_METHODS_MAX);
  });

  it("abstract_only：评价性字段剥离 + issue，描述性字段保留", () => {
    const { entry, issues } = parse(
      {
        researchProblem: "跟踪方法综述缺失",
        methodFamily: "survey",
        mainIdea: "综述 MOT 方法谱系。",
        strength: "覆盖全面。",
        limitation: "无实验。",
        keyFindings: ["结论一"],
      },
      "abstract_only",
    );
    expect(entry.interpretationDepth).toBe("abstract_only");
    expect(entry.mainIdea).toBeDefined();
    expect(entry.strength).toBeUndefined();
    expect(entry.limitation).toBeUndefined();
    expect(entry.keyFindings).toBeUndefined();
    const dropped = issues.filter((item) => item.code === "abstract_only_field_dropped");
    expect(dropped.length).toBe(3); // strength / limitation / keyFindings
  });

  it("anchors 形状校验：非法 field 丢弃 + issue；空 chunkIds 丢弃", () => {
    const { entry, issues } = parse({
      mainIdea: "x",
      anchors: [
        { field: "notAField", chunkIds: ["S001:a:0001:0123456789"] },
        { field: "mainIdea", chunkIds: [] },
        { field: "strength", chunkIds: ["S001:a:0002:0123456789", "S001:a:0002:0123456789"] },
      ],
    });
    expect(entry.anchors).toEqual([{ field: "strength", chunkIds: ["S001:a:0002:0123456789"] }]);
    expect(issues.some((item) => item.code === "anchor_field_invalid")).toBe(true);
  });

  it("超长文本截断到字段上限（不拒绝）", () => {
    const long = "长".repeat(SURVEY_FIELD_LIMITS.mainIdea + 50);
    const { entry } = parse({ mainIdea: long });
    expect(entry.mainIdea?.length).toBe(SURVEY_FIELD_LIMITS.mainIdea);
  });

  it("全部核心字段为空 → fail-closed（不产出空壳行）", () => {
    expect(() => parse({ keyTechnique: "只有次要字段" })).toThrow(AgentRunFailedError);
    expect(() => parse({})).toThrow(AgentRunFailedError);
  });
});
