/**
 * PaperTeam 业务层错误模型。
 *
 * 原则：
 * - 业务层只抛出本文件中的错误类型，底层细节（ECONNRESET、
 *   底层 Runtime 内部错误结构、child_process 原始错误等）只写日志；
 * - 每个错误携带稳定的 `code`，供 HTTP API 映射状态码与前端判断；
 * - `detail` 是给排障看的短摘要，不包含堆栈。
 */

/** 稳定错误码（对外 API 契约的一部分，不要随意改名） */
export type BusinessErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PROJECT_ID"
  | "INVALID_PROJECT_TITLE"
  | "PROJECT_NOT_FOUND"
  | "AGENT_RUNTIME_UNAVAILABLE"
  | "AGENT_RUN_FAILED"
  | "AGENT_TIMEOUT"
  | "INVALID_LATEX_OUTPUT"
  | "LATEX_TOOL_UNAVAILABLE"
  | "LATEX_COMPILE_FAILED"
  | "LATEX_COMPILE_TIMEOUT"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_INVALID_STATE"
  | "WORKFLOW_CANCELLED"
  | "PROJECT_BUSY"
  | "PROJECT_NOT_ARCHIVED"
  | "STAGE_FAILED"
  | "STAGE_CONTRACT_VIOLATION"
  | "MODEL_REPAIR_EXHAUSTED"
  | "REPAIR_PIPELINE_ERROR"
  | "DIRECT_WORKSPACE_MUTATION"
  | "REVISION_WORKSPACE_RECOVERY_FAILED"
  | "AWAITING_INPUT"
  | "EVIDENCE_VALIDATION"
  | "CITATION_VERIFICATION"
  | "QUALITY_GATE_FAILED"
  | "QUALITY_GATE_STALE"
  | "FACT_PRESERVATION_FAILED"
  | "BUILD_GATE_FAILED"
  | "BUILD_GATE_STALE"
  | "IMPORT_VALIDATION"
  | "MODEL_CONFIG_BUSY"
  | "SOURCE_IN_USE"
  | "PLAN_INVALID_STATE"
  | "GAP_INVALID_STATE"
  | "LOOP_INVALID_STATE"
  | "LOOP_POLICY_VIOLATION"
  | "EXECUTION_ENTRY_NOT_FOUND"
  | "EXECUTION_RESULTS_UNAVAILABLE"
  | "SEARCH_ALL_PROVIDERS_FAILED"
  | "SEARCH_PROVIDER_NOT_CONFIGURED"
  | "SEARCH_CACHE_MISS"
  | "SOURCE_NOT_INDEXABLE"
  | "RETRIEVAL_NOT_READY"
  | "EMBEDDING_UNAVAILABLE"
  | "INVALID_RETRIEVAL_FILTER"
  | "PDF_PARSE_FAILED"
  | "PDF_PARSER_UNAVAILABLE"
  | "INVALID_CHUNK_ID"
  | "CHUNK_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "CANDIDATE_STORE_CORRUPTED"
  | "SURVEY_MATRIX_CORRUPTED"
  | "SURVEY_SYNTHESIS_CORRUPTED"
  | "CORPUS_SNAPSHOT_CORRUPTED"
  | "SURVEY_OUTLINE_INVALID"
  | "FULLTEXT_NOT_RESOLVABLE"
  | "FULLTEXT_DOWNLOAD_FAILED"
  | "INGESTION_PARSE_FAILED"
  | "INGESTION_PARSER_UNAVAILABLE"
  | "EVIDENCE_VALUE_MISMATCH"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "TARGET_BENCHMARK_CORRUPTED"
  | "VISUAL_INVENTORY_CORRUPTED"
  // ---- Figures（M12.3 确定性图表生成；末尾追加，勿重排既有项） ----
  | "FIGURE_SPEC_INVALID"
  | "FIGURE_COMPILE_FAILED"
  | "FIGURE_COMPILE_TIMEOUT"
  | "FIGURE_PACKAGE_MISSING"
  // ---- Target profile / readiness（M12.1 A7/A8 derived artifact 损坏 fail-closed）----
  | "TARGET_PROFILE_CORRUPTED"
  | "TARGET_READINESS_CORRUPTED"
  // ---- Figures C4–C6（M12 Batch 3：产品 API / 插入 / 守卫；末尾追加） ----
  | "FIGURE_NOT_FOUND"
  | "FIGURE_RECOVERY_REQUIRED"
  | "FIGURE_ASSET_MISSING"
  | "FIGURE_LABEL_CONFLICT"
  | "FIGURE_LABEL_NOT_FOUND"
  | "FIGURE_SCOPE_VIOLATION"
  | "FIGURE_DATASET_STALE"
  | "FIGURE_SOURCE_MISSING"
  | "FIGURE_CAPTION_UNSUPPORTED"
  | "FIGURE_CAPTION_UNVERIFIED"
  | "FIGURE_ALREADY_INSERTED"
  | "REVISION_STORE_CORRUPTED"
  | "REVISION_RECOVERY_REQUIRED"
  | "EXTERNAL_INSTRUCTION_CONFLICT"
  | "EXPERIMENT_ARCHIVE_UNSAFE"
  | "EXPERIMENT_ARCHIVE_LIMIT"
  | "EXPERIMENT_MANIFEST_CORRUPTED"
  | "EXPERIMENT_CONFIRM_CONFLICT";

