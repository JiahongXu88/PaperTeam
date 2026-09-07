/**
 * Model Settings 服务：Settings UI 的后端编排层。
 *
 * 职责（全部经 Pi 官方公开 API，不 deep import、不自建第二套 credential）：
 * - 状态读取：生效配置解析（env > stored）、provider 凭据就绪（不含 key 本体）
 * - 模型目录：providers / per-provider models 的安全 metadata DTO
 * - 保存：模型偏好 → ModelSettingsStore；API Key → ModelRuntime.login
 *   （官方 credential 写路径：RuntimeCredentials.modify → agentDir/auth.json，
 *   并同步 provider 快照；Key 不进日志）
 * - 清除：ModelRuntime.logout（删 auth.json 条目 + 内存覆盖层 + 同步）
 * - Test Connection：completeSimple 最小真实调用（可携带未保存的 Key，
 *   经 options.apiKey 覆盖式注入，不落盘、不建 AgentSession、不写 Workspace）
 * - 生效：adapter.reconfigure（在途 run > 0 时拒绝，409；新 Run 用新配置）
 * - 自定义提供商：CustomProviderStore 持久化 + ModelRuntime.registerProvider
 *   注入 Pi 扩展层（启动时重放；Key 同样走 login/logout）
 *
 * 优先级（与 config.ts / 文档一致）：
 *   PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY（env，最高）
 *   > Settings UI 保存的本地配置（model.json + auth.json）
 *   > 未配置
 * env 覆盖时保存仍被允许（持久化到本地，env 不存在时生效），但状态
 * configurationSource=environment 明确提示，避免「保存后看似生效实则被 env
 * 覆盖」的误导。
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BusinessError, ModelConfigBusyError, NotFoundError } from "../errors.js";
import { parseModelSpec } from "../runtime/PiRuntimeAdapter.js";
import { PI_RUNTIME_VERSION } from "../runtime/pi/version.js";
import type { RuntimeHealth } from "../runtime/types.js";
import {
  type CustomProviderConfig,
  type CustomProviderStore,
  toProviderConfigInput,
  validateCustomProviderInput,
} from "./CustomProviderStore.js";
import type { ModelSettingsStore } from "./ModelSettingsStore.js";

/** Test Connection 的最小真实调用超时（毫秒） */
const TEST_CONNECTION_TIMEOUT_MS = 30_000;

/** 返回给前端的错误详情截断上限（不透传 Pi/provider 原始长文本） */
const DETAIL_MAX_CHARS = 300;

/** Settings 需要的 Runtime 能力子集（PiRuntimeAdapter 结构满足；测试可注入 fake） */
export interface ModelSettingsRuntime {
  healthCheck(): Promise<RuntimeHealth>;
  modelStatusSnapshot(): Promise<{
    phase: "configured" | "not_configured" | "unknown";
    providers: string[];
    detail: string;
  }>;
  readonly resolvedModel?: string;
  reconfigure(modelSpec: string | undefined): Promise<unknown>;
  runtimeStats(): { activeRuns: number; managedSessions: number };
}

export interface ModelSettingsEnv {
  /** PAPERTEAM_PI_MODEL（已 trim；未设置为 undefined） */
  piModel?: string;
  /** PAPERTEAM_PI_API_KEY（已 trim；未设置为 undefined） */
  piApiKey?: string;
}

export interface ModelSettingsStatus {
  /** 生效模型的 provider 段（模型未配置时缺省） */
  provider?: string;
  /** 生效模型的 model-id 段（provider 之后整体；可含 "/"，如 openrouter 的 anthropic/claude-sonnet-4） */
  modelId?: string;
  /** 生效模型 "provider/model-id"（env 覆盖时为 env 值） */
  model?: string;
  /** Settings UI 保存的本地偏好（可能与生效值不同：env 覆盖时） */
  savedModel?: string;
  /** provider 是否有可用凭据（任何来源：env / auth.json / 标准环境变量） */
  apiKeyConfigured: boolean;
  /** 凭据来源（不含 key 本体） */
  apiKeySource: "environment" | "stored" | "none";
  /** 生效配置来源：环境变量 > 本地保存 > 未配置 */
  configurationSource: "environment" | "stored" | "not_configured";
  /** 是否存在 env 覆盖（PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 任一存在） */
  envOverride: boolean;
  runtimePhase: "healthy" | "unhealthy";
  runtimeVersion: string;
  modelPhase: "configured" | "not_configured" | "unknown";
  modelDetail: string;
  /** 人读状态说明（env 覆盖提示在此） */
  detail: string;
}

