/**
 * Quality Gate Survey 规则测试（M11.2 §二十二-6）。
 *
 * 覆盖：survey 四条规则的 blocking / 呈现语义——
 * - survey_outline_contract（悬空 refs → FAIL）
 * - survey_citation_keys_valid（fake key → FAIL）
 * - survey_synthesis_traceability（evidence_backed 不可回溯 → FAIL）
 * - survey_writing_metrics（启发式信号只呈现，恒 PASS 不阻断）
 * - 无 surveyWriting 输入 = 普通论文路径零改动（规则不出现）
 */

import { describe, expect, it } from "vitest";

import type { CitationReport } from "../../src/citation/CitationService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../../src/agents/FeasibilityService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import type { SurveyWritingEvaluation } from "../../src/survey/writingInvariants.js";

const passingReview: ReviewSummary = {
  generatedAt: "2026-10-03T00:00:00Z",
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

const cleanCitation: CitationReport = {
  generatedAt: "2026-10-03T00:00:00Z",
  static: { citedKeys: ["a"], missingKeys: [], unusedKeys: [], duplicateKeys: [], badCitations: [], bibEntries: [] },
  metadata: { enabled: false, providers: [], checked: 0, skipped: 0, results: [], byStatus: { verified: 0, mismatch: 0, not_found: 0, unverifiable: 0 } },
  summary: { citedCount: 1, missingKeys: 0, unusedKeys: 0, duplicateKeys: 0, badCitations: 0, hallucinated: 0, mismatched: 0, unverifiable: 0 },
};

const nullFeasibility = null as unknown as FeasibilityReport;

function surveyEvaluation(
  overrides: Partial<Pick<SurveyWritingEvaluation, "blockers" | "warnings" | "metrics">> = {},
): SurveyWritingEvaluation {
  return {
    blockers: [],
    warnings: [],
    metrics: {
      sections: 6,
      totalCiteCommands: 30,
      multiKeyCiteCommands: 12,
      multiKeyCiteRatio: 0.4,
      literatureCoverage: 1,
      citedLiterature: 5,
      totalLiterature: 5,
      groundedSynthesisUsage: 1,
      evidenceBackedUsed: 8,
      evidenceBackedTotal: 8,
      singleKeyParagraphRatio: 0.3,
      listingRuns: 0,
      speculativeLeakSignals: 0,
      familyCoverage: [{ label: "tracking_association", cited: 5, total: 5 }],
    },
    sections: [],
    contexts: [],
    ...overrides,
  };
}

function gateWith(surveyWriting?: SurveyWritingEvaluation) {
  return evaluateQualityGate({
    review: passingReview,
    citation: cleanCitation,
    evidence: cleanEvidence,
    feasibility: nullFeasibility,
    ...(surveyWriting !== undefined ? { surveyWriting } : {}),
  });
}

describe("Quality Gate survey 规则", () => {
  it("干净 survey：四条规则全部通过（metrics 恒 PASS 只呈现）", () => {
    const gate = gateWith(surveyEvaluation());
    expect(gate.passed).toBe(true);
    const surveyRules = gate.rules.filter((rule) => rule.rule.startsWith("survey_"));
    expect(surveyRules.map((rule) => rule.rule)).toEqual([
      "survey_outline_contract",
      "survey_citation_keys_valid",
      "survey_synthesis_traceability",
      "survey_writing_metrics",
    ]);
    expect(surveyRules.every((rule) => rule.passed)).toBe(true);
  });

  it("悬空 refs → survey_outline_contract FAIL", () => {
    const gate = gateWith(
      surveyEvaluation({
        blockers: [{ code: "dangling_refs", detail: "section association 悬空 refs：synthesisRefs SYN-nope" }],
      }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("survey_outline_contract"))).toBe(true);
  });

  it("fake citation key → survey_citation_keys_valid FAIL", () => {
    const gate = gateWith(
      surveyEvaluation({
        blockers: [{ code: "fake_citation_key", detail: "section association 引用了 bibliography 之外的 citation key：ghost2099" }],
      }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("survey_citation_keys_valid"))).toBe(true);
  });

  it("evidence_backed 不可回溯 → survey_synthesis_traceability FAIL", () => {
    const gate = gateWith(
      surveyEvaluation({
        blockers: [{ code: "synthesis_untraceable", detail: "evidence_backed synthesis 不可回溯 1 条：SYN-aaaaaaaaaa" }],
        metrics: {
          ...surveyEvaluation().metrics,
          evidenceBackedUsed: 7,
          evidenceBackedTotal: 8,
          groundedSynthesisUsage: 0.875,
        },
      }),
    );
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("survey_synthesis_traceability"))).toBe(true);
  });

  it("启发式 warnings（罗列倾向 / 覆盖低）不阻断：survey_writing_metrics 恒 PASS 但明细可见", () => {
    const gate = gateWith(
      surveyEvaluation({
        warnings: ["检测到 2 处连续单文献段落游程（≥3 段）——疑似 literature listing 结构"],
        metrics: {
          ...surveyEvaluation().metrics,
          listingRuns: 2,
          singleKeyParagraphRatio: 0.7,
          speculativeLeakSignals: 1,
        },
      }),
    );
    expect(gate.passed).toBe(true);
    const metricsRule = gate.rules.find((rule) => rule.rule === "survey_writing_metrics")!;
    expect(metricsRule.passed).toBe(true);
    expect(metricsRule.detail).toContain("罗列游程 2");
    expect(metricsRule.detail).toContain("speculative 泄漏信号 1");
  });

  it("无 surveyWriting 输入：规则不出现（普通论文路径零改动）", () => {
    const gate = gateWith(undefined);
    expect(gate.rules.some((rule) => rule.rule.startsWith("survey_"))).toBe(false);
    expect(gate.passed).toBe(true);
  });
});
