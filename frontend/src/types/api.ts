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

/**
 * 语言润色策略（M5.4；idea_to_paper / existing_paper_improvement 的 run 选项）：
 *   suggest_only（默认）Style Reviewer 只给建议，minor 不进入修订计划
 *   apply_once          Quality Gate 通过后询问一次，用户选中的 style 建议进入 style-only 修订
 * existing_paper_review（Quick Review）不接受该选项——它 100% 只读。
 */
export type StylePolicy = "suggest_only" | "apply_once";

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

/** 统一导入入口的稿件格式（M7.0.3：PDF 论文 / LaTeX 工程） */
export type ImportPaperFormat = "pdf" | "latex";

/** 导入请求的可选研究定位字段（高级选项） */
export interface ImportPaperMetaInput {
  researchField?: string;
  targetVenue?: string;
  targetProfile?: string;
  language?: string;
}

/** POST /api/projects/import-paper 输入：format=pdf（缺省兼容） */
export interface ImportPaperPdfInput extends ImportPaperMetaInput {
  format: "pdf";
  fileName: string;
  contentBase64: string;
  goal: ExistingPaperGoal;
}

/** POST /api/projects/import-paper 输入：format=latex（只走系统性改进） */
export interface ImportPaperLatexInput extends ImportPaperMetaInput {
  format: "latex";
  fileName: string;
  archiveBase64: string;
}

export type ImportProjectPaperInput = ImportPaperPdfInput | ImportPaperLatexInput;

/** LaTeX 导入结构报告（Backend LatexImportReport；UI 展示用子集） */
export interface LatexImportReportView {
  importedAt: string;
  entryCount: number;
  structure: {
    entryFile: string;
    texFiles: string[];
    bibFile: string | null;
    figures: string[];
    otherFiles: string[];
  };
  baselineCompile: {
    attempted: boolean;
    ok: boolean;
    tool: string;
    error?: string;
    logPath?: string;
  };
  warnings: string[];
}

