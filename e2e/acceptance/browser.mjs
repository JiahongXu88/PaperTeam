#!/usr/bin/env node
/**
 * Claude Browser Acceptance —— acceptance 浏览器生命周期管理（仅开发工具，不进产品代码）。
 *
 * 职责（刻意保持最小，见 docs/BROWSER_ACCEPTANCE.md）：
 *   start   启动一台专用的、隔离 profile 的 Chrome，开 loopback-only 的 CDP 调试端口
 *   status  查看运行状态（pid / port / profile / CDP 是否可达）
 *   stop    只关闭本工具启动的那台 Chrome（校验进程命令行后才 kill），可选 --purge 清 profile
 *
 * 安全约束：
 *   - 独立 user-data-dir（e2e/.tmp/acceptance/profile，gitignored），绝不触碰用户日常 Chrome profile
 *   - 调试端口默认 9222，被占用时自动向后找空闲端口（最多 +10）；只绑 127.0.0.1（Chrome 默认，
 *     我们从不传 --remote-debugging-address）
 *   - stop 前用 Win32_Process CommandLine 校验目标 pid 确实带着我们的 user-data-dir，
 *     pid 被复用成无关进程时拒绝 kill；绝不 taskkill 任何其它 Chrome
 *
 * 浏览器动作本身（click / fill / upload / 截图 / console / network）不在这里：
 *   由 @playwright/mcp connector 通过 --cdp-endpoint 连上来执行（mcp-bridge.mjs 或
 *   重启后 Claude Code 原生 MCP 工具）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const e2eRoot = resolve(here, "..");
export const repoRoot = resolve(e2eRoot, "..");
export const acceptanceDir = resolve(e2eRoot, ".tmp", "acceptance");
export const STATE_FILE = resolve(acceptanceDir, "state.json");
export const PROFILE_DIR = resolve(acceptanceDir, "profile");
export const SHOTS_DIR = resolve(acceptanceDir, "shots");

const DEFAULT_PORT = Number(process.env.PAPERTEAM_ACCEPTANCE_PORT ?? 9222);
const PORT_SPAN = 10;

/** 找本机 Chrome；可用 PAPERTEAM_ACCEPTANCE_CHROME 覆盖（无头 CI 机器可指向其它 Chromium） */
export function findChrome() {
  const override = process.env.PAPERTEAM_ACCEPTANCE_CHROME?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PAPERTEAM_ACCEPTANCE_CHROME 指向的文件不存在：${override}`);
    }
    return override;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : undefined,
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error("未找到本机 Chrome；请设置 PAPERTEAM_ACCEPTANCE_CHROME 指向 chrome.exe");
  }
  return found;
}

/** 127.0.0.1:port 能否建立 TCP 连接（能 = 端口被占） */
export function portInUse(port) {
  return new Promise((settles) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      settles(true);
    });
    socket.once("error", () => settles(false));
  });
}

/** pid 是否存活（Windows 下 EPERM 也代表存活：进程存在但无权限发信号） */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 读某 pid 的完整命令行（PowerShell 单引号避免引号转义问题）；失败返回 null */
export function processCommandLine(pid) {
  const query = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (query.status !== 0) {
    return null;
  }
  return query.stdout.trim() || null;
}

/** 该 pid 是否是「带着我们 user-data-dir 的 Chrome」——kill 前的硬校验 */
export function isOurBrowser(state) {
  if (!pidAlive(state?.pid)) {
    return false;
  }
  const commandLine = processCommandLine(state.pid);
  if (commandLine === null) {
    // 读不到命令线时保守拒绝：宁可让用户手杀，也不错杀无关进程
    return false;
  }
  const normalized = commandLine.toLowerCase().replace(/\//g, "\\");
  return normalized.includes("chrome") && normalized.includes(state.profileDir.toLowerCase().replace(/\//g, "\\"));
}

/** 等待 CDP /json/version 就绪（只在 127.0.0.1 上探测） */
export async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return (await response.json());
      }
    } catch {
      // 尚未就绪，继续轮询
    }
    if (Date.now() > deadline) {
      throw new Error(`CDP 端点 http://127.0.0.1:${port}/json/version 在 ${timeoutMs}ms 内未就绪`);
    }
    await new Promise((sleep) => setTimeout(sleep, 250));
  }
}

