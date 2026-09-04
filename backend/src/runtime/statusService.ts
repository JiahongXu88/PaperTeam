/**
 * Runtime 状态诊断（M3.5）：GET /api/runtime/status 的实现。
 *
 * 一次诊断回答四个问题（全部只读，不泄露 token / 密钥 / 敏感路径）：
 *
 *   gateway  存活（/health）→ 连接与鉴权（connect 握手）→ 身份/版本
 *   runtime  综合相位：ready / model_not_configured / auth_error /
 *            protocol_mismatch / gateway_unavailable / starting
 *   agents   PaperTeam 业务角色 → OpenClaw agentId 映射是否真实注册
 *   model    models.authStatus 的防御性摘要（有无可用 provider 凭据）
 *
 * RPC 全部使用 operator.read 权限（与 runAgent 相同的连接，不提权）：
 *   gateway.identity.get / agents.list / models.authStatus
 */

import type { AgentRuntime, RuntimeHealth } from "./types.js";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { GatewayConnectionError, OpenClawGatewayConnection } from "./openclaw/gatewayClient.js";

/**
 * Backend 使用的官方 gateway-client SDK 版本（与 backend/package.json 的
 * 精确 pin 保持一致；backend/test/dev/versionPins 有断言防止漂移）。
 */
export const GATEWAY_CLIENT_SDK_VERSION = "2026.9.1";

/** 网关连接相位 */
export type GatewayPhase =
  | "healthy"
  | "starting"
  | "unavailable"
  | "auth_error"
  | "protocol_mismatch";

/** Runtime 综合相位（对齐 M3.5 验收口径） */
export type RuntimePhase =
  | "ready"
  | "model_not_configured"
  | "auth_error"
  | "protocol_mismatch"
  | "gateway_unavailable";

/** 模型配置相位 */
export type ModelPhase = "configured" | "not_configured" | "unknown";

export interface AgentMappingStatus {
  role: string;
  /** 配置映射到的 OpenClaw agentId */
  agentId: string;
  /** 该 agentId 是否在 Gateway 注册 */
  registered: boolean;
  status: "configured" | "missing";
}

export interface RuntimeStatus {
  /** 后端自身（能响应即 ok） */
  backend: { ok: true };
  gateway: {
    phase: GatewayPhase;
    /** 人类可读说明（无敏感信息） */
    detail: string;
    /** /health 探测延迟（毫秒） */
    latencyMs: number | null;
  };
  runtime: {
    phase: RuntimePhase;
    detail: string;
  };
  versions: {
    /** 本 Backend 使用的官方 SDK 版本（package.json） */
    gatewayClientSdk: string;
    /** 期望的 Gateway runtime 版本（与 Runtime Bootstrap 锁定一致） */
    expectedRuntime?: string;
    /** Gateway 实际上报的版本（identity；解析失败时缺省） */
    gatewayRuntime?: string;
    /** wire protocol 版本（官方常量） */
    protocol: number;
  };
  agents: {
    /** 网关默认 agent */
    defaultId?: string;
    /** 注册表形态：sole（单 agent）/ explicit（多 agent fleet）等 */
    ownership?: string;
    roles: AgentMappingStatus[];
  };
  model: {
    phase: ModelPhase;
    /** 有凭据的 provider 名单（不含任何 key） */
    providers: string[];
    detail: string;
  };
}

export interface RuntimeStatusOptions {
  runtime: AgentRuntime;
  agentIds: { writer: string; researcher: string; reviewer: string; citation: string };
  /** Bootstrap 锁定的 runtime 版本（诊断展示用） */
  expectedRuntimeVersion?: string;
  /** 单次诊断连接的预算（毫秒），默认 8000 */
  timeoutMs?: number;
  /** 连接工厂（测试注入 fake） */
  createConnection?: (options: ConnectionDeps) => StatusConnection;
  log?: (message: string) => void;
}

