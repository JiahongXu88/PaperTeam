import { randomUUID } from "node:crypto";

import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
} from "../errors.js";
import {
  GatewayConnectError,
  GatewayProtocolError,
  GatewayRpcError,
  GatewayTimeoutError,
  GatewayWebSocket,
} from "./openclaw/gatewayWebSocket.js";
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
 * 所有 OpenClaw 细节都封装在本文件（及 ./openclaw/ 内部模块）中，
 * 业务层只感知 AgentRuntime 接口。
 *
 * 健康检查使用的真实接口（已对照 OpenClaw 源码与官方文档确认）：
 *   GET {gateway}/health   —— 无鉴权 liveness 探针
 *   健康时返回 HTTP 200，响应体 {"ok":true,"status":"live"}
 *   （Gateway 默认端口 18789；另有 /healthz 别名与 /ready 深度就绪探针）
 *
 * runAgent 使用的真实接口（对照 docs/gateway/protocol.md、docs/gateway/external-apps.md
 * 与 @openclaw/gateway-protocol@2026.8.1 的 protocol.schema.json 确认）：
 *   1. WebSocket 连接到 Gateway 根路径，connect 握手（operator 角色 + 共享 token）
 *   2. RPC "agent"        {message, idempotencyKey, agentId?} → {runId, status:"in_flight", sessionKey?}
 *   3. RPC "agent.wait"   {runId, timeoutMs} → {status:"ok"|"error"|"timeout"|..., error?, terminalReply?}
 *   4. RPC "chat.history" {sessionKey, limit, maxChars} → {messages:[{role,text,...}]}
 *      （terminalReply.text 上限 4096 字符，完整 LaTeX 必须从 chat.history 获取）
 *
 * 参考来源：OpenClaw Gateway HTTP 探针实现（src/gateway/server-http.ts，
 * GATEWAY_PROBE_STATUS_BY_PATH）、src/gateway/server-methods/agent*.ts、
 * src/gateway/agent-turn/agent-job.ts 与官方文档 docs.openclaw.ai/gateway/*。
 */

const HEALTH_PATH = "/health";

/** 网络层错误码 → 判定为“请求超时”的集合 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** 单次 agent.wait 轮询的最大等待（毫秒） */
const AGENT_WAIT_CHUNK_MS = 30_000;

/** agent.wait 请求本身的响应超时余量（毫秒） */
const AGENT_WAIT_RPC_SLACK_MS = 10_000;

/** chat.history 允许返回的最大正文字符数（协议上限 500000） */
const CHAT_HISTORY_MAX_CHARS = 200_000;

export interface OpenClawRuntimeOptions {
  /** Gateway 基地址，如 http://127.0.0.1:18789（不应带查询串/锚点） */
  baseUrl: string;
  /** Gateway API Key。/health 探针无需鉴权；WebSocket connect 握手使用它。 */
  apiKey?: string;
  /** 单次健康检查超时（毫秒），默认 5000 */
  timeoutMs?: number;
  /** WebSocket 连接与单次 RPC 的默认超时（毫秒），默认 15000 */
  rpcTimeoutMs?: number;
  /** 单次 runAgent 的整体超时（毫秒），默认 300000 */
  runTimeoutMs?: number;
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
  private readonly rpcTimeoutMs: number;
  private readonly runTimeoutMs: number;
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
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 300_000;
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

  // ---- runAgent（M2 真实实现） ----

  /**
   * 执行一次 Agent 任务（同步完成语义：返回时任务已达终态）。
   *
   * 映射到 OpenClaw 的真实调用序列：
   *   agent → agent.wait（分片轮询至终态）→ chat.history（取完整回复文本）
   *
   * 异常映射：
   *   连接/握手/协议错误 → AgentRuntimeUnavailableError
   *   RPC 被网关拒绝     → AgentRunFailedError
   *   整体超时           → AgentTimeoutError
   *   运行以 error 终态结束 → 返回 status="failed" 的 AgentTask（不抛异常）
   */
  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const message = input.task.trim();
    if (message === "") {
      throw new AgentRunFailedError("任务内容为空");
    }
    const runTimeoutMs = input.timeoutMs ?? this.runTimeoutMs;

