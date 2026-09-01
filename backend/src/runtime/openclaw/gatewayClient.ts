/**
 * OpenClaw Gateway 连接（Adapter 内部模块，业务层不得 import）。
 *
 * M2.1 起协议完全由官方 SDK 负责：
 *   @openclaw/gateway-client 的 GatewayClient 实现
 *   - WebSocket transport（ws）与帧编解码
 *   - connect.challenge 挑战 → connect 握手 → hello-ok
 *   - 鉴权（共享 token）、protocol negotiation（v4）
 *   - request id 关联、响应超时、structured error
 *   - 重连退避（1s→30s，指数 ×2）
 *
 * 本文件只保留 PaperTeam 侧的职责：
 *   - 配置装配（url/身份/scopes/超时）
 *   - 「等待就绪」生命周期：start() 后等第一个 hello-ok（带预算，
 *     超时/连接失败立即放弃并停止客户端——单次 runAgent 语义不需要重试）
 *   - 统一的 close()（幂等，stopAndWait）
 *
 * 不再包含任何 wire protocol 细节（帧 schema、request map、握手报文等）。
 */

import { GatewayClient } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

/**
 * 连接阶段失败（连不上 / 握手被拒 / 就绪等待超时）。
 * 由 SDK 的 onConnectError / onClose 或本地就绪预算触发。
 */
export class GatewayConnectionError extends Error {
  override readonly name = "GatewayConnectionError";
  /** 网关侧错误码（如 AUTH_TOKEN_MISMATCH、PROTOCOL_MISMATCH）；本地失败为 LOCAL_* */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface GatewayConnectionOptions {
  /** WebSocket 地址（ws:// 或 wss://，Gateway 根路径） */
  url: string;
  /** Gateway 共享鉴权 token；缺省以匿名身份连接（仅无鉴权网关可用） */
  token?: string;
  /** 连接（challenge + connect 握手）的整体预算（毫秒） */
  connectTimeoutMs: number;
  /** 单次 RPC 的默认超时（毫秒），可被 request() 逐次覆盖 */
  requestTimeoutMs: number;
  /** 客户端版本号（握手上报） */
  clientVersion: string;
  /** 诊断日志 */
  log?: (message: string) => void;
}

/** 官方 SDK 的请求选项原样透传（timeoutMs / signal 等） */
export type GatewayRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class OpenClawGatewayConnection {
  private client: GatewayClient | null = null;
  private closed = false;

  constructor(
    private readonly options: GatewayConnectionOptions,
  ) {}

  /**
   * 建立连接并等待 hello-ok（带预算）。
   * 失败抛 GatewayConnectionError；成功后可用 request()。
   */
  async connect(): Promise<void> {
    if (this.client !== null) {
      throw new GatewayConnectionError("连接已建立", "LOCAL_ALREADY_CONNECTED");
    }
    const { resolve, reject, promise: ready } = Promise.withResolvers<void>();
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const toConnectionError = (error: unknown): GatewayConnectionError => {
      if (error instanceof GatewayConnectionError) {
        return error;
      }
      const code = readGatewayErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      return new GatewayConnectionError(message, code);
    };

    // 就绪预算：SDK 内部还有 challenge 超时（默认 15s），
    // 这里用业务侧预算兜底，保证 runAgent 的连接阶段有界。
    const timer = setTimeout(() => {
      settle(new GatewayConnectionError(
        `连接 Gateway 超时（${this.options.connectTimeoutMs}ms）：${this.options.url}`,
        "LOCAL_CONNECT_TIMEOUT",
      ));
      void this.stop();
    }, this.options.connectTimeoutMs);
    timer.unref?.();

    const client = new GatewayClient({
      url: this.options.url,
      ...(this.options.token ? { token: this.options.token } : {}),
      // 协议版本使用官方常量（当前 v4）；SDK 对 backend 客户端默认即 v4-only，
      // 显式传入以便与官方 README 的推荐用法一致。
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      // 官方 client id 注册表是封闭集合，外部应用统一使用 "gateway-client"
      //（SDK 默认值），展示名用于网关侧诊断。
      clientDisplayName: "PaperTeam Backend",
      clientVersion: this.options.clientVersion,
      mode: "backend",
      role: "operator",
      // agent / agent.wait 需要 operator.write（隐含 operator.read）；
      // 不索取默认的 operator.admin，按最小权限申请。
      scopes: ["operator.read", "operator.write"],
      requestTimeoutMs: this.options.requestTimeoutMs,
      connectChallengeTimeoutMs: this.options.connectTimeoutMs,
      onHelloOk: () => settle(),
      onConnectError: (error) => {
        // 单次 runAgent 语义：首次连接失败立即放弃（不搭乘 SDK 重试循环）。
        // 注意先 settle 再 stop：SDK 的 beginStop 在握手未完成时会以
        // "gateway client stopped" 再次触发 onConnectError，重入须被忽略。
        settle(toConnectionError(error));
        void this.stop();
      },
      onClose: (code, reason) => {
        if (!settled) {
          settle(new GatewayConnectionError(
            `Gateway 连接在握手完成前关闭（code=${code}${reason ? `，${reason}` : ""}）`,
            "LOCAL_CLOSED_BEFORE_HELLO",
          ));
          void this.stop();
        }
      },
      hostDeps: {
        logDebug: (message) => this.options.log?.(`[gateway-client] ${message}`),
        logError: (message) => this.options.log?.(`[gateway-client] ${message}`),
      },
    });
    this.client = client;
    client.start();
    await ready;
  }

  /** 发送一次 RPC；失败抛 SDK 的结构化错误（GatewayClientRequestError 等） */
  request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    const client = this.client;
    if (client === null || this.closed) {
      return Promise.reject(
        new GatewayConnectionError("Gateway 连接未建立或已关闭", "LOCAL_NOT_OPEN"),
      );
    }
    return client.request<T>(method, params, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  /** 主动关闭（幂等；未完成的请求会被 SDK 拒绝） */
  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const client = this.client;
    this.client = null;
    if (client === null) {
      return;
    }
    await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {
      // stopAndWait 超时（罕见）：SDK 内部已 beginStop，socket 会被强制终止
    });
  }
}

/** 从 SDK 错误中读网关错误码（GatewayClientRequestError.code / gatewayCode） */
function readGatewayErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code?: unknown }).code !== "CLIENT_TIMEOUT"
  ) {
    return (error as { code: string }).code;
  }
  return "UNKNOWN";
}
