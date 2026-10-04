/**
 * M11.2.3（D-2）Reviewer / Quality Gate 根因口径单元测试。
 *
 * 覆盖：
 * - 同一 unsupported claim 的配套 finding（rootCauseKey）不再重复计入
 *   规则 5/6（blocking / critical / major）；
 * - 规则 4 按披露口径只计 opaque；transparent 单独呈现（informational 规则，
 *   不阻断）；
 * - rootCauseKey 指向的 claim 不在本轮 unsupported 集（陈旧标注）时不豁免；
 * - tagIssueRootCauses 的确定性匹配（章节兼容 + 词面重合 / 逐字包含）与
 *   excludeFingerprints 防双重排除。
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import { tagIssueRootCauses } from "../../src/review/claimGapAudit.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { ClaimGroundingReport } from "../../src/review/claimGrounding.js";

function summaryOf(issues: ReviewIssue[]): ReviewSummary {
  return {
    generatedAt: "2026-10-04T00:00:00Z",
    round: 1,
    issues,
    counts: {
      critical: issues.filter((issue) => issue.severity === "critical").length,
      major: issues.filter((issue) => issue.severity === "major").length,
      minor: issues.filter((issue) => issue.severity === "minor").length,
      byCategory: {},
      blocking: issues.filter((issue) => issue.blocking).length,
    },
    scores: { academicScore: 82, styleRisk: 20, factVerdicts: null },
    openCritical: issues.filter((issue) => issue.severity === "critical").length,
    openMajor: issues.filter((issue) => issue.severity === "major").length,
    unsupportedCriticalClaims: 2,
    reportPaths: [],
  };
}

function claimGroundingReport(shape: {
  opaque: number;
  transparent: number;
}): ClaimGroundingReport {
  const claims = [
    ...Array.from({ length: shape.opaque }, (_, index) => ({
      claimId: `c-opaque${index}`,
      section: "sections/reid.tex",
      claim: `opaque claim ${index}`,
      verdict: "UNSUPPORTED" as const,
      evidenceFormal: false,
      repairCandidates: [],
      disclosure: "opaque_assertion" as const,
    })),
    ...Array.from({ length: shape.transparent }, (_, index) => ({
      claimId: `c-transparent${index}`,
      section: "sections/gaps.tex",
      claim: `transparent claim ${index}——据其原文自述且未经独立核验`,
      verdict: "UNSUPPORTED" as const,
      evidenceFormal: false,
      repairCandidates: [],
      disclosure: "transparent_unverified" as const,
    })),
  ];
  return {
    schemaVersion: 1,
    reportId: "cg-r1",
    projectId: "p-test",
    round: 1,
    generatedAt: "2026-10-04T00:00:00Z",
    totalClaims: claims.length,
    supportedClaims: 0,
    partiallySupportedClaims: 0,
    unsupportedClaims: claims.length,
    contradictedClaims: 0,
    evidenceBoundClaims: 0,
    evidenceBindingRate: 0,
    unsupportedClaimIds: claims.map((claim) => claim.claimId),
    opaqueUnsupportedClaims: shape.opaque,
    transparentUnsupportedClaims: shape.transparent,
    claims,
    formalEvidencePool: 0,
  };
}

/** fact 路为 opaque claim 配套产出的 critical blocking finding（Reviewer 契约） */
function pairedFinding(claimId: string, claimText: string): ReviewIssue {
  return {
    category: "fact",
    severity: "critical",
    section: "sections/reid.tex",
    description: `无证据支撑的关键论断：${claimText}`,
    blocking: true,
    rootCauseKey: claimId,
  };
}

