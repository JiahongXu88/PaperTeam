/**
 * M15.18 Phase E：投稿准备度报告（纯函数汇总 + Markdown 渲染）——语义红线回归。
 */

import { describe, expect, it } from "vitest";

import {
  buildSubmissionReadinessReport,
  renderSubmissionReadinessMarkdown,
  type SubmissionReadinessInputs,
} from "../../src/target/TargetSubmissionReadinessService.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");

function inputs(overrides: Partial<SubmissionReadinessInputs> = {}): SubmissionReadinessInputs {
  return {
    projectId: "p-test",
    now: NOW,
    manuscriptRevision: 3,
    guideline: { schemaVersion: 1, venueId: "cjig", displayName: "中国图象图形学报", identity: {}, scope: {}, requirements: [], provenance: { sourceUrls: [], accessDate: "2026-10-01", confidence: "high" }, frozenAt: "2026-10-01T00:00:00.000Z" },
    compliance: {
      schemaVersion: 1, venueId: "cjig", guidelineFrozenAt: "2026-10-01", evaluatedAt: "2026-11-01T09:00:00.000Z", manuscriptRevision: 2,
      checks: [
        { requirementId: "R-REF-COUNT", field: "references.count", status: "PASS", hard: false, observed: "57", expected: "≥ 30", officialQuote: "q", sourceUrl: "u" },
        { requirementId: "R-DOI", field: "references.doiCoverage", status: "NOT_EVALUATED", hard: true, observed: "部分未识别", expected: "全部", officialQuote: "q", sourceUrl: "u", reason: "DOI 部分未识别（解析失败≠未提供）" },
        { requirementId: "R-TABLE", field: "figures.tableThreeLine", status: "ADVISORY", hard: false, observed: "—", expected: "三线表", officialQuote: "q", sourceUrl: "u" },
        { requirementId: "R-TITLE", field: "title.maxLengthZh", status: "VIOLATION", hard: true, observed: "31 字", expected: "≤ 20 字", officialQuote: "q", sourceUrl: "u" },
      ],
      summary: { hardViolations: 1, passCount: 1, notEvaluatedCount: 1, advisoryCount: 1, topStatus: "HARD_VIOLATION" },
      provenance: { basis: "official_guideline_evidence", disclaimer: "advisory" },
    } as never,
    profile: null,
    readiness: {
      schemaVersion: 1, evaluatedAt: "x", benchmarkRevision: 1, manuscriptRevision: 3,
      dimensions: [{ dimension: "literature", verdict: "MEETS_TARGET", observed: "57 refs", targetRange: "P25–P75 40–70", gaps: [], confidence: "medium", evidenceBasis: "parser" }],
      overall: { verdict: "MEETS_TARGET", summary: "" },
      provenance: { basis: "benchmark_observation", disclaimer: "", profileGeneratedAt: "x" },
    },
    benchmarkSufficiency: "insufficient",
    benchmarkSize: 5,
    audit: null,
    plan: null,
    closure: null,
    ...overrides,
  };
}

