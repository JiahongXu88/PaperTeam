/**
 * Revision Item 状态机测试（M6.7 §5）：
 * - 计划派生产出 planned 条目（≡ pending）并携带 riskLevel / relatedEvidenceIds
 * - 合法流转：planned → applied → validated；applied → needs_review → approved；
 *   rejected → planned（重派发）
 * - 非法流转确定性拒绝：planned → validated（跳过执行）、validated → applied
 *   （复活终态）、skipped → 任何（终态）
 * - 终态流转补写 resolvedAt / resolution；applied 携带修订号与 targetChanged
 */

import { describe, expect, it } from "vitest";

import {
  buildRevisionPlan,
  type RevisionPlan,
} from "../../src/review/revisionPlan.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import {
  applyRevisionItemTransitions,
  canTransitionRevisionItem,
  revisionItemCounts,
  REVISION_ITEM_TERMINAL,
} from "../../src/review/revisionItemStatus.js";

function summaryWith(issues: Partial<ReviewIssue>[]): ReviewSummary {
  // 构造最小 ReviewSummary：issues 借道 buildRevisionPlan 的派生输入（见下）
  return {
    generatedAt: "2026-09-18T00:00:00.000Z",
    round: 1,
    issues: issues.map((issue, index) => ({
      category: "academic",
      severity: "major",
      section: "sections/introduction.tex",
      description: `问题 ${index + 1}`,
      blocking: false,
      ...issue,
    })) as ReviewIssue[],
    counts: { critical: 0, major: issues.length, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: 85, styleRisk: 20, factVerdicts: null },
    openCritical: 0,
    openMajor: issues.length,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}

function planOf(): RevisionPlan {
  return buildRevisionPlan({
    projectId: "p1",
    sourceRevision: 3,
    reviewRound: 1,
    summary: summaryWith([{ severity: "critical", description: "关键论断无证据" }]),
    citationMissing: [{ key: "ghost2020", files: ["sections/method.tex"] }],
    evidenceLinks: [{ key: "ghost2020", evidenceIds: ["E001", "E002"] }],
  });
}

describe("Revision Item 状态机（M6.7）", () => {
  it("计划派生：planned 状态 + 确定性 riskLevel / relatedEvidenceIds", () => {
    const plan = planOf();
    const finding = plan.items.find((item) => item.kind === "review_finding");
    expect(finding?.status).toBe("planned"); // ≡ pending
    expect(finding?.riskLevel).toBe("high"); // critical finding

    const citation = plan.items.find((item) => item.kind === "citation_missing");
    expect(citation?.status).toBe("planned");
    expect(citation?.riskLevel).toBe("high");
    expect(citation?.relatedEvidenceIds).toEqual(["E001", "E002"]); // evidenceLinks 注入

    const major = buildRevisionPlan({
      projectId: "p1",
      sourceRevision: 3,
      reviewRound: 1,
      summary: summaryWith([{ severity: "major" }]),
    }).items[0];
    expect(major?.riskLevel).toBe("medium");
  });

  it("合法流转：planned → applied → validated；applied 携带修订号与 targetChanged", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    const applied = applyRevisionItemTransitions(
      plan,
      [{ id, to: "applied", reason: "dispatched", appliedAt: "2026-09-18T01:00:00.000Z", appliedRevision: 4, targetChanged: true }],
      "2026-09-18T01:00:00.000Z",
    );
    expect(applied.plan.items[0]).toMatchObject({
      status: "applied",
      appliedRevision: 4,
      targetChanged: true,
      appliedAt: "2026-09-18T01:00:00.000Z",
    });
    expect(applied.plan.items[0]?.resolution).toBeUndefined();

    const validated = applyRevisionItemTransitions(
      applied.plan,
      [{ id, to: "validated", reason: "validation_passed", detail: "四类复核无违规" }],
      "2026-09-18T02:00:00.000Z",
    );
    expect(validated.plan.items[0]).toMatchObject({
      status: "validated",
      resolvedAt: "2026-09-18T02:00:00.000Z",
      resolution: "validation_passed：四类复核无违规",
    });
    expect(REVISION_ITEM_TERMINAL.has("validated")).toBe(true);
  });

  it("合法流转：applied → needs_review → approved（用户明示接受）；rejected → planned（重派发清痕迹）", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    const applied = applyRevisionItemTransitions(plan, [{ id, to: "applied", reason: "dispatched" }], "2026-09-18T01:00:00.000Z").plan;
    const needs = applyRevisionItemTransitions(applied, [{ id, to: "needs_review", reason: "evidence_stale", detail: "E001 已失效" }], "2026-09-18T01:00:00.000Z");
    expect(needs.plan.items[0]?.status).toBe("needs_review");
    const approved = applyRevisionItemTransitions(needs.plan, [{ id, to: "approved", reason: "user_approved" }], "2026-09-18T02:00:00.000Z");
    expect(approved.plan.items[0]?.resolution).toContain("user_approved");

    const rejected = applyRevisionItemTransitions(
      applyRevisionItemTransitions(
        applyRevisionItemTransitions(plan, [{ id, to: "applied", reason: "dispatched" }], "2026-09-18T01:00:00.000Z").plan,
        [{ id, to: "rejected", reason: "fact_preservation_violation", detail: "数值漂移" }],
        "2026-09-18T02:00:00.000Z",
      ).plan,
      [{ id, to: "planned", reason: "re_dispatched" }],
      "2026-09-18T03:00:00.000Z",
    );
    // 重派发回到 planned：执行与判定痕迹清空（新一轮生命周期）
    expect(rejected.plan.items[0]).toMatchObject({
      status: "planned",
      appliedRevision: undefined,
      resolvedAt: undefined,
      resolution: undefined,
    });
  });

  it("非法状态流转确定性拒绝（不部分应用）", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    // planned → validated：跳过执行与验证
    expect(() =>
      applyRevisionItemTransitions(plan, [{ id, to: "validated", reason: "validation_passed" }], "2026-09-18T00:00:00.000Z"),
    ).toThrow(/不是合法流转/);
    // 不存在的条目 id
    expect(() =>
      applyRevisionItemTransitions(plan, [{ id: "not-exist", to: "applied", reason: "dispatched" }], "2026-09-18T00:00:00.000Z"),
    ).toThrow(/不在计划/);
    // 重复 id
    expect(() =>
      applyRevisionItemTransitions(
        plan,
        [
          { id, to: "applied", reason: "dispatched" },
          { id, to: "applied", reason: "dispatched" },
        ],
        "2026-09-18T00:00:00.000Z",
      ),
    ).toThrow(/重复 id/);

    // 终态不可流转：validated / approved / skipped
    const validated = applyRevisionItemTransitions(
      applyRevisionItemTransitions(plan, [{ id, to: "applied", reason: "dispatched" }], "2026-09-18T00:00:00.000Z").plan,
      [{ id, to: "validated", reason: "validation_passed" }],
      "2026-09-18T00:00:00.000Z",
    ).plan;
    expect(canTransitionRevisionItem("validated", "applied")).toBe(false);
    expect(() =>
      applyRevisionItemTransitions(validated, [{ id, to: "rejected", reason: "user_rejected" }], "2026-09-18T00:00:00.000Z"),
    ).toThrow(/不是合法流转/);
    expect(canTransitionRevisionItem("skipped", "applied")).toBe(false);
    expect(canTransitionRevisionItem("planned", "skipped")).toBe(true);
  });

  it("revisionItemCounts：生命周期计数（gate 规则 / HITL payload 用）", () => {
    let plan = planOf();
    const ids = plan.items.map((item) => item.id);
    plan = applyRevisionItemTransitions(
      plan,
      ids.map((id) => ({ id, to: "applied" as const, reason: "dispatched" as const })),
      "2026-09-18T00:00:00.000Z",
    ).plan;
    plan = applyRevisionItemTransitions(
      plan,
      ids.slice(0, 1).map((id) => ({ id, to: "validated" as const, reason: "validation_passed" as const })),
      "2026-09-18T00:00:00.000Z",
    ).plan;
    const counts = revisionItemCounts(plan);
    expect(counts.applied).toBe(ids.length - 1);
    expect(counts.validated).toBe(1);
    expect(counts.rejected).toBe(0);
    expect(revisionItemCounts(null).planned).toBe(0);
  });
});
