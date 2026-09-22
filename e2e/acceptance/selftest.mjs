#!/usr/bin/env node
/**
 * Claude Browser Acceptance —— launcher 自测（§开发工具测试，不进产品代码）。
 *
 * 覆盖 docs/BROWSER_ACCEPTANCE.md 承诺的生命周期行为：
 *   1. start（复用既有 profile 目录）→ state 写入 + CDP 就绪
 *   2. 重复 start → 幂等复用同一 pid
 *   3. CDP 只监听 loopback（netstat 核验无 0.0.0.0 / [::]）
 *   4. status → running 且字段齐全
 *   5. 端口被占 → 自动向后找空闲端口，且不杀占用者
 *   6. stop 拒绝杀「state 指向但命令行不含我们 profile」的无关进程
 *   7. stale pid → start 清理过期 state 后正常启动
 *   8. stop → 进程树退出、state 删除；--purge 顺带清 profile
 *   9. bridge 冒烟：--list 与一次 browser_navigate 工具调用
 *
 * 直接运行：node acceptance/selftest.mjs（会真实拉起/关闭一台隔离 Chrome，约 1 分钟）
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROFILE_DIR,
  STATE_FILE,
  cdpUp,
  clearState,
  loopbackOnly,
  pidAlive,
  readState,
  start,
  status,
  stop,
} from "./browser.mjs";

const results = [];

function report(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function assert(name, condition, detail = "") {
  report(name, Boolean(condition), detail);
  if (!condition) {
    process.exitCode = 1;
  }
}

/** 找一个空闲端口并占住（模拟端口被无关进程占用） */
function squatPort() {
  return new Promise((fulfill) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      fulfill({ server, port: server.address().port });
    });
  });
}

async function main() {
  // 前置清理：不管上次留下什么，先归零
  await stop({ purge: true }).catch(() => {});
  clearState();

  // 1 + 复用既有 profile（stale profile 场景）：先造出 profile 目录再启动
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(`${PROFILE_DIR.replace(/\\/g, "/")}/.stale-marker`, "leftover", "utf8");

  const first = await start();
  assert("start 启动成功并写入 state", first.started && existsSync(STATE_FILE) && first.state.pid > 0);
  const version = await cdpUp(first.state.port);
  assert("CDP /json/version 就绪", version !== null && /Chrome/i.test(version.Browser ?? ""), version?.Browser);

  // 2 重复 start 幂等
  const again = await start();
  assert("重复 start 幂等复用同一 pid", !again.started && again.reused && again.state.pid === first.state.pid);

  // 3 loopback-only
  const binding = loopbackOnly(first.state.port);
  assert("CDP 仅监听 loopback", binding.ok, `listeners=${binding.listeners.join(",")} offenders=${binding.offenders.join(",")}`);

  // 4 status
  const stateNow = await status();
  assert("status 报告 running 且含 pid/port/profile", stateNow.running === true && stateNow.pid === first.state.pid && stateNow.cdpEndpoint === `http://127.0.0.1:${first.state.port}`);

  // 5 端口被占 → 向后找空闲端口（占用者是我们自己的 listener，不许被动到）
  await stop();
  const { server, port } = await squatPort();
  const fallback = await start({ port });
  const squatterAlive = server.listening;
  assert("端口被占时自动换端口", fallback.started && fallback.state.port !== port && fallback.state.port > port && fallback.state.port <= port + 10, `请求 ${port} → 实际 ${fallback.state.port}`);
  assert("不杀端口占用者", squatterAlive && (await cdpUp(fallback.state.port)) !== null);
  server.close();
  await stop();

  // 6 stop 拒绝杀无关进程（state 指向一个无关的 node 进程）
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
  writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ version: 1, pid: dummy.pid, port: 0, profileDir: PROFILE_DIR }, null, 2)}\n`,
    "utf8",
  );
  const refusal = await stop();
  assert("stop 拒绝杀命令行不含我们 profile 的进程", refusal.stopped === false && refusal.reason === "refused-unverified-pid");
  assert("无关进程仍存活", pidAlive(dummy.pid));
  dummy.kill();
  clearState();

  // 7 stale pid → start 自愈
  writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ version: 1, pid: 4194303, port: 9222, profileDir: PROFILE_DIR }, null, 2)}\n`,
    "utf8",
  );
  const revived = await start();
  const revivedCdp = await cdpUp(revived.state.port);
  assert("stale pid 的 state 被 start 清理并正常启动", revived.started && revived.state.pid !== 4194303 && revivedCdp !== null);
  await stop();

  // 8 stop --purge
  const last = await start();
  const lastPid = last.state.pid;
  const purged = await stop({ purge: true });
  await new Promise((sleep) => setTimeout(sleep, 300));
  assert("stop 关闭浏览器进程树", purged.stopped && !pidAlive(lastPid));
  assert("stop 删除 state", !existsSync(STATE_FILE));
  assert("--purge 清空 profile 目录", !existsSync(PROFILE_DIR));

  // 9 bridge 冒烟：--list 与一次真实工具调用（证明 connector 能连上 launcher 的浏览器）
  const forBridge = await start();
  const bridgePath = join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.mjs");
  const listed = spawnSync(process.execPath, [bridgePath, "--list"], { encoding: "utf8", timeout: 90_000 });
  assert("bridge --list 列出 connector 工具", listed.status === 0 && listed.stdout.includes("browser_navigate"), listed.stdout.split("\n")[0] ?? "");
  const navigated = spawnSync(
    process.execPath,
    [bridgePath, "--call", "browser_navigate", "--args", JSON.stringify({ url: "about:blank" })],
    { encoding: "utf8", timeout: 90_000 },
  );
  assert(
    "bridge browser_navigate 工具调用成功",
    navigated.status === 0 && navigated.stdout.length > 0,
    (navigated.stderr || navigated.stdout).split("\n")[0] ?? "",
  );
  await stop({ purge: true });

  console.log(`\n${results.filter((item) => item.ok).length}/${results.length} 通过`);
}

await main();
