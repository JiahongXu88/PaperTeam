/**
 * PaperTeam Runtime Bootstrap 配置（<runtime-root>/runtime/runtime.json）。
 *
 * 保存三件事（均为用户级，不入 Git）：
 *   - openclawVersion：PaperTeam 使用的 OpenClaw runtime 精确版本（与根
 *     package.json 的 devDependency pin 一致，Bootstrap 校验防漂移）
 *   - gatewayPort：PaperTeam 独立 Gateway 端口（默认 18790，避开用户自己
 *     Gateway 常用的 18789）
 *   - gatewayToken：首次生成的随机共享 token（Gateway 鉴权 + Backend 连接）
 *
 * 环境变量优先级高于文件（供测试 / CI 注入），但不会写回文件。
 * token 属于敏感信息：序列化 / 日志一律走 redactGatewayToken。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { BootstrapError } from "./runtimePaths.js";

/** PaperTeam 运行的 OpenClaw 精确版本（禁止 ^ / ~ / latest） */
export const OPENCLAW_RUNTIME_VERSION = "2026.9.1";

/** PaperTeam 独立 Gateway 默认端口（避开 OpenClaw 全局默认 18789） */
export const DEFAULT_GATEWAY_PORT = 18790;

/** PaperTeam Backend 默认端口（与 backend config 的 PAPERTEAM_PORT 缺省一致） */
export const DEFAULT_BACKEND_PORT = 3000;

/** 环境变量覆盖（文件值 < 环境变量） */
export const ENV_GATEWAY_PORT = "PAPERTEAM_DEV_GATEWAY_PORT";
export const ENV_BACKEND_PORT = "PAPERTEAM_DEV_BACKEND_PORT";
export const ENV_GATEWAY_TOKEN = "PAPERTEAM_DEV_GATEWAY_TOKEN";

const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+$/;
const PORT_MIN = 1;
const PORT_MAX = 65_535;

export interface RuntimeConfig {
  /** OpenClaw runtime 精确版本 */
  openclawVersion: string;
  /** PaperTeam 独立 Gateway 端口 */
  gatewayPort: number;
  /** PaperTeam Backend 端口 */
  backendPort: number;
  /** Gateway 共享 token（敏感；展示走 redactGatewayToken） */
  gatewayToken: string;
}

export interface RuntimeConfigFile {
  openclawVersion?: unknown;
  gatewayPort?: unknown;
  backendPort?: unknown;
  gatewayToken?: unknown;
}

/** 端口合法性（1-65535 整数） */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX;
}

/** token 脱敏：只保留前 4 位用于辨认 */
export function redactGatewayToken(token: string): string {
  if (token.length <= 4) {
    return "****";
  }
  return `${token.slice(0, 4)}****`;
}

/** 日志安全的配置摘要（不含完整 token） */
export function summarizeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    openclawVersion: config.openclawVersion,
    gatewayPort: config.gatewayPort,
    backendPort: config.backendPort,
    gatewayToken: redactGatewayToken(config.gatewayToken),
  };
}

/**
 * 读取（不存在则创建）runtime.json 并合成最终配置。
 *
 * openclawVersion 的期望值始终以代码 pin（OPENCLAW_RUNTIME_VERSION）为唯一
 * 权威：文件里的旧版本（升级前 release 写入的）自动迁移为新 pin 并重写文件
 * （M3.6 升级路径），不迁移会导致 Bootstrap 用旧版本去校验本地安装而误报漂移。
 *
 * @param runtimeConfigPath runtime.json 路径
 * @param env 环境变量（覆盖端口 / token；不写回文件）
 * @param io 文件 IO（可注入，测试用）
 * @param log 迁移等提示日志（缺省丢弃）
 */
