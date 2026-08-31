/**
 * PaperTeam 业务层错误模型（M2）。
 *
 * 原则：
 * - 业务层只抛出本文件中的错误类型，底层细节（ECONNRESET、
 *   OpenClaw 内部错误结构、child_process 原始错误等）只写日志；
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

/** 把任意抛出的未知错误归一为 BusinessError（不吞掉已知业务错误） */
export function toBusinessError(error: unknown): BusinessError {
  if (error instanceof BusinessError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BusinessError("INTERNAL_ERROR", `内部错误：${message}`);
}