/** 错误码 → HTTP 状态码 */
const HTTP_STATUS_BY_CODE: Readonly<Record<BusinessErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_PROJECT_ID: 400,
  INVALID_PROJECT_TITLE: 400,
  PROJECT_NOT_FOUND: 404,
  AGENT_RUNTIME_UNAVAILABLE: 502,
  AGENT_RUN_FAILED: 502,
  AGENT_TIMEOUT: 504,
  INVALID_LATEX_OUTPUT: 502,
  LATEX_TOOL_UNAVAILABLE: 500,
  LATEX_COMPILE_FAILED: 422,
  LATEX_COMPILE_TIMEOUT: 504,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_INVALID_STATE: 409,
  WORKFLOW_CANCELLED: 409,
  PROJECT_BUSY: 409,
  PROJECT_NOT_ARCHIVED: 409,
  STAGE_FAILED: 500,
  STAGE_CONTRACT_VIOLATION: 500,
  MODEL_REPAIR_EXHAUSTED: 422,
  REPAIR_PIPELINE_ERROR: 500,
  DIRECT_WORKSPACE_MUTATION: 500,
  REVISION_WORKSPACE_RECOVERY_FAILED: 500,
  AWAITING_INPUT: 409,
  EVIDENCE_VALIDATION: 422,
  CITATION_VERIFICATION: 502,
  QUALITY_GATE_FAILED: 422,
  QUALITY_GATE_STALE: 409,
  FACT_PRESERVATION_FAILED: 422,
  BUILD_GATE_FAILED: 422,
  BUILD_GATE_STALE: 409,
  IMPORT_VALIDATION: 422,
  MODEL_CONFIG_BUSY: 409,
  SOURCE_IN_USE: 409,
  PLAN_INVALID_STATE: 409,
  GAP_INVALID_STATE: 409,
  LOOP_INVALID_STATE: 409,
  LOOP_POLICY_VIOLATION: 409,
  EXECUTION_ENTRY_NOT_FOUND: 404,
  EXECUTION_RESULTS_UNAVAILABLE: 409,
  SEARCH_ALL_PROVIDERS_FAILED: 502,
  SEARCH_PROVIDER_NOT_CONFIGURED: 503,
  SEARCH_CACHE_MISS: 404,
  SOURCE_NOT_INDEXABLE: 422,
  RETRIEVAL_NOT_READY: 503,
  EMBEDDING_UNAVAILABLE: 422,
  INVALID_RETRIEVAL_FILTER: 400,
  PDF_PARSE_FAILED: 422,
  PDF_PARSER_UNAVAILABLE: 503,
  INVALID_CHUNK_ID: 422,
  CHUNK_NOT_FOUND: 404,
  SOURCE_NOT_FOUND: 404,
  CANDIDATE_STORE_CORRUPTED: 500,
  SURVEY_MATRIX_CORRUPTED: 500,
  SURVEY_SYNTHESIS_CORRUPTED: 500,
  CORPUS_SNAPSHOT_CORRUPTED: 500,
  SURVEY_OUTLINE_INVALID: 422,
  FULLTEXT_NOT_RESOLVABLE: 422,
  FULLTEXT_DOWNLOAD_FAILED: 502,
  INGESTION_PARSE_FAILED: 422,
  INGESTION_PARSER_UNAVAILABLE: 503,
  EVIDENCE_VALUE_MISMATCH: 422,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  TARGET_BENCHMARK_CORRUPTED: 500,
  VISUAL_INVENTORY_CORRUPTED: 500,
  FIGURE_SPEC_INVALID: 422,
  FIGURE_COMPILE_FAILED: 422,
  FIGURE_COMPILE_TIMEOUT: 504,
  FIGURE_PACKAGE_MISSING: 503,
  TARGET_PROFILE_CORRUPTED: 500,
  TARGET_READINESS_CORRUPTED: 500,
  FIGURE_NOT_FOUND: 404,
  FIGURE_RECOVERY_REQUIRED: 409,
  FIGURE_ASSET_MISSING: 409,
  FIGURE_LABEL_CONFLICT: 409,
  FIGURE_LABEL_NOT_FOUND: 404,
  FIGURE_SCOPE_VIOLATION: 403,
  FIGURE_DATASET_STALE: 409,
  FIGURE_SOURCE_MISSING: 409,
  FIGURE_CAPTION_UNSUPPORTED: 422,
  FIGURE_CAPTION_UNVERIFIED: 422,
  FIGURE_ALREADY_INSERTED: 409,
  REVISION_STORE_CORRUPTED: 500,
  REVISION_RECOVERY_REQUIRED: 409,
  EXTERNAL_INSTRUCTION_CONFLICT: 409,
  EXPERIMENT_ARCHIVE_UNSAFE: 422,
  EXPERIMENT_ARCHIVE_LIMIT: 413,
  EXPERIMENT_MANIFEST_CORRUPTED: 500,
  EXPERIMENT_CONFIRM_CONFLICT: 409,
};

