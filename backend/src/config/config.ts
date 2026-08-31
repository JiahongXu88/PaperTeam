/**
 * PaperTeam Backend 配置（M1 只覆盖启动 Runtime Skeleton 所需部分）。
 *
 * 配置来源：环境变量（可选地从仓库根 / backend 目录的 .env 文件补缺）。
 * 语义与根目录 .env.example 保持一致，不引入新的必填项。
 */

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
  /** Gateway API Key（M1 的 /health 探针无需鉴权；预留给后续 RPC 调用） */
  apiKey?: string;
  /** 健康检查超时（毫秒） */
  healthTimeoutMs: number;
}

export interface AppConfig {
  env: NodeEnv;
  port: number;
  gateway: GatewayConfig;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MIN_MS = 100;
const HEALTH_TIMEOUT_MAX_MS = 60_000;

const NODE_ENVS: readonly NodeEnv[] = ["development", "production", "test"];

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return {
    env: readNodeEnv(source),
    port: readPort(source),
    gateway: {
      url: readGatewayUrl(source),
      apiKey: readOptionalValue(source, "OPENCLAW_GATEWAY_API_KEY"),
      healthTimeoutMs: readHealthTimeoutMs(source),
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
  const key = "OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS";
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HEALTH_TIMEOUT_MS;
  }
  const ms = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(ms) || ms < HEALTH_TIMEOUT_MIN_MS || ms > HEALTH_TIMEOUT_MAX_MS) {
    throw new ConfigError(
      `${key} 必须是 ${HEALTH_TIMEOUT_MIN_MS}-${HEALTH_TIMEOUT_MAX_MS} 的整数（毫秒），当前为 "${raw.trim()}"`,
    );
  }
  return ms;
}

function readOptionalValue(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = (source[key] ?? "").trim();
  return raw === "" ? undefined : raw;
}
