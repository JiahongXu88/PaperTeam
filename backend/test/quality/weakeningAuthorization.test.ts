/**
 * Typed Authorized Weakening（M11.2.1）单元测试。
 *
 * 对应验收清单（任务 §11 十二场景）：
 *   1 合法弱化（hedging 重排触发方向哨兵）+ 授权 → PASS
 *   2 授权 remove_unsupported_detail 删数值 → PASS
 *   3 数值替换（5.2 → 8.7）即使有弱化授权 → FAIL
 *   4 方向反转（提高 → 下降）→ FAIL
 *   5 断言升级（可能 → 已经证明）→ FAIL
 *   6 授权 A 顺便删 B fact → FAIL
 *   7 R1 合法弱化 R2 保持 → PASS
 *   8 R1 合法弱化 R2 偷改数值 → FAIL
 *   9 作者实验事实删除（无高级授权）→ FAIL
 *  10 表格数值（普通弱化授权不覆盖）→ FAIL
 *  11 Citation Preservation 不因弱化授权绕过
 *  12 弱化授权点名的数值不可反向重加（洗白封堵）+ cumulative 污染仍捕获
 * 另含：派生规则（plan / claim grounding）、条目生命周期授权修复、
 * 台账 append-only 幂等与 improvement 通道隔离。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateFactPreservation,
  type FactSnapshot,
} from "../../src/quality/factPreservation.js";
import type { FactPreservationSummary } from "../../src/quality/factPreservation.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import {
  appendWeakeningAuthorizations,
  readWeakeningAuthorizations,
} from "../../src/quality/cumulativeFactPreservation.js";
import {
  deriveClaimGroundingWeakeningAuthorizations,
  derivePlanWeakeningAuthorizations,
  type WeakeningAuthorizationInput,
} from "../../src/review/weakeningAuthorization.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { RevisionPlan, RevisionPlanItem } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ClaimGroundingReport } from "../../src/review/claimGrounding.js";
import type { CitationPreservationSummary } from "../../src/quality/citationPreservation.js";
import { evaluateRevisionValidation } from "../../src/review/revisionValidation.js";

// ---- 工厂 ----

function snapshot(revision: number, files: Record<string, string>): FactSnapshot {
  return {
    revision,
    files: Object.entries(files).map(([file, content]) => ({ file, content })),
  };
}

function weakening(
  overrides: Partial<WeakeningAuthorizationInput> & { section?: string },
): WeakeningAuthorizationInput {
  return {
    kind: "weaken_claim_strength",
    section: overrides.section ?? "sections/experiments.tex",
    targetSpan: "该论断无已核验证据支撑，弱化为归因式表述",
    itemId: "item-w",
    ...overrides,
  };
}

function evaluate(
  previousFiles: Record<string, string>,
  currentFiles: Record<string, string>,
  weakeningAuthorizations: WeakeningAuthorizationInput[] = [],
  plan: RevisionPlan | null = null,
): FactPreservationSummary {
  return evaluateFactPreservation({
    previous: snapshot(1, previousFiles),
    current: snapshot(2, currentFiles),
    plan,
    weakeningAuthorizations,
  });
}

const emptySummary: ReviewSummary = {
  generatedAt: "2026-10-03T00:00:00Z",
  round: 1,
  reviewedRevision: 1,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 88, styleRisk: 20, factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

function planWithItems(items: Partial<RevisionPlanItem>[], sourceRevision = 1): RevisionPlan {
  return {
    schemaVersion: 1,
    planId: `plan-r1-rev${sourceRevision}`,
    projectId: "p-test",
    sourceRevision,
    reviewRound: 1,
    createdAt: "2026-10-03T00:00:00Z",
    summary: { critical: 0, major: 0, blocking: 0, minorRecorded: 0, planned: items.length, skipped: 0 },
    items: items.map(
      (item, index): RevisionPlanItem => ({
        id: item.id ?? `item-${index}`,
        kind: item.kind ?? "review_finding",
        priority: item.priority ?? "high",
        section: item.section ?? "sections/experiments.tex",
        problem: item.problem ?? "",
        instruction: item.instruction ?? "",
        expectedOutcome: item.expectedOutcome ?? "",
        status: item.status ?? "planned",
        ...(item.needsEvidence !== undefined ? { needsEvidence: item.needsEvidence } : {}),
      }),
    ),
  };
}

function claimGroundingReport(claims: Array<{ section: string; claim: string; verdict: "SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED" }>): ClaimGroundingReport {
  return {
    schemaVersion: 1,
    reportId: "cg-r1",
    projectId: "p-test",
    round: 1,
    generatedAt: "2026-10-03T00:00:00Z",
    totalClaims: claims.length,
    supportedClaims: claims.filter((claim) => claim.verdict === "SUPPORTED").length,
    partiallySupportedClaims: 0,
    unsupportedClaims: claims.filter((claim) => claim.verdict === "UNSUPPORTED").length,
    contradictedClaims: claims.filter((claim) => claim.verdict === "CONTRADICTED").length,
    evidenceBoundClaims: 0,
    evidenceBindingRate: 0,
    unsupportedClaimIds: [],
    opaqueUnsupportedClaims: claims.filter((claim) => claim.verdict !== "SUPPORTED").length,
    transparentUnsupportedClaims: 0,
    claims: claims.map((claim, index) => ({
      claimId: `c-test${index}`,
      section: claim.section,
      claim: claim.claim,
      verdict: claim.verdict,
      evidenceFormal: false,
      repairCandidates: [],
    })),
    formalEvidencePool: 0,
  };
}

// ---- 1. 合法弱化：PASS ----

describe("Typed Authorized Weakening：合法弱化", () => {
  it("场景1：hedging 重排触发 metric_direction_flip 假阳性 + weaken 授权 → PASS（allowedWeakenings 审计）", () => {
    // previous 一句话：HOTA 提升 / 速度下降（方向词 = 末词「下降」→ 与 metric HOTA 配对为负）
    const previous = [
      "\\section{消融分析}",
      "消融显示加入外观使 HOTA 提升（+0.8），而速度下降。",
    ].join("\n");
    // current 拆句 + 加「据其原文」：HOTA 的句子方向词变「提升」→ 检测器判 flip；
    // 但文件级方向词计数不变、数值不变、无强表述新增 = 只有断言强度变化
    const current = [
      "\\section{消融分析}",
      "据其原文，加入外观使 HOTA 提升（+0.8）。",
      "速度下降。",
    ].join("\n");
    const noAuth = evaluate({ "sections/experiments.tex": previous }, { "sections/experiments.tex": current });
    expect(noAuth.ok).toBe(false);
    expect(noAuth.directionalChanges).toHaveLength(1);

    const withAuth = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    expect(withAuth.ok).toBe(true);
    expect(withAuth.directionalChanges).toHaveLength(0);
    expect(withAuth.allowedWeakenings).toBe(1);
    expect(withAuth.weakeningAuthorizationCount).toBe(1);
  });

  it("场景1（计划链）：needsEvidence 条目派生 weaken 授权同样放行（guard 侧匹配轮次计划派生）", () => {
    const previous = "消融显示加入外观使 HOTA 提升（+0.8），而速度下降。";
    const current = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。";
    const plan = planWithItems([
      {
        id: "f-abc",
        kind: "review_finding",
        section: "sections/experiments.tex",
        problem: "该消融论断无已核验证据支撑",
        instruction: "据其原文弱化为归因式表述",
        needsEvidence: true,
        status: "applied",
      },
    ]);
    const derived = derivePlanWeakeningAuthorizations(plan);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ kind: "weaken_claim_strength", findingId: "f-abc", round: 1 });
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      derived,
    );
    expect(summary.ok).toBe(true);
    expect(summary.allowedWeakenings).toBe(1);
  });

  it("场景7：R1 合法弱化后 R2 保持弱化（只改无关措辞）→ PASS", () => {
    const rev1 = "消融显示加入外观使 HOTA 提升（+0.8），而速度下降。";
    const rev2 = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。";
    const rev3 = "据其原文，加入外观使 HOTA 提升（+0.8）。\n推理速度下降。";
    const round1 = evaluate({ "sections/experiments.tex": rev1 }, { "sections/experiments.tex": rev2 }, [weakening({})]);
    expect(round1.ok).toBe(true);
    const round2 = evaluate({ "sections/experiments.tex": rev2 }, { "sections/experiments.tex": rev3 }, [weakening({})]);
    expect(round2.ok).toBe(true);
    expect(round2.directionalChanges).toHaveLength(0);
  });
});

// ---- 2. 授权删除：PASS ----

describe("Typed Authorized Weakening：remove_unsupported_detail", () => {
  it("场景2：「提高 5.2%」→ 删除 5.2%（授权点名该值）→ PASS", () => {
    const previous = "该方法在 MOT17 上的召回有所提高 5.2\\%。";
    const current = "该方法在 MOT17 上的召回有所提高。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [
        weakening({ kind: "remove_unsupported_detail", targetSpan: "「提高 5.2%」无证据支撑，删去具体数值 5.2，改为定性表述" }),
      ],
    );
    expect(summary.ok).toBe(true);
    expect(summary.removedFacts).toHaveLength(0);
    expect(summary.allowedRemovals).toBe(1);
  });

  it("场景2（claim grounding 链）：UNSUPPORTED claim 含数值 → 派生 remove 授权并放行删除", () => {
    const report = claimGroundingReport([
      { section: "sections/experiments.tex", claim: "该方法在 MOT17 上的召回提高 5.2%", verdict: "UNSUPPORTED" },
    ]);
    const derived = deriveClaimGroundingWeakeningAuthorizations(report);
    expect(derived).toHaveLength(2);
    expect(derived.map((entry) => entry.kind).sort()).toEqual(["remove_unsupported_detail", "weaken_claim_strength"]);
    const previous = "该方法在 MOT17 上的召回提高 5.2\\%。";
    const current = "该方法在 MOT17 上的召回提高。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      derived,
    );
    expect(summary.ok).toBe(true);
  });
});

// ---- 3-6. 授权绝不放行的变化 ----

describe("Typed Authorized Weakening：授权范围的硬边界", () => {
  const bothKinds: WeakeningAuthorizationInput[] = [
    weakening({ targetSpan: "该论断含 5.2 与 8.7 相关表述，弱化或删除" }),
    weakening({ kind: "remove_unsupported_detail", targetSpan: "删去无证据数值 5.2 或 8.7" }),
  ];

  it("场景3：「提高 5.2%」→「提高 8.7%」（数值替换）→ FAIL（授权删除 5.2 不等于授权新增 8.7）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": "该方法的召回提高 5.2\\%。" },
      { "sections/experiments.tex": "该方法的召回提高 8.7\\%。" },
      bothKinds,
    );
    expect(summary.ok).toBe(false);
    // 5.2 的删除被 remove 授权放行（审计计数），但 8.7 是无依据新增 → 违规
    expect(summary.allowedRemovals).toBe(1);
    expect(summary.addedUnsupportedFacts).toHaveLength(1);
    expect(summary.addedUnsupportedFacts[0]?.after).toContain("8.7");
  });

  it("场景4：方向反转（提升 → 下降）→ FAIL（弱化核验拒绝新增方向词）", () => {
    const previous = "该方法的召回提升。";
    const current = "该方法的召回下降。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    expect(summary.ok).toBe(false);
    expect(summary.directionalChanges.some((finding) => finding.reason === "metric_direction_flip")).toBe(true);
  });

  it("场景5a：纯断言升级（可能 → 已经证明）→ Revision Validation 层 block（claim_strength 通道裁决）", () => {
    // 事实守卫对无方向 finding 的纯措辞升级不重复裁决（M6.7 语义）；
    // 系统级 FAIL 由 claimStrength 升级检测保证：强表述 + 证据不足 → block
    const previous = "据报道该机制可能改善泛化性能。";
    const current = "该机制已经证明显著改善泛化性能。";
    const fact = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    expect(fact.ok).toBe(true);
    const validation = evaluateRevisionValidation({
      projectId: "p-test",
      reviewRound: 1,
      sourceRevision: 1,
      revision: 2,
      plan: null,
      previousFiles: [{ file: "sections/experiments.tex", content: previous }],
      currentFiles: [{ file: "sections/experiments.tex", content: current }],
      factPreservation: fact,
      citationPreservation: null,
      evidenceRecords: [],
    });
    expect(validation.claimStrength.length).toBeGreaterThan(0);
    expect(validation.claimStrength.some((finding) => finding.action === "block")).toBe(true);
  });

  it("场景5b：弱化重排（方向 finding）夹带断言升级 → FAIL（epistemic_strengthening 显式呈现 + 弱化覆盖被拒）", () => {
    const previous = "消融显示加入外观使 HOTA 提升（+0.8），而速度下降，据报道可能改善。";
    const current = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。\n该机制已经证明显著改善。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    expect(summary.ok).toBe(false);
    expect(summary.directionalChanges.some((finding) => finding.reason === "epistemic_strengthening")).toBe(true);
    // 类别核验拒绝（强表述新增）→ 方向 finding 不被弱化授权放行
    expect(summary.allowedWeakenings).toBe(0);
  });

  it("场景6：授权 claim A，Writer 顺便删 fact B → FAIL", () => {
    const previous = "方法A 的召回提高 5.2\\%。\n方法B 的 IDF1 下降 3.1\\%。";
    const current = "方法A 的召回提高 5.2\\%。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({ targetSpan: "方法A 的论断弱化" })],
    );
    expect(summary.ok).toBe(false);
    expect(summary.removedFacts).toHaveLength(1);
    expect(summary.removedFacts[0]?.classification?.oldValue).toContain("3.1");
  });

  it("场景8：R1 合法弱化、R2 偷改数值 → FAIL", () => {
    const rev1 = "消融显示加入外观使 HOTA 提升（+0.8），而速度下降。";
    const rev2 = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。";
    const rev3 = "据其原文，加入外观使 HOTA 提升（+9.9）。\n速度下降。";
    const round1 = evaluate({ "sections/experiments.tex": rev1 }, { "sections/experiments.tex": rev2 }, [weakening({})]);
    expect(round1.ok).toBe(true);
    const round2 = evaluate(
      { "sections/experiments.tex": rev2 },
      { "sections/experiments.tex": rev3 },
      [weakening({})],
    );
    expect(round2.ok).toBe(false);
    expect(round2.changedFacts).toHaveLength(1);
  });

  it("场景9：作者实验事实（数值）删除，仅有 weaken 授权 → FAIL（weakening 永不覆盖数值删除）", () => {
    const previous = "本文方法在低照度场景 IDS 为 35（基线 24），部署实测持续 18 min。";
    const current = "本文方法在低照度场景出现额外身份切换，部署实测持续 18 min。";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({ targetSpan: "低照度论断弱化为定性表述" })],
    );
    expect(summary.ok).toBe(false);
    expect(summary.removedFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("场景10：表格数值修改（45 → 44）普通弱化授权不覆盖 → FAIL", () => {
    const table = (value: string): string =>
      [
        "\\section{实验}",
        "\\begin{table}",
        "\\caption{对比}",
        "\\label{tab:cmp}",
        "\\begin{tabular}{lc}",
        "场景 & IDS \\\\",
        `低照度 & ${value} \\\\`,
        "\\end{tabular}",
        "\\end{table}",
      ].join("\n");
    const summary = evaluate(
      { "sections/experiments.tex": table("45") },
      { "sections/experiments.tex": table("44") },
      [weakening({})],
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.reason === "table_cell")).toBe(true);
  });

  it("场景12a：授权文本点名过的数值不可反向重加（洗白封堵：weakening 不进通用新增授权）", () => {
    // Round1 授权删除 5.2（targetSpan 点名）；Round2 把 5.2 加回来 → 必须仍 FAIL
    const summary = evaluate(
      { "sections/experiments.tex": "该方法的召回有所提高。" },
      { "sections/experiments.tex": "该方法的召回提高 5.2\\%。" },
      [weakening({ kind: "remove_unsupported_detail", targetSpan: "删去无证据数值 5.2" })],
    );
    expect(summary.ok).toBe(false);
    expect(summary.addedUnsupportedFacts).toHaveLength(1);
  });

  it("场景12b：合法弱化被放行的同一文件里新数值漂移仍被捕获（cumulative 语义的纯函数投影）", () => {
    const baseline = "消融显示加入外观使 HOTA 提升（+0.8），而速度下降。\n部署实测 18 min。";
    const current = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。\n部署实测 25 min。";
    const summary = evaluate(
      { "sections/experiments.tex": baseline },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    // 弱化重排被放行，但 18 → 25 的累计漂移必须呈现
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts).toHaveLength(1);
    expect(summary.allowedWeakenings).toBe(1);
  });
});

// ---- 11. Citation Preservation 不受弱化授权影响 ----

describe("Typed Authorized Weakening：与 Citation Preservation 正交", () => {
  it("场景11：弱化授权放行事实侧，引用无依据删除仍令 gate FAIL", () => {
    const previous = "据其原文，加入外观使 HOTA 提升（+0.8）\\cite{stanojevic2024boosttrack}。\n速度下降。";
    const current = "据其原文，加入外观使 HOTA 提升（+0.8）。\n速度下降。";
    const fact = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
      [weakening({})],
    );
    expect(fact.ok).toBe(true);
    const citationFailing: CitationPreservationSummary = {
      previousRevision: 1,
      currentRevision: 2,
      previousCount: 1,
      currentCount: 0,
      previousKeys: ["stanojevic2024boosttrack"],
      currentKeys: [],
      removedKeys: ["stanojevic2024boosttrack"],
      addedKeys: [],
      allowedRemovedKeys: [],
      unexpectedRemovedKeys: ["stanojevic2024boosttrack"],
      unexpectedRemoved: [{ key: "stanojevic2024boosttrack", files: ["sections/experiments.tex"] }],
      catastrophic: false,
      historicalRegression: null,
      planId: null,
      ok: false,
    };
    const gate = evaluateQualityGate(
      {
        review: emptySummary,
        citation: null,
        evidence: {
          total: 1,
          byStatus: { unverified: 0, verified: 1, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
          contradictory: 0,
          skippedLines: 0,
        },
        feasibility: null,
        citationPreservation: citationFailing,
        factPreservation: fact,
      },
      DEFAULT_QUALITY_THRESHOLDS,
    );
    expect(gate.passed).toBe(false);
    expect(gate.reasons.some((reason) => reason.startsWith("citation_keys_preserved:"))).toBe(true);
  });
});

// ---- 派生规则与台账 ----

describe("weakeningAuthorization：派生规则", () => {
  it("needsEvidence 条目 → weaken；指令含删除语义且点名数值 → 追加 remove", () => {
    const plan = planWithItems([
      {
        id: "f-1",
        kind: "review_finding",
        section: "sections/a.tex",
        problem: "『提高 5.2%』无证据支撑",
        instruction: "无法核实则删去具体数值改为定性表述",
        needsEvidence: true,
        status: "planned",
      },
    ]);
    const derived = derivePlanWeakeningAuthorizations(plan);
    expect(derived.map((entry) => entry.kind)).toEqual(["weaken_claim_strength", "remove_unsupported_detail"]);
    expect(derived[1]?.targetSpan).toContain("5.2");
  });

  it("style finding（无弱化语义）不派生；fact_preserve 条目永不派生", () => {
    const plan = planWithItems([
      { id: "f-style", kind: "review_finding", section: "sections/a.tex", problem: "句式冗长", instruction: "精简句式", status: "planned" },
      {
        id: "fact-preserve:x:0",
        kind: "fact_preserve",
        section: "sections/a.tex",
        problem: "45 → 28",
        instruction: "恢复原值",
        needsEvidence: true,
        status: "planned",
      },
    ]);
    expect(derivePlanWeakeningAuthorizations(plan)).toHaveLength(0);
  });

  it("rejected / skipped 条目不派生；plannedOnly 只认 planned（台账口径）", () => {
    const plan = planWithItems([
      { id: "f-r", kind: "review_finding", section: "s", problem: "p", instruction: "弱化", needsEvidence: true, status: "rejected" },
      { id: "f-s", kind: "review_finding", section: "s", problem: "p", instruction: "弱化", needsEvidence: true, status: "skipped" },
      { id: "f-a", kind: "review_finding", section: "s", problem: "p", instruction: "弱化", needsEvidence: true, status: "applied" },
    ]);
    expect(derivePlanWeakeningAuthorizations(plan).map((entry) => entry.itemId)).toEqual(["f-a"]);
    expect(derivePlanWeakeningAuthorizations(plan, { plannedOnly: true })).toHaveLength(0);
  });

  it("claim grounding：SUPPORTED 不派生；UNSUPPORTED 无数值只派生 weaken", () => {
    const report = claimGroundingReport([
      { section: "sections/a.tex", claim: "已核验论断", verdict: "SUPPORTED" },
      { section: "sections/b.tex", claim: "定性论断无数字", verdict: "UNSUPPORTED" },
    ]);
    const derived = deriveClaimGroundingWeakeningAuthorizations(report);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ kind: "weaken_claim_strength", claimId: "c-test1" });
  });
});

describe("条目生命周期授权修复（M11.2 振荡的结构性成因）", () => {
  it("applied 条目点名的数值修正（45→44，Evidence 含 44）在 gate 时刻仍获授权 → PASS", () => {
    const tex = (value: string): string => `\\section{实验}\n低照度场景 IDS 为 ${value}（基线 24）。`;
    const plan = planWithItems([
      {
        id: "f-fix",
        kind: "review_finding",
        section: "sections/experiments.tex",
        problem: "IDS 应为 45 → 44（依据 E001）",
        instruction: "依据 E001 更正为 44",
        needsEvidence: true,
        status: "applied",
      },
    ]);
    const summary = evaluate(
      { "sections/experiments.tex": tex("45") },
      { "sections/experiments.tex": tex("44") },
      [],
      plan,
    );
    expect(summary.ok).toBe(true);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
  });
});

// ---- 台账（append-only / 幂等 / 通道隔离） ----

describe("weakeningAuthorization：授权台账", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function newStore(): Promise<{ root: string; projects: ProjectStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "m1121-weak-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("测试项目");
    return { root, projects, projectId: project.id };
  }

  it("append → read 往返；重复 append 幂等；字段可追溯（kind/section/targetSpan/round/reason）", async () => {
    const { projects, projectId } = await newStore();
    const entries: WeakeningAuthorizationInput[] = [
      {
        kind: "weaken_claim_strength",
        section: "sections/a.tex",
        targetSpan: "claim 原文",
        itemId: "f-1",
        findingId: "f-1",
        round: 3,
        reason: "修订计划条目 f-1（needsEvidence）",
      },
    ];
    expect(await appendWeakeningAuthorizations(projects, projectId, entries, { runId: "w-1" })).toBe(1);
    expect(await appendWeakeningAuthorizations(projects, projectId, entries, { runId: "w-2" })).toBe(0);
    const read = await readWeakeningAuthorizations(projects, projectId);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      kind: "weaken_claim_strength",
      section: "sections/a.tex",
      targetSpan: "claim 原文",
      itemId: "weaken_claim_strength:f-1",
      findingId: "f-1",
      round: 3,
    });
  });
});
