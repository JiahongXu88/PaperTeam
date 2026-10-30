#!/usr/bin/env node
/**
 * M15.16 Phase D · B3 — 浏览器级 UI 验收（Chrome DevTools Protocol，真实点击）。
 *
 * 真实性边界：浏览器事件 / HTTP / SSE / React 渲染 / 后端 / 模型全部真实
 * （连到已启动的生产 backend + vite dev）；脚本只做「打开页面 → 点按钮 → 等报告」。
 *
 * 步骤：
 *   1. 打开 /projects/<id>?tab=target（case-R × CJIG，尚未审计）
 *   2. 断言「证据审计（实验性）」空态可见（flag on）
 *   3. 点击「执行证据审计」→ 等真实模型完成（≤8 分钟）
 *   4. 断言逐贡献比较 / 先前工作身份 / 行动清单渲染；截屏存档
 *   5. 复核既有项目：b1（fresh 报告）与 case-R 换稿项目（stale 警示）
 *
 * 用法：node scripts/m1516/ui-acceptance.mjs
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.M1516_UI_BASE ?? "http://127.0.0.1:5173";
const OUT = "D:\\PaperTeamData\\M15\\M15_16\\e2e\\ui";
const UI_PROJECT = readFileSync("D:\\PaperTeamData\\M15\\M15_16\\e2e\\ui-project-id.txt", "utf8").trim();
const IDS = JSON.parse(readFileSync("D:\\PaperTeamData\\M15\\M15_16\\e2e\\project-ids.json", "utf8"));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9333;

const log = (...args) => console.log("[ui-e2e]", ...args);
await mkdir(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=" + join(OUT, "chrome-profile"),
  "--window-size=1440,2400",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 120_000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        if (data.error !== undefined) reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t["type"] === "page");
      if (page !== undefined) return page["webSocketDebuggerUrl"];
    } catch { /* chrome starting */ }
    await sleep(500);
  }
  throw new Error("chrome devtools 未就绪");
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
const send = (method, params) => cdpSend(ws, (msgId += 1), method, params);
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value;
};

async function goto(url) {
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(2500);
}

async function waitFor(selector, timeoutMs, pollMs = 1500) {
  const started = Date.now();
  for (;;) {
    const found = await evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (found === true) return true;
    if (Date.now() - started > timeoutMs) {
      const body = await evaluate("document.body.innerText.slice(0, 500)");
      throw new Error(`等待 ${selector} 超时（${timeoutMs}ms）；页面片段：${String(body).slice(0, 300)}`);
    }
    await sleep(pollMs);
  }
}

async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(OUT, name), Buffer.from(result["data"], "base64"));
  log("screenshot →", name);
}

try {
  // ---- 1-2. 打开 case-R × CJIG 项目（target 面板），断言空态 ----
  await goto(`${BASE_URL}/projects/${UI_PROJECT}?tab=target`);
  await waitFor('[data-testid="target-evidence-audit-empty"]', 30_000);
  log("空态可见（flag on，区块渲染）");

  // ---- 3. 点击「执行证据审计」（真实 POST + 真实模型）----
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="target-evidence-audit-run"]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error("未找到执行按钮");
  log("已点击执行证据审计；等待真实模型完成（≤8 分钟）…");

  await waitFor('[data-testid="target-evidence-audit-contribution"]', 480_000);
  await sleep(1500);
  await screenshot("01-caseR-cjig-audit-report.png");

  // ---- 4. 断言关键内容 ----
  const sectionText = await evaluate(`document.querySelector('[data-testid="target-evidence-audit-section"]').innerText.slice(0, 4000)`);
  const checks = {
    contributionsRendered: await evaluate(`document.querySelectorAll('[data-testid="target-evidence-audit-contribution"]').length`),
    gapPlanRendered: await evaluate(`document.querySelectorAll('[data-testid="target-evidence-audit-gapitem"]').length`),
    guardsLine: await evaluate(`document.querySelector('[data-testid="target-evidence-audit-guards"]')?.innerText ?? null`),
    hasPriorWorkIdentity: /doi:|arXiv:/.test(String(sectionText)),
    hasStatusBadge: /差异可支持|疑似重叠|证据缺口|证据不足/.test(String(sectionText)),
    hasActionSemantics: /可基于现有证据改写|需真实实验\/作者输入/.test(String(sectionText)),
    hasAdvisoryDisclaimer: /不构成任何期刊录用判断/.test(String(sectionText)),
  };
  log("断言：", JSON.stringify(checks));
  await writeFile(join(OUT, "01-section-text.txt"), String(sectionText), "utf8");

  // ---- 5. 复核既有项目：b1 fresh / case-R 换稿 stale ----
  await goto(`${BASE_URL}/projects/${IDS.b1ProjectId}?tab=target`);
  await waitFor('[data-testid="target-evidence-audit-contribution"]', 30_000);
  await sleep(1200);
  const b1Stale = await evaluate(`document.querySelector('[data-testid="target-evidence-audit-stale"]') !== null`);
  await screenshot("02-b1-survey-fresh-report.png");
  log(`b1（survey）报告可见，stale=${b1Stale}`);

  await goto(`${BASE_URL}/projects/${IDS.caseRProjectId}?tab=target`);
  await waitFor('[data-testid="target-evidence-audit-stale"]', 30_000);
  await screenshot("03-caseR-stale-banner.png");
  log("case-R 换稿项目的 stale 警示可见");

  await writeFile(
    join(OUT, "ui-acceptance.json"),
    JSON.stringify({ uiProjectId: UI_PROJECT, checks, b1Stale, finishedAt: new Date().toISOString() }, null, 1),
    "utf8",
  );
  const allPassed = checks.contributionsRendered > 0 && checks.gapPlanRendered > 0
    && checks.hasPriorWorkIdentity && checks.hasStatusBadge && checks.hasActionSemantics && checks.hasAdvisoryDisclaimer
    && b1Stale === false;
  log(allPassed ? "UI 验收全部断言通过" : "UI 验收存在未通过断言（见上）");
} finally {
  ws.close();
  chrome.kill();
}
