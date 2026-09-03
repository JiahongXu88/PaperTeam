/**
 * PaperTeam Backend 配置（M2 覆盖 Runtime 调用、项目与 LaTeX 编译所需部分）。
 *
 * 配置来源：环境变量（可选地从仓库根 / backend 目录的 .env 文件补缺）。
 * 语义与根目录 .env.example 保持一致，不引入新的必填项。
 */

import { resolve } from "node:path";

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}

export type NodeEnv = "development" | "production" | "test";

export interface GatewayConfig {
  /** OpenClaw Gateway 基地址，例如 http://127.0.0.1:18789 */
  url: string;
  /** Gateway API Key（/health 探针无需鉴权；WebSocket connect 握手使用） */
  apiKey?: string;
  /** 健康检查超时（毫秒） */
  healthTimeoutMs: number;
  /** WebSocket 连接与单次 RPC 的默认超时（毫秒） */
  rpcTimeoutMs: number;
  /** 单次 runAgent 的整体超时（毫秒） */
  runTimeoutMs: number;
}

export interface LatexConfig {
  /** 单次 LaTeX 编译超时（毫秒） */
  compileTimeoutMs: number;
}

export interface WorkflowConfig {
  /** 单个 Stage 执行超时（毫秒） */
  stageTimeoutMs: number;
  /** 单个 Stage 最大尝试次数（含首次） */
  stageMaxAttempts: number;
}

export interface AppConfig {
  env: NodeEnv;
  port: number;
  gateway: GatewayConfig;
  /** 各业务 Agent 对应的 OpenClaw agent id */
  agents: AgentIds;
  /** 论文项目工作区根目录（绝对路径） */
  projectsRoot: string;
  latex: LatexConfig;
  workflow: WorkflowConfig;
}

