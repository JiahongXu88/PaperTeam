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

// ---- Model Settings（M4.3.7.5；GET 永不返回 key 本体） ----

/** 模型配置生效来源（env > 本地保存 > 未配置） */
export type ModelConfigurationSource = "environment" | "stored" | "not_configured";

/** GET /api/settings/model 的 settings DTO（无任何 key 字段） */
export interface ModelSettingsView {
  provider?: string;
  model?: string;
  savedModel?: string;
  apiKeyConfigured: boolean;
  apiKeySource: "environment" | "stored" | "none";
  configurationSource: ModelConfigurationSource;
  envOverride: boolean;
  runtimePhase: "healthy" | "unhealthy";
  runtimeVersion: string;
  modelPhase: "configured" | "not_configured" | "unknown";
  modelDetail: string;
  detail: string;
}

/** provider 目录条目（安全 metadata） */
export interface ModelProviderOptionView {
  id: string;
  name: string;
  authConfigured: boolean;
  apiKeyLoginSupported: boolean;
  modelCount: number;
}

/** 单个模型目录条目（安全 metadata） */
export interface ModelOptionView {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
}

/** GET /api/settings/model/options（?provider= 时返回该 provider 的模型） */
export type ModelOptionsView =
  | { providers: ModelProviderOptionView[] }
  | { provider: ModelProviderOptionView; models: ModelOptionView[] };

/** POST /api/settings/model/test 的结果（失败分类稳定） */
export interface ModelTestResultView {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs?: number;
  code?: string;
  detail?: string;
}

// ---- 通用 ----

/** Backend 统一错误响应体：{status:"error", error:{code,message,detail?}} */
export interface ApiErrorBody {
  status: "error";
  error: { code: string; message: string; detail?: string };
}
