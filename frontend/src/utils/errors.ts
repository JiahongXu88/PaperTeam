import { ApiError } from "../api/client.js";

/**
 * 用户可见错误文案的唯一出口。
 *
 * Backend 业务错误码 → 中文提示；未知码回退 Backend 的 message（本身已是中文人读文本）。
 * 技术细节（detail）不进正文，由调用方决定是否折叠展示。
 */

const CODE_MESSAGES: Record<string, string> = {
  MODEL_CONFIG_BUSY: "当前有 Agent 任务正在运行，请等待任务结束后再修改模型配置。",
  PROJECT_BUSY: "当前项目仍有进行中的任务，请先等待完成或取消任务。",
  PROJECT_NOT_ARCHIVED: "只有已归档的项目才能永久删除，请先归档。",
  PROJECT_NOT_FOUND: "找不到这个项目，可能已被删除。",
  NOT_FOUND: "找不到对应的资源，可能已被删除。",
  WORKFLOW_NOT_FOUND: "找不到这个任务记录。",
  WORKFLOW_INVALID_STATE: "当前状态不允许这个操作（例如项目已有进行中的任务）。",
  AGENT_RUNTIME_UNAVAILABLE: "Agent 运行环境暂不可用，请稍后重试。",
  AGENT_RUN_FAILED: "模型任务执行失败，请稍后重试；若持续失败请检查模型配置。",
  AGENT_TIMEOUT: "模型任务超时，请稍后重试。",
  AUTH_FAILED: "API Key 无效或认证失败。",
  MODEL_NOT_FOUND: "找不到所选模型。",
  PROVIDER_UNAVAILABLE: "模型服务不可达，请检查网络或服务状态。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  TIMEOUT: "连接超时，请检查网络或模型服务。",
  PDF_PARSE_FAILED: "PDF 解析失败：文件可能损坏、加密或没有文本层。",
  PDF_PARSER_UNAVAILABLE: "本机缺少 PDF 解析依赖（Python + pymupdf）。",
  NETWORK_ERROR: "无法连接 PaperTeam 后端服务，请确认服务已启动。",
  INVALID_RESPONSE: "服务返回了无法解析的响应。",
  INTERNAL_ERROR: "服务内部错误，请稍后重试；详情见 Backend 日志。",
};

/** 这些错误码的 Backend message 携带用户需要的具体信息（安装指引 / 具体原因），优先展示 */
const PREFER_SERVER_MESSAGE: ReadonlySet<string> = new Set([
  "PDF_PARSE_FAILED",
  "PDF_PARSER_UNAVAILABLE",
  "INVALID_REQUEST",
  "INVALID_PROJECT_TITLE",
  "IMPORT_VALIDATION",
  "EVIDENCE_VALIDATION",
]);

export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (PREFER_SERVER_MESSAGE.has(error.code) && error.message.trim() !== "") {
      return error.message;
    }
    return CODE_MESSAGES[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 可折叠的技术细节（错误码 + detail）；没有额外信息时返回 undefined */
export function formatApiErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const parts = [error.code !== "" ? `错误码 ${error.code}` : undefined, error.status > 0 ? `HTTP ${error.status}` : undefined, error.detail];
  const text = parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
  return text === "" ? undefined : text;
}

/**
 * Workflow run 的失败信息可能内嵌 Provider 的原始 JSON（如 503 响应体）：
 * 给用户看的一行用稳定文案，原始内容留给折叠详情。
 */
export function summarizeRunError(message: string): { summary: string; detail?: string } {
  const providerStatus = /\b(401|403|404|429|5\d\d)\b/.exec(message);
  if (/no available channel|model_not_found|does not exist/i.test(message)) {
    return { summary: "模型服务暂时没有可用通道（Provider 返回 503），稍后重新 Review 即可。", detail: message };
  }
  if (providerStatus !== null && /\{"error"|"type":"error"|Provider|request id/i.test(message)) {
    const status = providerStatus[1];
    const summary =
      status === "401" || status === "403"
        ? "模型 API Key 无效或无权限。"
        : status === "429"
          ? "模型服务限流（429），稍后重试。"
          : `模型服务返回 ${status}，稍后重试。`;
    return { summary, detail: message };
  }
  if (message.length > 200) {
    return { summary: `${message.slice(0, 200)}…`, detail: message };
  }
  return { summary: message };
}
