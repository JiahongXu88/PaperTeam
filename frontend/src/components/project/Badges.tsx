import { Icon } from "../common/Icon.js";
import { RegistryStatus } from "../common/StatusBadge.js";
import { PROJECT_STATUS_STYLES, RUN_STATUS_STYLES, statusStyleOf } from "../common/status.js";
import { WORKFLOW_KIND_LABELS } from "../../constants/projectMeta.js";
import type { ProjectStatus, WorkflowKind, WorkflowRunStatus } from "../../types/api.js";

/** 项目类型：白底描边小标（不是状态，不上语义色） */
export function WorkflowKindBadge({ kind }: { kind: WorkflowKind | undefined }) {
  // 历史项目可能缺 workflowKind，按默认主线展示
  return (
    <span className="chip chip-outline">
      <Icon name="document" />
      {WORKFLOW_KIND_LABELS[kind ?? "idea_to_paper"]}
    </span>
  );
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus | undefined }) {
  if (status === undefined) {
    return null;
  }
  return <RegistryStatus style={statusStyleOf(PROJECT_STATUS_STYLES, status)} />;
}

export function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  return <RegistryStatus style={statusStyleOf(RUN_STATUS_STYLES, status)} />;
}
