/**
 * M13 Final Closure（A1）集成：拒绝 partial 命题的 claim 在 grounding → resolution → 授权链
 * 上的端到端确定性行为（复现 M13.7.11 §5.4 的真实阻断并验证修复不放宽其它口径）。
 */

import { describe, expect, it } from "vitest";

import type { FactClaimCheck } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import { computeClaimGroundingReport, isUnsupportedVerdict } from "../../src/review/claimGrounding.js";
import { classifyClaimResolution, computeClaimResolutions } from "../../src/review/claimResolution.js";
import { deriveClaimGroundingWeakeningAuthorizations } from "../../src/review/weakeningAuthorization.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";

function evidence(input: Partial<EvidenceRecord> & { id: string; claim: string }): EvidenceRecord {
  return {
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    source: { sourceId: `S-${input.id}`, title: `Paper ${input.id}`, year: 2024 },
    location: { chunk: `${input.id}:ABS:0001:deadbeef00` },
    createdBy: "test",
    createdAt: "2026-10-13T00:00:00Z",
    ...input,
  } as EvidenceRecord;
}

const POOL: EvidenceRecord[] = [
  evidence({
    id: "E006",
    claim: "This logical memory is also beyond break-even, exceeding its best physical qubit's lifetime by a factor of 2.4 ± 0.3.",
    quote: "exceeding its best physical qubit's lifetime by a factor of 2.4 $\\pm$ 0.3",
  }),
  evidence({
    id: "E008",
    claim: "实时纠错实验展示完全稳定且经纠错的逻辑量子比特，相干增益 G = 2.27 ± 0.07。",
    quote: "coherence gain of G = 2.27 ± 0.07",
  }),
  evidence({
    id: "E012",
    supportStrength: "partial",
    claim: "相干增益 G = 2.27 与表面码的 2.4 倍寿命提升是同一指标，可直接比较两条路线的纠错效果。",
    quote: "Whether it is practically possible to utilize QEC for extending quantum coherence thus remains an open question.",
  }),
];

const SECTION = "sections/route-comparison.tex";
const REFUTATION = "相干增益 G=2.27 与表面码 2.4 倍寿命超越并非同一指标，不可据此判定两条路线优劣。";

function report(claims: FactClaimCheck[]) {
  return computeClaimGroundingReport({ projectId: "p-test", round: 2, factClaims: claims, formalEvidence: POOL, bibEntries: [] });
}

