/**
 * M14.7 — thesis_abstract_snapshot_current Gate 规则单元测试。
 *
 * 语义：摘要存在（thesis_abstract_complete 已覆盖齐备性）时，快照绑定必须对应当前
 * 正文 / 事实 / 决定——不一致 → ABSTRACT_STALE（FAIL；Draft 可构建但不得视为摘要同步）。
 * 无摘要或绑定信息缺省（旧输入）→ 规则不出现（不适用），不额外阻断。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { CitationReport } from "../../src/citation/CitationService.js";

const passingReview: ReviewSummary = {
  generatedAt: "2026-10-17T00:00:00Z",
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

const highFeasibility = { level: "HIGH", reasons: [], missingRequirements: [], researchGaps: [], requiredExperiments: [], evidenceGaps: [], recommendations: [] } as never;

const cleanCitation = (): CitationReport => ({
  generatedAt: "2026-10-17T00:00:00Z",
  static: { citedKeys: ["a"], missingKeys: [], unusedKeys: [], duplicateKeys: [], badCitations: [], bibEntries: [] },
  metadata: { enabled: true, providers: [], checked: 1, skipped: 0, results: [], byStatus: { verified: 1, mismatch: 0, not_found: 0, unverifiable: 0 } },
  summary: { citedCount: 1, missingKeys: 0, unusedKeys: 0, duplicateKeys: 0, badCitations: 0, hallucinated: 0, mismatched: 0, unverifiable: 0 },
});

const baseThesis = {
  drift: { checked: 1, consistent: 1, equivalentFormat: 0, unauthorized: 0, absent: 0, findings: [] },
  mapping: { exists: true, confirmed: true, fingerprintMatchesOutline: true, invalidSourceInputs: [], invalidFactIds: [] },
  structureViolations: [],
  conflictsUnresolved: 0,
  abstract: { present: true, detail: "双语摘要 + 关键词齐备" },
  metaNotes: { hits: 0, samples: [] },
  citations: { citedCount: 1, hallucinated: 0, missingKeys: 0, applicable: true, supplyDegraded: false, formalEvidence: 2, bibEntries: 1 },
} as const;

describe("M14.7 thesis_abstract_snapshot_current", () => {
  const evaluate = (abstract: Record<string, unknown>) =>
    evaluateQualityGate(
      {
        review: passingReview,
        citation: cleanCitation(),
        evidence: cleanEvidence,
        feasibility: highFeasibility,
        thesis: { ...baseThesis, abstract: { ...baseThesis.abstract, ...abstract } } as never,
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );

  it("摘要绑定当前快照 → 规则通过", () => {
    const gate = evaluate({ snapshotCurrent: true, snapshotDetail: "摘要绑定当前快照（生成于 rev-2）" });
    const rule = gate.rules.find((entry) => entry.rule === "thesis_abstract_snapshot_current");
    expect(rule).toBeDefined();
    expect(rule?.passed).toBe(true);
    expect(gate.passed).toBe(true);
  });

  it("摘要绑定过期 → ABSTRACT_STALE FAIL（gate 不通过；Draft 仍可构建但不得视为摘要同步）", () => {
    const gate = evaluate({ snapshotCurrent: false, snapshotDetail: "ABSTRACT_STALE：摘要生成后正文已变化（绑定 rev-1）" });
    const rule = gate.rules.find((entry) => entry.rule === "thesis_abstract_snapshot_current");
    expect(rule?.passed).toBe(false);
    expect(rule?.detail).toContain("ABSTRACT_STALE");
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("thesis_abstract_snapshot_current"))).toBe(true);
  });

  it("无摘要（present=false）或快照信息缺省（旧输入）→ 规则不出现（不适用不阻断）", () => {
    const noAbstract = evaluate({ present: false, detail: "学位论文结构不完整：缺中文摘要" });
    expect(noAbstract.rules.find((entry) => entry.rule === "thesis_abstract_snapshot_current")).toBeUndefined();
    const legacy = evaluate({});
    expect(legacy.rules.find((entry) => entry.rule === "thesis_abstract_snapshot_current")).toBeUndefined();
  });
});
