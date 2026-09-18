/**
 * Revision Item 状态机（M6.7 §5：确定性，无 LLM）。
 *
 * Revision ≠ Correct Revision：Writer 执行（applied）不等于修订正确，必须经
 * Revision Validation 复核（validated）或被明确拒绝（rejected）/ 送人工
 * （needs_review）/ 用户接受（approved）。非法流转在代码层确定性拒绝——
 * 状态只沿下表单向推进，任何绕过验证的「直接 validated / 复活终态」都是
 * 编排缺陷而不是数据问题。
 *
 *   planned ──→ applied ──→ validated（终态：复核通过）
 *     │           │ └───→ rejected ──→ planned（重派发，bounded loop 内）
 *     │           │            └────→ approved（终态：用户明示接受）
 *     │           └─────→ needs_review ──→ approved / rejected / validated
 *     └──→ skipped（终态：记录不派发）
 *   rejected / needs_review 也可由用户在 HITL 决策时直接落定。
 */

import type { RevisionPlan, RevisionPlanItem, RevisionPlanItemStatus } from "./revisionPlan.js";

/** 合法流转表（键 = 当前状态，值 = 允许的下一状态集合） */
export const REVISION_ITEM_TRANSITIONS: Readonly<
  Record<RevisionPlanItemStatus, readonly RevisionPlanItemStatus[]>
> = {
  planned: ["applied", "skipped", "rejected"],
  skipped: [],
  applied: ["validated", "rejected", "needs_review", "approved"],
  validated: [],
  rejected: ["planned", "approved", "needs_review"],
  needs_review: ["validated", "rejected", "approved"],
  approved: [],
};

/** 终态集合（不再允许流转） */
export const REVISION_ITEM_TERMINAL: ReadonlySet<RevisionPlanItemStatus> = new Set([
  "skipped",
  "validated",
  "approved",
]);

export function canTransitionRevisionItem(
  from: RevisionPlanItemStatus,
  to: RevisionPlanItemStatus,
): boolean {
  return REVISION_ITEM_TRANSITIONS[from].includes(to);
}

/** 单条流转的机器可读原因短语（写入 item.resolution 的前缀） */
export type RevisionItemResolutionReason =
  | "dispatched"
  | "writer_unchanged"
  | "validation_passed"
  | "fact_preservation_violation"
  | "citation_removal_unauthorized"
  | "claim_strength_escalation"
  | "evidence_stale"
  | "no_change_detected"
  | "user_approved"
  | "user_rejected"
  | "user_needs_review"
  | "re_dispatched";

export interface RevisionItemTransition {
  id: string;
  to: RevisionPlanItemStatus;
  reason: RevisionItemResolutionReason;
  /** 附加说明（人读；进入 resolution） */
  detail?: string;
  resolvedAt?: string;
  /** to=applied 时携带：执行时刻与写入的修订号（M6.7 验证对齐用） */
  appliedAt?: string;
  appliedRevision?: number;
  /** to=applied 时携带：派发目标是否产生实际文本变更（确定性 diff） */
  targetChanged?: boolean;
}

export interface ApplyTransitionsResult {
  plan: RevisionPlan;
  changed: boolean;
}

/**
 * 对计划条目应用一批状态流转（纯函数；非法流转抛错并列出全部违规项，
 * 不做部分应用——状态损坏应当被发现而不是被吞掉）。
 *
 * 每次流转都会补写 resolvedAt（终态类流转）与 resolution
 * （`{reason}：{detail}`，供 UI / 审计解释条目为什么停在这个状态）。
 */
export function applyRevisionItemTransitions(
  plan: RevisionPlan,
  transitions: readonly RevisionItemTransition[],
  now: string,
): ApplyTransitionsResult {
  const byId = new Map(transitions.map((transition) => [transition.id, transition]));
  if (byId.size !== transitions.length) {
    throw new Error("revision item transitions 包含重复 id");
  }
  const illegal: string[] = [];
  for (const transition of transitions) {
    const item = plan.items.find((candidate) => candidate.id === transition.id);
    if (item === undefined) {
      illegal.push(`条目 ${transition.id} 不在计划 ${plan.planId} 中`);
      continue;
    }
    if (!canTransitionRevisionItem(item.status, transition.to)) {
      illegal.push(`${item.id}: ${item.status} → ${transition.to} 不是合法流转`);
    }
  }
  if (illegal.length > 0) {
    throw new Error(`非法的 revision item 状态流转（${illegal.join("；")}）`);
  }
  let changed = false;
  const items = plan.items.map((item): RevisionPlanItem => {
    const transition = byId.get(item.id);
    if (transition === undefined) {
      return item;
    }
    changed = true;
    if (transition.to === "applied") {
      return {
        ...item,
        status: "applied",
        ...(transition.appliedAt !== undefined ? { appliedAt: transition.appliedAt } : {}),
        ...(transition.appliedRevision !== undefined ? { appliedRevision: transition.appliedRevision } : {}),
        ...(transition.targetChanged !== undefined ? { targetChanged: transition.targetChanged } : {}),
        resolvedAt: undefined,
        resolution: undefined,
      };
    }
    return {
      ...item,
      status: transition.to,
      ...(REVISION_ITEM_TERMINAL.has(transition.to) ||
        transition.to === "rejected" ||
        transition.to === "needs_review"
        ? {
            resolvedAt: transition.resolvedAt ?? now,
            resolution: `${transition.reason}${transition.detail !== undefined ? `：${transition.detail}` : ""}`,
          }
        : {
            // planned（重派发）不是终态：清掉上一轮的判定与执行痕迹
            resolvedAt: undefined,
            resolution: undefined,
            appliedAt: undefined,
            appliedRevision: undefined,
            targetChanged: undefined,
          }),
    };
  });
  return { plan: changed ? { ...plan, items } : plan, changed };
}

/** 计划条目的生命周期计数（gate 规则 / HITL payload 用） */
export function revisionItemCounts(
  plan: RevisionPlan | null,
): { planned: number; applied: number; validated: number; rejected: number; needsReview: number; approved: number; skipped: number } {
  const counts = {
    planned: 0,
    applied: 0,
    validated: 0,
    rejected: 0,
    needsReview: 0,
    approved: 0,
    skipped: 0,
  };
  for (const item of plan?.items ?? []) {
    switch (item.status) {
      case "planned":
        counts.planned += 1;
        break;
      case "applied":
        counts.applied += 1;
        break;
      case "validated":
        counts.validated += 1;
        break;
      case "rejected":
        counts.rejected += 1;
        break;
      case "needs_review":
        counts.needsReview += 1;
        break;
      case "approved":
        counts.approved += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
    }
  }
  return counts;
}
