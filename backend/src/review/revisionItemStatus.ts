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
  | "citation_removal_detected"
  | "claim_strength_escalation"
  | "evidence_stale"
  | "no_change_detected"
  | "user_approved"
  | "user_rejected"
  | "user_needs_review"
  | "re_dispatched";

// ---- M9.10 Phase 1：协议违规的结构化错误 ----

/** 结构化协议违规（机器可读；进入 stage 失败分类与修复循环，不再是裸字符串） */
export interface RevisionProtocolViolation {
  /** 违规类别（duplicate_conflict 例外：单条 detail 描述整组矛盾） */
  code?: RevisionProtocolErrorCode;
  id?: string;
  from?: RevisionPlanItemStatus;
  to?: RevisionPlanItemStatus;
  detail: string;
}

export type RevisionProtocolErrorCode =
  | "duplicate_conflict"
  | "illegal_transition"
  | "unknown_item"
  | "duplicate_item_id"
  | "invalid_item_status"
  | "missing_transition";

/**
 * Revision 协议错误（M9.10）：重复 / 非法 / 缺失 transition 与计划 schema 违规
 * 的统一结构化载体。message 保持与旧实现一致的中文句子（既有测试 / 日志口径
 * 不变），code + violations 供 stage 失败处理与修复循环消费。
 */
export class RevisionProtocolError extends Error {
  readonly code: RevisionProtocolErrorCode;
  readonly violations: readonly RevisionProtocolViolation[];

  constructor(code: RevisionProtocolErrorCode, violations: RevisionProtocolViolation[], message: string) {
    super(message);
    this.name = "RevisionProtocolError";
    this.code = code;
    this.violations = violations;
  }
}

/** 合法 status 集合（运行时校验用；loadPlan 读回的 JSON 不受编译期类型保护） */
export const REVISION_ITEM_STATUSES: ReadonlySet<RevisionPlanItemStatus> = new Set([
  "planned",
  "skipped",
  "applied",
  "validated",
  "rejected",
  "needs_review",
  "approved",
]);

/**
 * 计划 schema 断言（M9.10 Phase 1）：条目 id 在计划内必须唯一、status 必须
 * 是生命周期合法值。确定性派生（buildRevisionPlan）与落盘读回（loadPlan）的
 * 双通道都过本断言——同 id 条目一旦进入计划，会在 validate 阶段以「矛盾序列」
 * 形式晚爆（applied→validated 与 applied→rejected 并列），在构建期拒绝才是
 * 稳定协议的口径。
 */
export function validateRevisionPlanShape(
  plan: Pick<RevisionPlan, "planId" | "items">,
): RevisionProtocolViolation[] {
  const violations: RevisionProtocolViolation[] = [];
  const seen = new Map<string, number>();
  for (const item of plan.items) {
    seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
    if (!REVISION_ITEM_STATUSES.has(item.status)) {
      violations.push({
        code: "invalid_item_status",
        id: item.id,
        detail: `status "${String(item.status)}" 不是合法生命周期状态`,
      });
    }
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      violations.push({
        code: "duplicate_item_id",
        id,
        detail: `条目 id 在计划 ${plan.planId} 中出现 ${count} 次（必须唯一）`,
      });
    }
  }
  return violations;
}

/**
 * 缺失 transition 检测（M9.10 Phase 1）：revision.validate 之后仍停留在 applied
 * 的条目 = 派发了执行却没走到任何复核终态（validated / rejected / needs_review），
 * 属于编排跳步或复核漏判——条目会无声悬置（Quality Gate 只消费 validation
 * result，不看计划残留），必须显式暴露。
 */
export function findStuckAppliedItems(plan: Pick<RevisionPlan, "items"> | null): RevisionPlanItem[] {
  return (plan?.items ?? []).filter((item) => item.status === "applied");
}

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

/**
 * M9.7.6 duplicate-id normalization 诊断（§2.2）：普通可恢复重复（幂等重述 /
 * 合法顺序路径）只记录不失败；真正矛盾（无法构成合法路径）才在 errors 里
 * 拒绝。originalTransitions / normalizedTransitions 保留计数供审计。
 */
export interface TransitionNormalization {
  /** 出现重复声明的条目 id（去重后） */
  duplicateIds: string[];
  /** 每个重复 id 的原始声明序列（`to` 按出现顺序） */
  originalSequences: Record<string, RevisionPlanItemStatus[]>;
  originalCount: number;
  normalizedCount: number;
}

export interface ApplyTransitionsResult {
  plan: RevisionPlan;
  changed: boolean;
  /** 本批发生的 normalization（无重复时为 undefined；可恢复重复不构成失败） */
  normalization?: TransitionNormalization;
}

