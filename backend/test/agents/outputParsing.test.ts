/**
 * outputParsing：结构化输出的防御性提取。
 *
 * 重点回归：输出被模型 maxTokens 截断（顶层对象未闭合）时，不得回退到某个
 * 嵌套子对象再报出误导性的「缺少字段 X」（2026-10-10 真实 run
 * w-b06991bbe160：Researcher JSON 截断 → 解析器抓到 plan 内层对象 →
 * "缺少非空字符串字段 domainOverview"），而要如实报告 JSON 不完整。
 */

import { describe, expect, it } from "vitest";

import { extractJsonObject, readRequiredString, StructuredOutputError } from "../../src/agents/outputParsing.js";

describe("extractJsonObject", () => {
  it("合法 JSON / 围栏包裹 / 前后带说明文字：均能提取顶层对象", () => {
    const payload = { domainOverview: "综述", plan: { questions: ["q1"] } };
    const json = JSON.stringify(payload);
    expect(extractJsonObject(json, "t")).toEqual(payload);
    expect(extractJsonObject("```json\n" + json + "\n```", "t")).toEqual(payload);
    expect(extractJsonObject("以下是结果：\n" + json + "\n以上。", "t")).toEqual(payload);
  });

  it("说明文字里有闭合的花括号（非 JSON 对象）：跳过后仍提取真正的 JSON", () => {
    const payload = { domainOverview: "综述" };
    const text = "模板形如 {key} 的占位符。\n" + JSON.stringify(payload);
    expect(extractJsonObject(text, "t")).toEqual(payload);
  });

  it("顶层对象未闭合（输出被截断）：抛 json_parse 错误并指出不完整，不回退到嵌套子对象", () => {
    // 模拟截断：plan 子对象完整闭合，顶层对象在 domainOverview 字符串中途被切断
    const truncated =
      '{"plan": {"questions": ["研究问题 1"], "queries": [{"query": "MOT identity switch", "kind": "academic"}]}, ' +
      '"domainOverview": "多目标跟踪中的身份切换问题长期';
    let caught: unknown;
    try {
      extractJsonObject(truncated, "Researcher 调研结果");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StructuredOutputError);
    const error = caught as StructuredOutputError;
    expect(error.kind).toBe("json_parse");
    expect(error.message).toContain("不完整");
    expect(error.message).toContain("截断");
    // 旧行为会在这里返回 plan 子对象，导致下游报「缺少 domainOverview」
    expect(error.message).not.toContain("domainOverview");
  });

  it("截断且嵌套层级很深：同样判定为不完整（不被更内层的闭合对象误导）", () => {
    const truncated =
      '{"bibliography": [{"key": "a2024", "title": "A"}, {"key": "b2024", "title": "B"}], "evidence": [{"claim": "c", "source": {"title": "T"';
    expect(() => extractJsonObject(truncated, "t")).toThrow(/不完整/);
  });

  it("完全没有 JSON 对象：json_parse 错误", () => {
    expect(() => extractJsonObject("没有任何对象", "t")).toThrow(StructuredOutputError);
  });
});

describe("readRequiredString", () => {
  it("缺失 → missing_field；类型错误 → wrong_type", () => {
    expect(() => readRequiredString({}, "domainOverview", "t")).toThrow(/缺少非空字符串字段 domainOverview/);
    try {
      readRequiredString({ domainOverview: 1 }, "domainOverview", "t");
    } catch (error) {
      expect((error as StructuredOutputError).kind).toBe("wrong_type");
    }
  });
});
