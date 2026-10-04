/**
 * M11.3（Phase A）Reviewer Stability 纯函数测试：
 * - metricStats（min/median/mean/stddev/range；奇偶 n；空输入）；
 * - normalizeFindingKey（rootCauseKey 优先 / 归一化目标文本 / 标点与空白剥离）；
 * - matchFindings（同 run 去重 / stable 全采样 / unstable 部分采样 / 自定义阈值）；
 * - summarizeMetrics（缺省字段跳过）。
 */

import { describe, expect, it } from "vitest";

import {
  matchFindings,
  metricStats,
  normalizeFindingKey,
  summarizeMetrics,
  type ReviewRunSample,
} from "../../src/review/reviewerStability.js";

describe("metricStats", () => {
  it("奇数 n：min/median/max/range/stddev", () => {
    const stats = metricStats([74, 80, 84]);
    expect(stats).toEqual({ n: 3, min: 74, median: 80, mean: 79.333, max: 84, range: 10, stddev: 4.11 });
  });

  it("偶数 n：median 取中位平均", () => {
    expect(metricStats([72, 74, 80, 84]).median).toBe(77);
  });

  it("单元素：stddev=0；空输入：全零", () => {
    expect(metricStats([80])).toEqual({ n: 1, min: 80, median: 80, mean: 80, max: 80, range: 0, stddev: 0 });
    expect(metricStats([])).toEqual({ n: 0, min: 0, median: 0, mean: 0, max: 0, range: 0, stddev: 0 });
  });
});

describe("normalizeFindingKey", () => {
  it("rootCauseKey 优先（claim 级归因，M11.2.3）", () => {
    expect(
      normalizeFindingKey({ section: "sections/a.tex", category: "fact", rootCauseKey: "c-abc123" }),
    ).toBe("sections/a.tex|fact|rc:c-abc123");
  });

  it("无 rootCauseKey → 归一化目标文本（空白 / 标点剥离 + 截断）", () => {
    expect(
      normalizeFindingKey({ section: "sections/a.tex", category: "build", description: "第 9.2 节「关键分歧」段中途截断！" }),
    ).toBe(normalizeFindingKey({ section: "sections/a.tex", category: "build", description: "第9.2节关键分歧段中途截断" }));
  });

  it("target 优先于 description；section/category 缺省占位", () => {
    const key = normalizeFindingKey({ category: "style", target: " 重复句式 " });
    expect(key).toBe("-|style|t:重复句式");
  });
});

describe("matchFindings", () => {
  const sample = (run: string, issues: ReviewRunSample["issues"]): ReviewRunSample => ({
    run,
    mode: "academic",
    academicScore: 80,
    issues,
  });

  it("全采样出现 = stable；部分出现 = unstable；同 run 内同键去重", () => {
    const result = matchFindings([
      sample("s1", [
        { section: "a", category: "build", description: "截断问题", severity: "critical" },
        { section: "b", category: "style", description: "句式重复" },
        { section: "a", category: "build", description: "截断问题" }, // 同 run 重复
      ]),
      sample("s2", [
        { section: "a", category: "build", description: "截断问题" },
      ]),
      sample("s3", [
        { section: "a", category: "build", description: "截断问题" },
      ]),
    ]);
    expect(result.totalFindings).toBe(2);
    expect(result.stable).toHaveLength(1);
    expect(result.stable[0]?.frequency).toBe(3);
    expect(result.stable[0]?.runs).toEqual(["s1", "s2", "s3"]);
    expect(result.unstable).toHaveLength(1);
    expect(result.unstable[0]?.frequency).toBe(1);
  });

  it("stableThreshold 自定义（2/3 视为稳定）", () => {
    const result = matchFindings(
      [
        sample("s1", [{ section: "b", category: "style", description: "句式重复" }]),
        sample("s2", [{ section: "b", category: "style", description: "句式重复" }]),
        sample("s3", []),
      ],
      { stableThreshold: 2 },
    );
    expect(result.stable).toHaveLength(1);
  });
});

describe("summarizeMetrics", () => {
  it("跨采样汇总各数值指标；缺省字段跳过", () => {
    const metrics = summarizeMetrics([
      { run: "s1", mode: "academic", academicScore: 80, unsupported: 16 },
      { run: "s2", mode: "academic", academicScore: 84, unsupported: 19 },
      { run: "s3", mode: "academic", academicScore: 77, unsupported: 16 },
    ]);
    expect(metrics["academicScore"]!.max).toBe(84);
    expect(metrics["academicScore"]!.range).toBe(7);
    expect(metrics["unsupported"]!.median).toBe(16);
    expect(metrics["styleRisk"]).toBeUndefined();
  });
});
