#!/usr/bin/env node
/**
 * PaperTeam dev 启动器（`npm run dev`，M3.8：Pi in-process Runtime）。
 *
 * 启动模型（无 Gateway 子进程 / 端口 / 握手 / state 准备）：
 *
 *   npm run dev → 本启动器 → backend/dist/index.js（Pi SDK in-process 嵌入）
 *
 * 职责：
 *   1. Node 版本检查（复用根 package.json 的 engines.node，单一事实源）
 *   2. backend 依赖缺失时执行 npm install
 *   3. 构建 backend（tsc，保证 dist 新鲜）
 *   4. 启动 Backend 并透传信号 / 退出码
 *
 * Backend 监听端口经 PAPERTEAM_PORT 配置（默认 3000）；
 * 模型凭据经 PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 或
 * <PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent/auth.json 配置（见 .env.example）。
 *
 * 不引入任何 monorepo / 进程管理工具（Nx、Turborepo、PM2 等）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND_DIST_ENTRY = join(repoRoot, "backend", "dist", "index.js");

/**
 * Node 版本检查的唯一事实源：根 package.json 的 engines.node。
 * 这里不再手工维护第二份范围表，避免两处互相漂移。
 */
function readEnginesNode() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const engines = pkg?.engines?.node;
  if (typeof engines !== "string" || engines.trim() === "") {
    console.error("[paperteam-dev] 根 package.json 缺少 engines.node，无法进行 Node 版本检查。");
    process.exit(1);
  }
  return engines.trim();
}

/** engines 里实际用到的简单比较符（>= <= > < = + 纯数字版本）；不认识的语法直接报错 */
const VERSION_TOKEN = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function nodeVersionParts() {
  const parts = process.versions.node.split(".").map((piece) => Number.parseInt(piece, 10));
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

function satisfiesToken(token, { major, minor, patch }) {
  const match = VERSION_TOKEN.exec(token);
  if (match === null) {
    console.error(
      `[paperteam-dev] engines.node 含不支持的语法 "${token}"（启动器只实现 >= <= > < = 与纯数字版本）。`,
    );
    process.exit(1);
  }
  const operator = match[1] ?? "=";
  const target = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  const compared =
    (major - target[0]) || (minor - target[1]) || (patch - target[2]);
  switch (operator) {
    case ">=":
      return compared >= 0;
    case "<=":
      return compared <= 0;
    case ">":
      return compared > 0;
    case "<":
      return compared < 0;
    default:
      return compared === 0;
  }
}

function isSupportedNode(enginesNode) {
  const current = nodeVersionParts();
  return enginesNode.split("||").some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "")
      .every((token) => satisfiesToken(token, current)),
  );
}

function runSync(command, args, cwd) {
  // npm 在 Windows 上是 npm.cmd：优先经 npm_execpath（npm run 注入）用 node
  // 直接执行 npm-cli.js，避免 shell:true（DEP0190 且参数不经转义）
  if (command === "npm") {
    const npmCli = process.env.npm_execpath;
    if (npmCli && !npmCli.endsWith(".cmd")) {
      command = process.execPath;
      args = [npmCli, ...args];
    }
  }
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    ...(command === "npm" ? { shell: process.platform === "win32" } : {}),
  });
  if (result.error !== undefined && result.status === null) {
    console.error(`[paperteam-dev] 命令无法启动：${command} ${args.join(" ")}（${result.error.message}）`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[paperteam-dev] 命令失败（${result.status}）：${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  console.log(`PaperTeam dev（node ${process.versions.node}，Pi in-process Runtime）`);

  const enginesNode = readEnginesNode();
  if (!isSupportedNode(enginesNode)) {
    console.error(
      `[paperteam-dev] Node 版本不满足要求：需要满足 ${enginesNode}` +
        `（Node 26+ 可用），当前 ${process.versions.node}。 请切换 Node 后重试。`,
    );
    process.exit(1);
  }

  // 依赖检查（backend：业务 + Pi SDK 依赖）
  if (!existsSync(join(repoRoot, "backend", "node_modules", "@earendil-works"))) {
    console.log("[paperteam-dev] backend 依赖缺失，执行 npm install ...");
    runSync("npm", ["install"], join(repoRoot, "backend"));
  }

  // 构建（保证 dist 与 src 一致；tsc 增量很快）
  runSync("npm", ["run", "build"], join(repoRoot, "backend"));

  // 启动 Backend（Pi SDK in-process；stdio 直通）
  const child = spawn(process.execPath, [BACKEND_DIST_ENTRY], {
    cwd: join(repoRoot, "backend"),
    stdio: "inherit",
    env: { ...process.env },
  });
  if (process.platform !== "win32") {
    // POSIX：转发信号让 Backend 优雅关闭。
    // Windows 不转发：控制台 Ctrl+C 事件原生送达同一控制台的 Backend 进程
    // （其自身运行优雅清理）；此时 child.kill() 是 TerminateProcess，
    // 反而会在优雅关闭完成前硬杀 Backend。
    const forward = (signal) => {
      if (child.pid !== undefined) {
        try {
          child.kill(signal);
        } catch {
          // 已退出
        }
      }
    };
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
