/**
 * M15.7 Quality Policy V2 单测（预登记协议 §3 判定矩阵 + §4 保护锚的实现级验证）：
 *   - 三臂差分：legacy 恒等 / Candidate A 分数阈值 Advisory 化 / Candidate B 场景最小分权；
 *   - 单调性：任何 Legacy PASS 在 Candidate 臂不得变 FAIL；
 *   - 保护锚：NOT_EVALUATED(required) 不因 Advisory 化放行；覆盖守卫（M14.1a P0-2）不得被绕开。
 */

import { describe, expect, it } from "vitest";

import type { CitationReport } from "../../src/citation/CitationService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../../src/agents/FeasibilityService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewCoverageSummary } from "../../src/review/coverageLedger.js";
import type { QualityGateResult, QualityGateRule } from "../../src/quality/gates.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import {
  applyQualityPolicy,
  POLICY_RULE_IDS,
  QUALITY_POLICY_VERSION,
} from "../../src/quality/qualityPolicyV2.js";

// ---- 工厂（与 Gates.test.ts 同口径） ----

const passingReview: ReviewSummary = {
  generatedAt: "2026-10-26T00:00:00Z",
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

const cleanCitation = (): CitationReport => ({
  generatedAt: "2026-10-26T00:00:00Z",
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

const legacyGate = (review: ReviewSummary, coverage?: ReviewCoverageSummary): QualityGateResult =>
  evaluateQualityGate({
    review: { ...review, ...(coverage !== undefined ? { coverage } : {}) },
    citation: cleanCitation(),
    evidence: cleanEvidence,
    feasibility: highFeasibility,
  });

const incompleteCoverage: ReviewCoverageSummary = {
  mode: "units",
  snapshotId: "a".repeat(64),
  round: 1,
  targetUnits: 10,
  completedUnits: 8,
  failedUnits: 2,
  reusedUnits: 0,
  targetChars: 40000,
  reviewedChars: 32000,
  ratio: 0.8,
  complete: false,
  failedUnitIds: ["u-03", "u-07"],
};

const score79 = { ...passingReview, scores: { ...passingReview.scores, academicScore: 79 } };
const risk36 = { ...passingReview, scores: { ...passingReview.scores, styleRisk: 36 } };
const both79and36 = { ...passingReview, scores: { ...passingReview.scores, academicScore: 79, styleRisk: 36 } };

describe("M15.7 applyQualityPolicy：legacy_v1 臂恒等", () => {
  it("Legacy FAIL（79 分）→ gate 原对象返回、NO_CHANGE、阻断清单如实", () => {
    const gate = legacyGate(score79);
    expect(gate.passed).toBe(false);
    const result = applyQualityPolicy({ gate, arm: "legacy_v1" });
    expect(result.gate).toBe(gate);
    expect(result.ruleDiffs).toEqual([]);
    expect(result.outcome.reasonCode).toBe("NO_CHANGE");
    expect(result.outcome.legacyPassed).toBe(false);
    expect(result.outcome.candidatePassed).toBe(false);
    expect(result.outcome.remainingBlockers).toContain("academic_score_threshold");
  });
});

describe("M15.7 applyQualityPolicy：Candidate A 分数阈值 Advisory 化", () => {
  it("SCORE_ONLY_UNBLOCK：79 分单独阻断 → advisory 呈现、放行、机读载荷完整", () => {
    const gate = legacyGate(score79);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 79, styleRisk: 20 },
    });
    expect(result.outcome.reasonCode).toBe("SCORE_ONLY_UNBLOCK");
    expect(result.outcome.candidatePassed).toBe(true);
    expect(result.outcome.legacyPassed).toBe(false);
    expect(result.outcome.unblocked).toEqual(["academic_score_threshold"]);

    const rule = result.gate.rules.find((entry) => entry.rule === "academic_score_threshold");
    expect(rule?.status).toBe("ADVISORY");
    expect(rule?.passed).toBe(true);
    expect(rule?.required).toBe(false);
    expect(rule?.detail).toContain("UNCALIBRATED");
    expect(rule?.detail).toContain("academicScore=79");
    expect(rule?.advisory).toEqual({
      kind: "UNCALIBRATED_SCORE",
      legacyStatus: "FAIL",
      legacyRequired: true,
      legacyDetail: expect.stringContaining("academicScore=79") as unknown,
      score: 79,
      threshold: 80,
      direction: "at_least",
      calibration: "UNVALIDATED",
      policyVersion: QUALITY_POLICY_VERSION,
    });
    // 原分数、原阈值与历史 FAIL 对照保留
    expect(rule?.advisory?.legacyDetail).toContain("要求 ≥ 80");
    expect(result.gate.reasons.join("\n")).not.toContain("academic_score_threshold");
    expect(result.gate.verification?.counts.ADVISORY).toBe(1);
    expect(result.gate.verification?.requiredComplete).toBe(true);
  });

  it("STYLE_ONLY_UNBLOCK：styleRisk 36 单独阻断 → advisory 放行", () => {
    const result = applyQualityPolicy({
      gate: legacyGate(risk36),
      arm: "score_style_advisory",
      scores: { academicScore: 88, styleRisk: 36 },
    });
    expect(result.outcome.reasonCode).toBe("STYLE_ONLY_UNBLOCK");
    expect(result.outcome.candidatePassed).toBe(true);
    const rule = result.gate.rules.find((entry) => entry.rule === "style_risk_threshold");
    expect(rule?.status).toBe("ADVISORY");
    expect(rule?.advisory?.direction).toBe("at_most");
    expect(rule?.advisory?.threshold).toBe(35);
  });

  it("SCORE_STYLE_UNBLOCK：两规则同时为仅有的失败源", () => {
    const result = applyQualityPolicy({
      gate: legacyGate(both79and36),
      arm: "score_style_advisory",
      scores: { academicScore: 79, styleRisk: 36 },
    });
    expect(result.outcome.reasonCode).toBe("SCORE_STYLE_UNBLOCK");
    expect(result.outcome.candidatePassed).toBe(true);
    expect(result.outcome.unblocked).toEqual(
      expect.arrayContaining(["academic_score_threshold", "style_risk_threshold"]),
    );
  });

  it("REMAIN_BLOCKED：79 分 + citation 核验缺失（required NOT_EVALUATED）→ 仍阻断，缺的是核验不是分数", () => {
    const gate = evaluateQualityGate({
      review: score79,
      citation: null,
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    });
    expect(gate.passed).toBe(false);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 79, styleRisk: 20 },
    });
    expect(result.outcome.reasonCode).toBe("REMAIN_BLOCKED");
    expect(result.outcome.candidatePassed).toBe(false);
    expect(result.outcome.unblocked).toEqual(["academic_score_threshold"]);
    expect(result.outcome.remainingBlockers).toEqual(
      expect.arrayContaining(["hallucinated_citations_zero", "citation_structure_valid"]),
    );
    // required NOT_EVALUATED 不因 advisory 被算 PASS（协议 §6 门槛 2）
    expect(result.gate.verification?.requiredComplete).toBe(false);
  });

  it("评分缺失（null）→ NOT_EVALUATED(required) 保持阻断，不做 advisory 转换", () => {
    const missing = { ...passingReview, scores: { academicScore: null, styleRisk: null, factVerdicts: null } };
    const gate = legacyGate(missing);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: null, styleRisk: null },
    });
    expect(result.outcome.candidatePassed).toBe(false);
    expect(result.outcome.remainingBlockers).toEqual(
      expect.arrayContaining(["academic_score_threshold", "style_risk_threshold"]),
    );
    // Legacy 把缺失编码为 FAIL；政策层显式改写为 NOT_EVALUATED(required)——存在性要求不随 advisory 取消
    expect(result.ruleDiffs.map((diff) => diff.action)).toEqual(["MISSING_SCORE_RETAINED", "MISSING_SCORE_RETAINED"]);
    const academic = result.gate.rules.find((entry) => entry.rule === "academic_score_threshold");
    expect(academic?.status).toBe("NOT_EVALUATED");
    expect(academic?.required).toBe(true);
    expect(academic?.passed).toBe(false);
  });

  it("覆盖不完整 + 85 分（覆盖驱动 FAIL）→ 规则 7 advisory、8b 继续阻断（M14.1a P0-2 守卫不放松）", () => {
    const review85 = { ...passingReview, scores: { ...passingReview.scores, academicScore: 85 } };
    const gate = legacyGate(review85, incompleteCoverage);
    expect(gate.passed).toBe(false);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 85, styleRisk: 20 },
    });
    expect(result.outcome.reasonCode).toBe("REMAIN_BLOCKED");
    expect(result.outcome.remainingBlockers).toContain("review_coverage_complete");
    const academic = result.gate.rules.find((entry) => entry.rule === "academic_score_threshold");
    expect(academic?.status).toBe("ADVISORY");
    expect(academic?.detail).toContain("UNCALIBRATED");
  });

  it("覆盖不完整 + 79 分 → advisory 但 8b 仍阻断（分数与覆盖两腿独立）", () => {
    const gate = legacyGate(score79, incompleteCoverage);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 79, styleRisk: 20 },
    });
    expect(result.outcome.candidatePassed).toBe(false);
    expect(result.outcome.remainingBlockers).toContain("review_coverage_complete");
    expect(result.outcome.unblocked).toContain("academic_score_threshold");
  });
});