export async function loadRuntimeConfig(
  runtimeConfigPath: string,
  env: Record<string, string | undefined> = process.env,
  io: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  } = {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    },
  },
  log: (message: string) => void = () => {},
): Promise<RuntimeConfig> {
  let file: RuntimeConfigFile = {};
  let existed = true;
  try {
    file = JSON.parse(await io.readFile(runtimeConfigPath)) as RuntimeConfigFile;
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new Error("not an object");
    }
  } catch {
    existed = false;
    // 文件不存在 / 损坏时按首次初始化处理；损坏文件会被覆盖前的显式错误拦截
    if (await fileExists(io, runtimeConfigPath)) {
      throw new BootstrapError(
        `runtime.json 不是合法 JSON：${runtimeConfigPath}（请手工删除后重试，会重新生成默认配置）`,
        "RUNTIME_CONFIG_INVALID",
      );
    }
  }

  const fileVersion = readVersion(file.openclawVersion);
  const openclawVersion = OPENCLAW_RUNTIME_VERSION;
  if (fileVersion !== undefined && fileVersion !== openclawVersion) {
    log(
      `[bootstrap] runtime.json 的 openclawVersion ${fileVersion} → ${openclawVersion}` +
        `（跟随当前代码 pin 迁移，端口 / token 保持不变）`,
    );
  }
  const gatewayPort = readPortField(file.gatewayPort, "gatewayPort");
  const backendPort = readPortField(file.backendPort, "backendPort");
  const fileToken = readToken(file.gatewayToken);
  const hadTokenInFile = fileToken !== undefined;
  const gatewayToken = fileToken ?? randomBytes(32).toString("hex");

  const config: RuntimeConfig = {
    openclawVersion,
    gatewayPort,
    backendPort,
    gatewayToken,
  };

  // 首次生成或版本变化时（重新）落盘；落盘的是文件级配置（不含 env 覆盖）
  if (!existed || !hadTokenInFile || file.openclawVersion !== config.openclawVersion) {
    await saveRuntimeConfig(io, runtimeConfigPath, config);
  }

  // 环境变量覆盖（只影响本次运行，不写回文件）
  const envPort = readEnvPort(env[ENV_GATEWAY_PORT], ENV_GATEWAY_PORT);
  if (envPort !== undefined) {
    config.gatewayPort = envPort;
  }
  const envBackendPort = readEnvPort(env[ENV_BACKEND_PORT], ENV_BACKEND_PORT);
  if (envBackendPort !== undefined) {
    config.backendPort = envBackendPort;
  }
  const envToken = env[ENV_GATEWAY_TOKEN]?.trim();
  if (envToken !== undefined && envToken !== "") {
    config.gatewayToken = envToken;
  }
  return config;
}

async function saveRuntimeConfig(
  io: { writeFile: (path: string, content: string) => Promise<void> },
  path: string,
  config: RuntimeConfig,
): Promise<void> {
  await io.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function fileExists(
  io: { readFile: (path: string) => Promise<string> },
  path: string,
): Promise<boolean> {
  try {
    await io.readFile(path);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return false;
    }
    // Windows 上 readFile 目录会抛 ENOENT/EISDIR 之外的错误时保守视为存在
    return true;
  }
}

function readVersion(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return OPENCLAW_RUNTIME_VERSION;
  }
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new BootstrapError(
      `runtime.json 的 openclawVersion 必须是形如 2026.9.1 的精确版本号，当前为 ${JSON.stringify(value)}`,
      "RUNTIME_CONFIG_INVALID",
    );
  }
  return value;
}

function readPortField(value: unknown, field: string): number {
  if (value === undefined || value === null) {
    return field === "gatewayPort" ? DEFAULT_GATEWAY_PORT : DEFAULT_BACKEND_PORT;
  }
  if (typeof value !== "number" || !isValidPort(value)) {
    throw new BootstrapError(
      `runtime.json 的 ${field} 必须是 1-65535 的整数，当前为 ${JSON.stringify(value)}`,
      "RUNTIME_CONFIG_INVALID",
    );
  }
  return value;
}

function readEnvPort(value: string | undefined, envName: string): number | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || !isValidPort(port)) {
    throw new BootstrapError(`${envName} 必须是 1-65535 的整数，当前为 "${raw}"`);
  }
  return port;
}

function readToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(value.trim())) {
    throw new BootstrapError(
      "runtime.json 的 gatewayToken 格式非法（16-256 位字母数字字符）；请删除该字段后重试",
      "RUNTIME_CONFIG_INVALID",
    );
  }
  return value.trim();
}