export interface ModelProviderOption {
  id: string;
  name: string;
  /** provider 是否已有可用凭据（不含 key 本体） */
  authConfigured: boolean;
  /** 是否支持经 Settings UI 保存 API Key（provider.auth.apiKey.login 存在） */
  apiKeyLoginSupported: boolean;
  modelCount: number;
  /** builtin = Pi 内置或 agentDir/models.json；custom = Settings UI 添加的自定义提供商 */
  source: "builtin" | "custom";
}

/** 自定义提供商 DTO（配置本体 + 凭据是否就绪；不含 key） */
export interface CustomProviderView extends CustomProviderConfig {
  authConfigured: boolean;
}

export interface ModelOption {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
}

export type ModelTestResultCode =
  | "AUTH_FAILED"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNKNOWN";

export interface ModelTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs?: number;
  /** 失败分类（ok=true 时缺省） */
  code?: ModelTestResultCode;
  /** 失败详情（截断 + 脱敏；不含 key） */
  detail?: string;
}

export interface ModelSettingsServiceOptions {
  modelRuntime: ModelRuntime;
  runtime: ModelSettingsRuntime;
  store: ModelSettingsStore;
  customProviders: CustomProviderStore;
  env: ModelSettingsEnv;
  log?: (message: string) => void;
}

/**
 * 启动时把持久化的自定义提供商重放进 ModelRuntime（必须在 PiRuntimeAdapter
 * 解析启动模型之前调用，否则偏好指向自定义提供商时 Runtime 会判 not_configured）。
 * 单条注册失败只记日志、不阻塞启动。
 */
export async function registerStoredCustomProviders(
  modelRuntime: ModelRuntime,
  store: CustomProviderStore,
  log: (message: string) => void = () => {},
): Promise<number> {
  let registered = 0;
  for (const config of await store.load()) {
    try {
      modelRuntime.registerProvider(config.id, toProviderConfigInput(config));
      registered += 1;
    } catch (error) {
      log(`[model-settings] 自定义提供商 ${config.id} 注册失败：${errorText(error)}`);
    }
  }
  return registered;
}

export class ModelSettingsService {
  private readonly modelRuntime: ModelRuntime;
  private readonly runtime: ModelSettingsRuntime;
  private readonly store: ModelSettingsStore;
  private readonly customProviders: CustomProviderStore;
  private readonly env: ModelSettingsEnv;
  private readonly log: (message: string) => void;

  constructor(options: ModelSettingsServiceOptions) {
    this.modelRuntime = options.modelRuntime;
    this.runtime = options.runtime;
    this.store = options.store;
    this.customProviders = options.customProviders;
    this.env = options.env;
    this.log = options.log ?? (() => {});
  }

  // ---- 状态读取（GET /api/settings/model；不含任何 key） ----

