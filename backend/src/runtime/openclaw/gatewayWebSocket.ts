/**
 * OpenClaw Gateway WebSocket 客户端（Adapter 内部模块，业务层不得 import）。
 *
 * 实现的协议子集（对照 OpenClaw 官方协议文档与 protocol.schema.json 2026.8.1）：
 * - 传输：WebSocket 文本帧，JSON 载荷，Gateway 根路径（默认端口 18789）
 * - 帧：请求 {type:"req", id, method, params}
 *       响应 {type:"res", id, ok, payload|error}
 *       事件 {type:"event", event, payload}（M2 忽略）
 * - 握手：首帧必须是 connect 请求；operator 角色 + operator.read/write scope；
 *   鉴权使用共享 token（connect.params.auth.token）
 * - 响应错误结构：{code, message, details?, retryable?, retryAfterMs?}
 *
 * 依赖 Node 22+ 内置的全局 WebSocket（无需第三方库）。
 */

/** Gateway RPC 层错误（res.ok=false），携带网关返回的错误结构 */
export class GatewayRpcError extends Error {
  override readonly name = "GatewayRpcError";
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** 请求在超时时间内未收到响应 */
export class GatewayTimeoutError extends Error {
  override readonly name = "GatewayTimeoutError";

  constructor(method: string, timeoutMs: number) {
    super(`Gateway RPC ${method} 超时（${timeoutMs}ms）`);
  }
}

/** 连接/握手阶段失败（含鉴权被拒） */
export class GatewayConnectError extends Error {
  override readonly name = "GatewayConnectError";
  /** 网关返回的错误码（如 AUTH_TOKEN_MISMATCH），无则为 UNKNOWN */
  readonly code: string;

  constructor(message: string, code = "UNKNOWN") {
    super(message);
    this.code = code;
  }
}

/** 响应帧不符合协议（非 JSON / 缺字段等） */
export class GatewayProtocolError extends Error {
  override readonly name = "GatewayProtocolError";

  constructor(message: string) {
    super(message);
  }
}

/** 线上协议版本（官方 2026.8.1 客户端固定为 4） */
const PROTOCOL_VERSION = 4;

const OPERATOR_SCOPES: readonly string[] = ["operator.read", "operator.write"];

/** connect 请求的 id（握手是第一条请求，固定为 "connect" 便于排查） */
const CONNECT_REQUEST_ID = "connect";

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface GatewayWebSocketOptions {
  /** WebSocket 地址（ws:// 或 wss://） */
  url: string;
  /** Gateway 共享鉴权 token；缺省时以匿名身份连接（仅无鉴权网关可用） */
  token?: string;
  /** 连接与 connect 握手的整体超时（毫秒） */
  connectTimeoutMs: number;
  /** 单次 RPC 的默认超时（毫秒） */
  rpcTimeoutMs: number;
  /** 客户端版本号（握手上报） */
  clientVersion: string;
  /** 诊断日志 */
  log?: (message: string) => void;
}

export class GatewayWebSocket {
  private readonly options: GatewayWebSocketOptions;
  private readonly log: (message: string) => void;
  private socket: WebSocket | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: GatewayWebSocketOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  /**
   * 建立 WebSocket 连接并完成 connect 握手。
   * 成功 resolve；失败抛 GatewayConnectError / GatewayTimeoutError。
   */
  async connect(): Promise<void> {
    if (typeof WebSocket === "undefined") {
      throw new GatewayConnectError(
        "当前 Node 运行时没有全局 WebSocket（需要 Node.js 22+）",
        "NO_WEBSOCKET",
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let openTimer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (openTimer !== undefined) {
          clearTimeout(openTimer);
        }
        reject(error);
      };

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.options.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(new GatewayConnectError(`WebSocket 地址非法：${message}`));
        return;
      }
      this.socket = socket;

      // 打开 + 握手的整体超时
      openTimer = setTimeout(() => {
        fail(new GatewayTimeoutError("connect(handshake)", this.options.connectTimeoutMs));
        this.close();
      }, this.options.connectTimeoutMs);

      socket.addEventListener("open", () => {
        // 首帧必须是 connect 请求
        this.sendFrame({
          type: "req",
          id: CONNECT_REQUEST_ID,
          method: CONNECT_REQUEST_ID,
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              version: this.options.clientVersion,
              platform: process.platform,
              mode: "backend",
            },
            role: "operator",
            scopes: [...OPERATOR_SCOPES],
            ...(this.options.token ? { auth: { token: this.options.token } } : {}),
          },
        });
      });

