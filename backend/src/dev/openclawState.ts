/**
 * PaperTeam 独立 OpenClaw state / config 准备（M3.5 Runtime Bootstrap）。
 *
 * 依据 OpenClaw 2026.8.2 官方文档（docs/gateway/multiple-gateways.md 的
 * isolation checklist）确认的实例隔离方式：
 *   - OPENCLAW_STATE_DIR  <dir>   会话 / 凭据 / 缓存 / workspace 全部落在这里
 *   - OPENCLAW_CONFIG_PATH <file> 该实例的 openclaw.json
 *   - gateway --port <port>       每实例唯一端口
 *
 * 最小 config 写入 `{"gateway":{"mode":"local"}}`：OpenClaw gateway 启动时
 * 要求 config 中显式存在 gateway.mode=local（否则按“被破坏的配置”拒绝启动），
 * 我们不使用 --allow-unconfigured 绕过，而是给出真实有效的最小配置。
 * 已存在的 config 不覆盖（用户可在其中追加模型等配置）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { BootstrapError } from "./runtimePaths.js";

/** PaperTeam 生成的最小 OpenClaw config（JSON，兼容 JSON5 解析） */
export const MINIMAL_OPENCLAW_CONFIG = JSON.stringify(
  { gateway: { mode: "local" } },
  null,
  2,
) + "\n";

export interface PreparedOpenClawState {
  stateDir: string;
  configPath: string;
  /** state 目录是否为本次新建（首次运行） */
  created: boolean;
}

/** OpenClaw 安装位置解析结果 */
export interface OpenClawInstall {
  /** openclaw.mjs 入口（可直接 node 执行） */
  entryPath: string;
  /** 安装版本（package.json version） */
  version: string;
}

/**
 * 准备 PaperTeam 独立 state 目录与最小 config。
 * 幂等：目录已存在只补缺，config 已存在不覆盖。
 */
export async function prepareOpenClawState(
  paths: { openclawStateDir: string; openclawConfigPath: string },
  io: {
    mkdir: (path: string) => Promise<void>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  } = {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
  },
): Promise<PreparedOpenClawState> {
  let created = false;
  try {
    await io.readFile(paths.openclawConfigPath);
  } catch {
    // config 不存在：新建 state 目录 + 写最小 config
    created = true;
    await io.mkdir(paths.openclawStateDir);
    await io.writeFile(paths.openclawConfigPath, MINIMAL_OPENCLAW_CONFIG);
  }
  return { stateDir: paths.openclawStateDir, configPath: paths.openclawConfigPath, created };
}

/**
 * 解析项目本地安装的 OpenClaw（<repoRoot>/node_modules/openclaw）。
 * PaperTeam 不依赖全局安装，也不依赖任何 OpenClaw 源码 checkout。
 */
export async function resolveOpenClawInstall(
  repoRoot: string,
  expectedVersion: string,
  io: {
    readFile: (path: string) => Promise<string>;
  } = { readFile: (path) => readFile(path, "utf8") },
): Promise<OpenClawInstall> {
  const pkgPath = `${repoRoot.replaceAll("\\", "/")}/node_modules/openclaw/package.json`;
  let pkg: { version?: unknown; bin?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await io.readFile(pkgPath)) as { version?: unknown };
  } catch {
    throw new BootstrapError(
      `未找到项目本地 OpenClaw 安装（${pkgPath}）。请在仓库根目录执行 npm install。`,
      "OPENCLAW_NOT_INSTALLED",
    );
  }
  const version = typeof pkg.version === "string" ? pkg.version : undefined;
  if (!version) {
    throw new BootstrapError(`OpenClaw package.json 缺少 version 字段：${pkgPath}`);
  }
  if (version !== expectedVersion) {
    throw new BootstrapError(
      `项目本地 OpenClaw 版本是 ${version}，与 Bootstrap 锁定的 ${expectedVersion} 不一致。` +
        ` 请在仓库根目录重新执行 npm install（package.json / lockfile 已固定版本）。`,
      "OPENCLAW_VERSION_MISMATCH",
    );
  }
  const entryPath = `${repoRoot.replaceAll("\\", "/")}/node_modules/openclaw/openclaw.mjs`;
  return { entryPath, version };
}

/** 组装 Gateway 子进程环境变量（实例隔离的全部开关） */
export function gatewayProcessEnv(
  state: PreparedOpenClawState,
  runtimeConfig: { gatewayToken: string },
  parentEnv: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  // 实例隔离三件套（覆盖继承值，防止意外串到全局 state）
  env["OPENCLAW_STATE_DIR"] = state.stateDir;
  env["OPENCLAW_CONFIG_PATH"] = state.configPath;
  env["OPENCLAW_GATEWAY_TOKEN"] = runtimeConfig.gatewayToken;
  // OPENCLAW_PROFILE 会把 config/state 重定向到 ~/.openclaw-<profile>，
  // 与我们的显式路径冲突，一律剔除；OPENCLAW_ALLOW_MULTI_GATEWAY 与
  // 隔离实例不冲突（我们的 state/config 本就唯一），保留继承值。
  for (const key of Object.keys(env)) {
    if (key === "OPENCLAW_PROFILE") {
      delete env[key];
    }
  }
  return env;
}