  async getStatus(): Promise<ModelSettingsStatus> {
    const stored = await this.store.load();
    const envModel = this.env.piModel;
    const envOverride = envModel !== undefined || this.env.piApiKey !== undefined;
    const effectiveModel = envModel ?? stored.model;
    const parsed = effectiveModel !== undefined ? parseModelSpec(effectiveModel) : undefined;

    const [health, modelStatus] = await Promise.all([
      this.runtime.healthCheck(),
      this.runtime.modelStatusSnapshot(),
    ]);

    let apiKeyConfigured = false;
    let apiKeySource: ModelSettingsStatus["apiKeySource"] = "none";
    if (parsed !== undefined) {
      const auth = this.getAuthStatus(parsed.provider);
      apiKeyConfigured = auth.configured;
      apiKeySource = auth.source;
    }

    const configurationSource: ModelSettingsStatus["configurationSource"] = envOverride
      ? "environment"
      : stored.model !== undefined
        ? "stored"
        : "not_configured";

    return {
      ...(parsed !== undefined ? { provider: parsed.provider } : {}),
      ...(parsed !== undefined ? { modelId: parsed.modelId } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(stored.model !== undefined ? { savedModel: stored.model } : {}),
      apiKeyConfigured,
      apiKeySource,
      configurationSource,
      envOverride,
      runtimePhase: health.ok ? "healthy" : "unhealthy",
      runtimeVersion: PI_RUNTIME_VERSION,
      modelPhase: modelStatus.phase,
      modelDetail: modelStatus.detail,
      detail: describeSource(configurationSource),
    };
  }

  // ---- 模型目录（GET /api/settings/model/options[?provider=]） ----

  /** provider 列表（含凭据/登录能力标记）；或单个 provider 的模型目录 */
  async getOptions(providerId?: string): Promise<
    | { providers: ModelProviderOption[] }
    | { provider: ModelProviderOption; models: ModelOption[] }
  > {
    const customIds = new Set((await this.customProviders.load()).map((config) => config.id));
    if (providerId === undefined || providerId === "") {
      const providers = this.modelRuntime
        .getProviders()
        .map((provider) => this.toProviderOption(provider.id, customIds))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { providers };
    }
    const provider = this.modelRuntime.getProvider(providerId);
    if (provider === undefined) {
      throw new BusinessError("INVALID_REQUEST", `未知的 provider：${providerId}`);
    }
    const models = this.modelRuntime
      .getModels(providerId)
      .map((model) => this.toModelOption(model));
    return { provider: this.toProviderOption(providerId, customIds), models };
  }

  // ---- 自定义提供商（/api/settings/model/custom-providers） ----

  async listCustomProviders(): Promise<CustomProviderView[]> {
    return (await this.customProviders.load()).map((config) => this.toCustomProviderView(config));
  }

  /**
   * 新建或整体替换一个自定义提供商：校验 → 注入 ModelRuntime → 落盘 →
   * （可选）保存 Key。id 与内置 / models.json 提供商冲突时拒绝，避免遮蔽官方目录。
   */
  async saveCustomProvider(
    raw: unknown,
    apiKey?: string,
  ): Promise<{ provider: CustomProviderView; settings: ModelSettingsStatus }> {
    this.assertIdle();
    const input = validateCustomProviderInput(raw);
    const stored = await this.customProviders.load();
    const existing = stored.find((config) => config.id === input.id);
    if (existing === undefined && this.modelRuntime.getProvider(input.id) !== undefined) {
      throw new BusinessError("INVALID_REQUEST", `id "${input.id}" 与已有提供商冲突，请换一个 id`);
    }
    if (apiKey !== undefined && apiKey.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", "apiKey 不能为空字符串：不修改 Key 请省略该字段");
    }

    // 整体替换而不是合并：Pi 的重复注册会保留未提供的旧字段
    if (existing !== undefined) {
      this.modelRuntime.unregisterProvider(input.id);
    }
    try {
      this.modelRuntime.registerProvider(input.id, toProviderConfigInput(input));
    } catch (error) {
      if (existing !== undefined) {
        this.modelRuntime.registerProvider(existing.id, toProviderConfigInput(existing));
      }
      throw new BusinessError("INVALID_REQUEST", `提供商配置被 Runtime 拒绝：${errorText(error)}`);
    }

    const config: CustomProviderConfig = { ...input, updatedAt: new Date().toISOString() };
    const next = existing !== undefined
      ? stored.map((entry) => (entry.id === config.id ? config : entry))
      : [...stored, config];
    await this.customProviders.save(next);
    this.log(`[model-settings] 已${existing !== undefined ? "更新" : "添加"}自定义提供商 ${config.id}（${config.api}，${config.models.length} 个模型）`);

    if (apiKey !== undefined) {
      await this.storeApiKey(config.id, apiKey);
    }

    // 当前生效模型属于这个提供商时，让 Runtime 重新解析模型定义（baseUrl / 协议可能变了）
    const effective = this.env.piModel ?? (await this.store.load()).model;
    if (effective !== undefined && parseModelSpec(effective)?.provider === config.id) {
      await this.reconfigureSafely(effective, [apiKey]);
    }
    return { provider: this.toCustomProviderView(config), settings: await this.getStatus() };
  }

  /**
   * 删除自定义提供商：从 Runtime 注销、清掉它的本地凭据；若模型偏好指向它，
   * 一并清除偏好（否则重启后 Runtime 会解析到不存在的提供商）。
   */
  async deleteCustomProvider(id: string): Promise<ModelSettingsStatus> {
    this.assertIdle();
    const stored = await this.customProviders.load();
    if (!stored.some((config) => config.id === id)) {
      throw new NotFoundError("自定义提供商", id);
    }
    this.modelRuntime.unregisterProvider(id);
    try {
      await this.modelRuntime.logout(id);
    } catch {
      // 没有保存过凭据时 logout 无事可做
    }
    await this.customProviders.save(stored.filter((config) => config.id !== id));

    const preference = (await this.store.load()).model;
    if (preference !== undefined && parseModelSpec(preference)?.provider === id) {
      await this.store.clear();
      this.log(`[model-settings] 模型偏好 ${preference} 随自定义提供商 ${id} 一并清除`);
    }
    this.log(`[model-settings] 已删除自定义提供商 ${id}`);
    await this.reconfigureSafely(this.env.piModel ?? (await this.store.load()).model, []);
    return this.getStatus();
  }

  // ---- 保存（PUT /api/settings/model） ----

  /**
   * 保存模型偏好（必填）与 API Key（可选；省略 = 保持原 Key）。
   * 语义：先持久化，再重载 Runtime（在途 run > 0 时 409 拒绝，
   * 全部落盘但 Runtime 保持旧配置——下次空闲保存即可对齐；此处直接
   * 抛出，不产生半应用状态）。
   */
  async saveModel(input: { model: string; apiKey?: string }): Promise<ModelSettingsStatus> {
    // 前置空闲检查：避免「已落盘但 Runtime 被拒」的半应用状态
    // （reconfigure 内部仍有一致性守卫，双保险）
    this.assertIdle();
    const spec = input.model.trim();
    const parsed = parseModelSpec(spec);
    if (parsed === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `模型规格非法："${spec}"（应为 provider/model-id，如 zai-coding-cn/glm-5.3）`,
      );
    }
    const { provider, modelId } = parsed;
    if (this.modelRuntime.getModel(provider, modelId) === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `模型 ${provider}/${modelId} 不在注册表（可在 GET /api/settings/model/options?provider=${provider} 查看可用模型）`,
      );
    }

