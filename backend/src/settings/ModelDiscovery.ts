/**
 * 模型目录自动发现（M13.4）：Backend 代替浏览器请求网关的模型列表，
 * 规避 CORS，也保证凭据不进入浏览器 / URL / 日志。
 *
 * 路径规则（发现路径与推理路径分别处理，不混为一谈）：
 * - anthropic-messages 的推理是 {base}/v1/messages（Anthropic SDK 拼接），
 *   baseUrl 惯例不含 /v1；openai-* 的推理是 {base}/chat/completions 等
 *   （OpenAI SDK 拼接），baseUrl 惯例含 /v1。
 * - 发现统一按「baseUrl 路径是否以 /v1 结尾」决定：以 /v1 结尾 → /models，
 *   否则 → /v1/models（公司网关 https://api-gateway.glm.ai 即 /v1/models，
 *   OpenAI 官方 https://api.openai.com/v1 即 /models）——
 *   任何协议下都不会拼出 /v1/v1/models。
 * - 用户可在高级设置用 modelsPath 覆盖（只影响发现，不影响推理）。
 * - 首选路径 404/405 时按序尝试备选路径（有界：最多 2 个候选、0 次重试）；
 *   两者都不支持 → NOT_SUPPORTED（≠ 网关不可用，前端引导手动添加模型）。
 *
 * 安全约束：
 * - 认证只经请求头（Bearer / x-api-key 按协议选择），绝不进 URL；
 * - redirect: "manual"——仅允许同主机 http→https 升级跟一跳并重带认证头，
 *   跨主机重定向一律拒绝（不转发认证头）；
 * - 响应体大小上限、模型数量上限、整体超时；
 * - 失败 detail 只含 状态码 / 路径 / 主机名，永远不含 key。
 */

import type { CustomProviderApi } from "./CustomProviderStore.js";

/** 单个候选路径的整体超时（含重定向跟进的那一跳） */
export const DISCOVERY_TIMEOUT_MS = 15_000;
/** 响应体大小上限（超出即判定 BAD_RESPONSE，防止恶意/异常大响应占内存） */
export const DISCOVERY_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 返回给前端的模型数量上限（超出置 truncated=true） */
export const DISCOVERY_MAX_MODELS = 500;

export type DiscoveryErrorCode =
  | "AUTH_FAILED"
  | "NOT_SUPPORTED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "BAD_RESPONSE"
  | "REDIRECTED"
  | "NETWORK"
  | "UNKNOWN";

export interface DiscoveredModel {
  id: string;
  /** 目录提供的显示名（如 Anthropic display_name / OpenAI name）；缺省用 id */
  name?: string;
  /** 目录提供的归属（OpenAI owned_by）；用于前端分组 */
  ownedBy?: string;
  /** 目录提供的上下文窗口（OpenRouter context_length 等）；缺省 = 未经上游验证 */
  contextWindow?: number;
}

export interface DiscoverySuccess {
  ok: true;
  models: DiscoveredModel[];
  /** 实际命中的请求路径（如 "/v1/models"），用于前端展示与排查 */
  sourcePath: string;
  /** 去重前的条目总数 */
  total: number;
  truncated: boolean;
}

