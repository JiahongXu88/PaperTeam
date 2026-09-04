#!/usr/bin/env node
/**
 * PaperTeam dev 启动器（`npm run dev`，M4：Backend + React Workbench）。
 *
 * 启动模型（无 Gateway / supervisor / 进程管理器依赖）：
 *
 *   npm run dev → 本启动器 → backend/dist/index.js（Pi SDK in-process）
 *                            + frontend Vite Dev Server（proxy /api、/health）
 *
 * 职责：
 *   1. Node 版本检查（复用根 package.json 的 engines.node，单一事实源）
 *   2. backend / frontend 依赖缺失时执行 npm install
 *   3. 构建 backend（tsc，保证 dist 新鲜）；frontend 由 Vite 按需编译
 *   4. 同时启动两个子进程：日志加 [backend] / [vite] 前缀，任一退出则全部退出
 *
 * 端口：Backend 默认 3000（PAPERTEAM_PORT 覆盖，透传给 Vite proxy）；
 * Vite Dev Server 固定 5173（strictPort）。Ctrl+C 会终止两个子进程
 * （Windows 下用 taskkill 结束进程树；POSIX 转发 SIGINT/SIGTERM）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND_DIST_ENTRY = join(repoRoot, "backend", "dist", "index.js");
const VITE_ENTRY = join(repoRoot, "frontend", "node_modules", "vite", "bin", "vite.js");

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

/** 带前缀的子进程 stdout/stderr 转发（逐行加前缀；尾部不完整行缓存到下一段） */
function pipeWithPrefix(child, prefix) {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) {
      continue;
    }
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          process.stdout.write(`${prefix} ${line}\n`);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim() !== "") {
        process.stdout.write(`${prefix} ${buffer}\n`);
      }
    });
  }
}

/** 结束子进程树：Windows 用 taskkill /T（vite 还有 esbuild 子进程）；其余用 SIGTERM */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出
    }
  }
}

/** 双子进程编排：任一退出（含 Ctrl+C）→ 停掉另一个 → 同步退出码退出 */
function startChildren() {
  const sharedEnv = { ...process.env };
  const backend = spawn(process.execPath, [BACKEND_DIST_ENTRY], {
    cwd: join(repoRoot, "backend"),
    stdio: ["ignore", "pipe", "pipe"],
    env: sharedEnv,
  });
  const vite = spawn(process.execPath, [VITE_ENTRY], {
    cwd: join(repoRoot, "frontend"),
    stdio: ["ignore", "pipe", "pipe"],
    env: sharedEnv,
  });
  pipeWithPrefix(backend, "[backend]");
  pipeWithPrefix(vite, "[vite]");
  console.log(`[paperteam-dev] backend pid=${backend.pid ?? "?"}，vite pid=${vite.pid ?? "?"}（Ctrl+C 同时退出）`);

  let shuttingDown = false;
  const shutdown = (reason, code) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[paperteam-dev] ${reason}，正在退出…`);
    stopChild(backend);
    stopChild(vite);
    // 给子进程一点时间落地清理，然后退出（避免僵尸 dev 进程）
    setTimeout(() => process.exit(code), 500);
  };

  backend.on("exit", (code, signal) => {
    console.log(`[backend] exited（code=${code ?? "?"} signal=${signal ?? "-"}）`);
    shutdown("backend 退出", code ?? 1);
  });
  vite.on("exit", (code, signal) => {
    console.log(`[vite] exited（code=${code ?? "?"} signal=${signal ?? "-"}）`);
    shutdown("vite 退出", code ?? 1);
  });

  if (process.platform !== "win32") {
    // POSIX：转发信号。Windows：Ctrl+C 事件会送达共享控制台的子进程，
    // 子进程退出再触发上面的 shutdown 兜底。
    process.on("SIGINT", () => shutdown("SIGINT", 0));
    process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  }
}

function main() {
  console.log(`PaperTeam dev（node ${process.versions.node}，Pi in-process Runtime + React Workbench）`);

  const enginesNode = readEnginesNode();
  if (!isSupportedNode(enginesNode)) {
    console.error(
      `[paperteam-dev] Node 版本不满足要求：需要满足 ${enginesNode}` +
        `（Node 26+ 可用），当前 ${process.versions.node}。 请切换 Node 后重试。`,
    );
    process.exit(1);
  }

  // 依赖检查（backend：业务 + Pi SDK；frontend：React/Vite 工具链）
  if (!existsSync(join(repoRoot, "backend", "node_modules", "@earendil-works"))) {
    console.log("[paperteam-dev] backend 依赖缺失，执行 npm install ...");
    runSync("npm", ["install"], join(repoRoot, "backend"));
  }
  if (!existsSync(join(repoRoot, "frontend", "node_modules", "vite"))) {
    console.log("[paperteam-dev] frontend 依赖缺失，执行 npm install ...");
    runSync("npm", ["install"], join(repoRoot, "frontend"));
  }

  // 构建（保证 dist 与 src 一致；tsc 增量很快；frontend 交给 Vite 按需编译）
  runSync("npm", ["run", "build"], join(repoRoot, "backend"));

  startChildren();
}

main();
