import { apiClient } from "./client.js";
import type {
  ApiChannel,
  CustomProviderInput,
  CustomProviderView,
  ModelOptionsView,
  ModelSettingsView,
  ModelTestResultView,
} from "../types/api.js";

/**
 * Model Settings API。
 *
 *   GET    /api/settings/model          → { settings }（无 key 本体）
 *   PUT    /api/settings/model          → { settings }（apiKey 省略 = 保持原 Key）
 *   DELETE /api/settings/model/key      → { settings }
 *   GET    /api/settings/model/options  → { options }（?provider= 单 provider 模型）
 *   POST   /api/settings/model/test     → { result }
 *   GET    /api/settings/model/custom-providers      → { providers }
 *   PUT    /api/settings/model/custom-providers/:id  → { provider, settings }
 *   DELETE /api/settings/model/custom-providers/:id  → { settings }
 *
 * Key 只经 PUT/test 请求体发往同源 Backend；GET 响应不含 key，
 * 任何返回值都不落 localStorage/sessionStorage。apiChannel 是非 secret 的
 * 通道选择（Z.AI 家族 provider），与保存后的真实 Runtime 用同一通道。
 */

export async function getModelSettings(signal?: AbortSignal): Promise<ModelSettingsView> {
  const body = await apiClient.get<{ settings: ModelSettingsView }>(
    "/api/settings/model",
    signal,
  );
  return body.settings;
}

export async function saveModelSettings(input: {
  model: string;
  /** 省略 = 保持原 Key；空字符串非法（Backend 400） */
  apiKey?: string;
  /**
   * per-Agent override（M5.7）：省略 = 保持现有 override；存在时整体替换
   * （键缺省 / null = 该 Agent 继承默认）。只含 provider/model 规格，无 Key。
   */
  agents?: Record<string, string | null>;
  /**
   * Vision 模型（M10.2）：省略 = 保持现有；null = 清除（回落默认模型复用）；
   * 须为目录声明 image input 的模型（Backend 校验拒绝 text-only）。
   */
  visionModel?: string | null;
  /**
   * Z.AI API 通道：省略 = 保持现有；coding_plan = Pi 默认 Coding endpoint；
   * general_api = 按量 endpoint（baseUrl override）。仅双通道 provider 合法。
   */
  apiChannel?: ApiChannel;
}): Promise<ModelSettingsView> {
  const body = await apiClient.put<{ settings: ModelSettingsView }>("/api/settings/model", input);
  return body.settings;
}

export async function clearModelApiKey(): Promise<ModelSettingsView> {
  const body = await apiClient.delete<{ settings: ModelSettingsView }>(
    "/api/settings/model/key",
  );
  return body.settings;
}

export async function getModelOptions(
  provider?: string,
  signal?: AbortSignal,
): Promise<ModelOptionsView> {
  const path =
    provider !== undefined && provider !== ""
      ? `/api/settings/model/options?provider=${encodeURIComponent(provider)}`
      : "/api/settings/model/options";
  const body = await apiClient.get<{ options: ModelOptionsView }>(path, signal);
  return body.options;
}

export async function testModelConnection(input: {
  model: string;
  apiKey?: string;
  /** Z.AI API 通道（与保存后的真实 Runtime 用同一通道测试） */
  apiChannel?: ApiChannel;
}): Promise<ModelTestResultView> {
  const body = await apiClient.post<{ result: ModelTestResultView }>(
    "/api/settings/model/test",
    input,
  );
  return body.result;
}

export async function getCustomProviders(signal?: AbortSignal): Promise<CustomProviderView[]> {
  const body = await apiClient.get<{ providers: CustomProviderView[] }>("/api/settings/model/custom-providers", signal);
  return body.providers;
}

export async function saveCustomProvider(input: {
  provider: CustomProviderInput;
  /** 省略 = 保持该提供商已保存的 Key */
  apiKey?: string;
}): Promise<{ provider: CustomProviderView; settings: ModelSettingsView }> {
  return apiClient.put<{ provider: CustomProviderView; settings: ModelSettingsView }>(
    `/api/settings/model/custom-providers/${encodeURIComponent(input.provider.id)}`,
    input,
  );
}

export async function deleteCustomProvider(id: string): Promise<ModelSettingsView> {
  const body = await apiClient.delete<{ settings: ModelSettingsView }>(
    `/api/settings/model/custom-providers/${encodeURIComponent(id)}`,
  );
  return body.settings;
}
