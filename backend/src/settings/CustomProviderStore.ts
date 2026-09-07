/**
 * 自定义模型提供商（Anthropic / OpenAI 兼容网关等）的持久化：
 * `<runtimeRoot>/settings/custom-providers.json`。
 *
 * 只存非敏感配置（id / 名称 / baseUrl / 协议 / 模型目录 / 额外请求头）；
 * API Key 一律走 Pi 官方 credential storage（agentDir/auth.json，经
 * ModelRuntime.login/logout），请求头里也禁止出现认证头。
 *
 * 启动时由 ModelSettingsService 逐个 `ModelRuntime.registerProvider`
 * 注入 Pi 的扩展层（与手工编辑 agentDir/models.json 的 Pi 官方机制并存，
 * 互不覆盖）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BusinessError } from "../errors.js";
import { writeJsonAtomic } from "../util/atomic.js";

/** 可选的接口协议（Pi 内建 API 实现里对第三方网关有意义的三种） */
export const CUSTOM_PROVIDER_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export const CUSTOM_MODEL_INPUTS = ["text", "image"] as const;
export type CustomModelInput = (typeof CUSTOM_MODEL_INPUTS)[number];

export interface CustomProviderModel {
  id: string;
  name: string;
  /** 是否支持 thinking / reasoning（网关不支持时必须为 false，否则请求头会带上 beta 特性） */
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: CustomModelInput[];
}

export interface CustomProviderConfig {
  /** provider id：小写字母 / 数字 / 连字符，作为模型规格 "provider/model-id" 的前缀 */
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  /** anthropic-messages 协议下用 `Authorization: Bearer` 代替 `x-api-key`（多数网关需要） */
  authHeader: boolean;
  /** 额外请求头（不允许认证头；Key 走 credential storage） */
  headers: Record<string, string>;
  models: CustomProviderModel[];
  updatedAt: string;
}

/** 校验通过、尚未打时间戳的输入 */
export type CustomProviderInput = Omit<CustomProviderConfig, "updatedAt">;

/** Pi 未从包入口导出 ProviderConfigInput：从 registerProvider 签名推导，避免 deep import */
export type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_MODELS = 200;
const MAX_HEADERS = 20;
const MAX_TEXT = 200;
/** 认证头只能经 API Key 路径进入（落 auth.json、不回显、可清除） */
const FORBIDDEN_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

interface StoredFile {
  version: 1;
  providers: CustomProviderConfig[];
}

export class CustomProviderStore {
  private readonly filePath: string;

  constructor(options: { settingsDir: string }) {
    this.filePath = join(options.settingsDir, "custom-providers.json");
  }

  /** 读取全部自定义提供商（文件缺失 / 损坏 → 空列表并跳过形状不符的条目） */
  async load(): Promise<CustomProviderConfig[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const list = (parsed as { providers?: unknown } | null)?.providers;
    if (!Array.isArray(list)) {
      return [];
    }
    const result: CustomProviderConfig[] = [];
    for (const entry of list) {
      try {
        const input = validateCustomProviderInput(entry);
        const updatedAt = (entry as Record<string, unknown>)["updatedAt"];
        result.push({ ...input, updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString() });
      } catch {
        // 损坏条目：跳过而不是让整个设置不可用
      }
    }
    return result;
  }

  async save(providers: CustomProviderConfig[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const file: StoredFile = { version: 1, providers };
    await writeJsonAtomic(this.filePath, file);
  }
}

/** 请求体 → 已校验配置；任何字段不合法都抛 INVALID_REQUEST（400），消息可直接展示 */
export function validateCustomProviderInput(raw: unknown): CustomProviderInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BusinessError("INVALID_REQUEST", "provider 必须是对象");
  }
  const record = raw as Record<string, unknown>;

  const id = readText(record, "id");
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new BusinessError("INVALID_REQUEST", "id 只能包含小写字母、数字和连字符，且以字母或数字开头（最长 40 字符）");
  }
  const name = readText(record, "name");
  const baseUrl = readText(record, "baseUrl");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new BusinessError("INVALID_REQUEST", "baseUrl 不是合法的 URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new BusinessError("INVALID_REQUEST", "baseUrl 必须以 http:// 或 https:// 开头");
  }
  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new BusinessError("INVALID_REQUEST", "baseUrl 不能带查询参数或锚点");
  }

  const api = record["api"];
  if (typeof api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) {
    throw new BusinessError("INVALID_REQUEST", `api 必须是 ${CUSTOM_PROVIDER_APIS.join(" / ")} 之一`);
  }

  const authHeaderRaw = record["authHeader"];
  if (authHeaderRaw !== undefined && typeof authHeaderRaw !== "boolean") {
    throw new BusinessError("INVALID_REQUEST", "authHeader 必须是布尔值");
  }

  const headers = readHeaders(record["headers"]);
  const models = readModels(record["models"]);

  return {
    id,
    name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    api: api as CustomProviderApi,
    authHeader: authHeaderRaw ?? false,
    headers,
    models,
  };
}

