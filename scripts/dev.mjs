#!/usr/bin/env node
/**
 * PaperTeam dev 启动器（`npm run dev`，M3.5 Runtime Bootstrap 的入口薄壳）。
 *
 * 职责（真正的编排在 backend/dist/dev/cli.js，本文件只做进入前的准备）：
 *   1. Node 版本检查（直接复用根 package.json 的 engines.node，与
 *      openclaw@2026.9.1 的支持范围保持一致，单一事实源）
 *   2. 根目录依赖（openclaw runtime 本体）缺失时执行 npm install
 *   3. backend 依赖缺失时执行 npm install
 *   4. 构建 backend（tsc，保证 dist 新鲜）
 *   5. 启动 bootstrap CLI 并透传信号 / 退出码
 *
 * 不引入任何 monorepo / 进程管理工具（Nx、Turborepo、PM2 等）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_ENTRY = join(repoRoot, "node_modules", "openclaw", "openclaw.mjs");
const BACKEND_DIST_CLI = join(repoRoot, "backend", "dist", "dev", "cli.js");

/**
 * Node 版本检查的唯一事实源：根 package.json 的 engines.node
 * （与 openclaw@2026.9.1 node-version.mjs 的支持范围一致：
 *   >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0 —— 末段无上界，
 *   即 Node 26+ 受支持且为官方推荐线，Node 23 仍不支持）。
 * 这里不再手工维护第二份范围表，避免两处互相漂移（M3.6 修复项）。
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
  console.log(`PaperTeam dev（node ${process.versions.node}）`);

  const enginesNode = readEnginesNode();
  if (!isSupportedNode(enginesNode)) {
    console.error(
      `[paperteam-dev] Node 版本不满足要求：需要满足 ${enginesNode}` +
        `（与 openclaw@2026.9.1 支持范围一致；Node 26+ 可用），当前 ${process.versions.node}。` +
        ` 请切换 Node 后重试。`,
    );
    process.exit(1);
  }

  // 依赖检查（根：openclaw runtime；backend：业务依赖）
  if (!existsSync(OPENCLAW_ENTRY)) {
    console.log("[paperteam-dev] 根目录依赖缺失（openclaw runtime），执行 npm install ...");
    runSync("npm", ["install"], repoRoot);
  }
  if (!existsSync(join(repoRoot, "backend", "node_modules", "@openclaw"))) {
    console.log("[paperteam-dev] backend 依赖缺失，执行 npm install ...");
    runSync("npm", ["install"], join(repoRoot, "backend"));
  }

  // 构建（保证 dist 与 src 一致；tsc 增量很快）
  runSync("npm", ["run", "build"], join(repoRoot, "backend"));

  // 启动 bootstrap CLI（stdio 直通）
  const child = spawn(process.execPath, [BACKEND_DIST_CLI], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (process.platform !== "win32") {
    // POSIX：转发信号让 cli.js 优雅关闭。
    // Windows 不转发：控制台 Ctrl+C 事件原生送达同一控制台的 cli.js 及其
    // 子进程（各自运行优雅清理）；此时 child.kill() 是 TerminateProcess，
    // 反而会在优雅关闭完成前硬杀 cli.js。
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