export class BusinessError extends Error {
  override readonly name = "BusinessError";
  readonly code: BusinessErrorCode;
  /** 排障用短摘要（无堆栈、无底层原始错误对象） */
  readonly detail?: string;

  constructor(code: BusinessErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }

  get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

// ---- Project ----

export class InvalidProjectIdError extends BusinessError {
  constructor(projectId: string) {
    super(
      "INVALID_PROJECT_ID",
      `非法的项目 ID："${projectId}"（只允许字母、数字、连字符，长度 1-64）`,
    );
  }
}

export class InvalidProjectTitleError extends BusinessError {
  constructor(reason: string) {
    super("INVALID_PROJECT_TITLE", `非法的论文标题：${reason}`);
  }
}

export class ProjectNotFoundError extends BusinessError {
  constructor(projectId: string) {
    super("PROJECT_NOT_FOUND", `论文项目不存在：${projectId}`);
  }
}

// ---- 项目生命周期（归档 / 恢复 / 永久删除）----

/** 项目存在进行中的任务（workflow run）或 Runtime 在途会话，禁止归档 / 删除 */
export class ProjectBusyError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("PROJECT_BUSY", message, detail);
  }
}

/** 永久删除只允许作用于已归档项目 */
export class ProjectNotArchivedError extends BusinessError {
  constructor(projectId: string) {
    super(
      "PROJECT_NOT_ARCHIVED",
      `只有已归档的项目才能永久删除（请先归档项目 ${projectId}）`,
    );
  }
}

// ---- Agent Runtime ----