export async function cdpUp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export function readState() {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(state) {
  mkdirSync(acceptanceDir, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function clearState() {
  if (existsSync(STATE_FILE)) {
    rmSync(STATE_FILE);
  }
}

async function pickPort(requested) {
  for (let port = requested; port < requested + PORT_SPAN; port += 1) {
    if (!(await portInUse(port))) {
      return port;
    }
  }
  throw new Error(`端口 ${requested}~${requested + PORT_SPAN - 1} 全被占用；可用 --port 或 PAPERTEAM_ACCEPTANCE_PORT 指定其它端口`);
}

export async function start({ port = DEFAULT_PORT, headless = false, chromePath } = {}) {
  mkdirSync(acceptanceDir, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  // 幂等：state 有效且进程确实是我们的浏览器 → 直接复用
  const existing = readState();
  if (existing) {
    if (isOurBrowser(existing) && (await cdpUp(existing.port))) {
      return { started: false, reused: true, state: existing };
    }
    // pid 已死 / pid 被复用成无关进程 / CDP 无响应 → 过期 state，清掉重来
    clearState();
  }

  const executable = chromePath ?? findChrome();
  const chosenPort = await pickPort(port);
  const args = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-session-crashed-bubble",
    "--disable-search-engine-choice-screen",
    "--disable-background-networking",
    "--disable-component-update",
    "--window-size=1440,900",
    "about:blank",
  ];
  if (headless) {
    args.unshift("--headless=new");
  }

  // detached + unref：launcher 退出后浏览器继续存活（生命周期由 state.json 记录，stop 时关闭）
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  child.unref();

  let version;
  try {
    version = await waitForCdp(chosenPort);
  } catch (error) {
    // 端口没起来（极端竞态：选好的端口被抢）→ 只清理我们刚拉起的这个 pid，不碰别人
    if (pidAlive(child.pid)) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    }
    throw error;
  }

  const state = {
    version: 1,
    pid: child.pid,
    port: chosenPort,
    profileDir: PROFILE_DIR,
    chromePath: executable,
    chromeVersion: version?.Browser ?? "unknown",
    headless,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  return { started: true, reused: false, state };
}

export async function stop({ purge = false } = {}) {
  const state = readState();
  if (!state) {
    return { stopped: false, reason: "not-running" };
  }
  if (!pidAlive(state.pid)) {
    clearState();
    return { stopped: false, reason: "stale-state-cleaned" };
  }
  if (!isOurBrowser(state)) {
    // 硬拒绝：pid 活着但不是我们的浏览器（读不到命令线，或 pid 被复用）
    return {
      stopped: false,
      reason: "refused-unverified-pid",
      pid: state.pid,
      hint: `请人工确认 pid ${state.pid} 后处理；本工具只关闭自己启动的 acceptance 浏览器`,
    };
  }
  spawnSync("taskkill", ["/PID", String(state.pid), "/T", "/F"]);
  // 等进程树真正退出（最多 10s），避免留下监听端口的孤儿 renderer
  const deadline = Date.now() + 10_000;
  while (pidAlive(state.pid) && Date.now() < deadline) {
    await new Promise((sleep) => setTimeout(sleep, 200));
  }
  clearState();
  let purged = false;
  if (purge && existsSync(PROFILE_DIR)) {
    // Windows：进程树刚被 kill 后文件句柄释放有延迟，重试几轮再认输
    for (let attempt = 0; attempt < 6 && !purged; attempt += 1) {
      try {
        rmSync(PROFILE_DIR, { recursive: true, force: true });
        purged = true;
      } catch {
        await new Promise((sleep) => setTimeout(sleep, 500));
      }
    }
    if (!purged) {
      return {
        stopped: true,
        pid: state.pid,
        port: state.port,
        purged: false,
        hint: `浏览器已关闭，但 profile 目录仍被占用（${PROFILE_DIR}）；稍后可手动删除`,
      };
    }
  }
  return { stopped: true, pid: state.pid, port: state.port, purged: purge ? purged : undefined };
}

export async function status() {
  const state = readState();
  if (!state) {
    return { running: false, stateFile: STATE_FILE, profileDir: PROFILE_DIR };
  }
  const alive = pidAlive(state.pid);
  const ours = alive && isOurBrowser(state);
  const cdp = ours ? await cdpUp(state.port) : null;
  return {
    running: ours && cdp !== null,
    pid: state.pid,
    pidAlive: alive,
    verifiedOurs: ours,
    cdpEndpoint: `http://127.0.0.1:${state.port}`,
    cdpUp: cdp !== null,
    chromeVersion: state.chromeVersion,
    profileDir: state.profileDir,
    headless: state.headless,
    startedAt: state.startedAt,
    stale: !ours,
  };
}

/** netstat 核验：该端口的所有 LISTENING 都只绑 loopback（selftest 用） */
export function loopbackOnly(port) {
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 15_000 });
  if (netstat.status !== 0) {
    return { ok: false, reason: "netstat-failed", lines: [] };
  }
  const lines = netstat.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0]?.toLowerCase() === "tcp" && parts[3]?.toLowerCase() === "listening")
    .filter((parts) => {
      const local = parts[1] ?? "";
      return local === `127.0.0.1:${port}` || local === `[::1]:${port}` || local === `0.0.0.0:${port}` || local === `[::]:${port}`;
    });
  const offenders = lines.filter((parts) => {
    const local = parts[1] ?? "";
    return local.startsWith("0.0.0.0") || local === `[::]:${port}`;
  });
  return { ok: offenders.length === 0 && lines.length > 0, listeners: lines.map((parts) => parts[1]), offenders: offenders.map((parts) => parts[1]) };
}

// ============================ CLI ============================

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--port") {
      flags.port = Number(argv[++index]);
    } else if (token === "--headless") {
      flags.headless = true;
    } else if (token === "--chrome") {
      flags.chromePath = argv[++index];
    } else if (token === "--purge") {
      flags.purge = true;
    } else {
      positional.push(token);
    }
  }
  return { flags, command: positional[0] };
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const { flags, command } = parseArgs(process.argv.slice(2));
  try {
    if (command === "start") {
      print(await start(flags));
    } else if (command === "status") {
      print(await status());
    } else if (command === "stop") {
      print(await stop(flags));
    } else {
      console.error(`用法：node acceptance/browser.mjs start [--port N] [--headless] | status | stop [--purge]`);
      process.exitCode = 1;
    }
  } catch (error) {
    print({ ok: false, error: String(error?.message ?? error) });
    process.exitCode = 1;
  }
}

// 被 selftest.mjs 以模块方式复用；直接运行时走 CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
