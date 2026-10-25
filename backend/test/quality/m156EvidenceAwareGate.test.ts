/**
 * M15.6 阶段 C 测试：Evidence-Aware 规则 4/5/6 分层 + 跨节规则的 Gate 级语义。
 *
 * 覆盖预登记状态表（PRE_REGISTERED_PROTOCOL.md §1）的 claim / finding 分层与硬约束：
 *  - 无 pairing 材料（证据库空 + formal 池空）：UNSUPPORTED → NOT_EVALUATED（published 不阻断 /
 *    author 必需核验仍阻断）；evidence_gap 工件 finding 不计违规
 *  - 有 pairing 材料：opaque UNSUPPORTED / CONTRADICTED（opaque）→ 照旧计违规（反例保护）
 *  - CONTRADICTED + formal evidence 解析 → VERIFIED_CONTRADICTION（E001/S003 锚）
 *  - 跨域证据（零词面关联）→ PAIRING_DOMAIN_MISMATCH 不计
 *  - published rubric 自报 AUTHOR_CHECK_REQUIRED / EXTERNAL_DATA_REQUIRED → 核验不足不计违规
 *  - NOT_EVALUATED ≠ PASS（required NOT_EVALUATED → passed=false）；NOT_EVALUATED ≠ NOT_APPLICABLE
 *  - claimGapAudit 语境（existing-paper 返修）维持既有 revisionIntroduced 语义（不被 pairing 改写）
 *  - 跨节规则：verifiedContradictions > 0 → FAIL；suspected → NOT_EVALUATED（author required）
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate, type QualityGateInput } from "../../src/quality/gates.js";
import { deriveEvidencePairing, type EvidencePairingInput } from "../../src/quality/evidencePairing.js";
import type { ClaimGroundingReport, ClaimGroundingEntry } from "../../src/review/claimGrounding.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { CrossSectionConsistencySummary } from "../../src/review/crossSectionConsistency.js";

const THRESHOLDS = { ...DEFAULT_QUALITY_THRESHOLDS, requireFeasibility: false };

function reviewSummary(options: {
  issues?: ReviewIssue[];
  factVerdicts?: Record<string, number> | null;
  unsupportedCriticalClaims?: number;
  academicScore?: number | null;
}) {
  const issues = options.issues ?? [];
  return {
    generatedAt: "2026-10-25T00:00:00Z",
    round: 1,
    issues,
    counts: {
      critical: issues.filter((issue) => issue.severity === "critical").length,
      major: issues.filter((issue) => issue.severity === "major").length,
      minor: issues.filter((issue) => issue.severity === "minor").length,
      byCategory: {},
      blocking: issues.filter((issue) => issue.blocking).length,
    },
    scores: {
      academicScore: options.academicScore ?? 90,
      styleRisk: 10,
      factVerdicts: (options.factVerdicts ?? null) as QualityGateInput["review"]["scores"]["factVerdicts"],
    },
    openCritical: issues.filter((issue) => issue.severity === "critical").length,
    openMajor: issues.filter((issue) => issue.severity === "major").length,
    unsupportedCriticalClaims: options.unsupportedCriticalClaims ?? 0,
    reportPaths: [],
  };
}

function issue(overrides: Partial<ReviewIssue>): ReviewIssue {
  return {
    category: "fact",
    severity: "major",
    section: "sections/results.tex",
    description: "问题描述",
    blocking: false,
    ...overrides,
  };
}

function claimGroundingReport(entries: Partial<ClaimGroundingEntry>[], formalEvidencePool = 0): ClaimGroundingReport {
  const full: ClaimGroundingEntry[] = entries.map((entry, index) => ({
    claimId: entry.claimId ?? `c-test${index}`,
    section: entry.section ?? "sections/results.tex",
    claim: entry.claim ?? "论断",
    verdict: entry.verdict ?? "UNSUPPORTED",
    evidenceFormal: entry.evidenceFormal ?? false,
    repairCandidates: [],
    ...(entry.evidenceId !== undefined ? { evidenceId: entry.evidenceId } : {}),
    ...(entry.disclosure !== undefined ? { disclosure: entry.disclosure } : {}),
  }));
  const unsupportedIds = full.filter((entry) => entry.verdict === "UNSUPPORTED" || entry.verdict === "CONTRADICTED").map((entry) => entry.claimId);
  return {
    schemaVersion: 1,
    reportId: "cg-r1",
    projectId: "p-test",
    round: 1,
    generatedAt: "2026-10-25T00:00:00Z",
    totalClaims: full.length,
    supportedClaims: full.filter((entry) => entry.verdict === "SUPPORTED").length,
    partiallySupportedClaims: 0,
    unsupportedClaims: full.filter((entry) => entry.verdict === "UNSUPPORTED").length,
    contradictedClaims: full.filter((entry) => entry.verdict === "CONTRADICTED").length,
    evidenceBoundClaims: 0,
    evidenceBindingRate: 0,
    unsupportedClaimIds: unsupportedIds,
    opaqueUnsupportedClaims: full.filter((entry) => entry.verdict !== "SUPPORTED" && entry.verdict !== "PARTIALLY_SUPPORTED" && (entry.disclosure === undefined || entry.disclosure === "opaque_assertion")).length,
    transparentUnsupportedClaims: full.filter((entry) => entry.disclosure === "transparent_unverified").length,
    authorDataUnsupportedClaims: full.filter((entry) => entry.disclosure === "author_experiment_data").length,
    claims: full,
    formalEvidencePool,
  };
}

const NO_EVIDENCE = { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0, not_found: 0, mismatch: 0, unverifiable: 0 }, contradictory: 0, skippedLines: 0 };
const SOME_EVIDENCE = { total: 3, byStatus: { unverified: 1, verified: 2, plausible: 0, not_found: 0, mismatch: 0, unverifiable: 0 }, contradictory: 0, skippedLines: 0 };

/** EvidenceStats（gate 输入形态）→ evidencePairing 投影 */
function pairingEvidence(stats: typeof NO_EVIDENCE): EvidencePairingInput["evidence"] {
  return { total: stats.total, verified: stats.byStatus.verified, contradictory: stats.contradictory };
}

