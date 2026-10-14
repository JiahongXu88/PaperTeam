import { describe, expect, it } from "vitest";

import { compareFactValues, identifierTokens, normalizeLabel, parseFactValue } from "../../src/thesis/factValues.js";

describe("M14.1b factValues：数值解析", () => {
  it("解析常见数值形态（小数 / 千分位 / 科学计数 / 百分比 / 单位）", () => {
    expect(parseFactValue("0.724")).toMatchObject({ numeric: 0.724, normalized: "0.724" });
    expect(parseFactValue(".522")).toMatchObject({ numeric: 0.522 });
    expect(parseFactValue("1,065")).toMatchObject({ numeric: 1065, normalized: "1065" });
    expect(parseFactValue("1e-4")).toMatchObject({ numeric: 0.0001 });
    expect(parseFactValue("75.37%")).toMatchObject({ numeric: 75.37, unit: "%" });
    expect(parseFactValue("0.05 s")).toMatchObject({ numeric: 0.05, unit: "s" });
    expect(parseFactValue("21 ms")).toMatchObject({ numeric: 21, unit: "ms" });
    expect(parseFactValue("5.1MB")).toMatchObject({ numeric: 5.1, unit: "mb" });
    expect(parseFactValue("27.6M")).toMatchObject({ numeric: 27.6, unit: "M" });
    expect(parseFactValue("０.６９９")).toMatchObject({ numeric: 0.699 });
  });

  it("非数值内容不给 numeric（范围 / 勾选 / 文本 / 未知单位）", () => {
    expect(parseFactValue("0.654∼0.898").numeric).toBeUndefined();
    expect(parseFactValue("✓").numeric).toBeUndefined();
    expect(parseFactValue("M&C++").numeric).toBeUndefined();
    expect(parseFactValue("6-128-64-128-3").numeric).toBeUndefined();
    expect(parseFactValue("12 foo").numeric).toBeUndefined();
  });

  it("私用区字形标 glyphIssues 且不参与比较", () => {
    const value = parseFactValue("");
    expect(value.glyphIssues).toBe(true);
    expect(compareFactValues(value, parseFactValue("2")).outcome).toBe("non_numeric");
  });
});

describe("M14.1b factValues：可比性判定", () => {
  it("同值 equal；异值 value_mismatch", () => {
    expect(compareFactValues(parseFactValue("0.684"), parseFactValue("0.684")).outcome).toBe("equal");
    expect(compareFactValues(parseFactValue("0.699"), parseFactValue("0.724")).outcome).toBe("value_mismatch");
    expect(compareFactValues(parseFactValue("1.6288"), parseFactValue("1.589")).outcome).toBe("value_mismatch");
  });

  it("舍入差异单列（0.049 s vs 0.05 s）", () => {
    expect(compareFactValues(parseFactValue("0.049 s"), parseFactValue("0.05 s")).outcome).toBe("rounding_difference");
    expect(compareFactValues(parseFactValue("22.0"), parseFactValue("22.3")).outcome).toBe("value_mismatch");
  });

  it("可靠单位换算后相等：ms↔s、%↔比率、MB↔KB", () => {
    expect(compareFactValues(parseFactValue("50 ms"), parseFactValue("0.05 s")).outcome).toBe("equal_after_unit_normalization");
    expect(compareFactValues(parseFactValue("75.37%"), parseFactValue("0.7537")).outcome).toBe("equal_after_unit_normalization");
    expect(compareFactValues(parseFactValue("5.1MB"), parseFactValue("5100KB")).outcome).toBe("equal_after_unit_normalization");
  });

  it("单位无法可靠换算 → unit_incomparable（不猜）", () => {
    expect(compareFactValues(parseFactValue("21 ms"), parseFactValue("5.1MB")).outcome).toBe("unit_incomparable");
    expect(compareFactValues(parseFactValue("75.37%"), parseFactValue("75.37")).outcome).toBe("unit_incomparable");
    expect(compareFactValues(parseFactValue("27.6M"), parseFactValue("27.6MB")).outcome).toBe("unit_incomparable");
  });

  it("标签归一化与标识符 token", () => {
    expect(normalizeLabel("S ↑")).toBe("s");
    expect(normalizeLabel("max F ↑")).toBe("maxf");
    expect(normalizeLabel("PASCAL-S [39]")).toBe("pascals");
    expect(identifierTokens("SSAV 模型在DAVSOD数据集上的分离实验 Table 5 of SSAV on DAVSOD")).toEqual(["SSAV", "DAVSOD"]);
  });
});