describe("M15.7 applyQualityPolicy：旧产物守卫与单调性", () => {
  const handBuiltGate = (rules: QualityGateRule[]): QualityGateResult => {
    const reasons = rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`);
    return {
      passed: reasons.length === 0,
      reasons,
      rules,
      thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
      checkedAt: "2026-01-01T00:00:00Z",
    };
  };

  it("历史产物无 8b 可接力（覆盖驱动 FAIL 无替位守卫）→ COVERAGE_GUARD_RETAINED 保守保留阻断", () => {
    const gate = handBuiltGate([
      {
        rule: "academic_score_threshold",
        passed: false,
        detail: "academicScore=90（要求 ≥ 80）；review coverage 不完整（units 模式 80.0%，失败单元 2）——部分视图分数不得推导全文学术质量",
        status: "FAIL",
        required: true,
      },
      { rule: "style_risk_threshold", passed: true, detail: "styleRisk=20（要求 ≤ 35）", status: "PASS", required: true },
    ]);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 90, styleRisk: 20 },
    });
    expect(result.outcome.candidatePassed).toBe(false);
    expect(result.outcome.reasonCode).toBe("REMAIN_BLOCKED");
    const diff = result.ruleDiffs.find((entry) => entry.rule === "academic_score_threshold");
    expect(diff?.action).toBe("COVERAGE_GUARD_RETAINED");
    const academic = result.gate.rules.find((entry) => entry.rule === "academic_score_threshold");
    expect(academic?.status).toBe("FAIL");
    expect(academic?.required).toBe(true);
  });

  it("单调性：Legacy PASS 在 Candidate 臂仍 PASS（NO_CHANGE）", () => {
    const gate = legacyGate(passingReview);
    expect(gate.passed).toBe(true);
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 88, styleRisk: 20 },
    });
    expect(result.outcome.reasonCode).toBe("NO_CHANGE");
    expect(result.outcome.candidatePassed).toBe(true);
    expect(result.ruleDiffs).toEqual([]);
  });

  it("确定性：同输入两次运行结果深度相等（零时钟 / 零随机）", () => {
    const gate = legacyGate(both79and36);
    const a = applyQualityPolicy({ gate, arm: "policy_aware", scores: { academicScore: 79, styleRisk: 36 } });
    const b = applyQualityPolicy({ gate, arm: "policy_aware", scores: { academicScore: 79, styleRisk: 36 } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("M15.7 applyQualityPolicy：Candidate B 场景最小分权", () => {
  it("published_paper_assessment：评估完成语义三态 + 不映射投稿 READY", () => {
    // INCOMPLETE：required NOT_EVALUATED 残留
    const gateMissingCitation = evaluateQualityGate({
      review: score79,
      citation: null,
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    });
    const incomplete = applyQualityPolicy({
      gate: gateMissingCitation,
      arm: "policy_aware",
      scores: { academicScore: 79, styleRisk: 20 },
      scenario: { reviewPurpose: "published_paper_assessment" },
    });
    expect(incomplete.assessment?.completion).toBe("ASSESSMENT_INCOMPLETE");
    expect(incomplete.assessment?.requiredGaps).toContain("citation_structure_valid");
    expect(incomplete.assessment?.submissionReadiness).toBe("NOT_ASSESSED_QUICK_REVIEW");

    // WITH_FINDINGS：仍有非分数 FAIL
    const reviewContradiction = {
      ...passingReview,
      scores: { ...passingReview.scores, academicScore: 79 },
      unsupportedCriticalClaims: 1,
      counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 1 },
    };
    const gateFindings = evaluateQualityGate({
      review: reviewContradiction,
      citation: cleanCitation(),
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    });
    const withFindings = applyQualityPolicy({
      gate: gateFindings,
      arm: "policy_aware",
      scores: { academicScore: 79, styleRisk: 20 },
      scenario: { reviewPurpose: "published_paper_assessment" },
    });
    expect(withFindings.assessment?.completion).toBe("ASSESSMENT_COMPLETED_WITH_FINDINGS");
    expect(withFindings.assessment?.findingRules).toEqual(
      expect.arrayContaining(["blocking_issues_zero", "academic_score_threshold"]),
    );

    // CLEAR：干净稿（published 视角下 advisory 与 PASS 均不是 finding）
    const clean = applyQualityPolicy({
      gate: legacyGate(passingReview),
      arm: "policy_aware",
      scores: { academicScore: 88, styleRisk: 20 },
      scenario: { reviewPurpose: "published_paper_assessment" },
    });
    expect(clean.assessment?.completion).toBe("ASSESSMENT_COMPLETED_CLEAR");
    expect(clean.assessment?.findingRules).toEqual([]);
  });

  it("published purpose 也可来自 gate.evaluation（回放路径无需显式 scenario）", () => {
    const gate: QualityGateResult = {
      ...legacyGate(passingReview),
      evaluation: {
        entry: "workflow",
        workflowKind: "idea_to_paper",
        reviewPurpose: "published_paper_assessment",
        reviewRound: 1,
        reviewedRevision: null,
        runId: null,
        inputFingerprint: "f".repeat(16),
        contextGaps: [],
      },
    };
    const result = applyQualityPolicy({ gate, arm: "policy_aware", scores: { academicScore: 88, styleRisk: 20 } });
    expect(result.assessment?.completion).toBe("ASSESSMENT_COMPLETED_CLEAR");
  });

  it("quick_review（existing_paper_review 工作流）→ 阅读意见不是投稿 READY 凭证", () => {
    const result = applyQualityPolicy({
      gate: legacyGate(score79),
      arm: "policy_aware",
      scores: { academicScore: 79, styleRisk: 20 },
      scenario: { workflowKind: "existing_paper_review", reviewPurpose: "quick_review" },
    });
    expect(result.quickReview?.readiness).toBe("NOT_A_SUBMISSION_CREDENTIAL");
    expect(result.assessment).toBeUndefined();
  });

  it("author_manuscript / existing_paper_improvement：B 与 A 同判（不加分权、不动 revisionTaskGate 分层）", () => {
    const gate = legacyGate(score79);
    const a = applyQualityPolicy({ gate, arm: "score_style_advisory", scores: { academicScore: 79, styleRisk: 20 } });
    const b = applyQualityPolicy({
      gate,
      arm: "policy_aware",
      scores: { academicScore: 79, styleRisk: 20 },
      scenario: { workflowKind: "existing_paper_improvement", reviewPurpose: "author_manuscript" },
    });
    expect(b.outcome.reasonCode).toBe(a.outcome.reasonCode);
    expect(b.outcome.candidatePassed).toBe(a.outcome.candidatePassed);
    expect(b.assessment).toBeUndefined();
    expect(b.quickReview).toBeUndefined();
  });
});

describe("M15.7 applyQualityPolicy：契约常量", () => {
  it("POLICY_RULE_IDS 只含两个未校准阈值规则——政策变量不外溢", () => {
    expect([...POLICY_RULE_IDS]).toEqual(["academic_score_threshold", "style_risk_threshold"]);
  });

  it("非政策规则的 FAIL 不被触碰（contradictory evidence 阻断原样保留）", () => {
    const gate = evaluateQualityGate({
      review: score79,
      citation: cleanCitation(),
      evidence: { ...cleanEvidence, contradictory: 2 },
      feasibility: highFeasibility,
    });
    const result = applyQualityPolicy({
      gate,
      arm: "score_style_advisory",
      scores: { academicScore: 79, styleRisk: 20 },
    });
    expect(result.outcome.reasonCode).toBe("REMAIN_BLOCKED");
    expect(result.outcome.remainingBlockers).toContain("no_contradictory_evidence");
    const rule = result.gate.rules.find((entry) => entry.rule === "no_contradictory_evidence");
    expect(rule?.status).toBe("FAIL");
    expect(rule?.required).toBe(true);
  });
});
