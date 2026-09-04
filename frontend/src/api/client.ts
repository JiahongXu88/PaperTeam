import type { ApiErrorBody } from "../types/api.js";

/**
 * 统一 API Client（M4.1）：所有 HTTP 访问唯一入口。
 *
 * - Base URL 缺省为同源相对路径（dev 由 Vite proxy 转发到 Backend，
 *   覆盖用 VITE_API_BASE_URL）；
 * - JSON request / response、统一 HTTP 错误（ApiError：status + code）；
 * - 网络层失败（Backend 未启动 / 断连）收敛为 NETWORK_ERROR，
 *   页面据此渲染「重试」。
 *
 * React 组件不直接 fetch、不手拼 URL —— 一律经由 api/ 层 + TanStack Query。
 */

/** Base URL（空串 = 同源相对路径） */
const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** 结构化 API 错误（含 Backend 业务错误码；status=0 表示网络层失败） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 是否为「资源不存在」（ProjectPage 据此渲染 not found） */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>({ method, path, body, signal }: RequestOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "无法连接 PaperTeam Backend（请确认后端已启动）",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const text = await response.text();
  let data: unknown = null;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应体：保留原始文本供诊断，按 5xx 语义处理
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        `Backend 返回了非 JSON 响应（HTTP ${response.status}）`,
        text.slice(0, 200),
      );
    }
  }

  if (!response.ok) {
    const parsed = data as Partial<ApiErrorBody> | null;
    const error = parsed?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      error?.detail,
    );
  }
  return data as T;
}

export const apiClient = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>({ method: "GET", path, signal }),
  post: <T>(path: string, body?: unknown) => request<T>({ method: "POST", path, body }),
  patch: <T>(path: string, body?: unknown) => request<T>({ method: "PATCH", path, body }),
  delete: <T>(path: string) => request<T>({ method: "DELETE", path }),
};