export class AgentRuntimeUnavailableError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("AGENT_RUNTIME_UNAVAILABLE", `Agent Runtime 不可用：${message}`, detail);
  }
}

export class AgentRunFailedError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("AGENT_RUN_FAILED", `Agent 任务失败：${message}`, detail);
  }
}

/**
 * Agent 任务超时（M5.1 分层：init/session/queue/execution 四个真实生命周期
 * 阶段；M10.4.4 增 first_activity = 进入执行后无任何 provider 活动的静默期；
 * 缺省 phase 保持既有消息形态——历史调用方只按 code 判定）。结构化
 * 归因以任务终态的 errorCode（*_TIMEOUT）+ timeoutPhase 为准，本错误只负责
 * reject 通道的业务错误语义（HTTP 504 / Stage 分类 timeout）。
 */
export class AgentTimeoutError extends BusinessError {
  /** 超时归属阶段（与 AgentTask.timeoutPhase 同一枚举） */
  readonly phase?: "init" | "session" | "queue" | "execution" | "first_activity";
  constructor(
    timeoutMs: number,
    phase?: "init" | "session" | "queue" | "execution" | "first_activity",
  ) {
    const phaseLabel =
      phase === "init"
        ? "Runtime 初始化阶段，"
        : phase === "session"
          ? "会话创建阶段，"
          : phase === "queue"
            ? "排队等待阶段，"
            : phase === "execution"
              ? "执行阶段，"
              : phase === "first_activity"
                ? "执行启动后无 provider 活动（first-activity watchdog），"
                : "";
    super("AGENT_TIMEOUT", `Agent 任务超时（${phaseLabel}${timeoutMs}ms）未完成`);
    this.phase = phase;
  }
}

// ---- Writer / LaTeX ----

export class InvalidLatexOutputError extends BusinessError {
  constructor(reason: string) {
    super("INVALID_LATEX_OUTPUT", `Agent 返回的内容不是可用的 LaTeX 文档：${reason}`);
  }
}

export class LatexToolUnavailableError extends BusinessError {
  constructor(detail: string) {
    super("LATEX_TOOL_UNAVAILABLE", "本机未安装 LaTeX 编译工具（xelatex / bibtex）", detail);
  }
}

export class LatexCompileFailedError extends BusinessError {
  constructor(detail?: string) {
    super("LATEX_COMPILE_FAILED", "LaTeX 编译失败", detail);
  }
}

export class LatexCompileTimeoutError extends BusinessError {
  constructor(timeoutMs: number) {
    super("LATEX_COMPILE_TIMEOUT", `LaTeX 编译超时（${timeoutMs}ms）`);
  }
}

// ---- Workflow ----

export class WorkflowNotFoundError extends BusinessError {
  constructor(runId: string) {
    super("WORKFLOW_NOT_FOUND", `WorkflowRun 不存在：${runId}`);
  }
}

/** 对不在预期状态的 WorkflowRun 执行操作（非法状态转换） */
export class WorkflowInvalidStateError extends BusinessError {
  constructor(runId: string, currentStatus: string, action: string) {
    super(
      "WORKFLOW_INVALID_STATE",
      `无法对状态为 ${currentStatus} 的 WorkflowRun 执行 ${action}（runId: ${runId}）`,
    );
  }
}

/** WorkflowRun 已被取消后继续使用（内部信号错误；HTTP 层一般映射为 invalid state） */
export class WorkflowCancelledError extends BusinessError {
  constructor(runId: string) {
    super("WORKFLOW_CANCELLED", `WorkflowRun 已取消：${runId}`);
  }
}

/** Stage 执行失败（重试耗尽或不可重试；携带失败分类供编排层使用） */
export class StageFailedError extends BusinessError {
  readonly category: StageFailureCategory;
  constructor(stageId: string, category: StageFailureCategory, message: string, detail?: string) {
    super("STAGE_FAILED", `Stage ${stageId} 失败（${category}）：${message}`, detail);
    this.category = category;
  }
}

