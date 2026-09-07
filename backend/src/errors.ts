/**
 * PaperTeam 业务层错误模型（M2）。
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
  | "AWAITING_INPUT"
  | "EVIDENCE_VALIDATION"
  | "CITATION_VERIFICATION"
  | "QUALITY_GATE_FAILED"
  | "IMPORT_VALIDATION"
  | "MODEL_CONFIG_BUSY"
  | "PDF_PARSE_FAILED"
  | "PDF_PARSER_UNAVAILABLE"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

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
  AWAITING_INPUT: 409,
  EVIDENCE_VALIDATION: 422,
  CITATION_VERIFICATION: 502,
  QUALITY_GATE_FAILED: 422,
  IMPORT_VALIDATION: 422,
  MODEL_CONFIG_BUSY: 409,
  PDF_PARSE_FAILED: 422,
  PDF_PARSER_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
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

export class AgentTimeoutError extends BusinessError {
  constructor(timeoutMs: number) {
    super("AGENT_TIMEOUT", `Agent 任务超时（${timeoutMs}ms）未完成`);
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
    super("LATEX_TOOL_UNAVAILABLE", "本机未安装 LaTeX 编译工具（latexmk / xelatex）", detail);
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

// ---- Workflow（M3.0） ----

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
 * Stage 失败分类（决定是否重试，M3.0）：
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

// ---- Evidence / Citation（M3.1） ----

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

// ---- Quality Gate（M3.2；判定结果本身不是 HTTP 错误，此类型供内部复用） ----

export class QualityGateFailedError extends BusinessError {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super("QUALITY_GATE_FAILED", `Quality Gate 未通过：${reasons.join("；")}`);
    this.reasons = reasons;
  }
}

// ---- 导入（M3.2 Existing-LaTeX） ----

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

// ---- Model Settings（M4.3.7.5） ----

/** 配置变更时存在在途 Agent Run（不中断活跃 run；等待完成后再保存/清除） */
export class ModelConfigBusyError extends BusinessError {
  constructor(activeRuns: number) {
    super(
      "MODEL_CONFIG_BUSY",
      `当前有 ${activeRuns} 个 Agent Run 正在执行，暂不能变更模型配置（不会中断活跃任务，请等待完成后再试）`,
    );
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