function pairingInput(overrides: Partial<EvidencePairingInput>): EvidencePairingInput {
  return {
    reviewPurpose: "author_manuscript",
    evidence: pairingEvidence(NO_EVIDENCE),
    claimGrounding: null,
    claimChecks: undefined,
    factVerdicts: null,
    unsupportedCriticalClaims: 0,
    issues: [],
    evidenceRecords: [],
    ...overrides,
  };
}

describe("M15.6 deriveEvidencePairing（状态表 claim / finding 分层）", () => {
  it("无 pairing 材料：UNSUPPORTED（opaque）→ evidenceGap，不计违规；published 与 author 均不把它算进违规计数", () => {
    const report = claimGroundingReport([
      { claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" },
      { claimId: "c-2", verdict: "UNSUPPORTED", disclosure: "transparent_unverified" },
    ]);
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 2, CONTRADICTED: 0 } }));
    expect(pairing.pairingStatus).toBe("NO_PAIRING_MATERIAL");
    expect(pairing.claims.evidenceGapUnsupported).toBe(1); // opaque 那条（transparent 不入 gap 计数）
    expect(pairing.claims.countedUnsupported).toBe(0);
    expect(pairing.claims.verifiedContradictions).toBe(0);
    expect(pairing.claims.reviewerContradictions).toBe(0);
  });

  it("有 pairing 材料：UNSUPPORTED（opaque）维持计数（反例保护——检索执行后无支持）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }], 3);
    const pairing = deriveEvidencePairing(pairingInput({ evidence: pairingEvidence(SOME_EVIDENCE), claimGrounding: report, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    expect(pairing.pairingStatus).toBe("PAIRING_AVAILABLE");
    expect(pairing.claims.countedUnsupported).toBe(1);
    expect(pairing.claims.evidenceGapUnsupported).toBe(0);
  });

  it("CONTRADICTED + formal evidence 解析（域匹配）→ VERIFIED_CONTRADICTION（E001/S003 锚保持计数）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "CONTRADICTED", evidenceFormal: true, evidenceId: "E001", claim: "消融后机制贡献仍使所有指标均改善" }]);
    const pairing = deriveEvidencePairing(pairingInput({
      evidence: pairingEvidence(SOME_EVIDENCE),
      claimGrounding: report,
      evidenceRecords: [{ id: "E001", claim: "BDD100K 公平消融：检测器主导收益，机制项 MOTA 71.2 增益不显著" }],
      factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 1 },
    }));
    expect(pairing.claims.verifiedContradictions).toBe(1);
    expect(pairing.domainMismatches).toHaveLength(0);
  });

  it("CONTRADICTED + formal evidence 但证据与论断零词面关联 → PAIRING_DOMAIN_MISMATCH 不计违规", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "CONTRADICTED", evidenceFormal: true, evidenceId: "E999", claim: "ByteTrack 的关联机制保持身份一致性" }]);
    const pairing = deriveEvidencePairing(pairingInput({
      evidence: pairingEvidence(SOME_EVIDENCE),
      claimGrounding: report,
      evidenceRecords: [{ id: "E999", claim: "量子化学势能面的数值求解精度研究" }],
      factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 1 },
    }));
    expect(pairing.claims.verifiedContradictions).toBe(0);
    expect(pairing.claims.domainMismatchContradictions).toBe(1);
    expect(pairing.domainMismatches[0]?.note).toContain("PAIRING_DOMAIN_MISMATCH");
  });

  it("CONTRADICTED 无 formal 解析：opaque → reviewerContradictions（计违规）；transparent → 不计（现状口径）", () => {
    const report = claimGroundingReport([
      { claimId: "c-1", verdict: "CONTRADICTED", disclosure: "opaque_assertion" },
      { claimId: "c-2", verdict: "CONTRADICTED", disclosure: "transparent_unverified" },
    ]);
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 2 } }));
    expect(pairing.claims.reviewerContradictions).toBe(1);
    expect(pairing.claims.countedUnsupported).toBe(0);
  });

  it("finding 分层：无 pairing 时 evidence_gap 类 heavy finding 被排除；真实缺陷与 gap-root-caused（既有去重负责）照旧", () => {
    const report = claimGroundingReport([{ claimId: "c-gap", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const issues: ReviewIssue[] = [
      issue({ category: "evidence_gap", severity: "major", blocking: true, description: "数值无证据库记录" }),
      // rootCauseKey 归因到 gap claim 的 finding：claimGrounding 存在时由既有规则 5/6 rootCause 去重排除（本模块不双扣）
      issue({ category: "fact", severity: "critical", blocking: false, rootCauseKey: "c-gap", description: "论断无支撑" }),
      issue({ category: "fact", severity: "major", blocking: false, description: "正文 41.0 与表格 41.8 内部矛盾（真实缺陷）" }),
    ];
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, issues, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    expect(pairing.findings.blockingEvidenceGapExcluded).toBe(1); // evidence_gap blocking
    expect(pairing.findings.majorEvidenceGapExcluded).toBe(1); // evidence_gap major（同一第一条）
    expect(pairing.findings.criticalEvidenceGapExcluded).toBe(0); // root-caused critical 由既有去重负责（防双扣）
  });

  it("finding 分层（无 claimGrounding 的 legacy 形态）：rootCauseKey 归因到 gap claim 的 finding 仍被排除", () => {
    // legacy：claimGrounding 缺失但 verdicts 指示 gap——rootCauseKey 无法映射 gapClaimIds（无 claim 明细）→ 不排除（fail-closed）
    const issues: ReviewIssue[] = [issue({ category: "fact", severity: "critical", blocking: false, rootCauseKey: "c-legacy", description: "论断无支撑" })];
    const pairing = deriveEvidencePairing(pairingInput({ issues, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    expect(pairing.findings.criticalEvidenceGapExcluded).toBe(0);
    expect(pairing.findings.blockingEvidenceGapExcluded).toBe(0);
  });

  it("published 只读：rubric 自报 AUTHOR_CHECK_REQUIRED / EXTERNAL_DATA_REQUIRED → 核验不足不计违规；VERIFIED_IN_TEXT 照旧", () => {
    const issues: ReviewIssue[] = [
      issue({ severity: "major", blocking: false, verification: "AUTHOR_CHECK_REQUIRED", description: "需作者核对" }),
      issue({ severity: "major", blocking: false, verification: "EXTERNAL_DATA_REQUIRED", description: "需外部数据" }),
      issue({ severity: "major", blocking: false, verification: "VERIFIED_IN_TEXT", description: "稿内可证矛盾" }),
    ];
    const pairing = deriveEvidencePairing(pairingInput({ reviewPurpose: "published_paper_assessment", evidence: pairingEvidence(SOME_EVIDENCE), issues }));
    expect(pairing.findings.verificationDeclared).toEqual({ verifiedInText: 1, authorCheck: 1, externalData: 1, undeclared: 0 });
    expect(pairing.findings.majorEvidenceGapExcluded).toBe(2);
    expect(pairing.findings.verificationDeclaredExcluded).toBe(2);
  });

  it("已由 rootCauseKey 去重的 finding 不重复排除（防双扣）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const issues: ReviewIssue[] = [issue({ category: "fact", severity: "critical", rootCauseKey: "c-1", blocking: true })];
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, issues, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    // c-1 ∈ unsupportedClaimIds → 该 finding 由既有 rootCause 去重负责，本模块不重复排除
    expect(pairing.findings.blockingEvidenceGapExcluded).toBe(0);
    expect(pairing.findings.criticalEvidenceGapExcluded).toBe(0);
  });
});

function crossSectionSummary(counts: Partial<CrossSectionConsistencySummary["counts"]>, status: CrossSectionConsistencySummary["status"] = "EVALUATED"): CrossSectionConsistencySummary {
  return {
    schema: "paperteam.cross-section-consistency/v1",
    status,
    ...(status === "UNAVAILABLE" ? { unavailableReason: "NO_TABLES" } : {}),
    sectionsScanned: [],
    atomsTotal: 0,
    counts: { verifiedContradictions: 0, suspected: 0, consistent: 0, notEvaluated: 0, skippedInteger: 0, setQuantifierClaims: 0, ...counts },
    notEvaluatedReasons: {},
    witnesses: [],
    inputsSha256: "sha-test",
  };
}

function baseGateInput(overrides: Partial<QualityGateInput>): QualityGateInput {
  return {
    review: reviewSummary({}),
    citation: null,
    evidence: NO_EVIDENCE,
    feasibility: null,
    ...overrides,
  };
}

describe("M15.6 Gate 规则 4/5/6 消费 evidencePairing", () => {
  it("无 pairing + published 只读：UNSUPPORTED 工件 → 规则 4 NOT_EVALUATED 非 required（评估缺口，不是已证实错误）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const pairing = deriveEvidencePairing(pairingInput({
      reviewPurpose: "published_paper_assessment",
      claimGrounding: report,
      factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 },
    }));
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }),
      evidencePairing: pairing,
      reviewPurpose: "published_paper_assessment",
    }), THRESHOLDS);
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")!;
    expect(rule4.status).toBe("NOT_EVALUATED");
    expect(rule4.required).toBe(false);
    expect(rule4.passed).toBe(true); // 非 required 的 NOT_EVALUATED 不阻断（缺口呈现，不放行语义不变——见 verification 摘要）
    expect(rule4.detail).toContain("核验缺口");
    expect(gate.verification?.notEvaluated.some((entry) => entry.rule === "unsupported_critical_claims_zero" && !entry.required)).toBe(true);
  });

  it("无 pairing + author 稿件：规则 4 NOT_EVALUATED required=true → passed=false（必需核验未完成，不得 READY）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const pairing = deriveEvidencePairing(pairingInput({
      claimGrounding: report,
      factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 },
    }));
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }),
      evidencePairing: pairing,
    }), THRESHOLDS);
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")!;
    expect(rule4.status).toBe("NOT_EVALUATED");
    expect(rule4.required).toBe(true);
    expect(rule4.passed).toBe(false); // NOT_EVALUATED ≠ PASS
    expect(gate.passed).toBe(false);
    expect(rule4.detail).toContain("必需核验未完成");
  });

  it("有 pairing：opaque UNSUPPORTED → 规则 4 FAIL 维持（反例保护）", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }], 3);
    const pairing = deriveEvidencePairing(pairingInput({ evidence: pairingEvidence(SOME_EVIDENCE), claimGrounding: report, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }),
      evidencePairing: pairing,
    }), THRESHOLDS);
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")!;
    expect(rule4.status).toBe("FAIL");
    expect(gate.passed).toBe(false);
  });

  it("规则 5/6：evidence_gap 工件 blocking/critical/major 被排除，真实缺陷保持计数", () => {
    const report = claimGroundingReport([{ claimId: "c-gap", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const issues: ReviewIssue[] = [
      issue({ category: "evidence_gap", severity: "critical", blocking: true, description: "数值无证据库记录" }),
      issue({ category: "fact", severity: "major", blocking: false, description: "正文 41.0 与表格 41.8 内部矛盾（真实缺陷）" }),
    ];
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, issues, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ issues, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }),
      evidencePairing: pairing,
    }), THRESHOLDS);
    const rule5 = gate.rules.find((rule) => rule.rule === "blocking_issues_zero")!;
    expect(rule5.status).toBe("PASS"); // 工件 blocking 被排除
    expect(rule5.detail).toContain("M15.6");
    const rule6 = gate.rules.find((rule) => rule.rule === "open_critical_major_zero")!;
    expect(rule6.status).toBe("FAIL"); // 真实缺陷（major 41.0/41.8）保持计数
    expect(gate.passed).toBe(false);
  });

  it("claimGapAudit 语境（existing-paper 返修）不被 pairing 改写：revisionIntroduced 照旧计违规", () => {
    const report = claimGroundingReport([{ claimId: "c-1", verdict: "UNSUPPORTED", disclosure: "opaque_assertion" }]);
    const pairing = deriveEvidencePairing(pairingInput({ claimGrounding: report, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }));
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0 } }),
      evidencePairing: pairing,
      claimGapAudit: {
        schemaVersion: 1 as const,
        reportId: "cga-r1",
        projectId: "p",
        round: 1,
        generatedAt: "t",
        taskKind: "existing_paper_improvement" as const,
        baselineRevision: 0,
        claims: [],
        issueAttribution: [],
        counts: { unsupportedTotal: 3, revisionIntroduced: 1, excludedPreExisting: 2, excludedAuthorData: 0, greyZone: 0, issues: { critical: 0, major: 0, blocking: 0, excludedBlocking: 0, excludedCritical: 0, excludedMajor: 0 } },
      },
    }), THRESHOLDS);
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")!;
    expect(rule4.status).toBe("FAIL");
    expect(rule4.detail).toContain("修订引入");
  });

  it("未提供 evidencePairing（纯单元输入 / 旧产物）→ 规则 4/5/6 按旧口径（兼容）", () => {
    const gate = evaluateQualityGate(baseGateInput({
      review: reviewSummary({ factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 3, CONTRADICTED: 0 }, unsupportedCriticalClaims: 3 }),
    }), THRESHOLDS);
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")!;
    expect(rule4.status).toBe("FAIL");
    expect(rule4.detail).toContain("UNSUPPORTED/CONTRADICTED claim 3 条");
  });
});