/** Stage 产出未通过 DoD 校验（StageContract violation） */
export class StageContractViolationError extends BusinessError {
  readonly violations: readonly string[];
  constructor(stageId: string, violations: readonly string[]) {
    super(
      "STAGE_CONTRACT_VIOLATION",
      `Stage ${stageId} 的产出未通过 DoD 校验：${violations.join("；")}`,
    );
    this.violations = violations;
  }
}

/**
 * Stage 失败分类（决定是否重试）：
 * - transient          瞬时失败（Agent 输出异常、模型抖动）→ 可重试
 * - timeout            超时 → 可重试
 * - runtime_unavailable Runtime 不可用（Runtime 初始化失败 / 已关闭）→ 可重试
 * - contract_violation DoD / 结构化校验不通过 → 按契约可重试（LLM 重新生成可能自愈）
 * - permanent          永久失败（输入非法、环境缺失）→ 不重试
 */
export type StageFailureCategory =
  | "transient"
  | "timeout"
  | "runtime_unavailable"
  | "contract_violation"
  | "permanent";

/** HITL：Stage 需要用户输入才能继续（由编排层转为 awaiting_input，不是异常路径） */
export class AwaitingInputSignal extends BusinessError {
  readonly prompt: string;
  readonly options: readonly string[];
  constructor(prompt: string, options: readonly string[]) {
    super("AWAITING_INPUT", `Workflow 等待用户输入：${prompt}`);
    this.prompt = prompt;
    this.options = options;
  }
}

// ---- Evidence / Citation ----

export class EvidenceValidationError extends BusinessError {
  constructor(reason: string) {
    super("EVIDENCE_VALIDATION", `Evidence 数据校验失败：${reason}`);
  }
}

export class CitationVerificationError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("CITATION_VERIFICATION", `引用核验失败：${message}`, detail);
  }
}

// ---- Quality Gate（判定结果本身不是 HTTP 错误，此类型供内部复用） ----

export class QualityGateFailedError extends BusinessError {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super("QUALITY_GATE_FAILED", `Quality Gate 未通过：${reasons.join("；")}`);
    this.reasons = reasons;
  }
}

/** Gate / Build 产物与当前 manuscript 修订不对齐（Finalize 的 stale 防护；409） */
export class QualityGateStaleError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("QUALITY_GATE_STALE", `Quality Gate 结果已过期：${message}`, detail);
  }
}

export class BuildGateFailedError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("BUILD_GATE_FAILED", `Build Gate 未通过：${message}`, detail);
  }
}

export class BuildGateStaleError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("BUILD_GATE_STALE", `构建记录已过期：${message}`, detail);
  }
}

// ---- 导入（Existing-LaTeX） ----

export class ImportValidationError extends BusinessError {
  constructor(reason: string) {
    super("IMPORT_VALIDATION", `导入校验失败：${reason}`);
  }
}

// ---- 通用资源不存在（Skill / Evidence / Source 等非项目、非 run 的资源）----

