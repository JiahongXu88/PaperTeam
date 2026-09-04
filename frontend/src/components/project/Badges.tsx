import {
  PROJECT_STATUS_LABELS,
  RUN_STATUS_LABELS,
  WORKFLOW_KIND_LABELS,
} from "../../constants/projectMeta.js";
import type { ProjectStatus, WorkflowKind, WorkflowRunStatus } from "../../types/api.js";

/** 项目 / Run 状态徽标（M4.2）——只展示 Backend 真实字段，未知值原样显示 */

export function WorkflowKindBadge({ kind }: { kind: WorkflowKind | undefined }) {
  if (kind === undefined) {
    return <span className="badge badge-kind">Idea → Paper</span>;
  }
  return <span className="badge badge-kind">{WORKFLOW_KIND_LABELS[kind] ?? kind}</span>;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus | undefined }) {
  if (status === undefined) {
    return null;
  }
  const tone = status === "generated" ? "ok" : status === "failed" ? "error" : "muted";
  return (
    <span className={`badge badge-${tone}`}>
      {PROJECT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  const tone =
    status === "completed"
      ? "ok"
      : status === "failed"
        ? "error"
        : status === "running" || status === "awaiting_input"
          ? "info"
          : status === "cancelled"
            ? "muted"
            : "muted";
  return <span className={`badge badge-${tone}`}>{RUN_STATUS_LABELS[status] ?? status}</span>;
}
