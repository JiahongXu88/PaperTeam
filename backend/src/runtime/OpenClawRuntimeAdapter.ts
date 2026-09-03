import { randomUUID } from "node:crypto";

import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from "@openclaw/gateway-client";

import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
} from "../errors.js";
import {
  GatewayConnectionError,
  OpenClawGatewayConnection,
} from "./openclaw/gatewayClient.js";
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
 * OpenClawRuntimeAdapter —— AgentRuntime 的实现（对接 OpenClaw Gateway）。
 *
 * 所有 OpenClaw 细节都封装在本文件（及 ./openclaw/ 内部模块）中，
 * 业务层只感知 AgentRuntime 接口。
 *
 * 健康检查使用的真实接口（已对照 OpenClaw 源码与官方文档确认）：
 *   GET {gateway}/health   —— 无鉴权 liveness 探针
 *   健康时返回 HTTP 200，响应体 {"ok":true,"status":"live"}
 *   （Gateway 默认端口 18789；另有 /healthz 别名与 /ready 深度就绪探针）
 *
 * M2.1 起 runAgent 建立在官方 SDK 上（对照 OpenClaw 2026.8.1 源码
 * packages/gateway-client/*、src/gateway/server-methods/agent*.ts 与
 * docs/gateway/external-apps.md 确认）：
 *   0. @openclaw/gateway-client 完成 transport / connect.challenge 挑战 /
 *      connect 握手 / 鉴权 / protocol v4 / request 关联与结构化错误
 *   1. RPC "agent"  {message, idempotencyKey, agentId?, sessionKey?}
 *      → 验收 {runId, sessionKey, agentId, status:"accepted", acceptedAt}
 *      （网关随后还会对同一请求 id 发送 final 帧，供 expectFinal 客户端使用；
 *      本 Adapter 按官方 external-apps 指南采用 agent + agent.wait 组合，
 *      对断线重连更稳健，不依赖 final 帧）
 *   2. RPC "agent.wait" {runId, timeoutMs} 分片轮询至终态
 *      （终态 = ok | error，或带 endedAt 的 timeout 终态快照）
 *   3. RPC "chat.history" {sessionKey, limit, maxChars} → {messages:[{role,text,...}]}
 *      （agent.wait 的 terminalReply.text 上限 4096 字符，完整 LaTeX 必须从
 *      chat.history 获取；terminalReply 仅作兜底）
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

/** PaperTeam 派生 Runtime 会话的前缀（OpenClaw sessionKey 形如 agent:{agentId}:{peer}） */
const SESSION_PEER_PREFIX = "paperteam";

