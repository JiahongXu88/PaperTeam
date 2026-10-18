import { useState } from "react";

import { useExternalInstructions } from "../../hooks/queries.js";
import type { ExternalInstructionStatus } from "../../types/api.js";
import {
  ACTION_TYPE_LABEL,
  DISPOSITION_VIEW,
  type PlanConfirmItem,
  type PlanConfirmSummary,
  type PlanDisposition,
} from "./planConfirmView.js";

/**
 * M14.9.1 C0：改进计划确认面板。每条计划显式呈现 actionType、处置（将自动执行 / 需要作者决定 /
 * 不会执行）、原因、受影响章节、证据缺口与对应外部意见的当前闭环状态；未派发条目在批准前
 * 集中汇总并要求「已知悉」确认（由 HitlPanel 持有并持久化到 sessionStorage）。
 */

const COLLAPSED_COUNT = 12;

const INSTRUCTION_STATUS_LABEL: Record<ExternalInstructionStatus, { label: string; tone: "ok" | "info" | "warn" | "danger" | "neutral" }> = {
  pending: { label: "意见未闭环", tone: "neutral" },
  handled: { label: "意见已处理", tone: "ok" },
  partially_handled: { label: "意见部分处理", tone: "warn" },
  unresolved: { label: "意见未解决", tone: "warn" },
  conflict: { label: "意见与事实冲突", tone: "danger" },
  already_satisfied: { label: "意见已满足", tone: "ok" },
};

type Filter = "all" | "dispatched" | "not_dispatched";

const NOT_DISPATCHED: ReadonlySet<PlanDisposition> = new Set(["author_decision", "evidence_only", "not_executable"]);

export function PlanConfirmPayload({
  items,
  summary,
  feasibility,
  projectId,
  ack,
}: {
  items: PlanConfirmItem[];
  summary: PlanConfirmSummary;
  feasibility?: React.ReactNode;
  projectId?: string;
  ack: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const filtered = items.filter((item) =>
    filter === "all" ? true : filter === "dispatched" ? !NOT_DISPATCHED.has(item.disposition) : NOT_DISPATCHED.has(item.disposition));
  const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_COUNT);
  const notDispatched = items.filter((item) => NOT_DISPATCHED.has(item.disposition));
  return (
    <div className="hitl-payload" data-testid="hitl-payload-plan">
      {feasibility}
      <p className="hitl-payload-level" data-testid="hitl-plan-count">
        共 {summary.total} 条计划条目{summary.total > summary.shown ? `（此处展示前 ${summary.shown} 条，其余请在「修订计划」面板查看后再批准）` : ""}
      </p>
      <p className="hitl-plan-summary" data-testid="hitl-plan-summary">
        {(Object.keys(DISPOSITION_VIEW) as PlanDisposition[])
          .filter((disposition) => summary.byDisposition[disposition] > 0)
          .map((disposition) => (
            <span key={disposition} className={`status status-tone-${DISPOSITION_VIEW[disposition].tone}`} data-testid={`hitl-plan-summary-${disposition}`}>
              {DISPOSITION_VIEW[disposition].label} {summary.byDisposition[disposition]}
            </span>
          ))}
      </p>
      {notDispatched.length > 0 ? (
        <div className="hitl-plan-undispatched" role="note" data-testid="hitl-plan-undispatched">
          <p className="hitl-plan-undispatched-lead">
            批准后，以下 {notDispatched.length} 条<strong>不会</strong>在本轮自动执行，对应意见保持未闭环（批准不会改变动作类型，也不会绕过事实 / 证据守卫）：
          </p>
          <ul>
            {notDispatched.map((item) => (
              <li key={`nd-${item.index}`} data-testid={`hitl-plan-undispatched-${item.index}`}>
                <span className="mono">{item.logicalSection ?? item.section}</span>
                <span className="chip chip-tone-neutral mono">{ACTION_TYPE_LABEL[item.actionType]}</span>
                <span>{item.rationale ?? DISPOSITION_VIEW[item.disposition].help}</span>
              </li>
            ))}
          </ul>
          <p className="field-help">如需让某条进入自动修改，请用「修改计划」写明依据，由 Planner 重新生成计划；需要新证据的条目只能在补充证据后再修改。</p>
          <label className="hitl-plan-ack">
            <input type="checkbox" checked={ack.checked} onChange={(event) => ack.onChange(event.target.checked)} data-testid="hitl-plan-ack" />
            我已知悉以上 {notDispatched.length} 条不会自动执行
          </label>
        </div>
      ) : null}
      <div className="hitl-plan-filter" role="group" aria-label="按处置筛选计划条目">
        {(["all", "dispatched", "not_dispatched"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="btn btn-small"
            aria-pressed={filter === value}
            data-testid={`hitl-plan-filter-${value}`}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? `全部 ${items.length}` : value === "dispatched" ? `将执行 / 不改稿 ${items.length - notDispatched.length}` : `不会执行 ${notDispatched.length}`}
          </button>
        ))}
      </div>
      <ol className="hitl-plan-list" data-testid="hitl-plan-items">
        {visible.map((item) => (
          <PlanItemRow key={`${item.index}-${item.section}`} item={item} {...(projectId !== undefined ? { projectId } : {})} />
        ))}
      </ol>
      {filtered.length > COLLAPSED_COUNT ? (
        <button
          type="button"
          className="btn-link"
          aria-expanded={expanded}
          data-testid="hitl-plan-expand"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : `展开全部 ${filtered.length} 条`}
        </button>
      ) : null}
    </div>
  );
}

