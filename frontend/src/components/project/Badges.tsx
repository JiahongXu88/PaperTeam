import { RegistryStatus, StatusBadge } from "../common/StatusBadge.js";
import {
  PROJECT_STATUS_STYLES,
  RUN_STATUS_STYLES,
  statusStyleOf,
} from "../common/status.js";
import { WORKFLOW_KIND_LABELS } from "../../constants/projectMeta.js";
import type { ProjectStatus, WorkflowKind, WorkflowRunStatus } from "../../types/api.js";

/**
 * 项目 / Run 状态徽标（Visual Redesign 2026-09）。
 * 语义映射统一走 status.ts 注册表；未知值原样展示。
 */

export function WorkflowKindBadge({ kind }: { kind: WorkflowKind | undefined }) {
  // 历史项目可能缺 workflowKind，按默认主线（Idea → Paper）展示
  const label = WORKFLOW_KIND_LABELS[kind ?? "idea_to_paper"];
  return <span className="chip">{label}</span>;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus | undefined }) {
  if (status === undefined) {
    return null;
  }
  const style = statusStyleOf(PROJECT_STATUS_STYLES, status);
  return <RegistryStatus style={style} />;
}

export function RunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  const style = statusStyleOf(RUN_STATUS_STYLES, status);
  return <RegistryStatus style={style} />;
}

/** 独立 tone 状态（如「解析质量」）复用同一语言 */
export function PlainStatus({ label, tone }: { label: string; tone: "ok" | "warn" | "danger" }) {
  return <StatusBadge label={label} tone={tone} />;
}
