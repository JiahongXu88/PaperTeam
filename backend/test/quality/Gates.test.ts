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
  summarizeGateVerification,
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

describe("evaluateQualityGate：citationSemanticMode 语义分层", () => {
  const base = {
    review: passingReview,
    citation: cleanCitation(),
    evidence: cleanEvidence,
    feasibility: highFeasibility,
  };
  /** 语义层有硬伤的 integrity 输入（Layer 1 全干净） */
  const semanticHits = {
    probableFabricated: 0,
    notFoundObligatory: 0,
    unsupportedCritical: 2,
    mismatchCritical: 0,
    insufficientEvidence: 54,
  };

  it("off：语义规则不参与——没有 semantic records 不导致 FAIL", () => {
    const gate = evaluateQualityGate(
      { ...base, citationIntegrity: { ...semanticHits, unsupportedCritical: 0, insufficientEvidence: 0 }, citationSemanticMode: "off" },
    );
    const ruleNames = gate.rules.map((rule) => rule.rule);
    expect(ruleNames).not.toContain("citation_unsupported_critical_zero");
    expect(ruleNames).not.toContain("citation_insufficient_evidence_review");
    expect(ruleNames).toContain("citation_semantic_verification_off");
    expect(gate.passed).toBe(true);
  });

  it("full（缺省解释）：语义硬伤照常 FAIL（旧行为不变）", () => {
    const gate = evaluateQualityGate({ ...base, citationIntegrity: semanticHits });
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join("\n")).toContain("citation_unsupported_critical_zero");
  });

  it("contradiction_only：只有明确矛盾（unsupportedCritical）参与判定", () => {
    const contradicted = evaluateQualityGate(
      { ...base, citationIntegrity: semanticHits, citationSemanticMode: "contradiction_only" },
    );
    expect(contradicted.passed).toBe(false); // CONTRADICTED 计入 unsupportedCritical
    expect(contradicted.reasons.join("\n")).toContain("citation_unsupported_critical_zero");
    // 没有矛盾时不因「没有 SUPPORTED」失败
    const clean = evaluateQualityGate(
      { ...base, citationIntegrity: { ...semanticHits, unsupportedCritical: 0 }, citationSemanticMode: "contradiction_only" },
    );
    expect(clean.passed).toBe(true);
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

describe("Round 2：作者授权实验数据的 claim 披露口径", () => {
  it("author_experiment_data 不计入凭空断言阻断；单独呈现为 informational 规则", () => {
    const claimGrounding = {
      schemaVersion: 1 as const,
      reportId: "cg-r1",
      projectId: "p1",
      round: 1,
      generatedAt: "2026-10-10T00:00:00.000Z",
      totalClaims: 2,
      supportedClaims: 0,
      partiallySupportedClaims: 0,
      unsupportedClaims: 2,
      contradictedClaims: 0,
      evidenceBoundClaims: 0,
      evidenceBindingRate: 0,
      unsupportedClaimIds: ["c-1", "c-2"],
      opaqueUnsupportedClaims: 0,
      transparentUnsupportedClaims: 0,
      authorDataUnsupportedClaims: 2,
      claims: [],
      formalEvidencePool: 0,
    };
    const gate = evaluateQualityGate({
      review: passingReview,
      citation: cleanCitation(),
      evidence: cleanEvidence,
      feasibility: highFeasibility,
      claimGrounding,
    });
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero");
    expect(rule4?.passed).toBe(true);
    expect(rule4?.detail).toContain("作者授权实验数据 2 条单独呈现不阻断");
    const info = gate.rules.find((rule) => rule.rule === "author_experiment_data_reported");
    expect(info?.passed).toBe(true);
    expect(info?.detail).toContain("未经外部核验");
    // 对照：同样 2 条若是凭空断言 → 阻断
    const opaque = evaluateQualityGate({
      review: passingReview,
      citation: cleanCitation(),
      evidence: cleanEvidence,
      feasibility: highFeasibility,
      claimGrounding: { ...claimGrounding, opaqueUnsupportedClaims: 2, authorDataUnsupportedClaims: 0 },
    });
    expect(opaque.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")?.passed).toBe(false);
    expect(opaque.rules.find((rule) => rule.rule === "author_experiment_data_reported")).toBeUndefined();
  });
});

describe("M14.9.5.4 规则执行状态：「0 条违规」≠「完成核验」", () => {
  const base = { review: passingReview, citation: cleanCitation(), evidence: cleanEvidence, feasibility: highFeasibility };
  const statusOf = (gate: ReturnType<typeof evaluateQualityGate>, rule: string) => gate.rules.find((entry) => entry.rule === rule);

  it("全部前提成立：核心规则 PASS，verification.requiredComplete=true", () => {
    const gate = evaluateQualityGate(base);
    expect(gate.passed).toBe(true);
    for (const rule of ["hallucinated_citations_zero", "citation_structure_valid", "no_contradictory_evidence", "unsupported_critical_claims_zero", "open_critical_major_zero", "target_feasibility"]) {
      expect(statusOf(gate, rule)?.status).toBe("PASS");
    }
    expect(gate.verification).toMatchObject({ requiredComplete: true, notEvaluated: [] });
  });

  it("证据库为空：no_contradictory_evidence = NOT_EVALUATED（不阻断，不是 PASS）", () => {
    const gate = evaluateQualityGate({ ...base, evidence: { ...cleanEvidence, total: 0, byStatus: { ...cleanEvidence.byStatus, verified: 0 } } });
    expect(statusOf(gate, "no_contradictory_evidence")).toMatchObject({ status: "NOT_EVALUATED", required: false, passed: true });
    expect(gate.passed).toBe(true);
    expect(gate.verification?.notEvaluated.map((entry) => entry.rule)).toEqual(["no_contradictory_evidence"]);
    expect(gate.verification?.requiredComplete).toBe(true);
  });

  it("claim 级核验未执行（factVerdicts=null，如长文档单元模式）或 0 条 claim：NOT_EVALUATED（必需）→ Gate 不得 PASS", () => {
    const unitMode = evaluateQualityGate({ ...base, review: { ...passingReview, scores: { ...passingReview.scores, factVerdicts: null } } });
    expect(statusOf(unitMode, "unsupported_critical_claims_zero")).toMatchObject({ status: "NOT_EVALUATED", required: true, passed: false });
    expect(unitMode.passed).toBe(false);
    expect(unitMode.reasons).toEqual([expect.stringContaining("unsupported_critical_claims_zero: NOT_EVALUATED")]);
    expect(unitMode.verification?.requiredComplete).toBe(false);
    const zero = evaluateQualityGate({ ...base, review: { ...passingReview, scores: { ...passingReview.scores, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } } } });
    expect(statusOf(zero, "unsupported_critical_claims_zero")?.status).toBe("NOT_EVALUATED");
    expect(zero.passed).toBe(false);
  });

  it("未执行 citation.verify：两条引用规则 NOT_EVALUATED（必需）；稿件无 \cite：虚构引用检查 NOT_APPLICABLE", () => {
    const none = evaluateQualityGate({ ...base, citation: null });
    expect(statusOf(none, "hallucinated_citations_zero")).toMatchObject({ status: "NOT_EVALUATED", required: true, passed: false });
    expect(statusOf(none, "citation_structure_valid")).toMatchObject({ status: "NOT_EVALUATED", required: true, passed: false });
    expect(none.passed).toBe(false);
    const noCites = evaluateQualityGate({ ...base, citation: cleanCitation({ citedCount: 0 }) });
    expect(statusOf(noCites, "hallucinated_citations_zero")).toMatchObject({ status: "NOT_APPLICABLE", passed: true });
    expect(noCites.passed).toBe(true);
  });

  it("未评估可行性：NOT_EVALUATED 但不阻断（历史语义不变，只是不再显示为通过）", () => {
    const gate = evaluateQualityGate({ ...base, feasibility: null });
    expect(statusOf(gate, "target_feasibility")).toMatchObject({ status: "NOT_EVALUATED", required: false, passed: true });
    expect(gate.passed).toBe(true);
  });

  it("80 分阈值与学术分口径提示不变：长文档聚合分、尚未校准、不等同录用概率", () => {
    expect(DEFAULT_QUALITY_THRESHOLDS.academicPassScore).toBe(80);
    const gate = evaluateQualityGate({ ...base, review: { ...passingReview, scores: { ...passingReview.scores, academicScore: 79 }, academicScoreBasis: { mode: "units_char_weighted", calibration: "UNVALIDATED" } } });
    expect(statusOf(gate, "academic_score_threshold")?.detail).toMatch(/^academicScore=79（要求 ≥ 80）；长文档单元聚合分，尚未校准，不等同录用概率/);
    expect(gate.passed).toBe(false);
  });

  it("实验论断复算规则：未登记 / 矛盾 / 无法复算 / 一致 / 只读评估", () => {
    const summary = { registered: 0, consistent: 0, contradicted: [], notEvaluated: [], ledgerHash: "f".repeat(64), experimentPackages: 0 };
    expect(statusOf(evaluateQualityGate({ ...base, claimChecks: summary }), "experiment_claims_recomputed")?.status).toBe("NOT_APPLICABLE");
    const unregistered = evaluateQualityGate({ ...base, claimChecks: { ...summary, experimentPackages: 1 } });
    expect(statusOf(unregistered, "experiment_claims_recomputed")).toMatchObject({ status: "NOT_EVALUATED", required: false, passed: true });
    expect(statusOf(unregistered, "experiment_claims_recomputed")?.detail).toContain("导入记录不等于 Verified Evidence");
    const contradicted = evaluateQualityGate({
      ...base,
      review: { ...passingReview, issues: [{ category: "fact", severity: "major", section: "s", description: "d", blocking: false, rootCauseKey: "claim-check:S1b" }], counts: { ...passingReview.counts, major: 1 }, openMajor: 1 },
      claimChecks: { ...summary, registered: 2, consistent: 1, contradicted: [{ id: "S1b", materiality: "core", manuscriptValue: 14, derivedValue: 12 }], experimentPackages: 1 },
    });
    expect(statusOf(contradicted, "experiment_claims_recomputed")).toMatchObject({ status: "FAIL", passed: false });
    expect(statusOf(contradicted, "experiment_claims_recomputed")?.detail).toContain("S1b（稿件 14 ≠ 复算 12）");
    // 同根因的确定性 finding 不在 critical/major 口径重复计因
    expect(statusOf(contradicted, "open_critical_major_zero")).toMatchObject({ status: "PASS" });
    const missing = evaluateQualityGate({ ...base, claimChecks: { ...summary, registered: 1, notEvaluated: [{ id: "G1", reason: "COLUMN_MISSING", required: true }], experimentPackages: 1 } });
    expect(statusOf(missing, "experiment_claims_recomputed")).toMatchObject({ status: "NOT_EVALUATED", required: true, passed: false });
    const consistent = evaluateQualityGate({ ...base, claimChecks: { ...summary, registered: 1, consistent: 1, experimentPackages: 1 } });
    expect(statusOf(consistent, "experiment_claims_recomputed")?.status).toBe("PASS");
    expect(statusOf(consistent, "experiment_claims_recomputed")?.detail).toContain("未经外部独立核验");
    const published = evaluateQualityGate({ ...base, reviewPurpose: "published_paper_assessment", claimChecks: { ...summary, experimentPackages: 1 } });
    expect(statusOf(published, "experiment_claims_recomputed")?.status).toBe("NOT_APPLICABLE");
  });

  it("legacy 规则（无 status 字段）按 passed 汇总，不崩溃", () => {
    const summary = summarizeGateVerification([{ rule: "legacy_a", passed: true, detail: "" }, { rule: "legacy_b", passed: false, detail: "" }]);
    expect(summary.counts).toMatchObject({ PASS: 1, FAIL: 1, NOT_EVALUATED: 0 });
    expect(summary.requiredComplete).toBe(true);
  });
});