export interface AgentIds {
  writer: string;
  researcher: string;
  reviewer: string;
  citation: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_PROJECTS_ROOT = "./projects";
const DEFAULT_LATEX_COMPILE_TIMEOUT_MS = 120_000;
const DEFAULT_STAGE_TIMEOUT_MS = 900_000;
const DEFAULT_STAGE_MAX_ATTEMPTS = 2;

const HEALTH_TIMEOUT_MIN_MS = 100;
const HEALTH_TIMEOUT_MAX_MS = 60_000;
const RPC_TIMEOUT_MIN_MS = 1_000;
const RPC_TIMEOUT_MAX_MS = 120_000;
const RUN_TIMEOUT_MIN_MS = 1_000;
const RUN_TIMEOUT_MAX_MS = 3_600_000;
const LATEX_TIMEOUT_MIN_MS = 1_000;
const LATEX_TIMEOUT_MAX_MS = 1_800_000;
const STAGE_TIMEOUT_MIN_MS = 5_000;
const STAGE_TIMEOUT_MAX_MS = 3_600_000;
const STAGE_MAX_ATTEMPTS_MIN = 1;
const STAGE_MAX_ATTEMPTS_MAX = 5;

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NODE_ENVS: readonly NodeEnv[] = ["development", "production", "test"];

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return {
    env: readNodeEnv(source),
    port: readPort(source),
    gateway: {
      url: readGatewayUrl(source),
      apiKey: readOptionalValue(source, "OPENCLAW_GATEWAY_API_KEY"),
      healthTimeoutMs: readHealthTimeoutMs(source),
      rpcTimeoutMs: readTimeoutMs(source, "OPENCLAW_GATEWAY_RPC_TIMEOUT_MS", {
        default: DEFAULT_RPC_TIMEOUT_MS,
        min: RPC_TIMEOUT_MIN_MS,
        max: RPC_TIMEOUT_MAX_MS,
      }),
      runTimeoutMs: readTimeoutMs(source, "OPENCLAW_AGENT_RUN_TIMEOUT_MS", {
        default: DEFAULT_RUN_TIMEOUT_MS,
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
    },
    agents: {
      writer: readAgentId(source, "OPENCLAW_WRITER_AGENT_ID", "writer"),
      researcher: readAgentId(source, "OPENCLAW_RESEARCHER_AGENT_ID", "researcher"),
      reviewer: readAgentId(source, "OPENCLAW_REVIEWER_AGENT_ID", "reviewer"),
      citation: readAgentId(source, "OPENCLAW_CITATION_AGENT_ID", "citation"),
    },
    projectsRoot: readProjectsRoot(source),
    latex: {
      compileTimeoutMs: readTimeoutMs(source, "LATEX_COMPILE_TIMEOUT_MS", {
        default: DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
        min: LATEX_TIMEOUT_MIN_MS,
        max: LATEX_TIMEOUT_MAX_MS,
      }),
    },
    workflow: {
      stageTimeoutMs: readTimeoutMs(source, "WORKFLOW_STAGE_TIMEOUT_MS", {
        default: DEFAULT_STAGE_TIMEOUT_MS,
        min: STAGE_TIMEOUT_MIN_MS,
        max: STAGE_TIMEOUT_MAX_MS,
      }),
      stageMaxAttempts: readInt(source, "WORKFLOW_STAGE_MAX_ATTEMPTS", {
        default: DEFAULT_STAGE_MAX_ATTEMPTS,
        min: STAGE_MAX_ATTEMPTS_MIN,
        max: STAGE_MAX_ATTEMPTS_MAX,
      }),
    },
  };
}

function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  const raw = (source["NODE_ENV"] ?? "development").trim();
  const match = NODE_ENVS.find((candidate) => candidate === raw);
  if (!match) {
    throw new ConfigError(
      `NODE_ENV 只能是 ${NODE_ENVS.join(" / ")}，当前为 "${raw}"`,
    );
  }
  return match;
}

function readPort(source: Record<string, string | undefined>): number {
  const raw = source["PAPERTEAM_PORT"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(
      `PAPERTEAM_PORT 必须是 1-65535 的整数，当前为 "${raw.trim()}"`,
    );
  }
  return port;
}

function readGatewayUrl(source: Record<string, string | undefined>): string {
  const key = "OPENCLAW_GATEWAY_URL";
  const raw = (source[key] ?? "").trim();
  if (raw === "") {
    throw new ConfigError(
      `缺少必需配置 OPENCLAW_GATEWAY_URL（OpenClaw Gateway 地址，例如 http://127.0.0.1:18789）。` +
        ` 请参考根目录 .env.example 复制为 .env 并填写。`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`OPENCLAW_GATEWAY_URL 不是合法 URL："${raw}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `OPENCLAW_GATEWAY_URL 必须以 http:// 或 https:// 开头，当前为 "${raw}"`,
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError(`OPENCLAW_GATEWAY_URL 不应包含查询串或锚点："${raw}"`);
  }

  // 统一去掉尾部斜杠，便于 Adapter 直接拼接探测路径
  return raw.replace(/\/+$/, "");
}

function readHealthTimeoutMs(source: Record<string, string | undefined>): number {
  return readTimeoutMs(source, "OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS", {
    default: DEFAULT_HEALTH_TIMEOUT_MS,
    min: HEALTH_TIMEOUT_MIN_MS,
    max: HEALTH_TIMEOUT_MAX_MS,
  });
}

/** 通用整型超时配置读取（缺省 / 越界报错） */
function readTimeoutMs(
  source: Record<string, string | undefined>,
  key: string,
  bounds: { default: number; min: number; max: number },
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return bounds.default;
  }
  const ms = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(ms) || ms < bounds.min || ms > bounds.max) {
    throw new ConfigError(
      `${key} 必须是 ${bounds.min}-${bounds.max} 的整数（毫秒），当前为 "${raw.trim()}"`,
    );
  }
  return ms;
}

/** 读取 agent id 配置（缺省用默认值；非法字符报错） */
function readAgentId(
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const raw = (source[key] ?? "").trim();
  if (raw === "") {
    return fallback;
  }
  if (!AGENT_ID_PATTERN.test(raw)) {
    throw new ConfigError(
      `${key} 只能包含字母、数字、下划线或连字符（长度 1-64），当前为 "${raw}"`,
    );
  }
  return raw;
}

/** 通用整型配置读取（缺省 / 越界报错） */
function readInt(
  source: Record<string, string | undefined>,
  key: string,
  bounds: { default: number; min: number; max: number },
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return bounds.default;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${key} 必须是 ${bounds.min}-${bounds.max} 的整数，当前为 "${raw.trim()}"`,
    );
  }
  return value;
}

function readProjectsRoot(source: Record<string, string | undefined>): string {
  const key = "PROJECTS_ROOT";
  const raw = (source[key] ?? "").trim() || DEFAULT_PROJECTS_ROOT;
  // 相对路径基于进程工作目录解析为绝对路径，路径管理集中在服务端
  return resolve(process.cwd(), raw);
}

function readOptionalValue(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = (source[key] ?? "").trim();
  return raw === "" ? undefined : raw;
}