describe("M15.6 Gate 跨节规则（cross_section_numeric_consistency）", () => {
  it("verifiedContradictions > 0 → FAIL（required，CE1 型检出阻断）", () => {
    const gate = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({ verifiedContradictions: 2, consistent: 1, notEvaluated: 3 }) }), THRESHOLDS);
    const rule = gate.rules.find((r) => r.rule === "cross_section_numeric_consistency")!;
    expect(rule.status).toBe("FAIL");
    expect(rule.required).toBe(true);
    expect(rule.passed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it("suspected（author 稿件）→ NOT_EVALUATED required=true（转作者裁决，不得 READY）", () => {
    const gate = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({ suspected: 1, consistent: 1 }) }), THRESHOLDS);
    const rule = gate.rules.find((r) => r.rule === "cross_section_numeric_consistency")!;
    expect(rule.status).toBe("NOT_EVALUATED");
    expect(rule.required).toBe(true);
    expect(rule.passed).toBe(false);
  });

  it("suspected（published 只读）→ NOT_EVALUATED 非 required（如实报告，不硬判）", () => {
    const gate = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({ suspected: 1, consistent: 1 }), reviewPurpose: "published_paper_assessment" }), THRESHOLDS);
    const rule = gate.rules.find((r) => r.rule === "cross_section_numeric_consistency")!;
    expect(rule.status).toBe("NOT_EVALUATED");
    expect(rule.required).toBe(false);
    expect(rule.passed).toBe(true);
  });

  it("全部一致（无未核验）→ PASS；部分核验 → NOT_EVALUATED 非 required（不签发「已核验一致」）", () => {
    const pass = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({ consistent: 3 }) }), THRESHOLDS);
    expect(pass.rules.find((r) => r.rule === "cross_section_numeric_consistency")!.status).toBe("PASS");
    const partial = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({ consistent: 2, notEvaluated: 4 }) }), THRESHOLDS);
    const partialRule = partial.rules.find((r) => r.rule === "cross_section_numeric_consistency")!;
    expect(partialRule.status).toBe("NOT_EVALUATED");
    expect(partialRule.required).toBe(false);
    expect(partialRule.passed).toBe(true);
  });

  it("UNAVAILABLE → NOT_EVALUATED（快照缺失 / 无表格如实呈现，不代表一致）", () => {
    const gate = evaluateQualityGate(baseGateInput({ crossSectionConsistency: crossSectionSummary({}, "UNAVAILABLE") }), THRESHOLDS);
    const rule = gate.rules.find((r) => r.rule === "cross_section_numeric_consistency")!;
    expect(rule.status).toBe("NOT_EVALUATED");
    expect(rule.detail).toContain("未能执行");
  });
});
