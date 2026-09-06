import { apiClient } from "./client.js";
import type { WorkflowKind, WorkflowRunView } from "../types/api.js";

/**
 * WorkflowRun API（M4.2：只消费列表摘要；Live View / SSE 属于 M4.3）。
 *
 *   GET  /api/runs?projectId=xxx → { runs: WorkflowState[] }
 *   POST /api/projects/:id/workflows { kind } → 202 { runId }
 *
 * Backend 返回的是完整 WorkflowState（checkpoint 全量）；这里显式映射为
 * WorkflowRunView 子集，避免前端依赖内部字段（stageResults / inputs 等）。
 */

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "idea_to_paper",
  "existing_paper_improvement",
  "existing_paper_review",
]);

function toRunView(raw: Record<string, unknown>): WorkflowRunView {
  const kind = raw["workflowKind"];
  return {
    runId: String(raw["runId"] ?? ""),
    projectId: String(raw["projectId"] ?? ""),
    workflowKind: (typeof kind === "string" && KNOWN_KINDS.has(kind) ? kind : "idea_to_paper") as WorkflowKind,
    status: (raw["status"] as WorkflowRunView["status"]) ?? "pending",
    ...(typeof raw["currentStage"] === "string" ? { currentStage: raw["currentStage"] } : {}),
    createdAt: String(raw["createdAt"] ?? ""),
    updatedAt: String(raw["updatedAt"] ?? ""),
    awaiting: (raw["awaiting"] as WorkflowRunView["awaiting"]) ?? null,
    error: (raw["error"] as WorkflowRunView["error"]) ?? null,
    completion: (raw["completion"] as WorkflowRunView["completion"]) ?? null,
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

