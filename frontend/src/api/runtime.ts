import { apiClient } from "./client.js";
import type { RuntimeStatusView } from "../types/api.js";

/**
 * Runtime Status API（M4.1）。
 *
 *   GET /api/runtime/status → { status: RuntimeStatusView }
 *
 * M3.8 去 Gateway 化后的 Pi schema：runtime{provider,phase,version} /
 * model{phase,providers} / agents.roles / sessions{activeRuns,managedSessions}。
 * 不存在任何 gateway / protocol / clientSdk 字段（历史架构，前端禁止重现）。
 */

export async function getRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatusView> {
  const body = await apiClient.get<{ status: RuntimeStatusView }>("/api/runtime/status", signal);
  return body.status;
}
