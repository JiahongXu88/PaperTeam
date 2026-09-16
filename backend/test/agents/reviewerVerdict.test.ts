/**
 * M5.6 真实验收暴露：fact Reviewer 输出 verdict "CONTRADICTION"（非枚举值 CONTRADICTED），
 * 两次尝试均被严格解析拒绝 → review.run 失败 → 整条 run 失败。近似值归一只承认大小写 /
 * 分隔符差异与少数同义写法；其它值仍严格拒绝（语义不放宽）。
 */

import { describe, expect, it } from "vitest";

import { AgentRunFailedError } from "../../src/errors.js";
import { normalizeFactVerdict, parseModeReview } from "../../src/agents/ReviewerService.js";

function factOutput(verdict: string): Record<string, unknown> {
  return {
    summary: "事实核验",
    claims: [{ section: "sections/intro.tex", claim: "RAG 降低幻觉率", verdict, evidenceId: "E001" }],
    issues: [],
  };
}

describe("fact verdict 近似值归一", () => {
  it("枚举原值 / 大小写 / 分隔符 / 同义写法 → 规范枚举", () => {
    expect(normalizeFactVerdict("SUPPORTED")).toBe("SUPPORTED");
    expect(normalizeFactVerdict("supported")).toBe("SUPPORTED");
    expect(normalizeFactVerdict("Partially Supported")).toBe("PARTIALLY_SUPPORTED");
    expect(normalizeFactVerdict("partially-supported")).toBe("PARTIALLY_SUPPORTED");
    expect(normalizeFactVerdict("CONTRADICTION")).toBe("CONTRADICTED");
    expect(normalizeFactVerdict("contradictory")).toBe("CONTRADICTED");
    expect(normalizeFactVerdict("NOT_SUPPORTED")).toBe("UNSUPPORTED");
    expect(normalizeFactVerdict(" unsupported ")).toBe("UNSUPPORTED");
  });

  it("不可归一的值 → null；parseModeReview 仍以结构化 AgentRunFailedError 拒绝", () => {
    expect(normalizeFactVerdict("MAYBE")).toBeNull();
    expect(normalizeFactVerdict(42)).toBeNull();
    expect(normalizeFactVerdict("SUPPORTED_BY_NOTHING")).toBeNull();
    expect(() => parseModeReview("fact", factOutput("MAYBE"))).toThrow(AgentRunFailedError);
    expect(() => parseModeReview("fact", factOutput("MAYBE"))).toThrow(/verdict/);
  });

  it("真实回归：verdict=CONTRADICTION 的 fact 输出解析为 CONTRADICTED（review.run 不再整条失败）", () => {
    const result = parseModeReview("fact", factOutput("CONTRADICTION"));
    expect(result.claims?.[0]?.verdict).toBe("CONTRADICTED");
    expect(result.claims?.filter((c) => c.verdict === "CONTRADICTED")).toHaveLength(1);
  });
});

/**
 * 2026-09-16 真实回归（A10/B8 两臂、fact 与 academic 两个 lens）：模型省略
 * summary 字段 → readRequiredString 拒绝 → review.run 整条失败。summary 是
 * 展示性自由文本（不参与 Gate 判定），改为确定性兜底；语义字段仍严格。
 */
describe("reviewer summary 缺省兜底", () => {
  it("summary 缺省 / 空串 → 从 issues 计数派生（不抛错）", () => {
    const academic: Record<string, unknown> = {
      issues: [
        { category: "academic", severity: "critical", section: "sections/sec01.tex", description: "x" },
        { category: "academic", severity: "major", section: "sections/sec02.tex", description: "y" },
      ],
      scores: { rigor: 80, clarity: 75 },
    };
    for (const summaryValue of [undefined, "", "   "]) {
      const parsed = { ...academic, ...(summaryValue === undefined ? {} : { summary: summaryValue }) };
      const result = parseModeReview("academic", parsed);
      expect(result.summary).toContain("确定性兜底");
      expect(result.summary).toContain("1 critical");
      expect(result.summary).toContain("1 major");
    }
  });

  it("summary 为合法非空字符串 → 原样保留（不兜底）", () => {
    const result = parseModeReview("academic", {
      summary: "结构完整，论述清晰。",
      issues: [],
      scores: { rigor: 90 },
    });
    expect(result.summary).toBe("结构完整，论述清晰。");
  });

  it("语义字段缺失仍严格拒绝（scores / riskScore 不兜底）", () => {
    expect(() => parseModeReview("academic", { summary: "x", issues: [] })).toThrow(AgentRunFailedError);
    expect(() => parseModeReview("style", { summary: "x", issues: [], riskScore: 120 })).toThrow(AgentRunFailedError);
  });
});
