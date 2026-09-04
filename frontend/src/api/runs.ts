import { apiClient } from "./client.js";
import type { WorkflowRunView } from "../types/api.js";

/**
 * WorkflowRun API（M4.2：只消费列表摘要；Live View / SSE 属于 M4.3）。
 *
 *   GET /api/runs?projectId=xxx → { runs: WorkflowState[] }
 *
 * Backend 返回的是完整 WorkflowState（checkpoint 全量）；这里显式映射为
 * WorkflowRunView 子集，避免前端依赖内部字段（stageResults / inputs 等）。
 */

function toRunView(raw: Record<string, unknown>): WorkflowRunView {
  return {
    runId: String(raw["runId"] ?? ""),
    projectId: String(raw["projectId"] ?? ""),
    workflowKind:
      raw["workflowKind"] === "existing_paper_improvement"
        ? "existing_paper_improvement"
        : "idea_to_paper",
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
