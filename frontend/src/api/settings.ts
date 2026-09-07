import { apiClient } from "./client.js";
import type {
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
 *
 * Key 只经 PUT/test 请求体发往同源 Backend；GET 响应不含 key，
 * 任何返回值都不落 localStorage/sessionStorage。
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
}): Promise<ModelTestResultView> {
  const body = await apiClient.post<{ result: ModelTestResultView }>(
    "/api/settings/model/test",
    input,
  );
  return body.result;
}