describe("buildSubmissionReadinessReport", () => {
  it("官方条款按机检口径分层；硬性违规进入剩余风险；符合度修订号落后于当前稿 → 标注需重评", () => {
    const report = buildSubmissionReadinessReport(inputs());
    expect(report.official.counts).toEqual({ machine_checked: 2, partially_machine_checked: 1, not_evaluable: 1, hardViolations: 1 });
    expect(report.official.checks.find((check) => check.requirementId === "R-DOI")?.checkability).toBe("not_evaluable");
    expect(report.official.staleAgainstCurrent).toBe(true);
    expect(report.remainingRisks.some((risk) => risk.includes("R-TITLE") && risk.includes("硬性"))).toBe(true);
    expect(report.remainingRisks.some((risk) => risk.includes("不可机检"))).toBe(true);
  });

  it("benchmark 语料不足 → 统一 INSUFFICIENT（不展示「在带内」）；注明观测带非最低录用标准", () => {
    const report = buildSubmissionReadinessReport(inputs());
    expect(report.benchmark.overall).toMatch(/INSUFFICIENT/);
    expect(report.benchmark.dimensions[0]!.band).toMatch(/INSUFFICIENT/);
    expect(report.benchmark.note).toMatch(/不是最低录用标准/);
    const sufficient = buildSubmissionReadinessReport(inputs({ benchmarkSufficiency: "sufficient" }));
    expect(sufficient.benchmark.dimensions[0]!.band).toBe("处于观测带内");
  });

  it("审计/计划/复评缺失 → 各区块 available=false（不编造）；Markdown 含免责声明且无录用概率措辞", () => {
    const report = buildSubmissionReadinessReport(inputs());
    expect(report.contribution.available).toBe(false);
    expect(report.actions.available).toBe(false);
    expect(report.closure.available).toBe(false);
    const markdown = renderSubmissionReadinessMarkdown(report);
    expect(markdown).toContain("不是录用预测");
    expect(markdown).toContain("独立人类审稿质量标签 = 0");
    expect(markdown).not.toMatch(/录用概率\s*[:：=]\s*\d|预计(?:可|将)?录用|Publication Ready\s*[:：=]|已达到[^\n]*发表水平/);
  });

  it("行动清单按确定性分类分组；需实验项携带实验需求包；非 VALIDATED_FIXED 的批准项列为剩余风险", () => {
    const planItem = (itemId: string, classification: string, extra: Record<string, unknown> = {}) => ({
      itemId, contributionId: "C1", gap: `gap ${itemId}`, sourceActionType: "can_rewrite_from_existing_evidence", classification, classificationReason: "",
      anchor: { claimQuote: "q", sectionId: "S", anchorVerified: true, projection: { status: "resolved", file: "sections/sec01.tex" } },
      priorWork: [], forbidden: { values: [], citationKeys: [] }, allowedScope: "", authorDecision: { decision: "approve", decidedAt: "x" }, ...extra,
    });
    const plan = {
      plan: { planId: "tap-1", items: [
        planItem("ta-gap-1", "REWRITE_ELIGIBLE"),
        planItem("ta-gap-2", "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT", { experimentPlan: { purpose: "补消融", metrics: "HOTA" } }),
        planItem("ta-gap-3", "UNMAPPABLE_TARGET"),
      ] },
    } as never;
    const closure = {
      reportId: "tar-1", assessedAtRevision: 4, summary: { total: 3, VALIDATED_FIXED: 1, NEEDS_AUTHOR_DECISION: 1, STILL_OPEN: 1 },
      items: [
        { itemId: "ta-gap-1", classification: "REWRITE_ELIGIBLE", closure: "VALIDATED_FIXED", basis: "ok", checks: { lineage: true, targetBinding: true, contentChanged: true, notReverted: true, guards: true } },
        { itemId: "ta-gap-2", classification: "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT", closure: "NEEDS_AUTHOR_DECISION", basis: "需实验" },
        { itemId: "ta-gap-3", classification: "UNMAPPABLE_TARGET", closure: "STILL_OPEN", basis: "x" },
      ],
    } as never;
    const report = buildSubmissionReadinessReport(inputs({ plan, closure }));
    expect(report.actions.rewriteFromExistingEvidence.map((entry) => entry.itemId)).toEqual(["ta-gap-1"]);
    expect(report.actions.needsRealExperimentOrAuthorDecision[0]!.experimentPlan?.purpose).toBe("补消融");
    expect(report.actions.notActionable.map((entry) => entry.itemId)).toEqual(["ta-gap-3"]);
    expect(report.remainingRisks.some((risk) => risk.includes("ta-gap-1"))).toBe(false);
    expect(report.remainingRisks.some((risk) => risk.includes("ta-gap-2") && risk.includes("NEEDS_AUTHOR_DECISION"))).toBe(true);
    const markdown = renderSubmissionReadinessMarkdown(report);
    expect(markdown).toContain("实验需求包：目的 补消融");
    expect(markdown).toContain("| ta-gap-1 | REWRITE_ELIGIBLE | VALIDATED_FIXED | lineage✓");
  });
});
