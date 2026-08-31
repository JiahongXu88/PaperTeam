import type {
  AgentEvent,
  AgentRuntime,
  AgentTask,
  RunAgentInput,
  RuntimeHealth,
  RuntimeHealthStatus,
  RuntimeProvider,
} from "./types.js";
import { RuntimeCapabilityError } from "./types.js";

/**
 * OpenClawRuntimeAdapter —— AgentRuntime 的第一版实现（对接 OpenClaw Gateway）。
 *
 * 所有 OpenClaw 细节都封装在本文件内，业务层只感知 AgentRuntime 接口。
 *
 * 健康检查使用的真实接口（已对照 OpenClaw 源码与官方文档确认）：
 *   GET {gateway}/health   —— 无鉴权 liveness 探针
 *   健康时返回 HTTP 200，响应体 {"ok":true,"status":"live"}
 *   （Gateway 默认端口 18789；另有 /healthz 别名与 /ready 深度就绪探针）
 *
 * 参考来源：OpenClaw Gateway HTTP 探针实现（src/gateway/server-http.ts，
 * GATEWAY_PROBE_STATUS_BY_PATH）与官方文档 docs.openclaw.ai/gateway/health。
 */

const HEALTH_PATH = "/health";

/** 网络层错误码 → 判定为“请求超时”的集合 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export interface OpenClawRuntimeOptions {
  /** Gateway 基地址，如 http://127.0.0.1:18789（不应带查询串/锚点） */
  baseUrl: string;
  /** Gateway API Key。/health 探针无需鉴权，此项预留给后续 RPC 调用。 */
  apiKey?: string;
  /** 单次健康检查超时（毫秒），默认 5000 */
  timeoutMs?: number;
  /** 可注入的 fetch 实现（测试用），默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 诊断日志输出，默认 console.log */
  log?: (message: string) => void;
}

export class OpenClawRuntimeAdapter implements AgentRuntime {
  readonly provider: RuntimeProvider = "openclaw";

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(options: OpenClawRuntimeOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`OpenClawRuntimeAdapter: baseUrl 不是合法 URL："${options.baseUrl}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `OpenClawRuntimeAdapter: baseUrl 必须以 http:// 或 https:// 开头："${options.baseUrl}"`,
      );
    }

    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((message) => console.log(message));
  }

  /**
   * 对 Gateway 发起一次健康检查。
   *
   * 不抛出业务异常：无论 Gateway 是否在线，都返回结构化的 RuntimeHealth。
   * 底层错误的细节只进诊断日志，detail 字段保持简洁可读。
   */
  async healthCheck(): Promise<RuntimeHealth> {
    const url = `${this.baseUrl}${HEALTH_PATH}`;
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        // /health 是无鉴权探针；API Key 留给后续需要鉴权的 RPC 接口
        headers: this.apiKey ? { "x-openclaw-api-key": this.apiKey } : undefined,
      });
      const bodyText = await response.text();
      const latencyMs = Date.now() - startedAt;

      if (response.status !== 200) {
        this.log(
          `[openclaw-runtime] healthCheck GET ${url} -> HTTP ${response.status} (${latencyMs}ms)`,
        );
        return this.buildHealth(false, "unhealthy", latencyMs, {
          detail: `Gateway 探针 ${HEALTH_PATH} 返回 HTTP ${response.status}（预期 200）`,
        });
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        this.log(
          `[openclaw-runtime] healthCheck GET ${url} -> 200 但响应不是 JSON（${latencyMs}ms）`,
        );
        return this.buildHealth(false, "unhealthy", latencyMs, {
          detail: `Gateway 探针 ${HEALTH_PATH} 返回了非 JSON 响应：${snippet(bodyText)}`,
        });
      }

      const probeOk =
        typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
      if (!probeOk) {
        this.log(
          `[openclaw-runtime] healthCheck GET ${url} -> 200 但响应体不符合探针契约（${latencyMs}ms）`,
        );
        return this.buildHealth(false, "unhealthy", latencyMs, {
          detail: `Gateway 探针 ${HEALTH_PATH} 响应异常：${snippet(bodyText)}`,
        });
      }

      const probeStatus =
        typeof body === "object" && body !== null
          ? String((body as { status?: unknown }).status ?? "unknown")
          : "unknown";
      this.log(`[openclaw-runtime] healthCheck GET ${url} -> 200 ok (${latencyMs}ms)`);
      return this.buildHealth(true, "healthy", latencyMs, {
        detail: `Gateway 在线（liveness 探针状态：${probeStatus}）`,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const classified = classifyNetworkError(error);
      this.log(
        `[openclaw-runtime] healthCheck GET ${url} 失败（${latencyMs}ms）：` +
          `${classified.code ?? errorName(error)} ${errorSummary(error)}`,
      );
      return this.buildHealth(false, classified.status, latencyMs, {
        detail:
          classified.status === "timeout"
            ? `请求 Gateway 超时（${this.timeoutMs}ms）：GET ${url}`
            : `无法连接 Gateway：${classified.code ?? errorName(error)}（GET ${url}）`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 以下接口属于后续里程碑，当前只保留契约 ----

  runAgent(_input: RunAgentInput): Promise<AgentTask> {
    void _input;
    throw new RuntimeCapabilityError("runAgent", this.provider);
  }

  getTask(_taskId: string): Promise<AgentTask> {
    void _taskId;
    throw new RuntimeCapabilityError("getTask", this.provider);
  }

  cancelTask(_taskId: string): Promise<void> {
    void _taskId;
    throw new RuntimeCapabilityError("cancelTask", this.provider);
  }

  sendMessage(_sessionId: string, _message: string): Promise<void> {
    void _sessionId;
    void _message;
    throw new RuntimeCapabilityError("sendMessage", this.provider);
  }

  streamEvents(_taskId: string, _onEvent: (event: AgentEvent) => void): Promise<void> {
    void _taskId;
    void _onEvent;
    throw new RuntimeCapabilityError("streamEvents", this.provider);
  }

  // ---- 内部工具 ----

  private buildHealth(
    ok: boolean,
    status: RuntimeHealthStatus,
    latencyMs: number,
    fields: { detail: string },
  ): RuntimeHealth {
    return {
      ok,
      provider: this.provider,
      status,
      detail: fields.detail,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** 网络层错误归类：超时 / 不可连接 */
function classifyNetworkError(error: unknown): { status: RuntimeHealthStatus; code?: string } {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { status: "timeout" };
  }
  const code = errorCode(error);
  if (code && TIMEOUT_CODES.has(code)) {
    return { status: "timeout", code };
  }
  // 其余网络层错误（ECONNREFUSED / ENOTFOUND / ECONNRESET / …）统一视为不可连接
  return { status: "unreachable", code };
}

/** Node 的 fetch 失败通常抛 TypeError，真实原因挂在 cause 上 */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") {
      return causeCode;
    }
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 提取一行无堆栈的错误摘要，用于诊断日志 */
function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${causeMessage}`;
  }
  return String(error);
}

/** 响应体片段：截断并去除控制字符，只用于诊断展示 */
function snippet(text: string, maxLength = 120): string {
  const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e一-龥]/g, "?");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}