function PlanItemRow({ item, projectId }: { item: PlanConfirmItem; projectId?: string }) {
  const view = DISPOSITION_VIEW[item.disposition];
  return (
    <li value={item.index + 1} data-testid={`hitl-plan-item-${item.index}`} data-disposition={item.disposition}>
      <span className="hitl-plan-section mono">
        {item.section}
        {item.logicalSection !== null ? ` · ${item.logicalSection}` : ""}
      </span>
      <span className="hitl-plan-action">{item.action}</span>
      {item.priority !== null ? <span className={`chip chip-tone-${planPriorityTone(item.priority)}`}>{planPriorityLabel(item.priority)}</span> : null}
      <span className="chip chip-tone-neutral mono" data-testid={`hitl-plan-action-type-${item.index}`} title="Planner 给出的动作类型">
        {ACTION_TYPE_LABEL[item.actionType]}
      </span>
      <span className={`status status-tone-${view.tone}`} data-testid={`hitl-plan-disposition-${item.index}`} title={view.help}>
        {view.label}
      </span>
      {item.evidenceGap ? (
        <span className="status status-tone-warn" data-testid={`hitl-plan-evidence-gap-${item.index}`}>声明改动事实但无关联证据</span>
      ) : item.relatedEvidenceIds.length > 0 ? (
        <span className="muted">关联证据 {item.relatedEvidenceIds.length}</span>
      ) : null}
      {projectId !== undefined && item.instructionId !== null ? <InstructionStatus projectId={projectId} instructionId={item.instructionId} /> : null}
      {item.rationale !== null || item.targetQuote !== null ? (
        <details className="details-block hitl-plan-details">
          <summary>{NOT_DISPATCHED.has(item.disposition) ? "不执行原因与依据" : "理由与定位"}</summary>
          <div className="details-body">
            {item.rationale !== null ? <p>{item.rationale}</p> : null}
            {item.targetQuote !== null ? <p className="field-help">定位原文：<span className="mono">{item.targetQuote}</span></p> : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

function InstructionStatus({ projectId, instructionId }: { projectId: string; instructionId: string }) {
  const query = useExternalInstructions(projectId);
  const linked = query.data?.instructions.find((instruction) => instruction.instructionId === instructionId);
  if (linked === undefined) return null;
  const view = INSTRUCTION_STATUS_LABEL[linked.status];
  return (
    <span className={`status status-tone-${view.tone}`} data-testid={`hitl-plan-instruction-${instructionId}`} title={linked.statusNote ?? ""}>
      {view.label}
    </span>
  );
}

export function planPriorityTone(priority: string): "danger" | "warn" | "neutral" {
  if (priority === "high") return "danger";
  if (priority === "low") return "neutral";
  return "warn";
}

export function planPriorityLabel(priority: string): string {
  if (priority === "high") return "优先处理";
  if (priority === "low") return "较低优先";
  return "常规";
}