/**
 * 同 id 多条声明的确定性合并（M9.7.6 P0）。
 *
 * transitions 的语义是「按 id 分组的最终状态声明」，不是有序状态变化（§M9.7.6
 * 审计 §1.1-D：三个调用点全部从 item 当前状态出发做批式落定，且状态机不允许
 * applied → applied——把重复声明当顺序变化反而制造非法流转）。据此：
 *
 * - 幂等重述（to === 当前已到达状态）→ collapse：applied 元数据合并
 *   （targetChanged 取 OR、appliedRevision 取 max、appliedAt 取首个）；
 * - 合法前向路径（如 planned → applied → validated 依次出现）→ 按序推进，
 *   终态声明生效（防御未来调用方；现有调用点不会产生）；
 * - 无法构成合法路径（如 applied 与 rejected 并列声明）→ 不静默 last-wins，
 *   如实进入冲突错误（走既有 repair / retry）。
 */
function mergeAppliedMeta(
  base: RevisionItemTransition,
  extra: RevisionItemTransition,
): RevisionItemTransition {
  const targetChanged =
    base.targetChanged === undefined && extra.targetChanged === undefined
      ? undefined
      : (base.targetChanged ?? false) || (extra.targetChanged ?? false);
  const appliedRevision =
    base.appliedRevision !== undefined && extra.appliedRevision !== undefined
      ? Math.max(base.appliedRevision, extra.appliedRevision)
      : (base.appliedRevision ?? extra.appliedRevision);
  return {
    ...base,
    ...(appliedRevision !== undefined ? { appliedRevision } : {}),
    ...(targetChanged !== undefined ? { targetChanged } : {}),
  };
}

export function normalizeRevisionItemTransitions(
  plan: RevisionPlan,
  transitions: readonly RevisionItemTransition[],
): {
  transitions: RevisionItemTransition[];
  /** 经多步合法路径 replay 得到终态的条目（合法性已按路径验证） */
  replayedIds: ReadonlySet<string>;
  normalization?: TransitionNormalization;
  conflicts: string[];
} {
  const statusById = new Map(plan.items.map((item) => [item.id, item.status]));
  const grouped = new Map<string, RevisionItemTransition[]>();
  for (const transition of transitions) {
    const group = grouped.get(transition.id);
    if (group === undefined) {
      grouped.set(transition.id, [transition]);
    } else {
      group.push(transition);
    }
  }
  const normalized: RevisionItemTransition[] = [];
  const replayedIds = new Set<string>();
  const duplicateIds: string[] = [];
  const originalSequences: Record<string, RevisionPlanItemStatus[]> = {};
  const conflicts: string[] = [];
  for (const [id, group] of grouped) {
    if (group.length === 1) {
      // 单条声明：不经过路径归一，合法性由 apply 的单步校验判定
      //（未知 id / 非法流转 / 幂等 no-op 均保持既有口径）
      normalized.push(group[0]!);
      continue;
    }
    duplicateIds.push(id);
    originalSequences[id] = group.map((transition) => transition.to);
    const start = statusById.get(id);
    let current: RevisionPlanItemStatus | undefined = start;
    let effective: RevisionItemTransition | undefined;
    let advanced = false;
    let appliedMeta: RevisionItemTransition | undefined;
    let conflicted = false;
    for (const transition of group) {
      if (current === undefined) {
        // 未知 id：保持原样，由调用方的未知 id 校验拒绝
        effective = transition;
        continue;
      }
      if (transition.to === current) {
        // 幂等重述：合并元数据（同声明多次出现 = 派发到多个目标）
        effective = effective === undefined ? transition : mergeAppliedMeta(effective, transition);
        if (transition.to === "applied") {
          appliedMeta = mergeAppliedMeta(appliedMeta ?? transition, transition);
        }
        continue;
      }
      if (canTransitionRevisionItem(current, transition.to)) {
        current = transition.to;
        advanced = true;
        effective = transition;
        if (transition.to === "applied") {
          appliedMeta = mergeAppliedMeta(appliedMeta ?? transition, transition);
        }
        continue;
      }
      conflicts.push(
        `${id}: ${start} 起点下声明序列 ${group.map((t) => t.to).join(" → ")} 不构成合法状态路径`,
      );
      conflicted = true;
      break;
    }
    if (conflicted) {
      continue; // 该 id 有矛盾：不出有效声明，整体由 conflicts 拒绝
    }
    if (effective !== undefined) {
      // 多步 replay（如 planned → applied → validated 一批声明）：终态生效，
      // 沿途 applied 元数据（appliedAt / appliedRevision / targetChanged）随终态落盘
      if (advanced && appliedMeta !== undefined && effective.to !== "applied") {
        effective = {
          ...effective,
          ...(appliedMeta.appliedAt !== undefined ? { appliedAt: appliedMeta.appliedAt } : {}),
          ...(appliedMeta.appliedRevision !== undefined ? { appliedRevision: appliedMeta.appliedRevision } : {}),
          ...(appliedMeta.targetChanged !== undefined ? { targetChanged: appliedMeta.targetChanged } : {}),
        };
      }
      if (advanced && effective.to !== start) {
        replayedIds.add(id);
      }
      normalized.push(effective);
    }
  }
  return {
    transitions: normalized,
    replayedIds,
    ...(duplicateIds.length > 0
      ? {
          normalization: {
            duplicateIds,
            originalSequences,
            originalCount: transitions.length,
            normalizedCount: normalized.length,
          },
        }
      : {}),
    conflicts,
  };
}