export class NotFoundError extends BusinessError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource}不存在：${id}`);
  }
}

// ---- 文献库（M6.2）----

/**
 * 正式 Source 已被 Evidence 引用，禁止删除（M6.2 架构决定：
 * 最小正确行为是阻止删除而非 cascade / tombstone——引用关系由 Evidence 侧
 * 弱引用（EvidenceSourceRef.sourceId），cascade 会发明本轮不存在的语义）。
 */
export class SourceInUseError extends BusinessError {
  readonly referenceCount: number;
  constructor(sourceId: string, referenceCount: number) {
    super(
      "SOURCE_IN_USE",
      `文献 ${sourceId} 已被 ${referenceCount} 条 Evidence 引用，不能删除（请先处理引用它的 Evidence）`,
    );
    this.referenceCount = referenceCount;
  }
}

// ---- Retrieval（M6.4 Project RAG）----

/** 显式重建单个无法生成全文的 Source（metadata-only / 解析失败等）：422 */
export class SourceNotIndexableError extends BusinessError {
  readonly reason: string;
  constructor(sourceId: string, reason: string, detail?: string) {
    super(
      "SOURCE_NOT_INDEXABLE",
      `文献 ${sourceId} 无法建立检索索引（${reason}）`,
      detail,
    );
    this.reason = reason;
  }
}

/** 检索索引不可用（derived 产物损坏且重建失败 / 底层 IO 失败）：503 */
export class RetrievalNotReadyError extends BusinessError {
  constructor(message: string, detail?: string) {
    super("RETRIEVAL_NOT_READY", `项目检索索引不可用：${message}`, detail);
  }
}

/**
 * 显式请求 dense/hybrid 检索但 EmbeddingProvider 未配置：422。
 * 默认（auto）路径永不抛此错——dense 是 optional，缺省 lexical-only（D-0033）。
 */
export class EmbeddingUnavailableError extends BusinessError {
  constructor(message: string) {
    super("EMBEDDING_UNAVAILABLE", `Embedding 通道不可用：${message}`);
  }
}

/** 非法检索 filter（枚举值 / 年份区间 / sourceIds 形状）：400 */
export class RetrievalInvalidFilterError extends BusinessError {
  constructor(reason: string) {
    super("INVALID_RETRIEVAL_FILTER", `非法检索过滤条件：${reason}`);
  }
}

// ---- PDF 解析（Final PDF Review 输入）----

/** PDF 内容无法解析（损坏 / 加密 / 非 PDF 内容）：422，原料保留可重试 */
export class PdfParseFailedError extends BusinessError {
  constructor(reason: string, detail?: string) {
    super("PDF_PARSE_FAILED", `PDF 解析失败：${reason}`, detail);
  }
}

/** 本机缺少 PDF 解析依赖（Python / pymupdf）：503，附安装指引 */
export class PdfParserUnavailableError extends BusinessError {
  constructor(hint: string) {
    super("PDF_PARSER_UNAVAILABLE", `未找到 PDF 解析依赖：${hint}`);
  }
}

// ---- Document & Data Ingestion（M10.1）----

/** 文档/数据解析失败（损坏 / 加密 / 输出协议异常）：422，原料保留可重试 */
export class DocumentParseFailedError extends BusinessError {
  constructor(reason: string, detail?: string) {
    super("INGESTION_PARSE_FAILED", `文档解析失败：${reason}`, detail);
  }
}

/** 本机缺少所选结构化解析器（docling 等）：503，附安装指引（调用方可走显式降级链） */
export class DocumentParserUnavailableError extends BusinessError {
  constructor(hint: string) {
    super("INGESTION_PARSER_UNAVAILABLE", `结构化文档解析器不可用：${hint}`);
  }
}

/** user_confirmed 证据登记时 claim 与记录值机械比对不符：422（拒绝登记，防手填报错值） */
export class EvidenceValueMismatchError extends BusinessError {
  constructor(detail: string) {
    super("EVIDENCE_VALUE_MISMATCH", `证据声明与结构化记录值不一致：${detail}`);
  }
}

// ---- Model Settings ----

/** 配置变更时存在在途 Agent Run（不中断活跃 run；等待完成后再保存/清除） */
export class ModelConfigBusyError extends BusinessError {
  constructor(activeRuns: number) {
    super(
      "MODEL_CONFIG_BUSY",
      `当前有 ${activeRuns} 个 Agent Run 正在执行，暂不能变更模型配置（不会中断活跃任务，请等待完成后再试）`,
    );
  }
}

// ---- Figures（M12.3 确定性图表生成）----

/** PlotSpec / DiagramSpec 校验不通过（列引用缺失 / 非有限数值 / 结构非法等）：422 */
export class FigureSpecInvalidError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_SPEC_INVALID", `图表 spec 校验失败：${detail}`);
  }
}

/** 单图 xelatex 编译失败（非宏包缺失类：语法错误 / 产物缺失）：422 */
export class FigureCompileFailedError extends BusinessError {
  constructor(detail?: string) {
    super("FIGURE_COMPILE_FAILED", "图表编译失败", detail);
  }
}

/** 单图编译超时：504 */
export class FigureCompileTimeoutError extends BusinessError {
  constructor(detail?: string) {
    super("FIGURE_COMPILE_TIMEOUT", "图表编译超时", detail);
  }
}

/** TeX 发行版缺少图表所需宏包（pgfplots / tikz 等；附宏包名）：503 */
export class FigurePackageMissingError extends BusinessError {
  readonly packageName: string;
  constructor(packageName: string, detail?: string) {
    super("FIGURE_PACKAGE_MISSING", `LaTeX 宏包缺失：${packageName}`, detail);
    this.packageName = packageName;
  }
}

// ---- Figures C4–C6（M12 Batch 3：产品 API / 插入 / 真实性守卫）----

/** figId 未登记（manifest 不含该图）：404 */
export class FigureNotFoundError extends BusinessError {
  constructor(figId: string) {
    super("FIGURE_NOT_FOUND", `图表未登记：${figId}`);
  }
}

/** 已登记但 PDF 资产缺失（被手工删除 / 编译产物丢失）：409 */
export class FigureAssetMissingError extends BusinessError {
  constructor(figId: string) {
    super("FIGURE_ASSET_MISSING", `图表 PDF 资产缺失：${figId}（请重新生成）`, `资产文件 ${figId}.pdf 不在 figs/generated/ 下`);
  }
}

/** label 与全稿既有 figure label 冲突：409 */
export class FigureLabelConflictError extends BusinessError {
  constructor(label: string) {
    super("FIGURE_LABEL_CONFLICT", `figure label 冲突：${label}（全稿已存在同名列）`);
  }
}

/** replace 目标 label 不存在：404 */
export class FigureLabelNotFoundError extends BusinessError {
  constructor(label: string, file: string) {
    super("FIGURE_LABEL_NOT_FOUND", `替换目标不存在：${file} 中没有 label 为 ${label} 的 figure 环境`);
  }
}

/** 修订安全边界：已有论文项目不允许直接新增 figure 环境（须走受控替换或修订工作流）：403 */
export class FigureScopeViolationError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_SCOPE_VIOLATION", "图表插入被修订安全边界拒绝", detail);
  }
}

/** 数据集已变化（source 重解析后 datasetHash 不一致）：409 */
export class FigureDatasetStaleError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_DATASET_STALE", "图表数据已过期", detail);
  }
}

/** 数据来源缺失（sourceId 不存在 / 解析产物缺失）：409 */
export class FigureSourceMissingError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_SOURCE_MISSING", "图表数据来源缺失", detail);
  }
}

/** caption 定量声明被数据否定（确定性守卫：violation）：422 */
export class FigureCaptionUnsupportedError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_CAPTION_UNSUPPORTED", "caption 定量声明与数据不符（已拦截插入）", detail);
  }
}

/** caption 存在无法可靠校验的声明（AUTHOR_REVIEW_REQUIRED）：422 */
export class FigureCaptionUnverifiedError extends BusinessError {
  constructor(detail: string) {
    super("FIGURE_CAPTION_UNVERIFIED", "caption 存在需作者确认的声明（AUTHOR_REVIEW_REQUIRED）", detail);
  }
}

/** 同一图已在同文件同 label 位置插入（防无意重复插入）：409 */
export class FigureAlreadyInsertedError extends BusinessError {
  constructor(figId: string, file: string) {
    super("FIGURE_ALREADY_INSERTED", `图表已插入：${figId} 已在 ${file} 中（如需更新请使用 replace 模式）`);
  }
}

/**
 * 把任意抛出的未知错误归一为 BusinessError（不吞掉已知业务错误）。
 * 未知错误的原始消息可能带绝对路径 / SDK 内部细节，不进响应体；调用方负责记录原始错误。
 */
export function toBusinessError(error: unknown): BusinessError {
  if (error instanceof BusinessError) {
    return error;
  }
  return new BusinessError("INTERNAL_ERROR", "服务内部错误，请稍后重试；详情见 Backend 日志");
}