    const ws = new GatewayWebSocket({
      url: this.websocketUrl(),
      token: this.apiKey,
      connectTimeoutMs: this.rpcTimeoutMs,
      rpcTimeoutMs: this.rpcTimeoutMs,
      clientVersion: "paperteam-backend-0.1.0",
      log: this.log,
    });

    try {
      try {
        await ws.connect();
      } catch (error) {
        throw this.mapInfrastructureError(error, "连接 Gateway WebSocket 失败");
      }

      // 1. 发起 agent 运行
      let start: unknown;
      try {
        start = await ws.request(
          "agent",
          {
            message,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            idempotencyKey: `paperteam-${randomUUID()}`,
          },
          this.rpcTimeoutMs,
        );
      } catch (error) {
        throw this.mapInfrastructureError(error, "发起 agent 运行失败");
      }
      const startPayload = asRecord(start);
      const runId = readString(startPayload, "runId");
      if (!runId) {
        throw new AgentRunFailedError(
          "Gateway 响应缺少 runId",
          summarize(startPayload),
        );
      }
      const sessionKey = readString(startPayload, "sessionKey");
      this.log(
        `[openclaw-runtime] runAgent agent -> runId=${runId} sessionKey=${sessionKey ?? "(无)"} agentId=${input.agentId}`,
      );

      const createdAt = new Date().toISOString();

      // 2. 轮询 agent.wait 直到终态（或整体超时）
      const deadline = Date.now() + runTimeoutMs;
      let waitPayload: Record<string, unknown> = startPayload;
      let waitStatus = readString(startPayload, "status");
      while (!isTerminalWaitStatus(waitStatus)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AgentTimeoutError(runTimeoutMs);
        }
        const chunk = Math.min(remaining, AGENT_WAIT_CHUNK_MS);
        let waitResult: unknown;
        try {
          waitResult = await ws.request(
            "agent.wait",
            { runId, timeoutMs: chunk },
            chunk + AGENT_WAIT_RPC_SLACK_MS,
          );
        } catch (error) {
          throw this.mapInfrastructureError(error, "等待 agent 运行失败");
        }
        waitPayload = asRecord(waitResult);
        waitStatus = readString(waitPayload, "status");
        if (waitStatus === "timeout" && remaining <= chunk + 50) {
          // 最后一片等待超时：整体预算耗尽
          throw new AgentTimeoutError(runTimeoutMs);
        }
      }

      if (waitStatus !== "ok") {
        // 运行失败 / 超时终态：返回 failed 任务，由业务层解释
        const errorText =
          readString(waitPayload, "error") ??
          readString(waitPayload, "summary") ??
          readString(waitPayload, "stopReason") ??
          `运行以 ${waitStatus ?? "unknown"} 状态结束`;
        this.log(`[openclaw-runtime] runAgent ${runId} 终态=${waitStatus}：${errorText}`);
        return this.buildTask(runId, input.agentId, createdAt, "failed", {
          error: errorText,
          sessionKey,
        });
      }

      // 3. 取回完整回复文本（chat.history；terminalReply 有 4096 字符截断，仅作兜底）
      const output = await this.retrieveOutput(ws, runId, sessionKey, waitPayload);
      if (output === null) {
        throw new AgentRunFailedError(
          "Agent 运行成功但没有返回任何文本",
          `runId=${runId} sessionKey=${sessionKey ?? "(无)"}`,
        );
      }

