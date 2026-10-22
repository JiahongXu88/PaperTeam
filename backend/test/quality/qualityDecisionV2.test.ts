/**
 * M15.1 Quality Decision V2 影子结果：只读、不改生产 gate；Style 与科学轴解耦（advisory）；NOT_EVALUATED 不折算 PASS。
 */
import { describe, expect, it } from "vitest";
import { computeQualityDecisionV2Shadow, decisionPolicyFor } from "../../src/quality/qualityDecisionV2.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

const review: ReviewSummary = {
  generatedAt: "2026-10-22T00:00:00Z", round: 1, reviewedRevision: 2,
  issues: [{ category: "style", severity: "minor", section: "A", description: "模板化表达", blocking: false }],
  counts: { critical: 0, major: 0, minor: 1, byCategory: { style: 1 }, blocking: 0 },
  scores: { academicScore: 85, styleRisk: 50, factVerdicts: null }, openCritical: 0, openMajor: 0, unsupportedCriticalClaims: 0, reportPaths: [],
};

describe("M15.1 Quality Decision V2（shadow）", () => {
  it("生产 gate 原样：styleRisk 50 仍按旧阈值 FAIL；影子把 style 记为 advisory，不输出任何生成来源概率", () => {
    const gate = evaluateQualityGate({ review, citation: null, evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 }, feasibility: null }, DEFAULT_QUALITY_THRESHOLDS);
    const before = JSON.stringify(gate);
    const shadow = computeQualityDecisionV2Shadow({ policy: "quick_review", gate, review, claimAudit: null, citationAudit: null, findingAudit: null });
    expect(JSON.stringify(gate)).toBe(before);
    expect(gate.rules.find((rule) => rule.rule === "style_risk_threshold")?.status).toBe("FAIL");
    expect(shadow.styleQuality).toMatchObject({ role: "ADVISORY_NOT_A_GATE", legacyStyleRisk: 50, provenanceJudgement: "NOT_PRODUCED", polishAuthorization: "suggest_only_default" });
    expect(shadow.mode).toBe("SHADOW_ONLY");
    // NOT_EVALUATED 的必需核验进入 missing，不算通过
    expect(shadow.scientificIntegrity.status).toBe("NOT_EVALUATED");
    expect(shadow.verificationCompleteness.complete).toBe(false);
    expect(shadow.verificationCompleteness.missing).toEqual(expect.arrayContaining(["production:hallucinated_citations_zero", "production:unsupported_critical_claims_zero", "claim_audit", "citation_authenticity"]));
    expect(JSON.stringify(shadow)).not.toMatch(/aiProbability|AIGC|humanProbability/);
  });

  it("场景策略：只读评估 / Quick Review → quick_review；有外部审稿意见 → revision_task；否则 autonomous_improvement", () => {
    expect(decisionPolicyFor("idea_to_paper", true, false)).toBe("quick_review");
    expect(decisionPolicyFor("existing_paper_review", false, false)).toBe("quick_review");
    expect(decisionPolicyFor("existing_paper_improvement", false, true)).toBe("revision_task");
    expect(decisionPolicyFor("existing_paper_improvement", false, false)).toBe("autonomous_improvement");
  });
});
