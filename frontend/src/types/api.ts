/**
 * 前端 DTO（docs/API_CONTRACT.md 的前端侧）。
 *
 * React 不直接依赖 Backend 内部对象（Pi 会话 / 事件 / WorkflowState 全量），
 * 只消费这里声明的视图类型；字段与 Backend JSON 响应逐一对齐，可选字段保持可选。
 */

import type { PaperDocSummary } from "./paper.js";

// ---- Project ----

/** 一级工作流类型（Backend workflow/types.ts WorkflowKind） */
export type WorkflowKind =
  | "idea_to_paper"
  | "existing_paper_improvement"
  | "existing_paper_review";

/** 项目状态（project.json status） */
export type ProjectStatus = "created" | "generated" | "failed";

/** 项目列表条目 / 项目详情（Backend project.json 全量返回，两者同形） */
export interface ProjectView {
  id: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  workflowKind?: WorkflowKind;
  /** 生命周期：归档时间（存在 = 已归档；默认列表不显示） */
  archivedAt?: string;
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

/** 已有论文导入目标（UI 两个入口的内部映射，不进 prompt） */
export type ExistingPaperGoal = "review_only" | "improvement";

/** POST /api/projects/import-pdf 输入（File First：PDF + goal，其余可选） */
export interface ImportProjectPdfInput {
  fileName: string;
  contentBase64: string;
  goal: ExistingPaperGoal;
  researchField?: string;
  targetVenue?: string;
  targetProfile?: string;
  language?: string;
}

/** POST /api/projects/import-pdf 响应 */
export interface ImportProjectPdfResult {
  project: ProjectView;
  /** 解析后的文档摘要（与 GET /paper 的 document 同形） */
  document: PaperDocSummary;
  /** 项目标题来源：PDF 内标题 / 文件名兜底 */
  titleSource: "pdf" | "filename";
}

// ---- WorkflowRun（前端只消费列表级摘要） ----

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
  completion?: { label: "final" | "draft" | "review" } | null;
  /** 当前 stage 的进度快照（如分章节审阅的 index / total / findings） */
  progress?: { stageId: string; data: Record<string, unknown>; updatedAt: string } | null;
}

// ---- Existing-Paper Review（existing_paper_review 聚合报告） ----

/** 单条 ReviewFinding（Backend review/finding.ts） */
export interface ReviewFindingView {
  findingId: string;
  category: "fact" | "academic" | "style" | "citation" | "consistency";
  severity: "critical" | "major" | "minor" | "info";
  sectionId?: string;
  page?: number;
  claimText?: string;
  message: string;
  suggestion?: string;
  status: "open" | "resolved" | "dismissed";
  source: string;
}

/** GET /api/projects/:id/paper-review 的聚合报告（无报告为 null） */
export interface ExistingReviewReportView {
  schemaVersion: number;
  kind: "existing_paper_review";
  round: number;
  generatedAt: string;
  paper: { title: string; pageCount?: number; sections?: number };
  review: {
    sectionsReviewed: number;
    sectionsTotal: number;
    skippedSections?: number;
    /** 没有正文的章节（只有标题，如仅含子节的章）：计入 skippedSections */
    emptySections?: number;
    /** 模型调用多次失败、未能审阅的章节数（不计入 sectionsReviewed） */
    failedSections?: number;
    findingsTotal: number;
    parseFailures?: number;
    dropped?: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
  };
  citationIntegrity: {
    metadataByStatus?: Record<string, number>;
    semantic?: Record<string, unknown>;
    probableFabrications?: string[];
  };
  findings: ReviewFindingView[];
}

// ---- Runtime Status（Pi schema） ----

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
  /** 外部工具链就绪度（旧 Backend 可能缺省） */
  tools?: {
    pdfParser: {
      phase: "ready" | "unavailable" | "unknown";
      detail: string;
      pythonVersion?: string;
      pymupdfVersion?: string;
    };
  };
}

// ---- Model Settings（GET 永不返回 key 本体） ----

/** 模型配置生效来源（env > 本地保存 > 未配置） */
export type ModelConfigurationSource = "environment" | "stored" | "not_configured";

/** GET /api/settings/model 的 settings DTO（无任何 key 字段） */
export interface ModelSettingsView {
  provider?: string;
  /** model-id 段（provider 之后整体；可含 "/"，如 openrouter 的 anthropic/claude-sonnet-4） */
  modelId?: string;
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
  /** builtin = Pi 内置 / models.json；custom = 设置页添加的自定义提供商 */
  source: "builtin" | "custom";
}

/** 自定义提供商可选的接口协议（与 Backend CUSTOM_PROVIDER_APIS 一致） */
export type CustomProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface CustomProviderModelInput {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: Array<"text" | "image">;
}

/** PUT /api/settings/model/custom-providers/:id 的 provider 字段 */
export interface CustomProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  authHeader: boolean;
  headers: Record<string, string>;
  models: CustomProviderModelInput[];
}

/** GET /api/settings/model/custom-providers 条目（不含 key） */
export interface CustomProviderView extends CustomProviderInput {
  updatedAt: string;
  authConfigured: boolean;
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

/** Test Connection 失败分类（Backend ModelTestResultCode） */
export type ModelTestResultCode =
  | "AUTH_FAILED"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNKNOWN";

/** POST /api/settings/model/test 的结果 */
export interface ModelTestResultView {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs?: number;
  code?: ModelTestResultCode;
  detail?: string;
}

// ---- 通用 ----

/** Backend 统一错误响应体：{status:"error", error:{code,message,detail?}} */
export interface ApiErrorBody {
  status: "error";
  error: { code: string; message: string; detail?: string };
}