/**
 * 对计划条目应用一批状态流转（纯函数；非法流转抛错并列出全部违规项，
 * 不做部分应用——状态损坏应当被发现而不是被吞掉）。
 *
 * M9.7.6 P0：同 id 多条声明先经 normalizeRevisionItemTransitions 确定性合并
 * （幂等重述 collapse / 合法路径 replay；矛盾序列结构化拒绝）——可恢复的
 * 重复声明（如一条 finding 命中多个修订目标产生的重复 applied）不再杀死
 * 整个 workflow，真正的矛盾仍如实抛错进既有 repair / retry。
 *
 * 每次流转都会补写 resolvedAt（终态类流转）与 resolution
 * （`{reason}：{detail}`，供 UI / 审计解释条目为什么停在这个状态）。
 */
export function applyRevisionItemTransitions(
  plan: RevisionPlan,
  transitions: readonly RevisionItemTransition[],
  now: string,
): ApplyTransitionsResult {
  // M9.10 Phase 1：计划本体 schema 断言——重复 id / 非法 status 的计划在流转
  // 前拒绝（同 id 条目会让 byId 匹配与归一化路径产生未定义行为）
  const shapeViolations = validateRevisionPlanShape(plan);
  if (shapeViolations.length > 0) {
    throw new RevisionProtocolError(
      shapeViolations[0]?.code === "invalid_item_status" && !shapeViolations.some((v) => v.code === "duplicate_item_id")
        ? "invalid_item_status"
        : "duplicate_item_id",
      shapeViolations,
      `修订计划 schema 违规（${shapeViolations.map((violation) => `${violation.id ?? "?"}: ${violation.detail}`).join("；")}）`,
    );
  }
  const { transitions: normalized, replayedIds, normalization, conflicts } =
    normalizeRevisionItemTransitions(plan, transitions);
  if (conflicts.length > 0) {
    // M9.10：结构化拒绝（重复声明无法构成合法路径）；message 口径不变
    throw new RevisionProtocolError(
      "duplicate_conflict",
      conflicts.map((conflict) => ({ detail: conflict })),
      `revision item transitions 存在无法归一的重复声明（${conflicts.join("；")}）`,
    );
  }
  const byId = new Map(normalized.map((transition) => [transition.id, transition]));
  const illegal: string[] = [];
  const illegalViolations: RevisionProtocolViolation[] = [];
  for (const transition of normalized) {
    const item = plan.items.find((candidate) => candidate.id === transition.id);
    if (item === undefined) {
      illegal.push(`条目 ${transition.id} 不在计划 ${plan.planId} 中`);
      illegalViolations.push({
        code: "unknown_item",
        id: transition.id,
        to: transition.to,
        detail: `不在计划 ${plan.planId} 中`,
      });
      continue;
    }
    if (
      !replayedIds.has(transition.id) &&
      transition.to !== item.status &&
      !canTransitionRevisionItem(item.status, transition.to)
    ) {
      illegal.push(`${item.id}: ${item.status} → ${transition.to} 不是合法流转`);
      illegalViolations.push({
        code: "illegal_transition",
        id: item.id,
        from: item.status,
        to: transition.to,
        detail: "不是合法流转",
      });
    }
  }
  if (illegal.length > 0) {
    throw new RevisionProtocolError(
      illegalViolations.some((violation) => violation.code === "illegal_transition")
        ? "illegal_transition"
        : "unknown_item",
      illegalViolations,
      `非法的 revision item 状态流转（${illegal.join("；")}）`,
    );
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
      // 多步 replay（同批 applied → 终态）：沿途 applied 元数据随终态落盘（审计对齐）
      ...(transition.appliedAt !== undefined ? { appliedAt: transition.appliedAt } : {}),
      ...(transition.appliedRevision !== undefined ? { appliedRevision: transition.appliedRevision } : {}),
      ...(transition.targetChanged !== undefined ? { targetChanged: transition.targetChanged } : {}),
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
  return {
    plan: changed ? { ...plan, items } : plan,
    changed,
    ...(normalization !== undefined ? { normalization } : {}),
  };
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
