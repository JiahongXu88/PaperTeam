/**
 * M14.9.1 C0：改进计划确认（hitl.plan_confirm）的条目处置视图——纯函数。
 *
 * 处置口径逐条对齐后端派发过滤（workflow/definitions.ts collectRevisionDirectives）：
 *   modify                   → 将自动执行（派发 Writer；仍须通过范围 / 事实 / 引用 / 编译守卫）
 *   noop                     → 不改稿：主张基线已满足（引文核验不通过时转为作者决定）
 *   author_decision_required → 需要作者决定：本轮不会执行，意见保持未闭环
 *   evidence_only            → 只记录证据关联：不改稿，意见保持未闭环
 *   缺失 / 未识别            → 动作类型缺失：不会执行（REVISION_ACTION_TYPE_REQUIRED）
 * 批准计划不会改变任何条目的动作类型，也不会绕过守卫；改变处置只能经「修改计划」反馈让
 * Planner 重新生成。
 */

export type PlanActionType = "modify" | "noop" | "author_decision_required" | "evidence_only" | "missing";

export type PlanDisposition = "auto_execute" | "no_change_claimed" | "author_decision" | "evidence_only" | "not_executable";

export interface PlanConfirmItem {
  index: number;
  id: string | null;
  section: string;
  logicalSection: string | null;
  action: string;
  actionType: PlanActionType;
  rawActionType: string | null;
  disposition: PlanDisposition;
  rationale: string | null;
  priority: string | null;
  instructionId: string | null;
  relatedEvidenceIds: string[];
  expectedFactChanges: number;
  /** 计划条目声明要改动事实（expectedFactChanges）却没有任何关联证据 */
  evidenceGap: boolean;
  targetQuote: string | null;
}

export interface PlanConfirmSummary {
  total: number;
  shown: number;
  byDisposition: Record<PlanDisposition, number>;
  notDispatched: number;
}

export const DISPOSITION_VIEW: Record<PlanDisposition, { label: string; tone: "ok" | "info" | "warn" | "danger" | "neutral"; help: string }> = {
  auto_execute: { label: "将自动执行", tone: "ok", help: "批准后派发 Writer；补丁仍须通过范围、事实、引用与编译守卫，被拒的补丁不会落盘" },
  no_change_claimed: { label: "不改稿（主张已满足）", tone: "info", help: "Planner 认为现稿已覆盖该意见；系统会核验引文，核验失败则转为作者决定" },
  author_decision: { label: "需要作者决定 · 本轮不执行", tone: "warn", help: "批准计划不会执行此条，对应意见保持未闭环；如需改为自动修改，请用「修改计划」说明依据" },
  evidence_only: { label: "只记录证据 · 不改稿", tone: "warn", help: "只建立证据关联，不改动稿件；对应意见保持未闭环，待作者确认" },
  not_executable: { label: "动作类型缺失 · 不会执行", tone: "danger", help: "条目没有可识别的动作类型（REVISION_ACTION_TYPE_REQUIRED），后端会跳过派发" },
};

export const ACTION_TYPE_LABEL: Record<PlanActionType, string> = {
  modify: "modify",
  noop: "noop",
  author_decision_required: "author_decision_required",
  evidence_only: "evidence_only",
  missing: "（缺失）",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function actionTypeOf(value: unknown): PlanActionType {
  return value === "modify" || value === "noop" || value === "author_decision_required" || value === "evidence_only" ? value : "missing";
}

const DISPOSITION_OF: Record<PlanActionType, PlanDisposition> = {
  modify: "auto_execute",
  noop: "no_change_claimed",
  author_decision_required: "author_decision",
  evidence_only: "evidence_only",
  missing: "not_executable",
};

export function readPlanConfirmItems(payload: Record<string, unknown>): PlanConfirmItem[] {
  const raw = Array.isArray(payload["items"]) ? payload["items"] : [];
  const items: PlanConfirmItem[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const section = str(record["section"]);
    const action = str(record["action"]);
    if (section === null || action === null) return;
    const actionType = actionTypeOf(record["actionType"]);
    const relatedEvidenceIds = Array.isArray(record["relatedEvidenceIds"])
      ? record["relatedEvidenceIds"].filter((id): id is string => typeof id === "string")
      : [];
    const expectedFactChanges = Array.isArray(record["expectedFactChanges"]) ? record["expectedFactChanges"].length : 0;
    items.push({
      index,
      id: str(record["id"]),
      section,
      logicalSection: str(record["logicalSection"]),
      action,
      actionType,
      rawActionType: typeof record["actionType"] === "string" ? record["actionType"] : null,
      disposition: DISPOSITION_OF[actionType],
      rationale: str(record["rationale"]),
      priority: str(record["priority"]),
      instructionId: str(record["instructionId"]),
      relatedEvidenceIds,
      expectedFactChanges,
      evidenceGap: expectedFactChanges > 0 && relatedEvidenceIds.length === 0,
      targetQuote: str(record["targetQuote"]),
    });
  });
  return items;
}

