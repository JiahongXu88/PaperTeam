/**
 * Gateway 健康等待（M3.5 Runtime Bootstrap）。
 *
 * Gateway 启动需要时间（首次运行还要初始化 state），Bootstrap 在启动后
 * 轮询 `GET {gateway}/health`（OpenClaw 官方无鉴权 liveness 探针，
 * 健康时返回 200 + {"ok":true}），直到通过或超时。
 */

import { BootstrapError } from "./runtimePaths.js";

export interface HealthWaitOptions {
  /** 整体等待预算（毫秒），默认 60s（首次初始化较慢） */
  timeoutMs?: number;
  /** 轮询间隔（毫秒），默认 500ms */
  intervalMs?: number;
  /** 可注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 可注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 进度回调 */
  onPoll?: (attempt: number, detail: string) => void;
}

export interface HealthWaitResult {
  /** 达到健康所用的尝试次数 */
  attempts: number;
  /** 最后一次探测耗时（毫秒） */
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 500;

/** 轮询等待 Gateway /health 就绪；超时抛 BootstrapError */
export async function waitForGatewayHealth(
  baseUrl: string,
  options: HealthWaitOptions = {},
): Promise<HealthWaitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastDetail = "尚未探测";

  while (Date.now() <= deadline) {
    attempt += 1;
    const startedAt = Date.now();
    const outcome = await probeHealth(fetchImpl, baseUrl);
    if (outcome.ok) {
      return { attempts: attempt, latencyMs: Date.now() - startedAt };
    }
    lastDetail = outcome.detail;
    options.onPoll?.(attempt, outcome.detail);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remaining));
  }
  throw new BootstrapError(
    `等待 Gateway 就绪超时（${timeoutMs}ms）：${baseUrl}/health — 最后一次探测：${lastDetail}`,
    "GATEWAY_STARTUP_TIMEOUT",
  );
}

/** 一次 /health 探测 */
async function probeHealth(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status !== 200) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const bodyText = await response.text();
    try {
      const body = JSON.parse(bodyText) as { ok?: unknown };
      if (body?.ok === true) {
        return { ok: true, detail: "ok" };
      }
      return { ok: false, detail: `响应缺少 ok:true（${bodyText.slice(0, 80)}）` };
    } catch {
      return { ok: false, detail: `响应不是 JSON（${bodyText.slice(0, 80)}）` };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: reason };
  } finally {
    clearTimeout(timer);
  }
}