/** contextScope 的 scope 分隔符（projectId 与 scope 之间） */
const SESSION_SCOPE_SEPARATOR = "--";

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
  /** 在途连接（runAgent 每次一条；close() 时统一停止） */
  private readonly activeConnections = new Set<OpenClawGatewayConnection>();
  private closed = false;

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
    this.timeoutMs = options.timeoutMs ?? 5_000;
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

  // ---- runAgent（官方 Gateway Client 上的实现） ----

  /**
   * 执行一次 Agent 任务（同步完成语义：返回时任务已达终态）。
   *
   * 映射到 OpenClaw 官方推荐调用序列（docs/gateway/external-apps.md）：
   *   agent（验收，取 runId/sessionKey）
   *   → agent.wait（分片轮询至终态）
   *   → chat.history（取完整回复文本）
   *
   * 会话解析（M2.1）：
   *   input.sessionKey 原样复用；否则按 projectId 派生稳定会话
   *   agent:{agentId}:paperteam-{projectId}（同一 Project 复用上下文，
   *   不同 Project 互不污染；都不存在时不指定，由网关解析默认会话）。
   *
   * 异常映射：
   *   连接/握手/协议/鉴权错误 → AgentRuntimeUnavailableError
   *   RPC 被网关拒绝         → AgentRunFailedError
   *   整体超时               → AgentTimeoutError
   *   运行以 error/timeout 终态结束 → 返回 status="failed" 的 AgentTask（不抛异常）
   */
  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const message = input.task.trim();
    if (message === "") {
      throw new AgentRunFailedError("任务内容为空");
    }
    if (this.closed) {
      throw new AgentRuntimeUnavailableError("Runtime 已关闭", "adapter closed");
    }
    const runTimeoutMs = input.timeoutMs ?? this.runTimeoutMs;
    const sessionKey = resolveSessionKey(input);

    const connection = new OpenClawGatewayConnection({
      url: this.websocketUrl(),
      ...(this.apiKey ? { token: this.apiKey } : {}),
      connectTimeoutMs: this.rpcTimeoutMs,
      requestTimeoutMs: this.rpcTimeoutMs,
      clientVersion: "paperteam-backend-0.1.0",
      log: this.log,
    });
    this.activeConnections.add(connection);

    try {
      try {
        await connection.connect();
      } catch (error) {
        throw this.mapInfrastructureError(error, "连接 Gateway 失败");
      }

      // 1. 发起 agent 运行（网关验收后返回 runId/sessionKey）
      let start: Record<string, unknown>;
      try {
        start = asRecord(
          await connection.request("agent", {
            message,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(sessionKey ? { sessionKey } : {}),
            idempotencyKey: `paperteam-${randomUUID()}`,
          }),
        );
      } catch (error) {
        throw this.mapInfrastructureError(error, "发起 agent 运行失败");
      }
      const runId = readString(start, "runId");
      if (!runId) {
        throw new AgentRunFailedError("Gateway 响应缺少 runId", summarize(start));
      }
      const resolvedSessionKey = readString(start, "sessionKey") ?? sessionKey;
      this.log(
        `[openclaw-runtime] runAgent agent -> runId=${runId} ` +
          `sessionKey=${resolvedSessionKey ?? "(默认)"} agentId=${input.agentId}`,
      );

      const createdAt = new Date().toISOString();

      // 2. 轮询 agent.wait 直到终态（或整体超时）
      const deadline = Date.now() + runTimeoutMs;
      let waitPayload: Record<string, unknown> = start;
      while (!isTerminalWaitPayload(waitPayload)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AgentTimeoutError(runTimeoutMs);
        }
        const chunk = Math.min(remaining, AGENT_WAIT_CHUNK_MS);
        let waitResult: unknown;
        try {
          waitResult = await connection.request(
            "agent.wait",
            { runId, timeoutMs: chunk },
            { timeoutMs: chunk + AGENT_WAIT_RPC_SLACK_MS },
          );
        } catch (error) {
          throw this.mapInfrastructureError(error, "等待 agent 运行失败");
        }
        waitPayload = asRecord(waitResult);
      }

      const waitStatus = readString(waitPayload, "status");
      if (waitStatus !== "ok") {
        // 运行失败 / 运行超时终态：返回 failed 任务，由业务层解释
        const errorText =
          readString(waitPayload, "error") ??
          readString(waitPayload, "summary") ??
          readString(waitPayload, "stopReason") ??
          `运行以 ${waitStatus ?? "unknown"} 状态结束`;
        this.log(`[openclaw-runtime] runAgent ${runId} 终态=${waitStatus}：${errorText}`);
        return this.buildTask(runId, input.agentId, createdAt, "failed", {
          error: errorText,
          sessionKey: resolvedSessionKey,
        });
      }

      // 3. 取回完整回复文本（chat.history；terminalReply 有 4096 字符截断，仅作兜底）
      const output = await this.retrieveOutput(connection, runId, resolvedSessionKey, waitPayload);
      if (output === null) {
        throw new AgentRunFailedError(
          "Agent 运行成功但没有返回任何文本",
          `runId=${runId} sessionKey=${resolvedSessionKey ?? "(默认)"}`,
        );
      }

      return this.buildTask(runId, input.agentId, createdAt, "completed", {
        output,
        sessionKey: resolvedSessionKey,
      });
    } finally {
      this.activeConnections.delete(connection);
      await connection.stop();
    }
  }

  /** 从 chat.history 提取最后一条 assistant 消息；不可用时退回 terminalReply（可能被截断） */
  private async retrieveOutput(
    connection: OpenClawGatewayConnection,
    runId: string,
    sessionKey: string | undefined,
    waitPayload: Record<string, unknown>,
  ): Promise<string | null> {
    if (sessionKey) {
      let history: unknown;
      try {
        history = await connection.request(
          "chat.history",
          { sessionKey, limit: 50, maxChars: CHAT_HISTORY_MAX_CHARS },
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

  /** SDK / 连接层错误 → 业务错误（底层细节只进日志） */
  private mapInfrastructureError(error: unknown, context: string): Error {
    if (error instanceof GatewayConnectionError) {
      this.log(`[openclaw-runtime] ${context}：${error.code} ${error.message}`);
      return new AgentRuntimeUnavailableError(context, `${error.code}：${error.message}`);
    }
    if (error instanceof GatewayClientRequestTimeoutError) {
      // SDK 本地请求截止（CLIENT_TIMEOUT）：连接状态不可信，视为 Runtime 不可用
      this.log(
        `[openclaw-runtime] ${context}：RPC ${error.method} 本地超时（${error.timeoutMs}ms）`,
      );
      return new AgentRuntimeUnavailableError(
        context,
        `RPC ${error.method} 本地超时（${error.timeoutMs}ms）`,
      );
    }
    if (error instanceof GatewayClientRequestError) {
      // 网关权威拒绝（结构化错误：code/gatewayCode/details/retryable）
      const code = error.gatewayCode || error.code;
      this.log(`[openclaw-runtime] ${context}：RPC 拒绝 ${code} ${error.message}`);
      return new AgentRunFailedError(`${context}（${code}）`, `${code}：${error.message}`);
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

  // ---- 生命周期（M2.1） ----

  /** 停止全部在途连接；进程 shutdown 时调用（幂等） */
  async close(): Promise<void> {
    this.closed = true;
    const connections = [...this.activeConnections];
    this.activeConnections.clear();
    await Promise.allSettled(connections.map((connection) => connection.stop()));
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

/**
 * 解析本次运行的会话：显式复用 > 按 projectId（+ contextScope）派生 > 不指定（网关默认）。
 *
 * 派生规则（M3.0，ARCHITECTURE §6.3）：
 *   无 scope：agent:{agentId}:paperteam-{projectId}
 *   有 scope：agent:{agentId}:paperteam-{projectId}--{scope}
 * 同一 Project × Agent × Scope 稳定复用；任一维度不同则隔离。
 */
function resolveSessionKey(input: RunAgentInput): string | undefined {
  const explicit = input.sessionKey?.trim();
  if (explicit) {
    return explicit;
  }
  const projectId = input.projectId?.trim();
  if (projectId && input.agentId) {
    // OpenClaw sessionKey 形如 agent:{agentId}:{peer}；peer 部分保留 opaque id。
    // scope 归一化保证非法字符不会破坏 sessionKey 结构或造成 scope 串会话。
    const scope = sanitizeContextScope(input.contextScope);
    const peer = scope
      ? `${SESSION_PEER_PREFIX}-${projectId}${SESSION_SCOPE_SEPARATOR}${scope}`
      : `${SESSION_PEER_PREFIX}-${projectId}`;
    return `agent:${input.agentId}:${peer}`;
  }
  return undefined;
}

/**
 * contextScope 安全归一化：小写；允许 [a-z0-9/_-]；其余字符折叠为 "-"；
 * 首尾分隔符去除、连续 "-" 压缩、长度上限 48。
 * 注意折叠不完全单射（如空格与字面 "-" 会折叠到同一 scope）——scope 取值
 * 由 PaperTeam 代码内控（少量固定常量），不接受用户自由输入，因此可接受；
 * 该函数的目标是保证非法字符不会破坏 sessionKey 结构或注入额外 ":"。
 */
export function sanitizeContextScope(scope: string | undefined): string | undefined {
  const raw = scope?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9/_-]/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^[-/]+/, "")
    .replace(/[-/]+$/, "")
    .slice(0, 48)
    .replace(/[-]+$/, "");
  return normalized === "" ? undefined : normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * agent.wait 响应是否为终态（对照 src/gateway/agent-turn/agent-turn-service.ts
 * 的 waitForTurn 与 agent-job.ts 的终态快照）：
 * - status ok / error            → 终态
 * - status timeout + endedAt     → 运行以 timeout 终结的终态快照
 * - status timeout 无 endedAt    → 等待窗口耗尽（运行未结束，继续轮询）
 * - status pending / in_flight 等 → 未终态
 */
function isTerminalWaitPayload(payload: Record<string, unknown>): boolean {
  const status = readString(payload, "status");
  if (status === "ok" || status === "error") {
    return true;
  }
  if (status === "timeout" && typeof payload["endedAt"] === "number") {
    return true;
  }
  return false;
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
