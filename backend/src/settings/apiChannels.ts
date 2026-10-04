/**
 * Z.AI API 通道（Coding Plan / General API）解析与应用。
 *
 * 背景：Pi 内置的 zai / zai-coding-cn provider 默认指向 Coding Plan
 * endpoint（/api/coding/paas/v4，订阅 Key）。同一 Z.AI 账号体系还有
 * 按量计费的 General API（/api/paas/v4，个人充值 Key）——两种 Key 不能
 * 从内容猜测，必须由用户在 Settings UI 显式选择通道。
 *
 * 实现（全部经 Pi 公开 API，不 fork、不改 node_modules）：
 * - coding_plan（默认，向后兼容）：不注册任何 extension，使用 Pi provider
 *   内置 baseUrl（https://api.z.ai/api/coding/paas/v4 等）
 * - general_api：ModelRuntime.registerProvider(providerId, { baseUrl }) ——
 *   Pi 1.0.1 的 extension 层会把该 provider 全部模型的 baseUrl 替换为
 *   按量 endpoint；Test Connection 与真实 Agent Runtime 都经
 *   ModelRuntime.getModel 取同一模型对象，天然共享同一 endpoint
 *
 * 存储：非 secret，随模型偏好存 <runtimeRoot>/settings/model.json 的
 * apiChannel 字段（provider 级绑定）；credential 仍在 auth.json，不迁移、
 * 不复制。
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { StoredModelSettings } from "./ModelSettingsStore.js";

/** API 通道（产品语义：用户选的是「通道」，不是 URL） */
export type ApiChannel = "coding_plan" | "general_api";

export const API_CHANNELS: readonly ApiChannel[] = ["coding_plan", "general_api"];

export function isApiChannelValue(value: unknown): value is ApiChannel {
  return typeof value === "string" && (API_CHANNELS as readonly string[]).includes(value);
}

/**
 * 双通道 provider → General API（按量）endpoint。coding 通道一律使用
 * Pi provider 内置默认值（不在 PaperTeam 重复硬编码）。
 */
const ZAI_GENERAL_API_BASE_URLS: Readonly<Record<string, string>> = {
  zai: "https://api.z.ai/api/paas/v4",
  "zai-coding-cn": "https://open.bigmodel.cn/api/paas/v4",
};

/** provider 是否支持 Coding Plan / General API 双通道 */
export function supportsApiChannels(providerId: string): boolean {
  return providerId in ZAI_GENERAL_API_BASE_URLS;
}

/** General API endpoint（不支持双通道的 provider → undefined） */
export function generalApiBaseUrlFor(providerId: string): string | undefined {
  return ZAI_GENERAL_API_BASE_URLS[providerId];
}

/**
 * 通道 → baseUrl override（Test Connection 与 Runtime 共享的唯一 resolver）。
 * coding_plan / 不支持双通道 → undefined（Pi provider 默认 endpoint）。
 */
export function resolveApiChannelBaseUrl(
  providerId: string,
  channel: ApiChannel | undefined,
): string | undefined {
  if (channel !== "general_api") {
    return undefined;
  }
  return generalApiBaseUrlFor(providerId);
}

/**
 * 把存储的通道绑定同步到 ModelRuntime（幂等；存储是唯一事实源）：
 * - 绑定 general_api 的 provider → registerProvider(baseUrl override)
 * - 其余双通道 provider → unregisterProvider（清掉本服务注册的 override，
 *   回到 Pi 内置默认 endpoint；这些 id 是内置 provider，unregister 只会
 *   移除 extension 层，不影响 models.json / credential）
 *
 * 必须在 adapter 解析启动模型（applyModelConfig）之前调用，之后
 * reconfigure / getModel 返回的模型对象即携带 override 后的 baseUrl。
 */
export function syncApiChannelRegistrations(
  modelRuntime: Pick<ModelRuntime, "registerProvider" | "unregisterProvider">,
  stored: StoredModelSettings,
  log: (message: string) => void = () => {},
): void {
  const binding = stored.apiChannel;
  const overridden =
    binding !== undefined &&
    binding.channel === "general_api" &&
    supportsApiChannels(binding.provider)
      ? binding.provider
      : undefined;
  for (const providerId of Object.keys(ZAI_GENERAL_API_BASE_URLS)) {
    if (providerId === overridden) {
      const baseUrl = ZAI_GENERAL_API_BASE_URLS[providerId]!;
      modelRuntime.registerProvider(providerId, { baseUrl });
      log(`[model-settings] ${providerId} 使用按量 API 通道（${baseUrl}）`);
    } else {
      modelRuntime.unregisterProvider(providerId);
    }
  }
}

/** 启动 wiring：读取存储偏好并同步通道注册（index.ts / liveRuntime 同序调用） */
export async function applyStoredApiChannels(
  modelRuntime: Pick<ModelRuntime, "registerProvider" | "unregisterProvider">,
  store: Pick<ModelSettingsStoreLike, "load">,
  log: (message: string) => void = () => {},
): Promise<void> {
  syncApiChannelRegistrations(modelRuntime, await store.load(), log);
}

interface ModelSettingsStoreLike {
  load(): Promise<StoredModelSettings>;
}
