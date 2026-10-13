/**
 * M13 Final Closure（任务 B）：academicScore 带内复核的确定性聚合逻辑。
 */

import { describe, expect, it } from "vitest";

import type { ModeReviewResult, ReviewIssue } from "../../src/agents/ReviewerService.js";
import {
  aggregateAcademicSamples,
  medianScore,
  shouldConfirmAcademicScore,
} from "../../src/review/academicConfirmation.js";

const POLICY = { band: 5, extraSamples: 2, threshold: 80 };

function issue(partial: Partial<ReviewIssue> & { description: string }): ReviewIssue {
  return { category: "academic", severity: "major", section: "sections/route-comparison.tex", blocking: false, ...partial };
}

function academic(score: number | undefined, issues: ReviewIssue[] = [], taskId = "t"): ModeReviewResult {
  return { mode: "academic", taskId, issues, summary: "s", ...(score !== undefined ? { overallScore: score } : {}) };
}

describe("shouldConfirmAcademicScore（对称触发带）", () => {
  it("带内 [75, 85) 触发；带外不触发；两侧对称", () => {
    expect(shouldConfirmAcademicScore(79, POLICY)).toBe(true);
    expect(shouldConfirmAcademicScore(75, POLICY)).toBe(true);
    expect(shouldConfirmAcademicScore(84, POLICY)).toBe(true);
    expect(shouldConfirmAcademicScore(85, POLICY)).toBe(false);
    expect(shouldConfirmAcademicScore(74, POLICY)).toBe(false);
    expect(shouldConfirmAcademicScore(88, POLICY)).toBe(false);
  });

  it("band=0 或 extraSamples=0 关闭；分数缺失不触发（结构化输出问题不是方差问题）", () => {
    expect(shouldConfirmAcademicScore(79, { ...POLICY, band: 0 })).toBe(false);
    expect(shouldConfirmAcademicScore(79, { ...POLICY, extraSamples: 0 })).toBe(false);
    expect(shouldConfirmAcademicScore(null, POLICY)).toBe(false);
    expect(shouldConfirmAcademicScore(undefined, POLICY)).toBe(false);
  });
});

describe("medianScore", () => {
  it("奇数个取中位；偶数个取中间两数平均；空 → null", () => {
    expect(medianScore([79, 85, 88])).toBe(85);
    expect(medianScore([79, 82])).toBe(80.5);
    expect(medianScore([])).toBeNull();
  });
});

describe("aggregateAcademicSamples", () => {
  it("无额外样本 → 原结果透传，method=primary_only", () => {
    const primary = academic(79);
    const { result, confirmation } = aggregateAcademicSamples({ primary, extras: [], policy: POLICY });
    expect(result).toBe(primary);
    expect(confirmation.triggered).toBe(false);
    expect(confirmation.aggregatedScore).toBe(79);
  });

  it("M13.7.11 实录（79 / 85 / 88 型）：中位数替换主样本分数，全部样本可审计", () => {
    const { result, confirmation } = aggregateAcademicSamples({
      primary: academic(79, [], "t0"),
      extras: [academic(85, [], "t1"), academic(88, [], "t2")],
      policy: POLICY,
    });
    expect(result.overallScore).toBe(85);
    expect(confirmation.method).toBe("median_of_samples");
    expect(confirmation.samples.map((sample) => sample.overallScore)).toEqual([79, 85, 88]);
    expect(confirmation.samples.map((sample) => sample.taskId)).toEqual(["t0", "t1", "t2"]);
    expect(result.summary).toContain("79/85/88");
  });

  it("反向同样成立：主样本 84 PASS、额外 76 / 78 → 中位数 78 FAIL（不偏向 PASS）", () => {
    const { result } = aggregateAcademicSamples({
      primary: academic(84),
      extras: [academic(76), academic(78)],
      policy: POLICY,
    });
    expect(result.overallScore).toBe(78);
  });

  it("事实类 critical/major（fact / evidence_gap / citation / build）任一样本发现即并入", () => {
    const factMajor = issue({ category: "fact", severity: "major", description: "盈亏平衡定义颠倒", section: "sections/breakeven.tex" });
    const { result, confirmation } = aggregateAcademicSamples({
      primary: academic(79),
      extras: [academic(82, [factMajor]), academic(81)],
      policy: POLICY,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.description).toBe("盈亏平衡定义颠倒");
    expect(result.issues[0]?.reason).toContain("带内复核样本 1");
    expect(confirmation.mergedIssues.factClass).toBe(1);
  });

  it("意见类 major 只在同章节被 ≥ 2 份样本重现时并入；单样本意见丢弃（计数可见）", () => {
    const single = issue({ description: "综述覆盖面过窄且未声明选取标准" });
    const reproducedA = issue({ description: "比较维度不公平", section: "sections/route-comparison.tex" });
    const reproducedB = issue({ description: "横向比较流于罗列", section: "route-comparison" });
    const { result, confirmation } = aggregateAcademicSamples({
      primary: academic(79, []),
      extras: [academic(80, [single, reproducedA]), academic(78, [reproducedB])],
      policy: POLICY,
    });
    // single：仅样本 1 的 route-comparison major？——注意 single 与 reproducedA 同节，因此被样本 2 的 reproducedB 重现
    // 这里用不同章节验证丢弃：
    expect(result.issues.map((entry) => entry.description)).toEqual(
      expect.arrayContaining(["比较维度不公平", "横向比较流于罗列"]),
    );
    expect(confirmation.mergedIssues.opinionClassReproduced).toBeGreaterThanOrEqual(2);
    const dropped = aggregateAcademicSamples({
      primary: academic(79, []),
      extras: [academic(80, [issue({ description: "引言过长", section: "sections/introduction.tex" })]), academic(78, [])],
      policy: POLICY,
    });
    expect(dropped.result.issues).toHaveLength(0);
    expect(dropped.confirmation.mergedIssues.opinionClassDropped).toBe(1);
  });

  it("主样本自身的 finding 全部保留；额外样本的 minor 不并入；重复 finding 去重", () => {
    const primaryMinor = issue({ severity: "minor", description: "术语混排" });
    const primaryMajor = issue({ description: "主样本 major" });
    const dupMajor = issue({ description: "主样本 major" });
    const extraMinor = issue({ severity: "minor", description: "额外 minor" });
    const { result } = aggregateAcademicSamples({
      primary: academic(79, [primaryMinor, primaryMajor]),
      extras: [academic(80, [dupMajor, extraMinor])],
      policy: POLICY,
    });
    expect(result.issues.map((entry) => entry.description)).toEqual(["术语混排", "主样本 major"]);
  });

  it("额外样本分数缺失时不计入中位数（不被 null 污染）", () => {
    const { result, confirmation } = aggregateAcademicSamples({
      primary: academic(79),
      extras: [academic(undefined), academic(83)],
      policy: POLICY,
    });
    expect(result.overallScore).toBe(81);
    expect(confirmation.samples[1]?.overallScore).toBeNull();
  });
});