      socket.addEventListener("message", (event) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(readEventData(event)));
        } catch {
          this.log("[gateway-ws] 收到非 JSON 帧，忽略");
          return;
        }
        if (!isResponseFrame(frame)) {
          return; // 事件帧（connect.challenge 等）M2 不消费
        }
        if (frame.id !== CONNECT_REQUEST_ID) {
          this.handleResponseFrame(frame);
          return;
        }
        // 握手响应
        if (openTimer !== undefined) {
          clearTimeout(openTimer);
        }
        if (settled) {
          return;
        }
        if (frame.ok) {
          settled = true;
          resolve();
          return;
        }
        const error = frame.error;
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
        const message =
          isRecord(error) && typeof error.message === "string" ? error.message : "握手被拒绝";
        settled = true;
        reject(new GatewayConnectError(`Gateway 握手失败（${code}）：${message}`, code));
      });

      socket.addEventListener("error", () => {
        // 具体原因在 close 事件里更完整；这里只负责不悬挂
        fail(new GatewayConnectError(`无法连接 Gateway WebSocket：${this.options.url}`));
      });

      socket.addEventListener("close", (event) => {
        const code = readCloseCode(event);
        const reason = readCloseReason(event);
        this.rejectAllPending(
          new GatewayConnectError(`Gateway 连接已关闭（code=${code}）`, String(code)),
        );
        fail(
          new GatewayConnectError(
            `Gateway 连接被关闭（code=${code}${reason ? `，${reason}` : ""}）`,
          ),
        );
      });
    });
  }

  /** 发送一次 RPC，返回 res.ok=true 的 payload；失败抛 GatewayRpcError / 超时抛 GatewayTimeoutError */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayConnectError("Gateway 连接未建立或已断开", "NOT_OPEN"));
    }
    this.nextRequestId += 1;
    const id = String(this.nextRequestId);
    const budget = timeoutMs ?? this.options.rpcTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayTimeoutError(method, budget));
        // 超时后连接状态不可信，直接关闭
        this.close();
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      this.sendFrame({ type: "req", id, method, params });
    });
  }

  /** 主动关闭连接（幂等；未完成的请求会被拒绝） */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAllPending(new GatewayConnectError("连接已关闭", "CLOSED"));
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  private sendFrame(frame: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  private handleResponseFrame(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      this.log(`[gateway-ws] 收到未知 id 的响应：${frame.id}`);
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      const error = frame.error;
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      const message =
        isRecord(error) && typeof error.message === "string"
          ? error.message
          : `${pending.method} 调用失败`;
      pending.reject(new GatewayRpcError(code, message, isRecord(error) ? error.details : undefined));
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}

function isResponseFrame(value: unknown): value is ResponseFrame {
  return isRecord(value) && value["type"] === "res" && typeof value["id"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Node 的 WebSocket 事件类型不带 DOM 泛型，这里做轻量读取辅助
function readEventData(event: unknown): unknown {
  return (event as { data?: unknown }).data;
}

function readCloseCode(event: unknown): number | string {
  const code = (event as { code?: unknown }).code;
  return typeof code === "number" ? code : String(code ?? "unknown");
}

function readCloseReason(event: unknown): string {
  const reason = (event as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}