/** POST /api/projects/import-paper 响应 */
export interface ImportProjectPaperResult {
  project: ProjectView;
  /** 项目标题来源：PDF 内标题 / LaTeX \title / 文件名兜底 */
  titleSource: "pdf" | "latex" | "filename";
  /** format=pdf：解析后的文档摘要（与 GET /paper 的 document 同形） */
  document?: PaperDocSummary;
  /** format=latex：导入结构报告 */
  report?: LatexImportReportView;
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
  /** 语言润色策略（idea / improvement run 的 request 快照；旧 run 缺省 suggest_only） */
  stylePolicy?: StylePolicy;
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
  /** 仅 hitl.style_polish（M5.4）：应用选中的 style 建议（缺省全部） */
  | { action: "apply"; payload: { selectedFindingIds: string[] } }
  /** 仅 hitl.style_polish：只保留建议，不修改稿件 */
  | { action: "skip" }
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

// ---- Paper Artifacts / Build / Finalize（M4.7 Draft-Final 闭环） ----

/** 冻结的 Draft / Final 产物（Backend PaperArtifact） */
export interface PaperArtifactView {
  artifactId: string;
  kind: "draft" | "final";
  /** 冻结时对应的 manuscript 修订（Final revision 精确等于通过双 Gate 的修订） */
  revision: number;
  createdAt: string;
  buildGate: { passed: boolean; checkedAt: string; revision: number };
  /** Final 产物必带（Draft 不携带质量结论：Draft 只要求 Build Gate） */
  qualityGate?: { passed: boolean; round: number; checkedAt: string; reviewedRevision: number };
  file: { name: string; mimeType: "application/pdf"; bytes: number };
  sourceRunId?: string;
}

/** GET /api/projects/:id/artifacts（产物列表 + 最新标记 + 新鲜度） */
export interface ArtifactsResponseView {
  artifacts: PaperArtifactView[];
  latestDraft: PaperArtifactView | null;
  latestFinal: PaperArtifactView | null;
  currentRevision: number;
  /** Final 是否对齐当前修订（false = 修订后尚未重新 Finalize；旧 Final 仍可下载） */
  finalUpToDate: boolean;
}

/** 结构化编译诊断（Backend LatexDiagnostic；失败时从 compile.log 解析） */
export interface LatexDiagnosticView {
  file: string | null;
  line: number | null;
  message: string;
  contextLines: string[];
}

/** Build Gate 记录（LaTeX 编译结论；质量语义不参与构建——D-0015） */
export interface BuildGateRecordView {
  passed: boolean;
  reasons: string[];
  checkedAt: string;
  /** 编译时的 manuscript 修订（≠ 当前修订 → stale，需重新构建） */
  revision: number;
  compile: {
    ok: boolean;
    tool: string;
    durationMs: number;
    exitCode: number | null;
    pdfPath: string | null;
    logPath: string | null;
    error?: string;
  };
  diagnostics: LatexDiagnosticView[];
}

/** GET /api/projects/:id/build（构建状态卡片数据源） */
export interface BuildStatusView {
  build: BuildGateRecordView | null;
  currentRevision: number;
  stale: boolean;
}

/** POST /api/projects/:id/build（手动构建 + Draft 冻结） */
export interface BuildRunResultView {
  revision: number;
  build: BuildGateRecordView;
  draftArtifactId: string | null;
  diagnosticsCount: number;
  compile: BuildGateRecordView["compile"];
}

/** POST /api/projects/:id/finalize（后端确定性判定；任何不满足 → 4xx BusinessError） */
export interface FinalizeResultView {
  final: PaperArtifactView;
  draft: PaperArtifactView;
  revision: number;
  gateRound: number;
}

/** 修订迭代收敛历史的一条记录（iteration-history；确定性判定，无 LLM） */
export interface RevisionIterationView {
  revision: number;
  reviewRound: number;
  gateRound: number;
  /** PASS / IMPROVED / CONVERGED（→ HITL）/ REGRESSION（→ HITL）；首轮 null */
  outcome: string | null;
  planId?: string;
  completedAt: string;
  scorecard: {
    gatePassed: boolean;
    failedRuleIds: string[];
    critical: number;
    major: number;
    blocking: number;
    academicScore: number | null;
    styleRisk: number | null;
  };
}

// ---- Style Polish（M5.4：GET /api/projects/:id/style-polish，只读视图） ----

export interface StyleFindingView {
  id: string;
  section: string;
  issue: string;
  reason?: string;
  proposedAction?: string;
  severity: string;
}

export interface StylePlanItemView {
  id: string;
  section: string;
  problem: string;
  instruction: string;
  status: "planned" | "skipped";
  revisionReason?: string;
}

export interface StylePolishResultView {
  planId: string;
  reviewRound: number;
  sourceRevision: number;
  status: "applied" | "failed" | "noop";
  revision?: number;
  selectedFindingIds: string[];
  sections: Array<{
    section: string;
    itemIds: string[];
    invariantOk: boolean;
    violations: Array<{ rule: string; detail: string }>;
  }>;
  completedAt: string;
}

export interface StylePolishView {
  plan: { planId: string; reviewRound: number; sourceRevision: number; items: StylePlanItemView[] } | null;
  result: StylePolishResultView | null;
  reviewedRevision: number | null;
  /** 润色产生的修订是否已被新一轮 review 覆盖（null = 无已应用的润色） */
  reReviewed: boolean | null;
}

// ---- Manuscript Overview（M7.0.3：当前稿件聚合视图，只读；事实全部来自 Backend） ----

/** 稿件进入系统的方式（Backend 从落盘事实推导） */
export type ManuscriptSourceType = "latex" | "pdf" | "generated" | "none";

export interface ManuscriptOverviewView {
  projectId: string;
  title: string;
  /** 标题事实来源：outline（生成式稿件大纲）/ project（项目元数据） */
  titleSource: "outline" | "project";
  sourceType: ManuscriptSourceType;
  /** 0 = 尚无版本事实（刚创建 / 只导入未提交修订） */
  currentRevision: number;
  sectionCount: number;
  referenceCount: number;
  build: {
    passed: boolean;
    checkedAt: string;
    revision: number;
    /** 构建后稿件又前进了（结论已过期） */
    stale: boolean;
  } | null;
}

// ---- Manuscript Versions（M4.8：关联只由 Backend 完成，前端只展示） ----

export interface VersionReviewFactView {
  round: number;
  reviewedRevision: number;
  critical: number;
  major: number;
  blocking: number;
  academicScore: number | null;
}

export interface VersionGateFactView {
  round: number;
  passed: boolean;
  failedRuleIds: string[];
}

export interface VersionBuildFactView {
  passed: boolean;
  checkedAt: string;
  revision: number;
}

/** 一条论文版本（Backend 组装的稳定 DTO；前端不拼装猜测关系） */
export interface ManuscriptVersionView {
  revision: number;
  createdAt: string;
  source: string;
  runId?: string;
  /** source=revision.restore 时的恢复来源 */
  restoredFrom?: number;
  isCurrent: boolean;
  isFinal: boolean;
  hasDraft: boolean;
  review: VersionReviewFactView | null;
  qualityGate: VersionGateFactView | null;
  build: VersionBuildFactView | null;
  artifacts: { artifactId: string; kind: "draft" | "final" }[];
  revisionPlan: { planId: string; round: number; planned: number; skipped: number } | null;
  iteration: { outcome: string | null; gateRound: number } | null;
}

export interface VersionListView {
  current: number;
  versions: ManuscriptVersionView[];
}

export interface CompareSectionView {
  path: string;
  title: string;
  status: "unchanged" | "modified" | "added" | "removed";
  fromLines: number | null;
  toLines: number | null;
  added: number | null;
  removed: number | null;
}

/** 两个修订的确定性比较（零 LLM；差异计算完全在 Backend） */
export interface VersionCompareView {
  from: { revision: number; createdAt: string; source: string };
  to: { revision: number; createdAt: string; source: string };
  sections: CompareSectionView[];
  summary: { unchanged: number; modified: number; added: number; removed: number };
  reviewDelta: {
    from: VersionReviewFactView | null;
    to: VersionReviewFactView | null;
    fromGate: VersionGateFactView | null;
    toGate: VersionGateFactView | null;
  };
}

/** Restore 结果：恢复 = 新修订（历史不动） */
export interface VersionRestoreResultView {
  revision: number;
  created: boolean;
  restoredFrom: number;
  current: number;
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

/** 可独立配置模型的业务 Agent（M5.7；与 Backend AgentModelKey 一致） */
export type AgentModelKey =
  | "writer"
  | "researcher"
  | "academicReviewer"
  | "factReviewer"
  | "styleReviewer"
  | "citationReviewer";

/** 单个 Agent 的模型配置视图（无任何 key 字段） */
export interface AgentModelSettingView {
  key: AgentModelKey;
  /** 保存的 override 规格 "provider/model-id"（继承默认时缺省） */
  override?: string;
  overrideProvider?: string;
  overrideModelId?: string;
  /** 该 Agent 实际使用的 "provider/model-id"（默认未配置且无 override 时缺省） */
  effective?: string;
  source: "agent_override" | "default";
  /** override provider 是否有可用凭据（不含 key 本体） */
  authConfigured?: boolean;
}

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
  /** per-Agent 模型配置视图（M5.7；旧 Backend 可能缺省） */
  agents?: AgentModelSettingView[];
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

// ---- External Instructions / Revision Plan（M5.7） ----

/** 外部修改意见来源（与 Backend EXTERNAL_INSTRUCTION_SOURCES 一致） */
export type ExternalInstructionSource =
  | "user"
  | "journal_reviewer"
  | "editor"
  | "advisor"
  | "other";

/** 处理状态（确定性判定：handled 需要真实文件变化 + gate 复核通过） */
export type ExternalInstructionStatus =
  | "pending"
  | "handled"
  | "partially_handled"
  | "unresolved"
  | "conflict";

export interface ExternalInstructionView {
  instructionId: string;
  source: ExternalInstructionSource;
  reviewerLabel?: string;
  /** 原始意见全文（逐字保存，追溯审计） */
  text: string;
  section?: string;
  status: ExternalInstructionStatus;
  statusNote?: string;
  conflictBasis?: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/projects/:id/external-instructions */
export interface ExternalInstructionsResponse {
  instructions: ExternalInstructionView[];
  sectionOptions: string[];
}

export type RevisionPlanItemKind =
  | "external_instruction"
  | "review_finding"
  | "citation_missing"
  | "citation_removed"
  | "fact_preserve"
  | "build_error"
  | "gate_blocker";

export type RevisionPlanItemPriority = "mandatory" | "high" | "medium" | "low";

export interface RevisionPlanItemView {
  id: string;
  kind: RevisionPlanItemKind;
  priority: RevisionPlanItemPriority;
  section: string;
  problem: string;
  instruction: string;
  expectedOutcome: string;
  status: "planned" | "skipped";
  needsEvidence?: boolean;
  note?: string;
  source?: "external" | "internal";
  reviewerLabel?: string;
  sourceText?: string;
  instructionId?: string;
}

/** GET /api/projects/:id/revision-plan（?round= 缺省最新轮） */
export interface RevisionPlanView {
  schemaVersion: number;
  planId: string;
  projectId: string;
  sourceRevision: number;
  reviewRound: number;
  createdAt: string;
  summary: {
    critical: number;
    major: number;
    blocking: number;
    minorRecorded: number;
    planned: number;
    skipped: number;
    external?: number;
  };
  items: RevisionPlanItemView[];
}

// ---- 通用 ----

/** Backend 统一错误响应体：{status:"error", error:{code,message,detail?}} */
export interface ApiErrorBody {
  status: "error";
  error: { code: string; message: string; detail?: string };
}
