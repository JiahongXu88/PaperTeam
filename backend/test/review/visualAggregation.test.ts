/**
 * M12 Batch 2 · B5：ReviewAggregator 的 visual 单列汇总。
 *
 * 纪律断言：visual findings 只进 ReviewSummary.visual 单列——
 * counts（critical/major/minor/byCategory/blocking）、scores
 * （academicScore/styleRisk/factVerdicts）、openCritical/openMajor
 * 的既有计算路径零改动、零稀释。
 */

import { describe, expect, it } from "vitest";

import { aggregateReviews, summarizeVisualFindings } from "../../src/review/ReviewAggregator.js";
import { createFinding, type ReviewFinding } from "../../src/review/finding.js";

const NOW = "2026-10-07T10:00:00.000Z";

function vf(id: string, severity: "critical" | "major" | "minor" | "info", source: string, verification: "verified_deterministic" | "model_observation" | "needs_author_review"): ReviewFinding {
  return createFinding({
    findingId: id,
    category: "visual",
    severity,
    message: `视觉 finding ${id}`,
    source,
    now: NOW,
    figureEnvRef: "tex:main.tex:figure-1",
    verificationStatus: verification,
    ...(source === "deterministic-visual" ? { visualConfidence: "high" } : {}),
  });
}

describe("M12 B5 summarizeVisualFindings", () => {
  it("确定性 / 模型观察 / 待复核三分 + severity 计数", () => {
    const summary = summarizeVisualFindings([
      vf("vf-1", "major", "deterministic-visual", "verified_deterministic"),
      vf("vf-2", "minor", "deterministic-visual", "verified_deterministic"),
      vf("vf-3", "info", "vision-assisted", "needs_author_review"),
      vf("vf-4", "major", "vision-assisted", "model_observation"),
      vf("vf-5", "info", "vision-assisted", "model_observation"),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.bySeverity).toEqual({ critical: 0, major: 2, minor: 1, info: 2 });
    expect(summary.byVerification).toEqual({
      verified_deterministic: 2,
      model_observation: 2,
      needs_author_review: 1,
    });
    expect(summary.byOrigin).toEqual({ deterministic: 2, visionAssisted: 3, other: 0 });
  });

  it("非 visual 条目一概不计（防御：混入不计数控单）", () => {
    const nonVisual = createFinding({
      findingId: "f-1",
      category: "fact",
      severity: "critical",
      message: "非视觉条目",
      source: "section-review",
      now: NOW,
      sectionId: "SEC01",
    });
    const summary = summarizeVisualFindings([nonVisual, vf("vf-1", "major", "deterministic-visual", "verified_deterministic")]);
    expect(summary.total).toBe(1);
    expect(summary.bySeverity.critical).toBe(0);
  });

  it("空输入 → 全零", () => {
    expect(summarizeVisualFindings([])).toEqual({
      total: 0,
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
      byVerification: { verified_deterministic: 0, model_observation: 0, needs_author_review: 0 },
      byOrigin: { deterministic: 0, visionAssisted: 0, other: 0 },
    });
  });
});

describe("M12 B5 aggregateReviews 既有口径零稀释", () => {
  const modeResult = (mode: "fact" | "academic" | "style") => ({
    mode,
    taskId: `t-${mode}`,
    summary: "s",
    issues:
      mode === "academic"
        ? [{ category: "academic" as const, section: "S1", description: "d", severity: "major" as const, blocking: false }]
        : [],
    ...(mode === "academic" ? { overallScore: 82 } : {}),
    ...(mode === "style" ? { riskScore: 12 } : {}),
    ...(mode === "fact"
      ? {
          claims: [
            { verdict: "SUPPORTED" as const, claim: "c1", section: "S1" },
            { verdict: "UNSUPPORTED" as const, claim: "c2", section: "S1" },
          ],
        }
      : {}),
  });

  it("aggregateReviews 不消费 visual findings：无 visual 字段；分数只来自三路结果", () => {
    const summary = aggregateReviews([modeResult("fact"), modeResult("academic"), modeResult("style")], 3);
    expect(summary.visual).toBeUndefined();
    expect(summary.scores.academicScore).toBe(82);
    expect(summary.scores.styleRisk).toBe(12);
    expect(summary.counts.byCategory).toEqual({ academic: 1 });
    expect(summary.openMajor).toBe(1);
    expect(summary.unsupportedCriticalClaims).toBe(1);
  });

  it("visual 单列附加后：既有 counts / scores / openCritical 逐字段不变", () => {
    const without = aggregateReviews([modeResult("fact"), modeResult("academic"), modeResult("style")], 3);
    const visualFindings = [
      vf("vf-1", "critical", "deterministic-visual", "verified_deterministic"),
      vf("vf-2", "major", "vision-assisted", "model_observation"),
      vf("vf-3", "major", "vision-assisted", "model_observation"),
    ];
    const withVisual = { ...without, visual: summarizeVisualFindings(visualFindings) };
    // 单列可见性：visual 有 critical 1 / major 2，但既有口径一律不变
    expect(withVisual.counts).toEqual(without.counts);
    expect(withVisual.scores).toEqual(without.scores);
    expect(withVisual.openCritical).toEqual(without.openCritical);
    expect(withVisual.openMajor).toEqual(without.openMajor);
    expect(withVisual.visual).toMatchObject({
      total: 3,
      bySeverity: { critical: 1, major: 2, minor: 0, info: 0 },
      byOrigin: { deterministic: 1, visionAssisted: 2, other: 0 },
    });
  });
});
