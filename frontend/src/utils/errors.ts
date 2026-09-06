import { ApiError } from "../api/client.js";

/**
 * 用户可见错误文案的统一出口（UX Polish 2026-09）。
 *
 * Backend 业务错误码 → 中文提示；未知码回退原始 message（Backend
 * message 本身已是中文人读文本）。技术 detail 不直接进正文，需要时
 * 由调用方放入 title / 折叠区域。
 */

const CODE_MESSAGES: Record<string, string> = {
  MODEL_CONFIG_BUSY: "当前有 Agent 正在运行，请等待任务结束后再修改模型配置。",
  AUTH_FAILED: "API Key 无效或认证失败。",
  MODEL_NOT_FOUND: "找不到所选模型。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  TIMEOUT: "连接超时，请检查网络或模型服务。",
  NETWORK_ERROR: "无法连接 PaperTeam 后端服务，请确认服务已启动。",
};

/** 把 error 转成用户可读中文文案（未知错误回退原始 message） */
export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    const mapped = CODE_MESSAGES[error.code];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
