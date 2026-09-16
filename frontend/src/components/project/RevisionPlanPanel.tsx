import { useState } from "react";

import { useExternalInstructions, useRevisionPlan } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import type { RevisionPlanItemPriority, RevisionPlanItemView } from "../../types/api.js";

/**
 * 修订计划面板（M5.7）：确定性 RevisionPlan 的来源 / 优先级 / 状态展示。
 * 外部意见条目（mandatory · Reviewer 2）明显可识别；conflict / handled
 * 状态从外部意见存储按 instructionId 关联（计划是轮次快照，状态是活数据）。
 */

const PRIORITY_VIEW: Record<RevisionPlanItemPriority, { label: string; tone: "danger" | "warn" | "neutral" | "accent" }> = {
  mandatory: { label: "MUST", tone: "accent" },
  high: { label: "HIGH", tone: "danger" },
  medium: { label: "NORMAL", tone: "warn" },
  low: { label: "LOW", tone: "neutral" },
};

const KIND_LABEL: Record<RevisionPlanItemView["kind"], string> = {
  external_instruction: "外部修改意见",
  review_finding: "审稿问题",
  citation_missing: "引用缺失",
  citation_removed: "引用误删恢复",
  fact_preserve: "实验事实恢复",
  build_error: "编译错误",
  gate_blocker: "门禁阻止项",
};

const ITEM_STATUS_LABEL: Record<RevisionPlanItemView["status"], string> = {
  planned: "将派发",
  skipped: "不派发",
};

export function RevisionPlanPanel({ projectId }: { projectId: string }) {
  const planQuery = useRevisionPlan(projectId);
  const instructionsQuery = useExternalInstructions(projectId);
  const [showAll, setShowAll] = useState(false);

  const plan = planQuery.data?.plan ?? null;
  const instructions = instructionsQuery.data?.instructions ?? [];
  const items = plan?.items ?? [];
  const visible = showAll ? items : items.slice(0, 8);

  if (planQuery.isPending) {
    return null;
  }
  if (planQuery.isError) {
    return (
      <section className="section-block" data-testid="revision-plan-panel">
        <div className="section-head">
          <h2>修订计划</h2>
        </div>
        <p className="form-error" role="alert">
          加载失败：{formatApiError(planQuery.error)}
          <button type="button" className="btn-link" onClick={() => void planQuery.refetch()}>
            重试
          </button>
        </p>
      </section>
    );
  }
  if (plan === null) {
    return null; // 尚无修订计划（未跑改进 / 首轮未出计划）：不占位
  }

  return (
    <section className="section-block" data-testid="revision-plan-panel">
      <div className="section-head">
        <h2>修订计划</h2>
        <span className="muted">
          第 {plan.reviewRound} 轮 · 派发 {plan.summary.planned} / 记录 {plan.summary.skipped}
          {plan.summary.external !== undefined ? ` · 外部意见 ${plan.summary.external}` : ""}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="panel-empty">本轮计划为空。</p>
      ) : (
        <>
          <ul className="revision-plan-list" data-testid="revision-plan-items">
            {visible.map((item) => (
              <RevisionPlanRow key={item.id} item={item} instructions={instructions} />
            ))}
          </ul>
          {items.length > visible.length ? (
            <button type="button" className="btn-link" onClick={() => setShowAll(true)} data-testid="revision-plan-expand">
              展开全部 {items.length} 条
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function RevisionPlanRow({
  item,
  instructions,
}: {
  item: RevisionPlanItemView;
  instructions: { instructionId: string; status: string; conflictBasis?: string }[];
}) {
  const priority = PRIORITY_VIEW[item.priority];
  const linked =
    item.instructionId !== undefined
      ? instructions.find((instruction) => instruction.instructionId === item.instructionId)
      : undefined;
  const isExternal = item.source === "external";
  const conflict = linked?.status === "conflict";
  return (
    <li className={`revision-plan-item${isExternal ? " revision-plan-external" : ""}`} data-testid={`revision-plan-item-${item.id}`}>
      <div className="revision-plan-head">
        <span className={`chip chip-tone-${priority.tone}`}>{priority.label}</span>
        <span className="chip chip-tone-neutral">{KIND_LABEL[item.kind]}</span>
        {isExternal ? (
          <span className="status status-tone-info">
            {item.reviewerLabel !== undefined ? item.reviewerLabel : "外部意见"}
          </span>
        ) : (
          <span className="muted">内部审稿 / 确定性规则</span>
        )}
        {conflict ? <span className="status status-tone-warn">与事实冲突</span> : null}
        {linked?.status === "handled" ? <span className="status status-tone-ok">已处理</span> : null}
        <span className="muted mono revision-plan-section">{item.section}</span>
        <span className="muted">{ITEM_STATUS_LABEL[item.status]}</span>
      </div>
      <p className="revision-plan-problem">{item.problem}</p>
      {item.note !== undefined ? <p className="field-help">{item.note}</p> : null}
      {conflict && linked?.conflictBasis !== undefined ? (
        <p className="field-help">
          冲突依据：<span className="mono">{linked.conflictBasis}</span>
        </p>
      ) : null}
      {item.sourceText !== undefined ? (
        <details className="details-block">
          <summary>意见原文</summary>
          <div className="details-body">
            <pre className="external-instruction-text">{item.sourceText}</pre>
          </div>
        </details>
      ) : null}
    </li>
  );
}
