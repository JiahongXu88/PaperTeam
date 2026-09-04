/**
 * Frontend DTO（M4.0 API Contract 的前端侧）。
 *
 * 原则（docs/API_CONTRACT.md）：React 不直接依赖 Backend 内部对象
 * （Pi AgentSession / Pi event / AgentRunHandle / WorkflowState 全量等），
 * 只消费这里声明的视图类型；新增字段必须先落到 API Contract 文档。
 * 字段与 Backend JSON 响应逐一对齐，可选字段保持可选（不虚构数据）。
 */

// ---- Project ----

/** 一级工作流类型（Backend workflow/types.ts WorkflowKind） */
export type WorkflowKind = "idea_to_paper" | "existing_paper_improvement";

/** 项目状态（project.json status） */
export type ProjectStatus = "created" | "generated" | "failed";

/** 项目列表条目 / 项目详情（Backend project.json 全量返回，M4.0 两者同形） */
export interface ProjectView {
  id: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  workflowKind?: WorkflowKind;
  researchIdea?: string;
  researchField?: string;
  documentType?: string;
  targetProfile?: string;
  targetVenue?: string;
  language?: string;
}

/** 创建项目输入（Backend readResearchMeta 接受的字段） */
export interface CreateProjectInput {
  title: string;
  workflowKind?: WorkflowKind;
  researchIdea?: string;
  researchField?: string;
  documentType?: string;
  targetProfile?: string;
  targetVenue?: string;
  language?: string;
}

// ---- WorkflowRun（M4.2 只消费列表级摘要；完整 Live View 属于 M4.3） ----

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/** Run 摘要（GET /api/runs?projectId= 的逐条映射，只保留 UI 消费的子集） */
export interface WorkflowRunView {
  runId: string;
  projectId: string;
  workflowKind: WorkflowKind;
  status: WorkflowRunStatus;
  currentStage?: string;
  createdAt: string;
  updatedAt: string;
  awaiting?: { stageId: string; prompt: string; options: string[] } | null;
  error?: { code: string; message: string } | null;
  completion?: { label: "final" | "draft" } | null;
}

// ---- Runtime Status（M3.8 去 Gateway 化后的 Pi schema） ----

export interface RuntimeStatusView {
  backend: { ok: true };
  runtime: {
    provider: "pi";
    phase: "healthy" | "unhealthy";
    version: string;
    detail: string;
    latencyMs: number | null;
  };
  model: {
    phase: "configured" | "not_configured" | "unknown";
    model?: string;
    providers: string[];
    detail: string;
  };
  agents: {
    roles: Array<{ role: string; agentId: string; status: "configured" | "missing" }>;
  };
  sessions: {
    activeRuns: number;
    managedSessions: number;
  };
}

// ---- 通用 ----

/** Backend 统一错误响应体：{status:"error", error:{code,message,detail?}} */
export interface ApiErrorBody {
  status: "error";
  error: { code: string; message: string; detail?: string };
}