/** 转成 Pi `registerProvider` 需要的形状（cost 全零：网关计费不在 PaperTeam 内核算） */
export function toProviderConfigInput(config: CustomProviderInput): ProviderConfigInput {
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    api: config.api,
    authHeader: config.authHeader,
    headers: config.headers,
    models: config.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

function readText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BusinessError("INVALID_REQUEST", `字段 ${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) {
    throw new BusinessError("INVALID_REQUEST", `字段 ${field} 过长（最多 ${MAX_TEXT} 字符）`);
  }
  return trimmed;
}

function readHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BusinessError("INVALID_REQUEST", "headers 必须是对象（请求头名 → 值）");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) {
    throw new BusinessError("INVALID_REQUEST", `请求头最多 ${MAX_HEADERS} 个`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of entries) {
    const headerName = key.trim();
    if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
      throw new BusinessError("INVALID_REQUEST", `请求头名不合法："${key}"`);
    }
    if (FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
      throw new BusinessError("INVALID_REQUEST", `请求头 ${headerName} 属于认证头，请改用 API Key 字段保存`);
    }
    if (typeof value !== "string" || value.length > MAX_TEXT || /[\r\n]/.test(value)) {
      throw new BusinessError("INVALID_REQUEST", `请求头 ${headerName} 的值必须是单行字符串（最多 ${MAX_TEXT} 字符）`);
    }
    headers[headerName] = value;
  }
  return headers;
}

function readModels(raw: unknown): CustomProviderModel[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BusinessError("INVALID_REQUEST", "models 至少需要一个模型");
  }
  if (raw.length > MAX_MODELS) {
    throw new BusinessError("INVALID_REQUEST", `models 最多 ${MAX_MODELS} 个`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BusinessError("INVALID_REQUEST", `models[${index}] 必须是对象`);
    }
    const record = entry as Record<string, unknown>;
    const id = readText(record, "id");
    if (/\s/.test(id)) {
      throw new BusinessError("INVALID_REQUEST", `models[${index}].id 不能包含空白字符`);
    }
    if (seen.has(id)) {
      throw new BusinessError("INVALID_REQUEST", `模型 id 重复："${id}"`);
    }
    seen.add(id);
    const nameRaw = record["name"];
    const name = typeof nameRaw === "string" && nameRaw.trim() !== "" ? nameRaw.trim().slice(0, MAX_TEXT) : id;
    const reasoning = record["reasoning"];
    if (reasoning !== undefined && typeof reasoning !== "boolean") {
      throw new BusinessError("INVALID_REQUEST", `models[${index}].reasoning 必须是布尔值`);
    }
    const contextWindow = readPositiveInt(record, "contextWindow", index, 200_000);
    const maxTokens = readPositiveInt(record, "maxTokens", index, 8_192);
    const inputRaw = record["input"];
    let input: CustomModelInput[] = ["text"];
    if (inputRaw !== undefined) {
      if (!Array.isArray(inputRaw) || inputRaw.some((item) => !(CUSTOM_MODEL_INPUTS as readonly string[]).includes(String(item)))) {
        throw new BusinessError("INVALID_REQUEST", `models[${index}].input 只能包含 text / image`);
      }
      input = [...new Set(inputRaw as CustomModelInput[])];
      if (!input.includes("text")) {
        input.unshift("text");
      }
    }
    return { id, name, reasoning: reasoning ?? false, contextWindow, maxTokens, input };
  });
}

function readPositiveInt(record: Record<string, unknown>, field: string, index: number, fallback: number): number {
  const value = record[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 100_000_000) {
    throw new BusinessError("INVALID_REQUEST", `models[${index}].${field} 必须是正整数`);
  }
  return value;
}