export interface DiscoveryFailure {
  ok: false;
  code: DiscoveryErrorCode;
  detail: string;
  attemptedPaths: string[];
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

export interface DiscoverModelsInput {
  baseUrl: string;
  api: CustomProviderApi;
  authHeader: boolean;
  /** 额外请求头（已经过 CustomProviderStore 校验，不含认证头） */
  headers?: Record<string, string>;
  /** 高级设置里的发现路径覆盖（"/v1/models" 形态） */
  modelsPath?: string;
  /** 可缺省：部分本地网关免认证 */
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * 发现请求的认证头：OpenAI 协议一律 Bearer；anthropic-messages 按用户
 * 选择（authHeader=true → Bearer，false → Anthropic 原生 x-api-key）。
 */
export function discoveryAuthHeaders(
  api: CustomProviderApi,
  authHeader: boolean,
  apiKey: string | undefined,
): Record<string, string> {
  if (apiKey === undefined || apiKey === "") {
    return {};
  }
  const useBearer = api !== "anthropic-messages" || authHeader;
  return useBearer ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey };
}

/** 候选发现路径（按优先级；全部相对 baseUrl 拼接） */
export function discoveryPaths(baseUrl: string, modelsPath?: string): string[] {
  if (modelsPath !== undefined && modelsPath !== "") {
    return [modelsPath];
  }
  let basePath = "";
  try {
    basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    basePath = "";
  }
  const endsWithV1 = /\/v1$/.test(basePath);
  const primary = endsWithV1 ? "/models" : "/v1/models";
  const secondary = endsWithV1 ? "/v1/models" : "/models";
  return primary === secondary ? [primary] : [primary, secondary];
}

/** 解析目录响应文本（{data:[...]} / {models:[...]} / 裸数组），失败抛 Error */
export function parseModelCatalog(text: string): { models: DiscoveredModel[]; total: number } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  const container = json as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(json)
    ? json
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : undefined;
  if (list === undefined) {
    throw new Error('响应结构不符合预期（需 {data:[...]}、{models:[...]} 或裸数组）');
  }
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const idRaw = record["id"];
    if (typeof idRaw !== "string") {
      continue;
    }
    const id = idRaw.trim();
    if (id === "" || id.length > 200 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      ...optionalText(record, "name", "name"),
      ...optionalText(record, "display_name", "name"),
      ...optionalText(record, "owned_by", "ownedBy"),
      ...optionalPositiveInt(record, "context_length", "contextWindow"),
      ...optionalPositiveInt(record, "context_window", "contextWindow"),
    });
    if (models.length >= DISCOVERY_MAX_MODELS) {
      return { models, total: list.length };
    }
  }
  return { models, total: list.length };
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
  as: string,
): Record<string, string> {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") {
    return { [as]: value.trim().slice(0, 200) };
  }
  return {};
}

function optionalPositiveInt(
  record: Record<string, unknown>,
  key: string,
  as: string,
): Record<string, number> {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000_000) {
    return { [as]: value };
  }
  return {};
}

/**
 * 执行发现：按候选路径逐个请求，404/405 时尝试下一个，其余失败立即终止。
 * 任何返回值 / 抛出的错误都不含 key。
 */
export async function discoverModels(input: DiscoverModelsInput): Promise<DiscoveryResult> {
  const timeoutMs = input.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const paths = discoveryPaths(input.baseUrl, input.modelsPath);
  const attempted: string[] = [];
  for (const path of paths) {
    attempted.push(path);
    const outcome = await fetchUrl(joinUrl(input.baseUrl, path), input, path, timeoutMs, 0);
    if (outcome.kind === "success") {
      return { ok: true, ...outcome.value, sourcePath: path };
    }
    if (outcome.code === "NOT_SUPPORTED") {
      continue;
    }
    return {
      ok: false,
      code: outcome.code,
      detail: outcome.detail,
      attemptedPaths: attempted,
    };
  }
  return {
    ok: false,
    code: "NOT_SUPPORTED",
    detail:
      `${safeHost(input.baseUrl)} 未提供模型目录接口（尝试了 ${attempted.join("、")}，均返回 404/405）。` +
      "这不代表网关不可用：请手动添加 Model ID。",
    attemptedPaths: attempted,
  };
}

type FetchOutcome =
  | { kind: "success"; value: { models: DiscoveredModel[]; total: number; truncated: boolean } }
  | { kind: "failure"; code: DiscoveryErrorCode; detail: string };

