import { apiClient } from "./client.js";
import type { NetworkProxyInput, NetworkSettingsView, NetworkTestResultView } from "../types/api.js";

/**
 * Network Settings API（M13.8 Research 代理；非敏感配置，无任何 key）。
 *
 *   GET  /api/settings/network       → { settings }
 *   PUT  /api/settings/network       → { settings }（保存后对后续学术请求生效）
 *   POST /api/settings/network/test  → { result }（候选配置可未保存；enabled=false = 直连对照）
 *
 * 作用范围只在学术检索 / 文献元数据核验 / 合法全文下载；模型 API 请求不经过它。
 */

export async function getNetworkSettings(signal?: AbortSignal): Promise<NetworkSettingsView> {
  const body = await apiClient.get<{ settings: NetworkSettingsView }>("/api/settings/network", signal);
  return body.settings;
}

export async function saveNetworkSettings(input: NetworkProxyInput): Promise<NetworkSettingsView> {
  const body = await apiClient.put<{ settings: NetworkSettingsView }>("/api/settings/network", input);
  return body.settings;
}

export async function testNetworkSettings(input: NetworkProxyInput): Promise<NetworkTestResultView> {
  const body = await apiClient.post<{ result: NetworkTestResultView }>("/api/settings/network/test", input);
  return body.result;
}