/** 诊断连接的最小接口（真实实现是 OpenClawGatewayConnection） */
export interface StatusConnection {
  connect(): Promise<void>;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
}

export interface ConnectionDeps {
  url: string;
  token?: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

export class RuntimeStatusService {
  private readonly runtime: AgentRuntime;
  private readonly agentIds: RuntimeStatusOptions["agentIds"];
  private readonly expectedRuntimeVersion?: string;
  private readonly timeoutMs: number;
  private readonly createConnection: (options: ConnectionDeps) => StatusConnection;
  private readonly log: (message: string) => void;

  constructor(options: RuntimeStatusOptions) {
    this.runtime = options.runtime;
    this.agentIds = options.agentIds;
    this.expectedRuntimeVersion = options.expectedRuntimeVersion;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.createConnection =
      options.createConnection ??
      ((deps) =>
        new OpenClawGatewayConnection({
          url: deps.url,
          ...(deps.token ? { token: deps.token } : {}),
          connectTimeoutMs: deps.connectTimeoutMs,
          requestTimeoutMs: deps.requestTimeoutMs,
          clientVersion: "paperteam-backend-0.1.0",
          log: (message) => this.log(message),
        }));
    this.log = options.log ?? (() => {});
  }

  /** 执行一次完整诊断（任何内部失败都收敛为结构化状态，不抛出） */
  async getStatus(): Promise<RuntimeStatus> {
    const health: RuntimeHealth = await this.runtime.healthCheck();
    const base = {
      backend: { ok: true as const },
      versions: {
        gatewayClientSdk: GATEWAY_CLIENT_SDK_VERSION,
        ...(this.expectedRuntimeVersion ? { expectedRuntime: this.expectedRuntimeVersion } : {}),
        protocol: PROTOCOL_VERSION,
      },
    };

    if (!health.ok) {
      return {
        ...base,
        gateway: {
          phase: "unavailable",
          detail: `Gateway 不可达：${health.detail}`,
          latencyMs: health.latencyMs,
        },
        runtime: {
          phase: "gateway_unavailable",
          detail: "Gateway 不可用（请确认 Gateway 已启动、OPENCLAW_GATEWAY_URL 正确）",
        },
        agents: { roles: this.uncheckedRoles() },
        model: { phase: "unknown", providers: [], detail: "Gateway 不可用，无法检查模型配置" },
      };
    }

    // Gateway 存活 → 打开一条诊断连接（同时验证鉴权与协议）
    const info = runtimeConnectionInfo(this.runtime);
    let connection: StatusConnection;
    try {
      connection = this.createConnection({
        url: websocketUrl(info.baseUrl),
        ...(info.apiKey ? { token: info.apiKey } : {}),
        connectTimeoutMs: this.timeoutMs,
        requestTimeoutMs: this.timeoutMs,
      });
    } catch (error) {
      this.log(`[runtime-status] 无法建立诊断连接：${errorText(error)}`);
      return {
        ...base,
        gateway: {
          phase: "healthy",
          detail: `Gateway 在线（${health.latencyMs ?? "?"}ms），但诊断连接不可用`,
          latencyMs: health.latencyMs,
        },
        runtime: {
          phase: "ready",
          detail: "Gateway 在线；诊断连接不可用（Runtime 实现未暴露连接信息）",
        },
        agents: { roles: this.uncheckedRoles() },
        model: { phase: "unknown", providers: [], detail: "诊断连接不可用" },
      };
    }

    let identity: Record<string, unknown> | null = null;
    let agentList: Record<string, unknown> | null = null;
    let modelStatus: Record<string, unknown> | null = null;
    let phaseOverride: { gateway: GatewayPhase; runtime: RuntimePhase; detail: string } | null = null;

    try {
      await connection.connect();
    } catch (error) {
      const code = error instanceof GatewayConnectionError ? error.code : readErrorCode(error);
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`[runtime-status] 连接失败 ${code}: ${detail}`);
      if (code === "AUTH_TOKEN_MISMATCH" || code === "AUTH_REQUIRED" || code === "UNAUTHORIZED") {
        phaseOverride = {
          gateway: "auth_error",
          runtime: "auth_error",
          detail: "Gateway 鉴权失败：OPENCLAW_GATEWAY_API_KEY 与 Gateway token 不匹配",
        };
      } else if (code === "PROTOCOL_MISMATCH" || code === "PROTOCOL_UNSUPPORTED") {
        phaseOverride = {
          gateway: "protocol_mismatch",
          runtime: "protocol_mismatch",
          detail: `Gateway 协议版本不兼容（${detail}）`,
        };
      } else {
        phaseOverride = {
          gateway: "starting",
          runtime: "gateway_unavailable",
          detail: `Gateway 存活但 RPC 连接失败：${code} ${detail}`,
        };
      }
    }

