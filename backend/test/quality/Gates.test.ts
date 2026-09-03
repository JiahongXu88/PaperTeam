/**
 * Build Gate / Quality Gate 测试（M3.2）：
 * 判定矩阵（各规则单独触发）、Draft/Final 规则、
 * 质量问题不影响 Build Gate（D-0015）。
 */

import { afterAll, describe, expect, it } from "vitest";

import type { CitationReport } from "../../src/citation/CitationService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../../src/agents/FeasibilityService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import {
  DEFAULT_QUALITY_THRESHOLDS,
  evaluateBuildGate,
  evaluateQualityGate,
} from "../../src/quality/gates.js";

afterAll(async () => {});

// ---- 工厂 ----

const passingReview: ReviewSummary = {
  generatedAt: "2026-09-03T00:00:00Z",
  round: 1,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 88, styleRisk: 20, factVerdicts: { SUPPORTED: 3, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

const cleanEvidence: EvidenceStats = {
  total: 3,
  byStatus: { unverified: 0, verified: 3, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
  contradictory: 0,
  skippedLines: 0,
};

const cleanCitation = (overrides: Partial<CitationReport["summary"]> = {}): CitationReport => ({
  generatedAt: "2026-09-03T00:00:00Z",
  static: {
    citedKeys: ["a"],
    missingKeys: [],
    unusedKeys: [],
    duplicateKeys: [],
    badCitations: [],
    bibEntries: [],
  },
  metadata: {
    enabled: true,
    providers: [],
    checked: 1,
    skipped: 0,
    results: [],
    byStatus: { verified: 1, mismatch: 0, not_found: 0, unverifiable: 0 },
  },
  summary: {
    citedCount: 1,
    missingKeys: 0,
    unusedKeys: 0,
    duplicateKeys: 0,
    badCitations: 0,
    hallucinated: 0,
    mismatched: 0,
    unverifiable: 0,
    ...overrides,
  },
});

const highFeasibility: FeasibilityReport = {
  level: "HIGH",
  reasons: [],
  missingRequirements: [],
  researchGaps: [],
  requiredExperiments: [],
  evidenceGaps: [],
  recommendations: [],
};

describe("evaluateQualityGate：通过路径", () => {
  it("全部干净 → passed", () => {
    const gate = evaluateQualityGate({
      review: passingReview,
      citation: cleanCitation(),
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    });
    expect(gate.passed).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it("未做可行性评估（null）不阻塞", () => {
    const gate = evaluateQualityGate({
      review: passingReview,
      citation: cleanCitation(),
      evidence: cleanEvidence,
      feasibility: null,
    });
    expect(gate.passed).toBe(true);
  });

  it("metadata 不可核验（网络故障）不是质量问题", () => {
    const gate = evaluateQualityGate({
      review: passingReview,
      citation: cleanCitation({ unverifiable: 1 }),
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    });
    expect(gate.passed).toBe(true);
  });
});

describe("evaluateQualityGate：各规则独立触发失败", () => {
  const base = {
    review: passingReview,
    citation: cleanCitation(),
    evidence: cleanEvidence,
    feasibility: highFeasibility,
  };

  const expectFails = (gate: { passed: boolean; reasons: string[] }, rule: string) => {
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join("\n")).toContain(rule);
  };

  it("hallucinated citation（metadata not_found）", () => {
    expectFails(evaluateQualityGate({ ...base, citation: cleanCitation({ hallucinated: 1 }) }), "hallucinated_citations_zero");
  });

  it("missing / duplicate / bad citations", () => {
    expectFails(evaluateQualityGate({ ...base, citation: cleanCitation({ missingKeys: 1 }) }), "citation_structure_valid");
    expectFails(evaluateQualityGate({ ...base, citation: cleanCitation({ duplicateKeys: 2 }) }), "citation_structure_valid");
    expectFails(evaluateQualityGate({ ...base, citation: cleanCitation({ badCitations: 1 }) }), "citation_structure_valid");
  });

  it("contradictory evidence", () => {
    expectFails(
      evaluateQualityGate({ ...base, evidence: { ...cleanEvidence, contradictory: 1 } }),
      "no_contradictory_evidence",
    );
  });

  it("unsupported critical claims / blocking / open critical+major", () => {
    const review: ReviewSummary = {
      ...passingReview,
      unsupportedCriticalClaims: 1,
      counts: { ...passingReview.counts, blocking: 1, critical: 1, major: 2 },
      openCritical: 1,
      openMajor: 2,
    };
    const gate = evaluateQualityGate({ ...base, review });
    expect(gate.passed).toBe(false);
    expect(gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule)).toEqual(
      expect.arrayContaining([
        "unsupported_critical_claims_zero",
        "blocking_issues_zero",
        "open_critical_major_zero",
      ]),
    );
  });

  it("academic score 低于阈值 / style risk 超阈值 / 评分缺失", () => {
    const lowAcademic: ReviewSummary = {
      ...passingReview,
      scores: { ...passingReview.scores, academicScore: 79 },
    };
    expectFails(evaluateQualityGate({ ...base, review: lowAcademic }), "academic_score_threshold");

    const highRisk: ReviewSummary = {
      ...passingReview,
      scores: { ...passingReview.scores, styleRisk: 36 },
    };
    expectFails(evaluateQualityGate({ ...base, review: highRisk }), "style_risk_threshold");

    const missingScores: ReviewSummary = {
      ...passingReview,
      scores: { academicScore: null, styleRisk: null, factVerdicts: null },
    };
    const gate = evaluateQualityGate({ ...base, review: missingScores });
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join("\n")).toContain("缺少 academic 评分");
    expect(gate.reasons.join("\n")).toContain("缺少 style 风险评分");
  });

  it("feasibility LOW / INSUFFICIENT 阻止 Final（知情接受不降低标准）", () => {
    const low: FeasibilityReport = { ...highFeasibility, level: "LOW" };
    expectFails(evaluateQualityGate({ ...base, feasibility: low }), "target_feasibility");
    const insufficient: FeasibilityReport = { ...highFeasibility, level: "INSUFFICIENT" };
    expectFails(
      evaluateQualityGate({ ...base, feasibility: insufficient, acceptedKnownGaps: true }),
      "target_feasibility",
    );
  });
});

describe("evaluateBuildGate（与质量语义分离）", () => {
  const okCompile = {
    ok: true,
    tool: "latexmk",
    exitCode: 0,
    pdfPath: "build/paper.pdf",
    logPath: "build/compile.log",
    durationMs: 100,
  };

  it("编译成功 + 结构完整 → passed", () => {
    const gate = evaluateBuildGate({ compile: okCompile, missingIncludes: [], bibMissing: false });
    expect(gate.passed).toBe(true);
  });

  it("编译失败 / include 缺失 / bib 缺失 → failed（带原因）", () => {
    const failedCompile = { ...okCompile, ok: false, error: "! Undefined control sequence." };
    expect(evaluateBuildGate({ compile: failedCompile, missingIncludes: [], bibMissing: false }).passed).toBe(false);
    const missingInclude = evaluateBuildGate({
      compile: okCompile,
      missingIncludes: ["无法读取 sections/ghost.tex"],
      bibMissing: false,
    });
    expect(missingInclude.passed).toBe(false);
    expect(missingInclude.reasons.join("\n")).toContain("ghost.tex");
    expect(
      evaluateBuildGate({ compile: okCompile, missingIncludes: [], bibMissing: true }).passed,
    ).toBe(false);
  });

  it("质量语义永不影响 Build Gate（D-0015：not_found citation 不禁止编译）", () => {
    // 引用问题是 Quality Gate 输入，Build Gate 接口根本不接受这些字段
    const gate = evaluateBuildGate({
      compile: okCompile,
      missingIncludes: [],
      bibMissing: false,
    });
    expect(gate.passed).toBe(true);
    expect(DEFAULT_QUALITY_THRESHOLDS.academicPassScore).toBe(80);
    expect(DEFAULT_QUALITY_THRESHOLDS.styleRiskMax).toBe(35);
  });
});
