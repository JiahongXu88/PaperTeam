/**
 * Quality Gate Revision Gate 规则测试（M6.7 §10）：
 * - revision_items_resolved：全部 validated → PASS；rejected / needs_review → FAIL；
 *   用户 approve → 按决策放行（记录在案，不静默）
 * - claim_strength_guard：block 级强 claim 弱证据 → FAIL；仅 warning → PASS（计数可解释）；
 *   用户 approve → 放行
 * - 输入缺省（无修订 / 不对齐）→ 规则不出现（与 Preservation null 同纪律）
 */

import { describe, expect, it } from "vitest";

import { evaluateQualityGate, type QualityGateInput } from "../../src/quality/gates.js";
import type { RevisionValidationResult } from "../../src/review/revisionValidation.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

const summary: ReviewSummary = {
  generatedAt: "2026-09-18T00:00:00.000Z",
  round: 1,
  reviewedRevision: 3,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 90, styleRisk: 20, factVerdicts: null },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

function validation(partial: Partial<RevisionValidationResult>): RevisionValidationResult {
  return {
    schemaVersion: 1,
    validationId: "val-r1-rev3",
    planId: "plan-r1-rev2",
    projectId: "p1",
    reviewRound: 1,
    sourceRevision: 2,
    revision: 3,
    validatedAt: "2026-09-18T02:00:00.000Z",
    items: [],
    factPreservation: null,
    citationPreservation: null,
    claimStrength: [],
    citationDelta: { added: [], removed: [] },
    evidenceRecheck: [],
    uncoveredAddedKeys: [],
    ok: true,
    blocked: false,
    ...partial,
  };
}

function gateWith(revisionValidation: RevisionValidationResult | undefined) {
  const input: QualityGateInput = {
    review: summary,
    citation: null,
    evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 },
    feasibility: null,
  };
  return evaluateQualityGate(revisionValidation !== undefined ? { ...input, revisionValidation } : input);
}

describe("Quality Gate：Revision Gate 规则（M6.7）", () => {
  it("输入缺省 → 规则不出现（无修订 / 不对齐项目不误伤）", () => {
    const result = gateWith(undefined);
    expect(result.rules.find((rule) => rule.rule === "revision_items_resolved")).toBeUndefined();
    expect(result.rules.find((rule) => rule.rule === "claim_strength_guard")).toBeUndefined();
  });

  it("revision 全部通过：validated 条目 → revision_items_resolved PASS", () => {
    const result = gateWith(
      validation({
        items: [
          { id: "f-1", kind: "review_finding", section: "s", riskLevel: "high", status: "validated", reasonCodes: [], reasons: [] },
          { id: "f-2", kind: "review_finding", section: "s", riskLevel: "medium", status: "validated", reasonCodes: [], reasons: [] },
        ],
      }),
    );
    const rule = result.rules.find((rule) => rule.rule === "revision_items_resolved");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("validated=2");
    expect(result.passed).toBe(true);
  });

  it("revision 失败阻塞：rejected / needs_review → revision_items_resolved FAIL", () => {
    const rejected = gateWith(
      validation({
        items: [
          { id: "f-1", kind: "review_finding", section: "s", riskLevel: "high", status: "rejected", reasonCodes: ["fact_preservation_violation"], reasons: ["数值漂移"] },
        ],
      }),
    );
    const rejectedRule = rejected.rules.find((rule) => rule.rule === "revision_items_resolved");
    expect(rejectedRule?.passed).toBe(false);
    expect(rejectedRule?.detail).toContain("rejected=1");
    expect(rejected.passed).toBe(false);
    expect(rejected.reasons.join("\n")).toContain("revision_items_resolved");

    const needsReview = gateWith(
      validation({
        items: [
          { id: "f-1", kind: "review_finding", section: "s", riskLevel: "high", status: "needs_review", reasonCodes: ["evidence_stale"], reasons: ["E001 失效"] },
        ],
      }),
    );
    expect(needsReview.rules.find((rule) => rule.rule === "revision_items_resolved")?.passed).toBe(false);
    expect(needsReview.passed).toBe(false);
  });

  it("claim_strength_guard：block 级 FAIL；仅 warning PASS（计数可解释）", () => {
    const block = gateWith(
      validation({
        claimStrength: [
          {
            file: "sections/experiments.tex",
            before: "可能改善",
            after: "显著改善",
            claimStrength: "strong",
            evidenceSupport: "insufficient",
            action: "block",
            markers: ["显著改善"],
          },
        ],
      }),
    );
    const blockRule = block.rules.find((rule) => rule.rule === "claim_strength_guard");
    expect(blockRule?.passed).toBe(false);
    expect(block.passed).toBe(false);

    const warning = gateWith(
      validation({
        claimStrength: [
          {
            file: "sections/experiments.tex",
            before: "可能改善",
            after: "显著改善",
            claimStrength: "strong",
            evidenceSupport: "partial",
            action: "warning",
            markers: ["显著改善"],
          },
        ],
      }),
    );
    const warningRule = warning.rules.find((rule) => rule.rule === "claim_strength_guard");
    expect(warningRule?.passed).toBe(true);
    expect(warningRule?.detail).toContain("warning 1");
  });

  it("用户 approve：两条规则按决策放行（HITL 明示接受，记录在案）", () => {
    const result = gateWith(
      validation({
        items: [
          { id: "f-1", kind: "review_finding", section: "s", riskLevel: "high", status: "rejected", reasonCodes: ["claim_strength_escalation"], reasons: ["强 claim 弱证据"] },
        ],
        claimStrength: [
          {
            file: "sections/experiments.tex",
            before: "可能改善",
            after: "显著改善",
            claimStrength: "strong",
            evidenceSupport: "insufficient",
            action: "block",
            markers: ["显著改善"],
          },
        ],
        userDecision: { decision: "approve", decidedAt: "2026-09-18T03:00:00.000Z" },
      }),
    );
    expect(result.rules.find((rule) => rule.rule === "revision_items_resolved")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.rule === "claim_strength_guard")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.rule === "revision_items_resolved")?.detail).toContain("用户已在修订验证 HITL 明示接受");
    expect(result.passed).toBe(true);
  });
});