    if (phaseOverride === null) {
      try {
        // 三个只读 RPC，逐个防御式解析，单个失败不影响其余
        identity = asRecord(await connection.request("gateway.identity.get", {}));
        agentList = asRecord(await connection.request("agents.list", {}));
        try {
          modelStatus = asRecord(await connection.request("models.authStatus", { refresh: false }));
        } catch (error) {
          this.log(`[runtime-status] models.authStatus 失败：${errorText(error)}`);
        }
      } catch (error) {
        this.log(`[runtime-status] 诊断 RPC 失败：${errorText(error)}`);
        phaseOverride = {
          gateway: "starting",
          runtime: "gateway_unavailable",
          detail: `Gateway 存活但诊断 RPC 失败：${errorText(error)}`,
        };
      } finally {
        await connection.stop().catch(() => {});
      }
    } else {
      await connection.stop().catch(() => {});
    }

    const agents = this.mapAgents(agentList);
    const model = modelStatus !== null ? summarizeModelStatus(modelStatus) : {
      phase: "unknown" as ModelPhase,
      providers: [],
      detail: phaseOverride ? "连接不可用，无法检查模型配置" : "models.authStatus 不可用",
    };

    let gatewayPhase: GatewayPhase = "healthy";
    let runtimeDetail = "Runtime 就绪";
    let runtimePhase: RuntimePhase = "ready";
    if (model.phase === "not_configured" && phaseOverride === null) {
      runtimePhase = "model_not_configured";
      runtimeDetail =
        "Runtime 就绪，但模型未配置：请在 PaperTeam 独立 state 的 .env 中添加 provider API Key（见 README）";
    }
    if (phaseOverride !== null) {
      gatewayPhase = phaseOverride.gateway;
      runtimePhase = phaseOverride.runtime;
      runtimeDetail = phaseOverride.detail;
    }

    return {
      ...base,
      gateway: {
        phase: gatewayPhase,
        detail:
          phaseOverride !== null
            ? phaseOverride.detail
            : `Gateway 在线（${health.latencyMs ?? "?"}ms）`,
        latencyMs: health.latencyMs,
      },
      runtime: { phase: runtimePhase, detail: runtimeDetail },
      versions: {
        ...base.versions,
        ...(readGatewayVersion(identity) ? { gatewayRuntime: readGatewayVersion(identity)! } : {}),
      },
      agents,
      model,
    };
  }

  /** 连接不可用时仍返回完整角色清单（registered 未知 → missing） */
  private uncheckedRoles(): AgentMappingStatus[] {
    return roleEntries(this.agentIds).map(([role, agentId]) => ({
      role,
      agentId,
      registered: false,
      status: "missing" as const,
    }));
  }

