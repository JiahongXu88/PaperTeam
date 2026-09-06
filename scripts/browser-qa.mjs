#!/usr/bin/env node
/**
 * Browser QA driver（Project Entry & Lifecycle UX 2026-09）。
 *
 * 用 Chrome DevTools Protocol 直接驱动本机 Chrome（无 playwright 依赖）：
 * 导航 / 视口尺寸 / DOM 断言 / 截图 / 文件上传。截图写入 .qa-shots/。
 * 用法：node scripts/browser-qa.mjs <baseUrl>
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:5173";
const SHOTS = resolve(".qa-shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9333;

const shotState = { index: 0 };
const failures = [];

await mkdir(SHOTS, { recursive: true });

// ---------- 启动 Chrome ----------
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=" + resolve(".qa-chrome-profile"),
  "about:blank",
], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 等待 DevTools endpoint 就绪
async function waitForEndpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error("Chrome DevTools endpoint 未就绪");
}
await waitForEndpoint();

// ---------- CDP 连接 ----------
let ws;
let msgId = 0;
const pending = new Map();

function connect(url) {
  return new Promise((resolveConn, rejectConn) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolveConn(socket));
    socket.addEventListener("error", (e) => rejectConn(new Error("ws error: " + e.message)));
  });
}

async function send(method, params = {}, sessionId) {
  msgId += 1;
  const id = msgId;
  const message = { id, method, params };
  if (sessionId !== undefined) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`CDP timeout: ${method}`));
      }
    }, 30_000);
  });
}

const versionResponse = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
const versionInfo = await versionResponse.json();
ws = await connect(versionInfo.webSocketDebuggerUrl);

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(`${msg.error.message} (${msg.method ?? ""})`));
    else res(msg.result);
  }
});

// 新建 target（页面）
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("DOM.enable", {}, sessionId);

// ---------- 帮助函数 ----------
async function setViewport(width, height) {
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
}

async function navigate(path) {
  await send("Page.navigate", { url: BASE + path }, sessionId);
  await wait(1200);
}

async function evalJs(expression) {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error("eval 异常: " + JSON.stringify(result.exceptionDetails).slice(0, 400));
  }
  return result.result?.value;
}

async function waitForJs(expression, timeoutMs = 10000, label = expression) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = (await evalJs(`Boolean((${expression}))`)) === true;
    } catch {}
    if (ok) return true;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时: ${label}`);
    }
    await wait(250);
  }
}

async function shot(name) {
  shotState.index += 1;
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const file = join(SHOTS, `${String(shotState.index).padStart(2, "0")}-${name}.png`);
  await writeFile(file, Buffer.from(data, "base64"));
  console.log(`  📸 ${file}`);
}

function check(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures.push(name);
  }
}

/** 点击（真实事件，经 CDP） */
async function click(expression) {
  const message = JSON.stringify(`element not found: ${expression}`);
  await evalJs(`(() => { const el = (${expression}); if (!el) throw new Error(${message}); el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
  await wait(350);
}

/** 文件上传：DOM.setFileInputFiles */
async function uploadFile(selector, filePaths) {
  const { root } = await send("DOM.getDocument", {}, sessionId);
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector }, sessionId);
  if (!nodeId) throw new Error("upload: input 未找到 " + selector);
  await send("DOM.setFileInputFiles", { files: filePaths, nodeId }, sessionId);
  await wait(800);
}

async function type(selector, text) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp" }, sessionId);
  }
  await wait(200);
}

export const cdp = {
  setViewport, navigate, evalJs, waitForJs, shot, check, click, uploadFile, type,
  close: async () => {
    try { await send("Target.closeTarget", { targetId }); } catch {}
    try { ws.close(); } catch {}
    chrome.kill();
    await wait(300);
  },
  failures: () => failures,
};

// 直接运行时执行 QA 脚本
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const { runQa } = await import("./browser-qa-paths.mjs");
  try {
    await runQa(cdp);
  } finally {
    await cdp.close();
  }
  if (failures.length > 0) {
    console.error(`\nQA 失败 ${failures.length} 项:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nBrowser QA 全部通过。");
}