describe("claimGrounding × 拒绝 partial 命题（真实阻断样本的修复）", () => {
  it("reviewer SUPPORTED + 绑 partial E012 的拒绝句 → PARTIALLY_SUPPORTED（不再 UNSUPPORTED / opaque）", () => {
    const result = report([{ section: SECTION, claim: REFUTATION, verdict: "SUPPORTED", evidenceId: "E012" }]);
    const entry = result.claims[0]!;
    expect(entry.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(entry.reviewerVerdict).toBe("SUPPORTED");
    expect(entry.stance).toBe("refutation");
    expect(entry.numbersAnchored).toBe(true);
    expect(entry.supportBoundary).toContain("Refutation of a partial proposition");
    expect(result.unsupportedClaims).toBe(0);
    expect(result.opaqueUnsupportedClaims).toBe(0);
    expect(result.evidenceBoundClaims).toBe(1);
  });

  it("修复后 Quality Gate 规则 unsupported_critical_claims_zero 不再因该句阻断", () => {
    const grounding = report([{ section: SECTION, claim: REFUTATION, verdict: "SUPPORTED", evidenceId: "E012" }]);
    const gate = evaluateQualityGate({
      review: {
        generatedAt: "2026-10-13T00:00:00Z",
        round: 2,
        issues: [],
        counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
        scores: { academicScore: 85, styleRisk: 20, factVerdicts: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 1, UNSUPPORTED: 0, CONTRADICTED: 0 } },
        openCritical: 0,
        openMajor: 0,
        // 旧口径（reviewer 原判）下也为 0；本测试锁定的是 claimGrounding 口径的 opaque 计数
        unsupportedCriticalClaims: 0,
        reportPaths: [],
      },
      citation: null,
      evidence: { total: 3, byStatus: { unverified: 0, verified: 3, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 },
      feasibility: null,
      claimGrounding: grounding,
    });
    const rule = gate.rules.find((item) => item.rule === "unsupported_critical_claims_zero");
    expect(rule?.passed).toBe(true);
    // 对照：旧行为（该句被改判 opaque UNSUPPORTED）会使同一规则失败
    const blocked = evaluateQualityGate({
      review: {
        generatedAt: "2026-10-13T00:00:00Z",
        round: 2,
        issues: [],
        counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
        scores: { academicScore: 85, styleRisk: 20, factVerdicts: null },
        openCritical: 0,
        openMajor: 0,
        unsupportedCriticalClaims: 0,
        reportPaths: [],
      },
      citation: null,
      evidence: { total: 3, byStatus: { unverified: 0, verified: 3, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 },
      feasibility: null,
      claimGrounding: { ...grounding, opaqueUnsupportedClaims: 1, unsupportedClaims: 1 },
    });
    expect(blocked.rules.find((item) => item.rule === "unsupported_critical_claims_zero")?.passed).toBe(false);
  });

  it("对抗 1：拒绝句夹带池外数值（3.1 倍）→ 仍 UNSUPPORTED（真正缺证据的数值不得伪装成 refutation）", () => {
    const result = report([
      {
        section: SECTION,
        claim: "表面码 3.1 倍寿命提升与 G=2.27 并非同一指标，不可据此判定优劣",
        verdict: "SUPPORTED",
        evidenceId: "E012",
      },
    ]);
    expect(result.claims[0]!.verdict).toBe("UNSUPPORTED");
    expect(result.opaqueUnsupportedClaims).toBe(1);
  });

  it("对抗 2：否定形态的事实断言绑 partial → 仍 UNSUPPORTED（否定词 ≠ 拒绝命题）", () => {
    const result = report([
      { section: SECTION, claim: "相干增益 G=2.27 的逻辑比特并未超越盈亏平衡", verdict: "SUPPORTED", evidenceId: "E012" },
    ]);
    expect(result.claims[0]!.verdict).toBe("UNSUPPORTED");
    expect(result.claims[0]!.stance).toBeUndefined();
  });

  it("对抗 3：正面可比性主张（与 E012 同向）绑 partial → 仍 UNSUPPORTED", () => {
    const result = report([
      {
        section: SECTION,
        claim: "相干增益 G=2.27 与 2.4 倍寿命提升是同一指标，可直接比较两条路线的纠错效果",
        verdict: "SUPPORTED",
        evidenceId: "E012",
      },
    ]);
    expect(result.claims[0]!.verdict).toBe("UNSUPPORTED");
  });

  it("对抗 4：reviewer 本身判 UNSUPPORTED 的拒绝句 → 不升级，但记录立场与锚定供阶梯消费", () => {
    const result = report([{ section: SECTION, claim: REFUTATION, verdict: "UNSUPPORTED", evidenceId: "E012" }]);
    const entry = result.claims[0]!;
    expect(entry.verdict).toBe("UNSUPPORTED");
    expect(entry.stance).toBe("refutation");
    expect(entry.numbersAnchored).toBe(true);
  });

  it("绑 direct 记录（r1 绑 E006）行为不变：SUPPORTED 保持", () => {
    const result = report([{ section: SECTION, claim: REFUTATION, verdict: "SUPPORTED", evidenceId: "E006" }]);
    expect(result.claims[0]!.verdict).toBe("SUPPORTED");
    expect(result.claims[0]!.stance).toBeUndefined();
  });

  it("原有 M11.3 口径不放宽：含数字的正面断言绑 partial 仍 UNSUPPORTED；无数字拒绝句绑 partial 仍 PARTIALLY", () => {
    const result = report([
      { section: SECTION, claim: "表面码寿命超越最佳物理比特 2.4 倍", verdict: "SUPPORTED", evidenceId: "E012" },
      { section: SECTION, claim: "两条路线的指标口径不同，不支持整体性能排序", verdict: "SUPPORTED", evidenceId: "E012" },
    ]);
    expect(result.claims[0]!.verdict).toBe("UNSUPPORTED");
    expect(result.claims[1]!.verdict).toBe("PARTIALLY_SUPPORTED");
  });
});

describe("claimResolution × 拒绝立场（阶梯 4c）", () => {
  const context = { sources: [], formalEvidence: POOL };

  it("UNSUPPORTED 拒绝句（数值全部锚定）→ author_decision_required，不再 remove_unsupported_detail", () => {
    const grounding = report([{ section: SECTION, claim: REFUTATION, verdict: "UNSUPPORTED", evidenceId: "E012" }]);
    const resolution = classifyClaimResolution(grounding.claims[0]!, context);
    expect(resolution.action).toBe("author_decision_required");
    expect(resolution.basis).toBe("refutation_numbers_anchored");
  });

  it("UNSUPPORTED 拒绝句但数值无锚定 → 照常 remove_unsupported_detail（numeric_no_grounding）", () => {
    const grounding = report([
      { section: SECTION, claim: "表面码 3.1 倍寿命提升与 G=2.27 并非同一指标，不可据此判定优劣", verdict: "UNSUPPORTED" },
    ]);
    const resolution = classifyClaimResolution(grounding.claims[0]!, context);
    expect(resolution.action).toBe("remove_unsupported_detail");
    expect(resolution.basis).toBe("numeric_no_grounding");
  });

  it("UNSUPPORTED 否定形态事实断言（含数字、数字锚定、无候选）→ 照常 remove_unsupported_detail，不进作者裁决", () => {
    const grounding = report([
      { section: SECTION, claim: "相干增益 G=2.27 的逻辑比特并未超越盈亏平衡", verdict: "UNSUPPORTED" },
    ]);
    // 该句的 2.27 词面命中 E008 → 阶梯 1（use_existing_evidence，原有行为）；
    // 去掉候选后应落到数值阶梯而不是 4c（立场 = assertion）
    const entry = { ...grounding.claims[0]!, repairCandidates: [] };
    const resolution = classifyClaimResolution(entry, context);
    expect(resolution.action).toBe("remove_unsupported_detail");
    expect(classifyClaimResolution(grounding.claims[0]!, context).action).toBe("use_existing_evidence");
  });

  it("context 未提供 formalEvidence 且 entry 无锚定信息 → 保守回落数值阶梯", () => {
    const entry = {
      claimId: "c-x",
      section: SECTION,
      claim: REFUTATION,
      verdict: "UNSUPPORTED" as const,
      evidenceFormal: false,
      repairCandidates: [],
      disclosure: "opaque_assertion" as const,
    };
    expect(classifyClaimResolution(entry, { sources: [] }).action).toBe("remove_unsupported_detail");
  });

  it("批量：author_decision_required 计数正确且不派发 Writer", () => {
    const grounding = report([
      { section: SECTION, claim: REFUTATION, verdict: "UNSUPPORTED", evidenceId: "E012" },
      { section: SECTION, claim: "表面码 3.1 倍寿命提升是最佳结果", verdict: "UNSUPPORTED" },
    ]);
    const resolutions = computeClaimResolutions(
      grounding.claims.filter((entry) => isUnsupportedVerdict(entry.verdict)),
      context,
      { projectId: "p-test", round: 2 },
    );
    expect(resolutions.counts.author_decision_required).toBe(1);
    expect(resolutions.counts.remove_unsupported_detail).toBe(1);
  });
});

describe("weakeningAuthorization × 拒绝立场", () => {
  it("数值全部锚定的 UNSUPPORTED 拒绝句：只铸 weaken 授权，不铸「只许删除数值」授权", () => {
    const grounding = report([{ section: SECTION, claim: REFUTATION, verdict: "UNSUPPORTED", evidenceId: "E012" }]);
    const authorizations = deriveClaimGroundingWeakeningAuthorizations(grounding);
    expect(authorizations.map((entry) => entry.kind)).toEqual(["weaken_claim_strength"]);
  });

  it("无锚定数值的 UNSUPPORTED 断言仍铸 remove_unsupported_detail（原口径）", () => {
    const grounding = report([{ section: SECTION, claim: "表面码 3.1 倍寿命提升是最佳结果", verdict: "UNSUPPORTED" }]);
    const kinds = deriveClaimGroundingWeakeningAuthorizations(grounding).map((entry) => entry.kind);
    expect(kinds).toContain("remove_unsupported_detail");
  });
});