  private mapAgents(agentList: Record<string, unknown> | null): RuntimeStatus["agents"] {
    if (agentList === null) {
      return { roles: this.uncheckedRoles() };
    }
    const registered = new Set(
      Array.isArray(agentList["agents"])
        ? agentList["agents"]
            .map((entry) => asRecord(entry)["id"])
            .filter((id): id is string => typeof id === "string")
        : [],
    );
    const roles = roleEntries(this.agentIds).map(([role, agentId]) => ({
      role,
      agentId,
      registered: registered.has(agentId),
      status: registered.has(agentId) ? ("configured" as const) : ("missing" as const),
    }));
    return {
      ...(typeof agentList["defaultId"] === "string"
        ? { defaultId: agentList["defaultId"] }
        : {}),
      ...(typeof agentList["ownership"] === "string"
        ? { ownership: agentList["ownership"] }
        : {}),
      roles,
    };
  }
}

function roleEntries(agentIds: RuntimeStatusOptions["agentIds"]): Array<[string, string]> {
  return [
    ["researcher", agentIds.researcher],
    ["writer", agentIds.writer],
    ["reviewer", agentIds.reviewer],
    ["citation", agentIds.citation],
  ];
}

/**
 * models.authStatus 防御性摘要：结构未在公开 protocol schema 中固定，
 * 只依赖“顶层或 providers/entries 数组里出现带 provider 名的条目”这一宽松假设。
 */
function summarizeModelStatus(payload: Record<string, unknown>): RuntimeStatus["model"] {
  const providers = collectProviderNames(payload);
  if (providers.length > 0) {
    return {
      phase: "configured",
      providers,
      detail: `已配置模型凭据（provider：${providers.join(", ")}）`,
    };
  }
  // 显式空配置 vs 结构不认识
  if (payload["providers"] !== undefined || payload["entries"] !== undefined || payload["status"] !== undefined) {
    return {
      phase: "not_configured",
      providers: [],
      detail: "网关未配置任何模型 provider 凭据（Agent 调用会失败）",
    };
  }
  return {
    phase: "unknown",
    providers: [],
    detail: "无法解析 models.authStatus 响应（未识别的字段结构）",
  };
}

function collectProviderNames(payload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const consider = (entry: Record<string, unknown>): void => {
    for (const key of ["provider", "providerId", "id", "name"]) {
      const value = entry[key];
      if (typeof value === "string" && value !== "") {
        names.add(value);
        return;
      }
    }
  };
  for (const arrayKey of ["providers", "entries", "auth", "profiles"]) {
    const list = payload[arrayKey];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === "string" && entry !== "") {
          names.add(entry);
        } else {
          const record = asRecord(entry);
          if (Object.keys(record).length > 0) {
            consider(record);
          }
        }
      }
    } else if (typeof list === "object" && list !== null && !Array.isArray(list)) {
      for (const [key, value] of Object.entries(list)) {
        const record = asRecord(value);
        if (Object.keys(record).length > 0) {
          consider({ provider: key, ...record });
        }
      }
    }
  }
  return [...names].slice(0, 10);
}

/** gateway.identity.get 响应中的版本字段（字段名防御式探测） */
function readGatewayVersion(identity: Record<string, unknown> | null): string | undefined {
  if (identity === null) {
    return undefined;
  }
  const direct = pickString(identity, ["version", "runtimeVersion", "gatewayVersion", "appVersion"]);
  if (direct) {
    return direct;
  }
  for (const key of ["identity", "gateway", "runtime", "info"]) {
    const nested = asRecord(identity[key]);
    const found = pickString(nested, ["version", "runtimeVersion", "gatewayVersion"]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

function websocketUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

/** 从 Runtime 实现读取连接信息（OpenClawRuntimeAdapter 提供；其余实现跳过直连诊断） */
function runtimeConnectionInfo(
  runtime: AgentRuntime,
): { baseUrl: string; apiKey?: string } {
  const info = (runtime as { connectionInfo?: () => { baseUrl: string; apiKey?: string } })
    .connectionInfo;
  if (typeof info === "function") {
    return info.call(runtime);
  }
  return { baseUrl: "" };
}

function readErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    const gatewayCode = (error as { gatewayCode?: unknown }).gatewayCode;
    if (typeof gatewayCode === "string") {
      return gatewayCode;
    }
  }
  return "UNKNOWN";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
