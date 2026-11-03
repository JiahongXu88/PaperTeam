/**
 * M16 工程收口 A：顶层对象的只加转义修复 + 不回退内层碎片 + expectAnyKey。
 * 样例形态取自 M16 留出集真实单元输出（中文正文夹裸 ASCII 引号、LaTeX 反斜杠、缺开引号、401 错误体）。
 */
import { describe, expect, it } from "vitest";

import { extractJsonObject, repairJsonEscapes, StructuredOutputError } from "../../src/agents/outputParsing.js";

const UNIT_KEYS = ["summary", "issues", "academicScore", "riskScore", "claims"];

describe("extractJsonObject · M16 工程收口 A", () => {
  it("未转义的 ASCII 引号：只加转义恢复整份对象（内容逐字），onRepair 报 stray_quote", () => {
    const raw = '{"summary":"贡献清晰，但"real-world dynamics"表述超出范围。","issues":[{"category":"academic","severity":"major","description":"正文称 "shown in Fig. 2"，与图注不符","quote":"x"}],"academicScore":70}';
    let kinds: string[] = [];
    const parsed = extractJsonObject(raw, "unit", { expectAnyKey: UNIT_KEYS, onRepair: (k) => { kinds = k; } });
    expect(kinds).toEqual(["stray_quote"]);
    expect(parsed["summary"]).toBe('贡献清晰，但"real-world dynamics"表述超出范围。');
    expect((parsed["issues"] as Array<Record<string, unknown>>)[0]!["description"]).toBe('正文称 "shown in Fig. 2"，与图注不符');
    expect(parsed["academicScore"]).toBe(70);
  });

  it("正文里的「引号 + 逗号 + 普通词」不是结构结束（\"Splatting\", a loose…）", () => {
    const raw = '{"summary":"a typo of "Splatting" as "Splitting", a loose attribution","issues":[]}';
    expect(extractJsonObject(raw, "unit", { expectAnyKey: UNIT_KEYS })["summary"]).toBe('a typo of "Splatting" as "Splitting", a loose attribution');
  });

  it("LaTeX 非法转义（\\mathcal）：反斜杠按字面量保留", () => {
    const raw = '{"summary":"符号 S 与 \\mathcal{S} 混用","issues":[]}';
    let kinds: string[] = [];
    expect(extractJsonObject(raw, "unit", { expectAnyKey: UNIT_KEYS, onRepair: (k) => { kinds = k; } })["summary"]).toBe("符号 S 与 \\mathcal{S} 混用");
    expect(kinds).toEqual(["invalid_escape"]);
  });

  it("修不回来的顶层对象：抛 json_parse，绝不返回内层 issue 碎片", () => {
    const raw = '{"summary":TERC 与 MI 排序,"issues":[{"category":"academic","severity":"minor","description":"x","quote":"y"}],"academicScore":60}';
    expect(() => extractJsonObject(raw, "unit")).toThrow(/顶层 JSON 对象不合法/);
    try {
      extractJsonObject(raw, "unit");
    } catch (error) {
      expect((error as StructuredOutputError).kind).toBe("json_parse");
    }
  });

  it("expectAnyKey：错误体（401: {code,message}）不是合法输出；说明文字包裹的合法 JSON 仍可提取", () => {
    expect(() => extractJsonObject('401: {"code":"1000","message":"身份验证失败。"}', "unit", { expectAnyKey: UNIT_KEYS })).toThrow(StructuredOutputError);
    expect(extractJsonObject('以下是结果：{"summary":"ok","issues":[]} 以上。', "unit", { expectAnyKey: UNIT_KEYS })["summary"]).toBe("ok");
    // 不传 expectAnyKey 的调用方行为不变
    expect(extractJsonObject('401: {"code":"1000"}', "x")).toEqual({ code: "1000" });
  });

  it("合法 JSON 不触发修复；修复只加转义、不删改字符", () => {
    let called = false;
    extractJsonObject('{"summary":"He said \\"ok\\".","issues":[]}', "unit", { onRepair: () => { called = true; } });
    expect(called).toBe(false);
    const broken = '{"a":"x "y" z"}';
    const repaired = repairJsonEscapes(broken);
    expect(repaired.text.replace(/\\/g, "")).toBe(broken);
  });
});
