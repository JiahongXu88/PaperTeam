import { apiClient } from "./client.js";
import type { WorkflowKind, WorkflowRunStatus, WorkflowRunView } from "../types/api.js";

/**
 * WorkflowRun API。
 *
 *   GET  /api/runs?projectId=xxx → { runs: WorkflowState[] }
 *   POST /api/projects/:id/workflows { kind } → 202 { runId }
 *
 * Backend 返回完整 WorkflowState（checkpoint 全量）；这里逐字段校验后映射为
 * WorkflowRunView 子集，前端不依赖 stageResults / inputs 等内部字段。
 */

const KNOWN_KINDS: ReadonlySet<string> = new Set<WorkflowKind>([
  "idea_to_paper",
  "existing_paper_improvement",
  "existing_paper_review",
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>([
  "pending",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(value: unknown): WorkflowRunView["error"] {
  if (!isRecord(value) || typeof value["message"] !== "string") {
    return null;
  }
  return { code: typeof value["code"] === "string" ? value["code"] : "UNKNOWN", message: value["message"] };
}

function readAwaiting(value: unknown): WorkflowRunView["awaiting"] {
  if (!isRecord(value) || typeof value["stageId"] !== "string") {
    return null;
  }
  return {
    stageId: value["stageId"],
    prompt: typeof value["prompt"] === "string" ? value["prompt"] : "",
    options: Array.isArray(value["options"]) ? value["options"].filter((o): o is string => typeof o === "string") : [],
  };
}

function readCompletion(value: unknown): WorkflowRunView["completion"] {
  if (!isRecord(value)) {
    return null;
  }
  const label = value["label"];
  return label === "final" || label === "draft" || label === "review" ? { label } : null;
}

function readProgress(value: unknown): WorkflowRunView["progress"] {
  if (!isRecord(value) || typeof value["stageId"] !== "string" || !isRecord(value["data"])) {
    return null;
  }
  return {
    stageId: value["stageId"],
    data: value["data"],
    updatedAt: typeof value["updatedAt"] === "string" ? value["updatedAt"] : "",
  };
}

function toRunView(raw: Record<string, unknown>): WorkflowRunView {
  const kind = raw["workflowKind"];
  const status = raw["status"];
  return {
    runId: String(raw["runId"] ?? ""),
    projectId: String(raw["projectId"] ?? ""),
    workflowKind: typeof kind === "string" && KNOWN_KINDS.has(kind) ? (kind as WorkflowKind) : "idea_to_paper",
    status: typeof status === "string" && KNOWN_STATUSES.has(status) ? (status as WorkflowRunStatus) : "pending",
    ...(typeof raw["currentStage"] === "string" ? { currentStage: raw["currentStage"] } : {}),
    createdAt: String(raw["createdAt"] ?? ""),
    updatedAt: String(raw["updatedAt"] ?? ""),
    awaiting: readAwaiting(raw["awaiting"]),
    error: readError(raw["error"]),
    completion: readCompletion(raw["completion"]),
    progress: readProgress(raw["progress"]),
  };
}

export async function listProjectRuns(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunView[]> {
  const body = await apiClient.get<{ runs: Record<string, unknown>[] }>(
    `/api/runs?projectId=${encodeURIComponent(projectId)}`,
    signal,
  );
  return (body.runs ?? []).map(toRunView);
}

/** 启动 WorkflowRun（existing_paper_review = PDF 快速 Review） */
export async function createWorkflowRun(
  projectId: string,
  kind: WorkflowKind,
): Promise<{ runId: string; status: string; workflowKind: WorkflowKind }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/workflows`, { kind });
}

