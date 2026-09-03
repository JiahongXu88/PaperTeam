/**
 * PaperTeam 独立 OpenClaw Runtime 的路径解析（M3.5 Runtime Bootstrap）。
 *
 * 原则：PaperTeam 绝不读写用户全局 `~/.openclaw`（那是 AutoClaw / 用户其他
 * OpenClaw 项目的 state）。所有 Runtime state / config 都放在用户级
 * PaperTeam 目录下，默认布局：
 *
 *   <PAPERTEAM_RUNTIME_ROOT>/            （默认 %USERPROFILE%\.paperteam）
 *   ├── runtime/runtime.json             Bootstrap 配置（端口 / token / 版本）
 *   └── runtime/openclaw/                OPENCLAW_STATE_DIR（会话、凭据、缓存）
 *       └── openclaw.json                OPENCLAW_CONFIG_PATH（Gateway 配置）
 *
 * 隔离是硬约束：解析结果若与全局 `~/.openclaw` 重叠（相同或互为祖先），
 * 直接抛 BootstrapError，绝不静默落到全局 state。
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** PaperTeam 用户级运行时根目录的环境变量覆盖 */
export const PAPERTEAM_RUNTIME_ROOT_ENV = "PAPERTEAM_RUNTIME_ROOT";

/** PaperTeam Runtime Bootstrap / 启动流程的错误（进入结构化错误体系） */
export class BootstrapError extends Error {
  override readonly name = "BootstrapError";
  readonly code: string;

  constructor(message: string, code = "RUNTIME_BOOTSTRAP") {
    super(message);
    this.code = code;
  }
}

export interface RuntimePaths {
  /** PaperTeam 用户级根目录（<home>/.paperteam 或 PAPERTEAM_RUNTIME_ROOT） */
  root: string;
  /** Bootstrap 配置文件（runtime.json） */
  runtimeConfigPath: string;
  /** PaperTeam 独立 OpenClaw state 目录（OPENCLAW_STATE_DIR） */
  openclawStateDir: string;
  /** PaperTeam 独立 OpenClaw config 文件（OPENCLAW_CONFIG_PATH） */
  openclawConfigPath: string;
  /** PaperTeam 独立 OpenClaw 的 provider .env（模型 API Key 放这里，不入 Git） */
  openclawEnvPath: string;
}

/**
 * 解析 PaperTeam 独立 Runtime 路径。
 * @param env 环境变量来源（可注入，测试用）
 * @param home 用户主目录（可注入，测试用）
 */
export function resolveRuntimePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): RuntimePaths {
  const override = env[PAPERTEAM_RUNTIME_ROOT_ENV]?.trim();
  let root: string;
  if (override !== "" && override !== undefined) {
    // 相对路径拒绝（resolve 会基于 cwd 静默补全，掩盖配置错误）
    if (!isAbsolute(override)) {
      throw new BootstrapError(`PAPERTEAM_RUNTIME_ROOT 必须是绝对路径："${override}"`);
    }
    root = resolve(override);
  } else {
    root = join(home, ".paperteam");
  }
  const runtimeDir = join(root, "runtime");
  const openclawStateDir = join(runtimeDir, "openclaw");
  assertIsolatedFromGlobalOpenClaw(openclawStateDir, home);
  return {
    root,
    runtimeConfigPath: join(runtimeDir, "runtime.json"),
    openclawStateDir,
    openclawConfigPath: join(openclawStateDir, "openclaw.json"),
    openclawEnvPath: join(openclawStateDir, ".env"),
  };
}

/** PaperTeam state 与全局 ~/.openclaw 不得相同或互为祖先目录 */
function assertIsolatedFromGlobalOpenClaw(stateDir: string, home: string): void {
  const globalDir = join(home, ".openclaw");
  const a = normalize(stateDir);
  const b = normalize(globalDir);
  if (a === b) {
    throw new BootstrapError(
      `PaperTeam 的 OpenClaw state 目录不能是全局 ${b}（会污染用户其他 OpenClaw 项目）；` +
        ` 请检查 ${PAPERTEAM_RUNTIME_ROOT_ENV}。`,
      "STATE_DIR_NOT_ISOLATED",
    );
  }
  // Windows 跨盘符时 path.relative 直接返回对方的绝对路径，需一并排除
  const nested = (from: string, to: string): boolean => {
    const rel = relative(from, to);
    if (isAbsolute(rel)) {
      return false; // 跨盘符 → 必不嵌套
    }
    return rel !== "" && !rel.startsWith("..");
  };
  if (nested(a, b) || nested(b, a)) {
    throw new BootstrapError(
      `PaperTeam 的 OpenClaw state 目录（${a}）与全局目录（${b}）存在嵌套，拒绝使用；` +
        ` 请检查 ${PAPERTEAM_RUNTIME_ROOT_ENV}。`,
      "STATE_DIR_NOT_ISOLATED",
    );
  }
}

function normalize(path: string): string {
  // Windows 大小写不敏感；resolve 已按平台统一分隔符
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