async function fetchUrl(
  url: string,
  input: DiscoverModelsInput,
  displayPath: string,
  timeoutMs: number,
  redirectHops: number,
): Promise<FetchOutcome> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...input.headers,
    ...discoveryAuthHeaders(input.api, input.authHeader, input.apiKey),
  };
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal, redirect: "manual" });
  } catch (error) {
    return { kind: "failure", ...networkFailure(error, safeHost(input.baseUrl), displayPath) };
  }

  // 重定向：只允许同主机 http→https 升级（或同 URL），且最多跟一跳；跨主机一律拒绝
  if (response.status >= 300 && response.status < 400) {
    const currentUrl = new URL(url);
    const location = response.headers.get("location");
    const target = location !== null ? new URL(location, currentUrl) : undefined;
    if (target === undefined || redirectHops >= 1) {
      return {
        kind: "failure",
        code: "REDIRECTED",
        detail: `${safeHost(input.baseUrl)}${displayPath} 返回了重定向但未提供有效目标（或重定向次数超限），已停止`,
      };
    }
    const sameHost = target.host === currentUrl.host;
    const schemeUpgrade = currentUrl.protocol === "http:" && target.protocol === "https:";
    if (!sameHost || !(schemeUpgrade || target.toString() === currentUrl.toString())) {
      return {
        kind: "failure",
        code: "REDIRECTED",
        detail: `${safeHost(input.baseUrl)}${displayPath} 重定向到其他主机（${safeHost(target.href)}），已拒绝转发认证信息；请直接填写最终地址`,
      };
    }
    return fetchUrl(target.toString(), input, displayPath, timeoutMs, redirectHops + 1);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: "failure",
      code: "AUTH_FAILED",
      detail: `认证失败（HTTP ${response.status}）：请检查 API Key 是否正确、是否有该服务的权限`,
    };
  }
  if (response.status === 404 || response.status === 405) {
    return { kind: "failure", code: "NOT_SUPPORTED", detail: `HTTP ${response.status}` };
  }
  if (response.status === 429) {
    return {
      kind: "failure",
      code: "RATE_LIMITED",
      detail: "请求被限流（HTTP 429）：请稍后重试",
    };
  }
  if (response.status >= 500) {
    return {
      kind: "failure",
      code: "SERVER_ERROR",
      detail: `网关服务错误（HTTP ${response.status}）：请稍后重试或检查服务状态`,
    };
  }
  if (response.status !== 200) {
    return {
      kind: "failure",
      code: "BAD_RESPONSE",
      detail: `意外的 HTTP 状态：${response.status}`,
    };
  }

  let body: string;
  try {
    body = await readBodyCapped(response);
  } catch (error) {
    if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
      return {
        kind: "failure",
        code: "BAD_RESPONSE",
        detail: `响应体超过 ${Math.floor(DISCOVERY_MAX_BODY_BYTES / 1024 / 1024)}MB 上限`,
      };
    }
    return { kind: "failure", ...networkFailure(error, safeHost(input.baseUrl), displayPath) };
  }

  try {
    const parsed = parseModelCatalog(body);
    return {
      kind: "success",
      value: {
        models: parsed.models,
        total: parsed.total,
        truncated: parsed.models.length >= DISCOVERY_MAX_MODELS,
      },
    };
  } catch (error) {
    return {
      kind: "failure",
      code: "BAD_RESPONSE",
      detail: `目录响应解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 流式读取并限制总大小，防止异常大响应撑爆内存 */
async function readBodyCapped(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      received += value.byteLength;
      if (received > DISCOVERY_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  }
  const total = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf8", { fatal: false }).decode(total);
}

function networkFailure(
  error: unknown,
  host: string,
  path: string,
): { code: DiscoveryErrorCode; detail: string } {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "TIMEOUT", detail: `请求 ${host}${path} 超时（${DISCOVERY_TIMEOUT_MS / 1000}s），请检查网络或稍后重试` };
  }
  return {
    code: "NETWORK",
    detail: `无法连接 ${host}${path}（${error instanceof Error ? error.message : "网络错误"}）`,
  };
}

/** baseUrl（已去尾斜杠）+ 绝对路径；path 自带查询的场景不存在（modelsPath 校验禁止） */
function joinUrl(baseUrl: string, path: string): string {
  const base = trimTrailingSlash(baseUrl);
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(无效地址)";
  }
}
