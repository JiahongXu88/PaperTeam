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

/**
 * 引用语义核验模式（Claim-Citation 一致性核验档位；Backend citation/semanticMode.ts）。
 * 引用真实性 / metadata 核验不受此模式影响（始终执行）。
 */
export type CitationSemanticMode = "off" | "contradiction_only" | "full";

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
  /** 实际开始执行 / 终态时间（pending 时无 startedAt；运行中无 finishedAt） */
  startedAt?: string;
  finishedAt?: string;
  /**
   * HITL 待办（checkpoint 持久化，刷新 / 重启后仍在）：stageId + 提示 + 允许的
   * decision + 该节点的业务上下文（如可行性结论 / 大纲 / 改进计划摘要）
   */
  awaiting?: {
    stageId: string;
    prompt: string;
    options: string[];
    payload?: Record<string, unknown>;
  } | null;
  error?: { code: string; message: string; stageId?: string } | null;
  completion?: { label: "final" | "draft" | "review" } | null;
  /** 当前 stage 的进度快照（如分章节审阅的 index / total / findings） */
  progress?: { stageId: string; data: Record<string, unknown>; updatedAt: string } | null;
  /** 已完成 stage id（按完成顺序；重复执行的 stage 只出现一次） */
  completedStages?: string[];
  /**
   * 前端富化字段（非后端 DTO）：当前 stage 的开始时间，来自 SSE stage.started
   * 事件 ts（含重连 replay），用于运行中阶段的耗时展示；无 SSE 时缺省
   */
  currentStageStartedAt?: string;
  /** 全部尝试记录（时间线 / 详细信息用；summary 只保留白名单数字字段） */
  stageHistory?: WorkflowStageRecordView[];
  /** 语义核验模式（existing_paper_review run 的 request 快照；旧 run 缺省 full） */
  citationSemanticMode?: CitationSemanticMode;
}

/** StageRecord 精简视图（不含 findings 等大 payload） */
export interface WorkflowStageRecordView {
  stageId: string;
  attempt: number;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  error?: { code: string; message: string } | null;
  /** 产出摘要中的数字字段（sectionsReviewed / findingsTotal / durationMs / 并发画像等） */
  summaryNumbers?: Record<string, number>;
  /** 并发画像（review.sections 特有：配置并发度 / 实际观测峰值） */
  concurrency?: { configured: number; maxObserved: number };
}

// ---- HITL Decision（POST /api/runs/:runId/resume 的前端侧类型） ----

/**
 * HITL 决策输入：action 严格来自当前 awaiting.options（后端按 WorkflowDefinition
 * 校验，非法 decision / 缺 payload → 409 WORKFLOW_INVALID_STATE）。
 * 各节点真实契约（backend workflow/definitions.ts）：
 *   approve       继续下一阶段（无 payload）
 *   adjust        仅 hitl.feasibility_confirm：targetProfile / targetVenue 至少一项
 *   revise        仅 hitl.outline_confirm / hitl.plan_confirm：非空 feedback
 *   accept_draft  仅 hitl.revision_overflow：知情接受当前稿
 *   revise_more   仅 hitl.revision_overflow：人工授权追加一轮修订
 *   cancel        取消整个 run（经 decision 通道，留档 inputs）
 */
export type HitlDecisionInput =
  | { action: "approve" }
  | { action: "adjust"; payload: { targetProfile?: string; targetVenue?: string } }
  | { action: "revise"; payload: { feedback: string } }
  | { action: "accept_draft" }
  | { action: "revise_more" }
  | { action: "cancel" };

// ---- Workflow Domain Event（SSE 载荷；业务事件，不透传 Pi Runtime 事件） ----

export type WorkflowDomainEventTypeView =
  | "workflow.started"
  | "stage.started"
  | "stage.progress"
  | "stage.completed"
  | "stage.failed"
  | "workflow.awaiting_input"
  | "workflow.resumed"
  | "workflow.recovered"
  | "workflow.cancelled"
  | "workflow.completed"
  | "workflow.failed"
  | "quality_gate.passed"
  | "quality_gate.failed"
  | "build_gate.passed"
  | "build_gate.failed";

export interface WorkflowDomainEventView {
  seq: number;
  type: WorkflowDomainEventTypeView | (string & {});
  runId: string;
  projectId: string;
  stageId?: string;
  attempt?: number;
  message?: string;
  data?: Record<string, unknown>;
  ts: string;
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
  /** 本轮语义核验模式（off 轮不携带 semantic 统计；旧报告缺省视为 full） */
  citationSemanticMode?: CitationSemanticMode;
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

// ---- Evidence（EvidenceStore 记录；Evidence Workbench 消费） ----

/** 证据核验状态（Backend EvidenceStore VerificationStatus；UI 标签集中映射，不改 Domain 枚举） */
export type EvidenceVerificationStatus =
  | "unverified"
  | "verified"
  | "plausible"
  | "mismatch"
  | "unverifiable"
  | "not_found";

/** 支撑强度（Quality Gate 的 no_contradictory_evidence 规则依据 contradictory） */
export type EvidenceSupportStrength = "direct" | "partial" | "indirect" | "contradictory";

/** 核验深度 */
export type EvidenceVerificationLevel = "metadata" | "abstract" | "fulltext" | "user_confirmed";

/** GET /api/projects/:id/evidence 的单条记录（列表与详情同形；一次请求返回列表所需全部字段） */
export interface EvidenceRecordView {
  id: string;
  claim: string;
  summary?: string;
  quote?: string;
  source?: {
    sourceId?: string;
    title?: string;
    authors?: string[];
    year?: number;
    doi?: string;
    url?: string;
  };
  location?: { page?: number; section?: string; chunk?: string };
  verificationStatus: EvidenceVerificationStatus;
  verificationMethod?: string;
  supportStrength?: EvidenceSupportStrength;
  verificationLevel?: EvidenceVerificationLevel;
  /** 辅助字段（0-1）；不参与 Quality Gate 判定，仅参考展示 */
  confidence?: number;
  relatedSections?: string[];
  usedBy?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

// ---- Quality Gate（确定性判定结果；frontend 只展示，不重算） ----

export interface QualityGateRuleView {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface QualityGateResultView {
  passed: boolean;
  reasons: string[];
  rules: QualityGateRuleView[];
  thresholds: { academicPassScore: number; styleRiskMax: number; requireFeasibility: boolean };
  checkedAt: string;
}

/** 每轮 gate 摘要（轮次切换器数据源；blockerCount = reasons.length） */
export interface QualityGateRoundView {
  round: number;
  passed: boolean;
  checkedAt: string;
  blockerCount: number;
}

/** gate 评估时消费的同轮三路审稿汇总（round 配对由产物结构保证） */
export interface ReviewSummaryView {
  generatedAt: string;
  round: number;
  counts: { critical: number; major: number; minor: number; blocking: number };
  scores: { academicScore: number | null; styleRisk: number | null };
  openCritical: number;
  openMajor: number;
  unsupportedCriticalClaims: number;
}

/** GET /api/projects/:id/quality-gate[?round=N] 的响应（尚无产物时 gate / reviewSummary / round 为 null） */
export interface QualityGateResponseView {
  rounds: QualityGateRoundView[];
  round: number | null;
  gate: QualityGateResultView | null;
  reviewSummary: ReviewSummaryView | null;
  /** 最新三路审稿轮次；大于当前 gate 轮次 → gate 结果已过期（stale） */
  latestReviewRound: number | null;
  stale: boolean;
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