    const apiKey = input.apiKey;
    if (apiKey !== undefined) {
      if (apiKey.trim() === "") {
        throw new BusinessError(
          "INVALID_REQUEST",
          "apiKey 不能为空字符串：不修改 Key 请省略该字段；清除 Key 请使用 DELETE /api/settings/model/key",
        );
      }
      await this.storeApiKey(provider, apiKey);
    }

    await this.store.save(spec);
    this.log(`[model-settings] 已保存模型偏好：${spec}`);

    // 生效值仍按优先级解析（env 覆盖时 Runtime 保持 env 配置）；
    // 同样收敛 SDK 错误对象（可能内嵌 credential）
    const effective = this.env.piModel ?? spec;
    await this.reconfigureSafely(effective, [apiKey].filter(Boolean));
    return this.getStatus();
  }

  // ---- 清除 Key（DELETE /api/settings/model/key） ----

  /**
   * 清除本地保存的 API Key（agentDir auth.json 条目 + 内存覆盖层）。
   * 若 env 仍提供凭据（PAPERTEAM_PI_API_KEY / 标准环境变量），模型保持
   * configured（reconfigure 会按优先级重新注入 startup env key）。
   */
  async clearApiKey(): Promise<ModelSettingsStatus> {
    this.assertIdle();
    const stored = await this.store.load();
    const effectiveModel = this.env.piModel ?? stored.model;
    const parsed = effectiveModel !== undefined ? parseModelSpec(effectiveModel) : undefined;
    if (parsed === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "当前没有已配置的模型（无 provider 可清除 Key）；请先保存模型配置",
      );
    }
    const provider = parsed.provider;
    try {
      await this.modelRuntime.logout(provider);
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      // SDK 凭据错误对象可能内嵌 key：只保留消息文本，且不带 key 本体
      throw new BusinessError("INTERNAL_ERROR", `清除 ${provider} 凭据失败：${redact(errorText(error), this.knownSecrets())}`);
    }
    this.log(`[model-settings] 已清除 ${provider} 的本地保存 API Key`);
    // 重载：startup env key（如有）重新注入；auth.json 变化同步到快照
    await this.reconfigureSafely(effectiveModel, []);
    return this.getStatus();
  }

  // ---- Test Connection（POST /api/settings/model/test） ----

  /**
   * 最小真实 Provider 调用：验证 模型存在 / 凭据有效 / Provider 可达 / LLM 响应。
   * 携带用户当前填写但尚未保存的 Key 时经 options.apiKey 覆盖式注入
   * （不落盘）；不创建 AgentSession、不写 Workspace、不污染会话历史。
   * 日志不打印请求体（可能含 Key）。
   */
  async testConnection(input: { model: string; apiKey?: string }): Promise<ModelTestResult> {
    const spec = input.model.trim();
    const parsed = parseModelSpec(spec);
    if (parsed === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `模型规格非法："${spec}"（应为 provider/model-id）`,
      );
    }
    const { provider, modelId } = parsed;
    const model = this.modelRuntime.getModel(provider, modelId);
    if (model === undefined) {
      return {
        ok: false,
        provider,
        model: spec,
        code: "MODEL_NOT_FOUND",
        detail: `模型 ${provider}/${modelId} 不在注册表`,
      };
    }

    const apiKey =
      input.apiKey !== undefined && input.apiKey.trim() !== "" ? input.apiKey : undefined;
    if (apiKey === undefined && !this.getAuthStatus(provider).configured) {
      return {
        ok: false,
        provider,
        model: spec,
        code: "AUTH_FAILED",
        detail: `provider ${provider} 无可用凭据（请填写 API Key，或先保存/设置环境变量）`,
      };
    }

    const startedAt = Date.now();
    let message: { stopReason?: string; errorMessage?: string };
    let aborted = false;
    const signal = AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS);
    try {
      message = await this.modelRuntime.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Connection test. Reply with exactly: OK" }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: 2048,
          ...(apiKey !== undefined ? { apiKey } : {}),
          signal,
        },
      );
    } catch (error) {
      aborted = signal.aborted;
      message = {
        stopReason: "error" as const,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const latencyMs = Date.now() - startedAt;

    const stopReason = message.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      const rawDetail = message.errorMessage ?? `stopReason=${stopReason}`;
      const code = aborted || signal.aborted ? "TIMEOUT" : classifyFailure(rawDetail);
      const detail = redact(truncate(rawDetail, DETAIL_MAX_CHARS), [apiKey, ...this.knownSecrets()]);
      this.log(
        `[model-settings] Test Connection 失败：${provider}/${modelId} code=${code}` +
          `（不打印请求体与 key）`,
      );
      return { ok: false, provider, model: spec, code, detail };
    }

    this.log(`[model-settings] Test Connection 成功：${provider}/${modelId}（${latencyMs}ms）`);
    return { ok: true, provider, model: spec, latencyMs };
  }

  // ---- 内部 ----

  /**
   * Pi 官方写路径：credentials.modify → agentDir/auth.json + provider 快照同步。
   * interaction 只应答唯一的 secret prompt；key 本体不进日志。
   * 同步失败时 SDK 抛 CredentialSynchronizationError（.credential 携带 key
   * 对象）——此处收敛为脱敏 BusinessError，杜绝 key 随错误对象进任何日志。
   */
  private async storeApiKey(provider: string, apiKey: string): Promise<void> {
    if (!this.supportsApiKeyLogin(provider)) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `provider ${provider} 不支持经 Settings UI 保存 API Key（仅环境变量凭据）`,
      );
    }
    try {
      await this.modelRuntime.login(provider, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type !== "secret") {
            throw new BusinessError(
              "INVALID_REQUEST",
              `provider ${provider} 的登录流程需要额外输入（${prompt.type}），不支持经 Settings UI 保存`,
            );
          }
          return apiKey;
        },
        notify: () => {},
      });
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw new BusinessError(
        "INTERNAL_ERROR",
        `保存 ${provider} 的凭据失败：${redact(errorText(error), [apiKey, ...this.knownSecrets()])}`,
      );
    }
    this.log(`[model-settings] 已保存 ${provider} 的 API Key（写入 agentDir auth.json）`);
  }

  private toCustomProviderView(config: CustomProviderConfig): CustomProviderView {
    return { ...config, authConfigured: this.getAuthStatus(config.id).configured };
  }

  /**
   * Runtime 重载的防泄漏包装：SDK 凭据同步错误（如
   * CredentialSynchronizationError）的错误对象可能内嵌 credential（含 key），
   * 绝不让原始对象逃逸到 HTTP 层的对象级日志；消息文本也先脱敏。
   */
  private async reconfigureSafely(
    modelSpec: string | undefined,
    secrets: (string | undefined)[],
  ): Promise<void> {
    try {
      await this.runtime.reconfigure(modelSpec);
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw new BusinessError(
        "INTERNAL_ERROR",
        `Runtime 模型配置重载失败：${redact(errorText(error), secrets)}`,
      );
    }
  }

  /** 进程内已知的 secret（env 注入的 key）：错误文本脱敏时一并抹除 */
  private knownSecrets(): (string | undefined)[] {
    return [this.env.piApiKey];
  }

  /** 存在在途 Agent Run 时拒绝配置变更（409；不中断活跃任务） */
  private assertIdle(): void {
    const { activeRuns } = this.runtime.runtimeStats();
    if (activeRuns > 0) {
      throw new ModelConfigBusyError(activeRuns);
    }
  }

  private getAuthStatus(providerId: string): {
    configured: boolean;
    source: ModelSettingsStatus["apiKeySource"];
  } {
    const status = this.modelRuntime.getProviderAuthStatus(providerId);
    if (!status.configured) {
      return { configured: false, source: "none" };
    }
    // "runtime"（PAPERTEAM_PI_API_KEY 注入的内存覆盖层）与 "environment"
    // （标准环境变量）对用户都是「环境变量提供」
    if (status.source === "stored") {
      return { configured: true, source: "stored" };
    }
    return { configured: true, source: "environment" };
  }

  private supportsApiKeyLogin(providerId: string): boolean {
    const provider = this.modelRuntime.getProvider(providerId);
    const login = (
      provider as { auth?: { apiKey?: { login?: unknown } } } | undefined
    )?.auth?.apiKey?.login;
    return typeof login === "function";
  }

  private toProviderOption(providerId: string, customIds: ReadonlySet<string>): ModelProviderOption {
    const provider = this.modelRuntime.getProvider(providerId);
    return {
      id: providerId,
      name: provider?.name ?? providerId,
      authConfigured: this.getAuthStatus(providerId).configured,
      apiKeyLoginSupported: this.supportsApiKeyLogin(providerId),
      modelCount: this.modelRuntime.getModels(providerId).length,
      source: customIds.has(providerId) ? "custom" : "builtin",
    };
  }

  private toModelOption(model: {
    id: string;
    name: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: string[];
  }): ModelOption {
    return {
      modelId: model.id,
      displayName: model.name,
      ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(Array.isArray(model.input) ? { input: [...model.input] } : {}),
    };
  }
}

