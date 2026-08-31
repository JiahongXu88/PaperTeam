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

export interface AppConfig {
  env: NodeEnv;
  port: number;
  gateway: GatewayConfig;
  /** Writer Agent 对应的 OpenClaw agent id */
  writerAgentId: string;
  /** 论文项目工作区根目录（绝对路径） */
  projectsRoot: string;
  latex: LatexConfig;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_WRITER_AGENT_ID = "writer";
const DEFAULT_PROJECTS_ROOT = "./projects";
const DEFAULT_LATEX_COMPILE_TIMEOUT_MS = 120_000;

const HEALTH_TIMEOUT_MIN_MS = 100;
const HEALTH_TIMEOUT_MAX_MS = 60_000;
const RPC_TIMEOUT_MIN_MS = 1_000;
const RPC_TIMEOUT_MAX_MS = 120_000;
const RUN_TIMEOUT_MIN_MS = 1_000;
const RUN_TIMEOUT_MAX_MS = 3_600_000;
const LATEX_TIMEOUT_MIN_MS = 1_000;
const LATEX_TIMEOUT_MAX_MS = 1_800_000;

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
    writerAgentId: readWriterAgentId(source),
    projectsRoot: readProjectsRoot(source),
    latex: {
      compileTimeoutMs: readTimeoutMs(source, "LATEX_COMPILE_TIMEOUT_MS", {
        default: DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
        min: LATEX_TIMEOUT_MIN_MS,
        max: LATEX_TIMEOUT_MAX_MS,
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

function readWriterAgentId(source: Record<string, string | undefined>): string {
  const key = "OPENCLAW_WRITER_AGENT_ID";
  const raw = (source[key] ?? "").trim();
  if (raw === "") {
    return DEFAULT_WRITER_AGENT_ID;
  }
  if (!AGENT_ID_PATTERN.test(raw)) {
    throw new ConfigError(
      `${key} 只能包含字母、数字、下划线或连字符（长度 1-64），当前为 "${raw}"`,
    );
  }
  return raw;
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
