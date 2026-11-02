/**
 * M16 续期收口 · G4 纠偏：审查覆盖不完整时，模型计数类规则的「0 条」不再以 PASS 呈现。
 *
 * 真实运行暴露（M16 OriginalQualityGateGoalClosure，aJUuere4fM）：3/13 单元被服务商内容过滤拒绝、覆盖 60.5%，
 * Gate 整体 FAIL（L0 覆盖规则）是对的，但 L2 `open_critical_major_zero` 仍为 PASS「critical=0 major=0」——
 * 未审的 40% 正文中有没有 major 是未知的。
 */
import { describe, expect, it } from "vitest";

import type { CitationReport } from "../../src/citation/CitationService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewCoverageSummary } from "../../src/review/coverageLedger.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { buildQualityReport } from "../../src/quality/qualityReport.js";

const coverage = (complete: boolean): ReviewCoverageSummary => ({
  mode: "units", snapshotId: "s", round: 1, targetUnits: 13, completedUnits: complete ? 13 : 10, failedUnits: complete ? 0 : 3, reusedUnits: 0,
  targetChars: 30_492, reviewedChars: complete ? 30_492 : 18_434, ratio: complete ? 1 : 18_434 / 30_492, complete, failedUnitIds: complete ? [] : ["a", "b", "c"],
});

const review = (complete: boolean, major = 0): ReviewSummary => ({
  generatedAt: "2026-11-02T00:00:00Z",
  round: 1,
  issues: Array.from({ length: major }, (_, i) => ({ category: "academic", severity: "major" as const, section: "S", description: `major ${i}`, blocking: false })),
  counts: { critical: 0, major, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 85, styleRisk: 10, factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: major,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
  coverage: coverage(complete),
});

const evidence: EvidenceStats = { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 };
const citation: CitationReport = {
  generatedAt: "2026-11-02T00:00:00Z",
  static: { citedKeys: ["a"], missingKeys: [], unusedKeys: [], duplicateKeys: [], badCitations: [], bibEntries: [] },
  metadata: { enabled: true, providers: [], checked: 1, skipped: 0, results: [], byStatus: { verified: 1, mismatch: 0, not_found: 0, unverifiable: 0 } },
  summary: { citedCount: 1, missingKeys: 0, unusedKeys: 0, duplicateKeys: 0, badCitations: 0, hallucinated: 0, mismatched: 0, unverifiable: 0 },
};
const rule = (gate: ReturnType<typeof evaluateQualityGate>, id: string) => gate.rules.find((r) => r.rule === id)!;

describe("M16 G4：部分覆盖下的模型计数规则", () => {
  it("覆盖不完整 + 0 条 → blocking / critical-major 规则为必需 NOT_EVALUATED，并写明覆盖比例；Gate 不通过", () => {
    const gate = evaluateQualityGate({ review: review(false), citation, evidence, feasibility: null });
    for (const id of ["blocking_issues_zero", "open_critical_major_zero"]) {
      expect(rule(gate, id).status, id).toBe("NOT_EVALUATED");
      expect(rule(gate, id).required).toBe(true);
      expect(rule(gate, id).detail).toContain("60.5%");
      expect(rule(gate, id).detail).toContain("0 条不代表全文无此类问题");
    }
    expect(gate.passed).toBe(false);
    const report = buildQualityReport(gate);
    const l2 = report.layers.L2.items.find((item) => item.id === "open_critical_major_zero");
    expect(l2?.status).toBe("NOT_EVALUATED");
  });

  it("覆盖不完整但已发现 major → 照常 FAIL（发现与覆盖无关，不被吞成未评估）", () => {
    const gate = evaluateQualityGate({ review: review(false, 2), citation, evidence, feasibility: null });
    expect(rule(gate, "open_critical_major_zero").status).toBe("FAIL");
    expect(rule(gate, "open_critical_major_zero").detail).toBe("critical=0 major=2");
  });

  it("覆盖完整 → 行为逐字不变（PASS「critical=0 major=0」）", () => {
    const gate = evaluateQualityGate({ review: review(true), citation, evidence, feasibility: null });
    expect(rule(gate, "open_critical_major_zero").status).toBe("PASS");
    expect(rule(gate, "open_critical_major_zero").detail).toBe("critical=0 major=0");
    expect(rule(gate, "blocking_issues_zero").detail).toBe("blocking issue 0 条");
  });
});