function describeSource(source: ModelSettingsStatus["configurationSource"]): string {
  switch (source) {
    case "environment":
      return "当前模型配置由环境变量提供（PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 优先）。仍可保存本地配置：将在环境变量不存在时生效。";
    case "stored":
      return "模型配置来自 Settings UI 保存的本地配置（模型偏好 model.json + API Key agentDir/auth.json）。";
    case "not_configured":
      return "模型未配置：在 Settings 页面保存，或设置 PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 环境变量。";
  }
}

/** Provider 错误文本 → 稳定失败分类（只看 HTTP 状态与关键词，不透传原始栈） */
function classifyFailure(rawDetail: string): ModelTestResultCode {
  const text = rawDetail.toLowerCase();
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]api[_ ]key|invalid_api_key|authentication/.test(text)) {
    return "AUTH_FAILED";
  }
  if (/\b429\b|rate[_ ]limit|too many requests|quota/.test(text)) {
    return "RATE_LIMITED";
  }
  if (/\b404\b|model_not_found|does not exist|not found/.test(text)) {
    return "MODEL_NOT_FOUND";
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|econnrefused|enotfound|fetch failed|network/.test(text)) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (/abort|timeout|timed out/.test(text)) {
    return "TIMEOUT";
  }
  return "UNKNOWN";
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把已知 secret（如用户提交的 key）从文本中抹除后再返回/落日志 */
function redact(text: string, secrets: (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.trim() !== "" && result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
}