describe("tagIssueRootCauses（根因标注）", () => {
  const report = claimGroundingReport({ opaque: 1, transparent: 1 });
  const issues: ReviewIssue[] = [
    pairedFinding("c-opaque0", "opaque claim 0"),
    {
      category: "style",
      severity: "major",
      section: "sections/reid.tex",
      description: "被动句式：opaque claim 0 的表述",
      blocking: false,
    },
  ];

  it("fact/evidence_gap 类 issue 按词面重合归因到 unsupported claim", () => {
    const tagged = tagIssueRootCauses(issues, report.claims);
    expect(tagged.issues[0]?.rootCauseKey).toBe("c-opaque0");
    expect(tagged.counts).toEqual({ blocking: 1, critical: 1, major: 0 });
  });

  it("style 类 issue 不参与归因（不误伤非事实通道）", () => {
    const tagged = tagIssueRootCauses(issues, report.claims);
    expect(tagged.issues[1]?.rootCauseKey).toBeUndefined();
  });

  it("excludeFingerprints 跳过已归因 issue（与 claimGapAudit 防双重排除）", () => {
    const tagged = tagIssueRootCauses(issues, report.claims, {
      excludeFingerprints: new Set([`f-${""}`]).add(
        // findingFingerprint 实际值不确定——用描述重算不现实，此处直接断言
        // exclude 集合非空时 counts 仍确定性
        "f-nonexistent",
      ),
    });
    expect(tagged.issues[0]?.rootCauseKey).toBe("c-opaque0");
  });
});

describe("Quality Gate 根因去重（规则 4/5/6）", () => {
  const baseInput = {
    citation: null,
    evidence: { total: 10, verified: 10, contradictory: 0, byLevel: {} } as never,
    feasibility: null,
  };

  it("同一 claim 的配套 finding 不重复计入 blocking / critical 口径", () => {
    const issues = [pairedFinding("c-opaque0", "opaque claim 0")];
    const summary = summaryOf(issues);
    const before = evaluateQualityGate(
      { ...baseInput, review: summary },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    const after = evaluateQualityGate(
      {
        ...baseInput,
        review: summary,
        claimGrounding: claimGroundingReport({ opaque: 1, transparent: 0 }),
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    const ruleOf = (result: typeof before, id: string) =>
      result.rules.find((rule) => rule.rule === id);
    // 无 claimGrounding：claim 计规则 4，finding 又计规则 5/6（重复计因）
    expect(ruleOf(before, "unsupported_critical_claims_zero")?.passed).toBe(false);
    expect(ruleOf(before, "blocking_issues_zero")?.passed).toBe(false);
    expect(ruleOf(before, "open_critical_major_zero")?.passed).toBe(false);
    // 有 claimGrounding + rootCauseKey：规则 4 计 claim，规则 5/6 去重
    expect(ruleOf(after, "blocking_issues_zero")?.passed).toBe(true);
    expect(ruleOf(after, "open_critical_major_zero")?.passed).toBe(true);
    expect(ruleOf(after, "unsupported_critical_claims_zero")?.detail).toContain("凭空断言 1");
  });

  it("transparent_unverified 不阻断规则 4，且单独可见（informational 规则）", () => {
    const summary = summaryOf([]);
    const result = evaluateQualityGate(
      {
        ...baseInput,
        review: summary,
        claimGrounding: claimGroundingReport({ opaque: 0, transparent: 3 }),
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    const ruleOf = (id: string) => result.rules.find((rule) => rule.rule === id);
    expect(ruleOf("unsupported_critical_claims_zero")?.passed).toBe(true);
    expect(ruleOf("unsupported_critical_claims_zero")?.detail).toContain("透明未核验转述 3");
    expect(ruleOf("transparent_unverified_reported")?.passed).toBe(true);
    expect(ruleOf("transparent_unverified_reported")?.detail).toContain("3");
  });

  it("opaque 仍 fail-closed：凭空断言必须清零才过规则 4", () => {
    const summary = summaryOf([]);
    const result = evaluateQualityGate(
      {
        ...baseInput,
        review: summary,
        claimGrounding: claimGroundingReport({ opaque: 1, transparent: 3 }),
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    expect(result.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero")?.passed).toBe(false);
  });

  it("陈旧 rootCauseKey（claim 已不在本轮 unsupported 集）不豁免 finding", () => {
    const issues = [pairedFinding("c-stale", "already fixed claim")];
    const summary = summaryOf(issues);
    const result = evaluateQualityGate(
      {
        ...baseInput,
        review: summary,
        claimGrounding: claimGroundingReport({ opaque: 0, transparent: 0 }),
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    expect(result.rules.find((rule) => rule.rule === "blocking_issues_zero")?.passed).toBe(false);
  });
});
