import { apiClient } from "./client.js";
import type {
  CitationSemanticMode,
  WorkflowKind,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStageRecordView,
} from "../types/api.js";

/**
 * WorkflowRun API。
 *
 *   GET  /api/runs?projectId=xxx → { runs: WorkflowState[] }
 *   POST /api/projects/:id/workflows { kind, citationSemanticMode? } → 202 { runId }
 *   POST /api/runs/:runId/cancel → { run }（cancelled 后重复取消幂等 200）
 *
 * Backend 返回完整 WorkflowState（checkpoint 全量）；这里逐字段校验后映射为
 * WorkflowRunView 子集，前端不依赖 stageResults / inputs 等内部字段。
 */

const KNOWN_KINDS: ReadonlySet<string> = new Set<WorkflowKind>([
  "idea_to_paper",
  "existing_paper_improvement",
  "existing_paper_review",
]);

const KNOWN_SEMANTIC_MODES: ReadonlySet<string> = new Set<CitationSemanticMode>([
  "off",
  "contradiction_only",
  "full",
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
  return {
    code: typeof value["code"] === "string" ? value["code"] : "UNKNOWN",
    message: value["message"],
    ...(typeof value["stageId"] === "string" ? { stageId: value["stageId"] } : {}),
  };
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

/** 语义核验模式（run.request 快照；旧 run 无该字段 → full，与后端兼容语义一致） */
function readSemanticMode(raw: Record<string, unknown>): CitationSemanticMode | undefined {
  const request = raw["request"];
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return "full";
  }
  const mode = (request as Record<string, unknown>)["citationSemanticMode"];
  if (mode === undefined) {
    return "full"; // 旧版本创建的 run 实际始终执行完整语义核验
  }
  return typeof mode === "string" && KNOWN_SEMANTIC_MODES.has(mode as CitationSemanticMode)
    ? (mode as CitationSemanticMode)
    : undefined;
}

/** stageHistory 条目：只保留时间线 / 详细信息需要的字段（summary 提炼数字白名单） */
function readStageRecord(value: unknown): WorkflowStageRecordView | null {
  if (!isRecord(value) || typeof value["stageId"] !== "string" || typeof value["status"] !== "string") {
    return null;
  }
  const error = isRecord(value["error"])
    ? {
        code: typeof value["error"]["code"] === "string" ? value["error"]["code"] : "",
        message: typeof value["error"]["message"] === "string" ? value["error"]["message"] : "",
      }
    : null;
  const summary = isRecord(value["summary"]) ? value["summary"] : undefined;
  const summaryNumbers: Record<string, number> = {};
  if (summary !== undefined) {
    for (const [key, entry] of Object.entries(summary)) {
      if (typeof entry === "number") {
        summaryNumbers[key] = entry;
      }
    }
  }
  const telemetry = isRecord(summary?.["concurrencyTelemetry"])
    ? (summary!["concurrencyTelemetry"] as Record<string, unknown>)
    : undefined;
  const concurrency =
    telemetry !== undefined &&
    typeof telemetry["reviewConcurrency"] === "number" &&
    typeof telemetry["maxObservedConcurrency"] === "number"
      ? { configured: telemetry["reviewConcurrency"], maxObserved: telemetry["maxObservedConcurrency"] }
      : undefined;
  return {
    stageId: value["stageId"],
    attempt: typeof value["attempt"] === "number" ? value["attempt"] : 1,
    status: value["status"] === "failed" ? "failed" : "completed",
    startedAt: typeof value["startedAt"] === "string" ? value["startedAt"] : "",
    finishedAt: typeof value["finishedAt"] === "string" ? value["finishedAt"] : "",
    ...(error !== null ? { error } : {}),
    ...(Object.keys(summaryNumbers).length > 0 ? { summaryNumbers } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
}

function toRunView(raw: Record<string, unknown>): WorkflowRunView {
  const kind = raw["workflowKind"];
  const status = raw["status"];
  const citationSemanticMode = readSemanticMode(raw);
  const stageHistory = Array.isArray(raw["stageHistory"])
    ? raw["stageHistory"].map(readStageRecord).filter((record): record is WorkflowStageRecordView => record !== null)
    : [];
  return {
    runId: String(raw["runId"] ?? ""),
    projectId: String(raw["projectId"] ?? ""),
    workflowKind: typeof kind === "string" && KNOWN_KINDS.has(kind) ? (kind as WorkflowKind) : "idea_to_paper",
    status: typeof status === "string" && KNOWN_STATUSES.has(status) ? (status as WorkflowRunStatus) : "pending",
    ...(typeof raw["currentStage"] === "string" ? { currentStage: raw["currentStage"] } : {}),
    createdAt: String(raw["createdAt"] ?? ""),
    updatedAt: String(raw["updatedAt"] ?? ""),
    ...(typeof raw["startedAt"] === "string" ? { startedAt: raw["startedAt"] } : {}),
    ...(typeof raw["finishedAt"] === "string" ? { finishedAt: raw["finishedAt"] } : {}),
    awaiting: readAwaiting(raw["awaiting"]),
    error: readError(raw["error"]),
    completion: readCompletion(raw["completion"]),
    progress: readProgress(raw["progress"]),
    ...(Array.isArray(raw["completedStages"])
      ? {
          completedStages: raw["completedStages"].filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
    ...(stageHistory.length > 0 ? { stageHistory } : {}),
    ...(citationSemanticMode !== undefined ? { citationSemanticMode } : {}),
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

/** 启动 WorkflowRun（existing_paper_review = PDF 快速 Review；citationSemanticMode 缺省 off） */
export async function createWorkflowRun(
  projectId: string,
  kind: WorkflowKind,
  options: { citationSemanticMode?: CitationSemanticMode } = {},
): Promise<{ runId: string; status: string; workflowKind: WorkflowKind }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
    kind,
    ...(options.citationSemanticMode !== undefined ? { citationSemanticMode: options.citationSemanticMode } : {}),
  });
}

/**
 * 取消 WorkflowRun。后端语义：立即 abort 在途模型调用、停止派发未开始的
 * 章节 / stage，循环检查点终结后落盘 cancelled。已是 cancelled 的重复取消
 * 幂等返回当前状态（200）；completed / failed → 409。
 */
export async function cancelWorkflowRun(runId: string): Promise<WorkflowRunView> {
  const body = await apiClient.post<{ run: Record<string, unknown> }>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
  return toRunView(body.run ?? {});
}

