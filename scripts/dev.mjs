#!/usr/bin/env node
/**
 * PaperTeam dev 启动器（`npm run dev`，M3.5 Runtime Bootstrap 的入口薄壳）。
 *
 * 职责（真正的编排在 backend/dist/dev/cli.js，本文件只做进入前的准备）：
 *   1. Node 版本检查（对齐锁定的 openclaw@2026.8.2 支持范围）
 *   2. 根目录依赖（openclaw runtime 本体）缺失时执行 npm install
 *   3. backend 依赖缺失时执行 npm install
 *   4. 构建 backend（tsc，保证 dist 新鲜）
 *   5. 启动 bootstrap CLI 并透传信号 / 退出码
 *
 * 不引入任何 monorepo / 进程管理工具（Nx、Turborepo、PM2 等）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_ENTRY = join(repoRoot, "node_modules", "openclaw", "openclaw.mjs");
const BACKEND_DIST_CLI = join(repoRoot, "backend", "dist", "dev", "cli.js");

/** openclaw@2026.8.2 支持的 Node 范围（与其 node-version.mjs 一致） */
const SUPPORTED_NODE_RANGES = [
  [22, 22, 3, 23],
  [24, 15, 0, 25],
  [25, 9, 0, 26],
];

function nodeVersionParts() {
  const parts = process.versions.node.split(".").map((piece) => Number.parseInt(piece, 10));
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

function isSupportedNode() {
  const { major, minor, patch } = nodeVersionParts();
  return SUPPORTED_NODE_RANGES.some(([loMajor, loMinor, loPatch, hiMajor]) => {
    if (major < loMajor || major >= hiMajor) {
      return false;
    }
    if (major > loMajor) {
      return true;
    }
    return minor > loMinor || (minor === loMinor && patch >= loPatch);
  });
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

  if (!isSupportedNode()) {
    console.error(
      `[paperteam-dev] Node 版本不满足要求：openclaw@2026.8.2 支持 ` +
        `>=22.22.3 <23 / >=24.15.0 <25 / >=25.9.0，当前 ${process.versions.node}。` +
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
