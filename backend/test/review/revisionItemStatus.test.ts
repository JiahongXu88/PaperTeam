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
  findStuckAppliedItems,
  revisionItemCounts,
  REVISION_ITEM_TERMINAL,
  RevisionProtocolError,
  validateRevisionPlanShape,
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
    // 不存在的条目 id（M9.7.6 后仍确定性拒绝）
    expect(() =>
      applyRevisionItemTransitions(plan, [{ id: "not-exist", to: "applied", reason: "dispatched" }], "2026-09-18T00:00:00.000Z"),
    ).toThrow(/不在计划/);

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

  it("M9.7.6 P0：完全相同的重复声明确定性 collapse（不再杀死 run）+ 归一诊断", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    const result = applyRevisionItemTransitions(
      plan,
      [
        { id, to: "applied", reason: "dispatched", appliedAt: "2026-09-18T01:00:00.000Z", appliedRevision: 4, targetChanged: true },
        { id, to: "applied", reason: "dispatched", appliedAt: "2026-09-18T01:00:01.000Z", appliedRevision: 4, targetChanged: false },
      ],
      "2026-09-18T01:00:00.000Z",
    );
    // 幂等重述 → 单条生效；applied 元数据合并（targetChanged OR、appliedAt 取首）
    expect(result.plan.items[0]).toMatchObject({
      status: "applied",
      appliedRevision: 4,
      appliedAt: "2026-09-18T01:00:00.000Z",
      targetChanged: true,
    });
    expect(result.normalization).toMatchObject({
      duplicateIds: [id],
      originalCount: 2,
      normalizedCount: 1,
      originalSequences: { [id]: ["applied", "applied"] },
    });
    // 其他条目不受影响
    expect(result.plan.items[1]?.status).toBe(plan.items[1]?.status);
  });

  it("M9.7.6 P0：合法顺序重复按序 replay（planned → applied → validated 一批声明）", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    const result = applyRevisionItemTransitions(
      plan,
      [
        { id, to: "applied", reason: "dispatched", appliedAt: "2026-09-18T01:00:00.000Z", appliedRevision: 4, targetChanged: true },
        { id, to: "validated", reason: "validation_passed" },
      ],
      "2026-09-18T02:00:00.000Z",
    );
    expect(result.plan.items[0]?.status).toBe("validated");
    expect(result.plan.items[0]?.resolution).toContain("validation_passed");
    expect(result.normalization?.duplicateIds).toEqual([id]);
  });

  it("M9.7.6 P0：互相矛盾的重复声明结构化拒绝（不静默 last-wins，不部分应用）", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    const other = plan.items[1]!.id;
    // applied 与 skipped 并列：planned 起点下无法构成合法路径
    expect(() =>
      applyRevisionItemTransitions(
        plan,
        [
          { id, to: "applied", reason: "dispatched" },
          { id, to: "skipped", reason: "writer_unchanged" },
          // 合法条目与矛盾条目同批：整体拒绝（原子性），不得部分应用
          { id: other, to: "applied", reason: "dispatched" },
        ],
        "2026-09-18T00:00:00.000Z",
      ),
    ).toThrow(/无法归一的重复声明/);
    // 原子性：失败的批次不改变计划
    expect(plan.items[0]?.status).toBe("planned");
    expect(plan.items[1]?.status).toBe("planned");
  });

  it("M9.7.6 P0 回归：m975 真实场景——一条 finding 命中两个修订目标产生重复 applied", () => {
    // m975 Arm A r1：f-841df05ccd04 section="sections/evaluation-failure.tex（并见
    // sections/reasoning-acting.tex）" 经 sectionMatches 命中两个 target，循环内
    // 同 id push 两次 → transitions 重复 → 旧实现 throw → transient 2/2 → run 死。
    // 新实现：collapse + targetChanged OR（一个目标改了 = 条目有实际变化）。
    const plan = planOf();
    const id = plan.items[0]!.id;
    const result = applyRevisionItemTransitions(
      plan,
      [
        { id, to: "applied", reason: "dispatched", appliedRevision: 5, targetChanged: false }, // target 1 未变
        { id, to: "applied", reason: "dispatched", appliedRevision: 5, targetChanged: true }, // target 2 变了
      ],
      "2026-09-24T00:00:00.000Z",
    );
    expect(result.changed).toBe(true);
    expect(result.plan.items[0]).toMatchObject({ status: "applied", targetChanged: true, appliedRevision: 5 });
    expect(result.normalization?.duplicateIds).toEqual([id]);
  });

  it("M9.10 Phase 1：协议错误结构化（code + violations），不再只是裸字符串", () => {
    const plan = planOf();
    const id = plan.items[0]!.id;
    // 矛盾重复声明 → duplicate_conflict
    try {
      applyRevisionItemTransitions(
        plan,
        [
          { id, to: "applied", reason: "dispatched" },
          { id, to: "skipped", reason: "writer_unchanged" },
        ],
        "2026-09-25T00:00:00.000Z",
      );
      expect.unreachable("矛盾重复声明应抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RevisionProtocolError);
      const protocolError = error as RevisionProtocolError;
      expect(protocolError.code).toBe("duplicate_conflict");
      expect(protocolError.violations.length).toBeGreaterThan(0);
      expect(protocolError.message).toContain("无法归一的重复声明");
    }
    // 非法流转 → illegal_transition（携带 id / from / to）
    try {
      applyRevisionItemTransitions(
        plan,
        [{ id, to: "validated", reason: "validation_passed" }],
        "2026-09-25T00:00:00.000Z",
      );
      expect.unreachable("非法流转应抛错");
    } catch (error) {
      const protocolError = error as RevisionProtocolError;
      expect(protocolError.code).toBe("illegal_transition");
      expect(protocolError.violations[0]).toMatchObject({ id, from: "planned", to: "validated" });
    }
    // 未知条目 → unknown_item
    try {
      applyRevisionItemTransitions(
        plan,
        [{ id: "ghost-item", to: "applied", reason: "dispatched" }],
        "2026-09-25T00:00:00.000Z",
      );
      expect.unreachable("未知条目应抛错");
    } catch (error) {
      const protocolError = error as RevisionProtocolError;
      expect(protocolError.code).toBe("unknown_item");
      expect(protocolError.violations[0]?.id).toBe("ghost-item");
    }
  });

  it("M9.10 Phase 1：计划 schema 断言——重复条目 id / 非法 status 确定性拒绝", () => {
    const plan = planOf();
    expect(validateRevisionPlanShape(plan)).toHaveLength(0);
    // 篡改出重复 id
    const duplicated: RevisionPlan = {
      ...plan,
      items: [...plan.items, { ...plan.items[0]!, status: "planned" }],
    };
    const violations = validateRevisionPlanShape(duplicated);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ code: "duplicate_item_id", id: plan.items[0]!.id });
    // 重复 id 的计划在流转入口被拒（结构化错误，不进入下一阶段）
    expect(() =>
      applyRevisionItemTransitions(
        duplicated,
        [{ id: plan.items[0]!.id, to: "applied", reason: "dispatched" }],
        "2026-09-25T00:00:00.000Z",
      ),
    ).toThrow(RevisionProtocolError);
    // 非法 status（loadPlan 读回的旧 / 坏 JSON 防御）
    const badStatus: RevisionPlan = {
      ...plan,
      items: plan.items.map((item, index) =>
        index === 0 ? { ...item, status: "finished" as never } : item,
      ),
    };
    expect(validateRevisionPlanShape(badStatus)[0]?.code).toBe("invalid_item_status");
  });

  it("M9.10 Phase 1：缺失 transition 检测——validate 后仍停留 applied 的条目可见", () => {
    const plan = planOf();
    const ids = plan.items.map((item) => item.id);
    // 派发了两条，只复核了一条 → 另一条 stuck applied（缺失 transition）
    const applied = applyRevisionItemTransitions(
      plan,
      ids.map((id) => ({ id, to: "applied" as const, reason: "dispatched" as const })),
      "2026-09-25T00:00:00.000Z",
    ).plan;
    expect(findStuckAppliedItems(applied)).toHaveLength(ids.length);
    const partiallyValidated = applyRevisionItemTransitions(
      applied,
      [{ id: ids[0]!, to: "validated", reason: "validation_passed" }],
      "2026-09-25T01:00:00.000Z",
    ).plan;
    const stuck = findStuckAppliedItems(partiallyValidated);
    expect(stuck.map((item) => item.id)).toEqual(ids.slice(1));
    const fullyValidated = applyRevisionItemTransitions(
      partiallyValidated,
      ids.slice(1).map((id) => ({ id, to: "validated" as const, reason: "validation_passed" as const })),
      "2026-09-25T02:00:00.000Z",
    ).plan;
    expect(findStuckAppliedItems(fullyValidated)).toHaveLength(0);
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
