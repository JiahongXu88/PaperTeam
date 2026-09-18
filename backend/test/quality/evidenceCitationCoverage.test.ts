/**
 * Evidence Citation Coverage 测试（M6.6 §13）：
 * - 正文引用 key ↔ verified evidence 覆盖检测（citation without evidence 可发现）
 * - Quality Gate 新规则 citations_evidence_backed：
 *   默认呈现不阻断；requireEvidenceBackedCitations=true 时未覆盖引用阻断
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  computeEvidenceCitationCoverage,
} from "../../src/quality/evidenceCitationCoverage.js";
import {
  DEFAULT_QUALITY_THRESHOLDS,
  evaluateQualityGate,
} from "../../src/quality/gates.js";
import type { CitationReport } from "../../src/citation/CitationService.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../../src/agents/FeasibilityService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

const BIB_ENTRIES = [
  { key: "gao2023survey", type: "article", title: "A Survey of Retrieval-Augmented Generation", year: 2023, doi: "10.1000/survey" },
  { key: "lewis2020rag", type: "article", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", year: 2020 },
  { key: "chen2024unbacked", type: "article", title: "An Unbacked Paper", year: 2024 },
];

const FORMAL_EVIDENCE: EvidenceRecord = {
  id: "E001",
  claim: "RAG 降低幻觉率",
  verificationStatus: "verified",
  supportStrength: "direct",
  verificationLevel: "fulltext",
  source: { sourceId: "S001", title: "A Survey of Retrieval-Augmented Generation", year: 2023, doi: "10.1000/survey" },
  location: { chunk: "S001:SEC01:0001:a1b2c3d4e5", section: "Introduction", page: 3 },
  createdBy: "researcher",
  createdAt: "2026-09-17T00:00:00Z",
};

const LEGACY_UNVERIFIED: EvidenceRecord = {
  id: "E002",
  claim: "legacy 未核验线索（同标题但未核验）",
  verificationStatus: "unverified",
  source: { sourceId: "S004", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", year: 2020 },
  createdBy: "researcher",
  createdAt: "2026-09-17T00:00:00Z",
};

const VERIFIED_NO_ANCHOR: EvidenceRecord = {
  id: "E003",
  claim: "verified 但无锚点",
  verificationStatus: "verified",
  source: { sourceId: "S005", title: "An Unbacked Paper", year: 2024 },
  createdBy: "user",
  createdAt: "2026-09-17T00:00:00Z",
};

describe("computeEvidenceCitationCoverage", () => {
  it("citation without evidence 可检测：uncovered 精确列出无 verified evidence 的 key", () => {
    const coverage = computeEvidenceCitationCoverage({
      citedKeys: ["gao2023survey", "lewis2020rag", "chen2024unbacked"],
      bibEntries: BIB_ENTRIES,
      evidenceRecords: [FORMAL_EVIDENCE],
    });
    expect(coverage.covered).toEqual(["gao2023survey"]);
    expect(coverage.uncovered).toEqual(["lewis2020rag", "chen2024unbacked"]);
    expect(coverage.byKey["chen2024unbacked"]).toBe(false);
  });

  it("evidence-backed citation：全部覆盖时 uncovered 为空", () => {
    const secondFormal: EvidenceRecord = {
      ...FORMAL_EVIDENCE,
      id: "E004",
      claim: "RAG 用于知识密集任务",
      source: { sourceId: "S002", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", year: 2020 },
      location: { chunk: "S002:SEC01:0001:bbbbbbbbbb" },
    };
    const coverage = computeEvidenceCitationCoverage({
      citedKeys: ["gao2023survey", "lewis2020rag"],
      bibEntries: BIB_ENTRIES,
      evidenceRecords: [FORMAL_EVIDENCE, secondFormal],
    });
    expect(coverage.uncovered).toEqual([]);
    expect(coverage.covered).toEqual(["gao2023survey", "lewis2020rag"]);
  });

  it("legacy unverified 与无锚点 verified 不产生覆盖（使用策略同源）", () => {
    const coverage = computeEvidenceCitationCoverage({
      citedKeys: ["lewis2020rag", "chen2024unbacked"],
      bibEntries: BIB_ENTRIES,
      evidenceRecords: [LEGACY_UNVERIFIED, VERIFIED_NO_ANCHOR],
    });
    expect(coverage.covered).toEqual([]);
    expect(coverage.uncovered).toEqual(["lewis2020rag", "chen2024unbacked"]);
  });

  it("bib 中不存在的 key 记为未覆盖（结构问题由既有规则处理，不误报为 covered）", () => {
    const coverage = computeEvidenceCitationCoverage({
      citedKeys: ["ghost2020"],
      bibEntries: BIB_ENTRIES,
      evidenceRecords: [FORMAL_EVIDENCE],
    });
    expect(coverage.byKey["ghost2020"]).toBe(false);
  });
});

// ---- Gate 集成 ----

const passingReview: ReviewSummary = {
  generatedAt: "2026-09-17T00:00:00Z",
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
  total: 1,
  byStatus: { unverified: 0, verified: 1, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
  contradictory: 0,
  skippedLines: 0,
};

const citationReport: CitationReport = {
  generatedAt: "2026-09-17T00:00:00Z",
  static: {
    citedKeys: ["gao2023survey", "chen2024unbacked"],
    missingKeys: [],
    unusedKeys: [],
    duplicateKeys: [],
    badCitations: [],
    bibEntries: BIB_ENTRIES,
  },
  metadata: {
    enabled: false,
    providers: [],
    checked: 0,
    skipped: 0,
    results: [],
    byStatus: { verified: 0, mismatch: 0, not_found: 0, unverifiable: 0 },
  },
  summary: {
    citedCount: 2,
    missingKeys: 0,
    unusedKeys: 0,
    duplicateKeys: 0,
    badCitations: 0,
    hallucinated: 0,
    mismatched: 0,
    unverifiable: 0,
  },
};

const highFeasibility: FeasibilityReport = {
  level: "HIGH",
  reasons: [],
  missingRequirements: [],
  researchGaps: [],
  requiredExperiments: [],
  evidenceGaps: [],
  recommendations: [],
};

const uncoveredCoverage = computeEvidenceCitationCoverage({
  citedKeys: citationReport.static.citedKeys,
  bibEntries: BIB_ENTRIES,
  evidenceRecords: [FORMAL_EVIDENCE],
});

describe("Quality Gate：citations_evidence_backed 规则", () => {
  it("未提供 coverage 输入 → 规则不出现（兼容既有调用方）", () => {
    const gate = evaluateQualityGate(
      { review: passingReview, citation: citationReport, evidence: cleanEvidence, feasibility: highFeasibility },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    expect(gate.rules.find((rule) => rule.rule === "citations_evidence_backed")).toBeUndefined();
    expect(gate.passed).toBe(true);
  });

  it("citation without evidence：默认可检测不阻断（规则呈现未覆盖计数）", () => {
    const gate = evaluateQualityGate(
      { review: passingReview, citation: citationReport, evidence: cleanEvidence, feasibility: highFeasibility, evidenceCitationCoverage: uncoveredCoverage },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    const rule = gate.rules.find((r) => r.rule === "citations_evidence_backed");
    expect(rule).toBeDefined();
    expect(rule!.passed).toBe(true); // 检测可见、不阻断（M6.6 接入期口径）
    expect(rule!.detail).toContain("chen2024unbacked");
    expect(gate.passed).toBe(true);
  });

  it("requireEvidenceBackedCitations=true：未覆盖引用阻断 Final", () => {
    const gate = evaluateQualityGate(
      { review: passingReview, citation: citationReport, evidence: cleanEvidence, feasibility: highFeasibility, evidenceCitationCoverage: uncoveredCoverage },
      { ...DEFAULT_QUALITY_THRESHOLDS, requireEvidenceBackedCitations: true },
    );
    const rule = gate.rules.find((r) => r.rule === "citations_evidence_backed");
    expect(rule!.passed).toBe(false);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.includes("citations_evidence_backed"))).toBe(true);
  });

  it("evidence-backed citation 全覆盖：enforcing 模式下也 PASS", () => {
    const fullyBacked = computeEvidenceCitationCoverage({
      citedKeys: ["gao2023survey"],
      bibEntries: BIB_ENTRIES,
      evidenceRecords: [FORMAL_EVIDENCE],
    });
    const gate = evaluateQualityGate(
      { review: passingReview, citation: citationReport, evidence: cleanEvidence, feasibility: highFeasibility, evidenceCitationCoverage: fullyBacked },
      { ...DEFAULT_QUALITY_THRESHOLDS, requireEvidenceBackedCitations: true },
    );
    const rule = gate.rules.find((r) => r.rule === "citations_evidence_backed");
    expect(rule!.passed).toBe(true);
    expect(gate.passed).toBe(true);
  });
});
