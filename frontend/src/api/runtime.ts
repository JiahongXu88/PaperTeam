import { apiClient } from "./client.js";
import type { RuntimeStatusView } from "../types/api.js";

/** GET /api/runtime/status → { status }（Runtime / 模型 / 工具链就绪度） */
export async function getRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatusView> {
  const body = await apiClient.get<{ status: RuntimeStatusView }>("/api/runtime/status", signal);
  return body.status;
}