      return this.buildTask(runId, input.agentId, createdAt, "completed", {
        output,
        sessionKey,
      });
    } finally {
      ws.close();
    }
  }

  /** 从 chat.history 提取最后一条 assistant 消息；不可用时退回 terminalReply（可能被截断） */
  private async retrieveOutput(
    ws: GatewayWebSocket,
    runId: string,
    sessionKey: string | undefined,
    waitPayload: Record<string, unknown>,
  ): Promise<string | null> {
    if (sessionKey) {
      let history: unknown;
      try {
        history = await ws.request(
          "chat.history",
          { sessionKey, limit: 50, maxChars: CHAT_HISTORY_MAX_CHARS },
          this.rpcTimeoutMs,
        );
      } catch (error) {
        // 历史读取失败不致命：继续尝试 terminalReply 兜底
        this.log(`[openclaw-runtime] chat.history 读取失败（runId=${runId}）：${errorText(error)}`);
      }
      const text = extractLastAssistantText(history);
      if (text !== null) {
        return text;
      }
    }
    const terminalReply = asRecord(waitPayload["terminalReply"]);
    if (terminalReply && terminalReply["disposition"] === "visible") {
      const text = readString(terminalReply, "text");
      if (text) {
        return text;
      }
    }
    return null;
  }

  private buildTask(
    runId: string,
    agentId: string,
    createdAt: string,
    status: "completed" | "failed",
    fields: { output?: string; error?: string; sessionKey?: string },
  ): AgentTask {
    const now = new Date().toISOString();
    return {
      taskId: runId,
      agentId,
      status,
      createdAt,
      updatedAt: now,
      startedAt: createdAt,
      completedAt: now,
      ...(fields.output !== undefined ? { output: fields.output } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.sessionKey !== undefined
        ? { metadata: { sessionKey: fields.sessionKey } }
        : {}),
    };
  }

  /** 底层错误 → 业务错误（底层细节只进日志） */
  private mapInfrastructureError(error: unknown, context: string): Error {
    if (error instanceof GatewayConnectError) {
      this.log(`[openclaw-runtime] ${context}：connect 错误 ${error.code} ${error.message}`);
      return new AgentRuntimeUnavailableError(context, `${error.code}：${error.message}`);
    }
    if (error instanceof GatewayTimeoutError) {
      this.log(`[openclaw-runtime] ${context}：${error.message}`);
      return new AgentRuntimeUnavailableError(context, error.message);
    }
    if (error instanceof GatewayRpcError) {
      this.log(`[openclaw-runtime] ${context}：RPC ${error.code} ${error.message}`);
      return new AgentRunFailedError(`${context}（${error.code}）`, `${error.code}：${error.message}`);
    }
    if (error instanceof GatewayProtocolError) {
      this.log(`[openclaw-runtime] ${context}：${error.message}`);
      return new AgentRuntimeUnavailableError(context, error.message);
    }
    this.log(`[openclaw-runtime] ${context}：未分类错误 ${errorText(error)}`);
    return new AgentRuntimeUnavailableError(context, errorText(error));
  }

  /** http(s) 基地址 → ws(s) WebSocket 地址（Gateway 根路径） */
  private websocketUrl(): string {
    const parsed = new URL(this.baseUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    if (parsed.pathname === "" || parsed.pathname === "/") {
      parsed.pathname = "/";
    }
    return parsed.toString();
  }

  // ---- 以下接口属于后续里程碑，当前只保留契约 ----

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

// ---- runAgent 辅助函数（防御性解析 Gateway 响应） ----

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** agent.wait 的终态集合（对照 src/gateway/agent-turn/agent-job.ts） */
function isTerminalWaitStatus(status: string | undefined): boolean {
  return status === "ok" || status === "error";
}

/** 从 chat.history 响应中提取最后一条 assistant 消息文本 */
function extractLastAssistantText(history: unknown): string | null {
  const messages = asRecord(history)["messages"];
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = asRecord(messages[index]);
    if (row["role"] === "assistant") {
      const text = readString(row, "text");
      if (text) {
        return text;
      }
    }
  }
  return null;
}

/** 响应摘要（诊断用，截断） */
function summarize(payload: Record<string, unknown>): string {
  return snippet(JSON.stringify(payload), 200);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