export function summarizePlanConfirm(items: readonly PlanConfirmItem[], totalItems: number | undefined): PlanConfirmSummary {
  const byDisposition: Record<PlanDisposition, number> = { auto_execute: 0, no_change_claimed: 0, author_decision: 0, evidence_only: 0, not_executable: 0 };
  for (const item of items) byDisposition[item.disposition] += 1;
  return {
    total: totalItems !== undefined && totalItems > items.length ? totalItems : items.length,
    shown: items.length,
    byDisposition,
    notDispatched: byDisposition.author_decision + byDisposition.evidence_only + byDisposition.not_executable,
  };
}

/** 未派发确认的会话持久化键：同一 run + 同一计划内容（刷新后仍记得「已知悉」；计划被重做则失效） */
export function planAckStorageKey(runId: string, items: readonly PlanConfirmItem[]): string {
  let hash = 2166136261;
  const text = items.map((item) => `${item.id ?? item.index}|${item.actionType}|${item.section}|${item.action}`).join("\n");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `paperteam:plan-confirm-ack:${runId}:${hash.toString(36)}`;
}

/**
 * M15.20 P0：编辑契约预览（后端 hitl.plan_confirm payload.editContracts）：批准前如实展示每个可执行条目
 * 的可写范围、受保护数值、结构化值变更提案与审计硬禁改——计划文字本身不构成改数授权，只有逐项勾选的
 * 结构化值变更会随批准提交；服务端独立复核（伪造 / 计划外 / 旧计划 / 硬禁改 → 409）。
 */
export interface PlanEditContractPreview {
  itemId: string;
  target: string;
  scope: "anchors" | "whole_target";
  anchor: string | null;
  protectedValueCount: number;
  protectedValuesSample: string[];
  proposedValueChanges: Array<{ before: string; after: string; basis: string | null; blockedByHardFreeze: boolean }>;
  linkedAuditContract: { contractId: string; hardNumericFreeze: boolean; anchors: string[]; conflicts: string[] } | null;
  unstructuredValueChangeWarning: string | null;
  unenforceable: string | null;
}

export interface PlanValueChangeSelection {
  itemId: string;
  before: string;
  after: string;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function readPlanEditContracts(payload: Record<string, unknown>): PlanEditContractPreview[] {
  const raw = Array.isArray(payload["editContracts"]) ? payload["editContracts"] : [];
  const previews: PlanEditContractPreview[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const itemId = str(record["itemId"]);
    const target = str(record["target"]);
    if (itemId === null || target === null) continue;
    const audit = typeof record["linkedAuditContract"] === "object" && record["linkedAuditContract"] !== null
      ? (record["linkedAuditContract"] as Record<string, unknown>)
      : null;
    previews.push({
      itemId,
      target,
      scope: record["scope"] === "anchors" ? "anchors" : "whole_target",
      anchor: str(record["anchor"]),
      protectedValueCount: typeof record["protectedValueCount"] === "number" ? record["protectedValueCount"] : 0,
      protectedValuesSample: strArray(record["protectedValuesSample"]),
      proposedValueChanges: (Array.isArray(record["proposedValueChanges"]) ? record["proposedValueChanges"] : []).flatMap((change) => {
        if (typeof change !== "object" || change === null) return [];
        const c = change as Record<string, unknown>;
        return typeof c["before"] === "string" && typeof c["after"] === "string"
          ? [{ before: c["before"], after: c["after"], basis: str(c["basis"]), blockedByHardFreeze: c["blockedByHardFreeze"] === true }]
          : [];
      }),
      linkedAuditContract: audit !== null && typeof audit["contractId"] === "string"
        ? { contractId: audit["contractId"], hardNumericFreeze: audit["hardNumericFreeze"] === true, anchors: strArray(audit["anchors"]), conflicts: strArray(audit["conflicts"]) }
        : null,
      unstructuredValueChangeWarning: str(record["unstructuredValueChangeWarning"]),
      unenforceable: str(record["unenforceable"]),
    });
  }
  return previews;
}

/** 批准请求体：绑定所见计划版本 + 逐项勾选的结构化值变更（未提供哈希的旧 payload → 只批准范围） */
export function buildPlanApprovalPayload(payload: Record<string, unknown>, selected: readonly PlanValueChangeSelection[]): Record<string, unknown> {
  const planHash = str(payload["planHash"]);
  const approvalToken = str(payload["approvalToken"]);
  if (planHash === null || approvalToken === null) return {};
  return { planHash, approvalToken, approvedFactChanges: selected.map((change) => ({ itemId: change.itemId, before: change.before, after: change.after })) };
}

/** 需要作者额外知悉的契约提示（计划文本暗含改数 / 不可执行条目）——未知悉前不允许无条件批准 */
export function planContractNoticeCount(previews: readonly PlanEditContractPreview[]): number {
  return previews.filter((preview) => preview.unstructuredValueChangeWarning !== null || preview.unenforceable !== null).length;
}
