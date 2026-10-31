#!/usr/bin/env node
/**
 * M15.18 Phase D — 浏览器真实点击作者决策（Chrome DevTools Protocol，headless）。
 *
 * 只做用户会做的事：打开项目 Target 页 → 看到计划条目 → 逐项点击「批准」/「不采纳」→
 * 等待 UI 反映决策 → 截图 + DOM innerText 留证。决策是**隔离测试项目上的代理测试性批准**
 *（任务书授权；日志明确标注），不涉及任何真实用户生产项目。
 *
 * 也用于收尾阶段：点击「复评闭环」并留存报告区块 innerText（--mode report）。
 *
 * 用法：node scripts/m1518/ui-decide.mjs --project <id> [--mode decide|report]
 *       [--ui http://localhost:5178] [--api http://127.0.0.1:3118] [--out <dir>] [--reject ta-gap-3,...]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const PROJECT = arg("project");
const MODE = arg("mode", "decide");
const UI = arg("ui", "http://localhost:5178").replace(/\/$/, "");
const API = arg("api", "http://127.0.0.1:3118").replace(/\/$/, "");
const OUT = arg("out", "D:\\PaperTeamData\\M15\\M15_18\\e2e\\ui");
const REJECT = new Set((arg("reject", "") ?? "").split(",").filter(Boolean));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = Number(arg("port", "9338"));
if (PROJECT === undefined) throw new Error("--project 必填");

const log = (...parts) => console.log("[m1518-ui]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${join(OUT, "chrome-profile")}`, "--window-size=1440,2600", "about:blank",
], { stdio: "ignore" });

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error("chrome devtools 未就绪");
}
const ws = new WebSocket(await wsUrl());
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
function send(method, params = {}) {
  const id = (nextId += 1);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 120_000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (data.error !== undefined) reject(new Error(JSON.stringify(data.error))); else resolve(data.result);
    };
    ws.addEventListener("message", onMessage);
  });
}
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
async function waitFor(selector, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    if ((await evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)) === true) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${selector} 超时；页面：${String(await evaluate("document.body.innerText.slice(0,400)"))}`);
    await sleep(1000);
  }
}
async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(OUT, name), Buffer.from(result.data, "base64"));
  log("screenshot →", name);
}

const record = { project: PROJECT, mode: MODE, startedAt: new Date().toISOString(), operator: "Claude Code（M15.18 验收代理；隔离测试项目上的代理测试性决策）", clicks: [] };
try {
  await send("Page.enable");
  await send("Page.navigate", { url: `${UI}/projects/${PROJECT}?tab=target` });
  await waitFor('[data-testid="target-audit-revision-section"]');
  await sleep(1500);
  if (MODE === "decide") {
    await waitFor('[data-testid="target-audit-revision-items"]');
    await screenshot(`${PROJECT}-10-plan-before-decision.png`);
    const itemIds = await evaluate(`[...document.querySelectorAll('[data-testid^="target-audit-revision-approve-"]')].map((b) => b.getAttribute("data-testid").replace("target-audit-revision-approve-", ""))`);
    if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error("未找到可决策条目（计划应 fresh 且未决策）");
    for (const itemId of itemIds) {
      const action = REJECT.has(itemId) ? "reject" : "approve";
      const testId = `target-audit-revision-${action}-${itemId}`;
      const clicked = await evaluate(`(() => { const b = document.querySelector('[data-testid="${testId}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
      record.clicks.push({ itemId, action, clicked, at: new Date().toISOString() });
      log(`点击 ${testId} → ${clicked}`);
      if (clicked !== true) throw new Error(`按钮不可点击：${testId}`);
      // 等待该条目的决策按钮消失（UI 已反映决策）
      const started = Date.now();
      while ((await evaluate(`document.querySelector('[data-testid="${testId}"]') !== null`)) === true) {
        if (Date.now() - started > 30_000) throw new Error(`决策未在 UI 生效：${itemId}`);
        await sleep(600);
      }
      await sleep(500);
    }
    await sleep(1500);
    record.sectionText = String(await evaluate(`document.querySelector('[data-testid="target-audit-revision-section"]').innerText`)).slice(0, 12_000);
    await screenshot(`${PROJECT}-11-plan-after-decision.png`);
    const plan = await (await fetch(`${API}/api/projects/${PROJECT}/target/evidence-audit/revision-plan`)).json();
    record.backendPlanStatus = plan.plan?.plan?.status ?? null;
    record.backendDecisions = (plan.plan?.plan?.items ?? []).map((item) => ({ itemId: item.itemId, decision: item.authorDecision?.decision ?? null, instructionId: item.instructionId ?? null }));
  } else {
    const clicked = await evaluate(`(() => { const b = document.querySelector('[data-testid="target-audit-revision-reassess"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    record.clicks.push({ action: "reassess", clicked, at: new Date().toISOString() });
    if (clicked === true) await waitFor('[data-testid="target-audit-revision-report"]');
    await sleep(1500);
    record.reportText = String(await evaluate(`document.querySelector('[data-testid="target-audit-revision-report"]')?.innerText ?? ""`)).slice(0, 12_000);
    const generated = await evaluate(`(() => { const b = document.querySelector('[data-testid="target-readiness-generate"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    record.clicks.push({ action: "generate-readiness", clicked: generated, at: new Date().toISOString() });
    if (generated === true) await waitFor('[data-testid="target-readiness-report"]');
    await sleep(800);
    record.downloadHref = await evaluate(`document.querySelector('[data-testid="target-readiness-download"]')?.getAttribute("href") ?? null`);
    record.readinessText = String(await evaluate(`document.querySelector('[data-testid="target-readiness-report"]')?.innerText ?? ""`)).slice(0, 12_000);
    await screenshot(`${PROJECT}-20-closure-report.png`);
  }
  record.finishedAt = new Date().toISOString();
  await writeFile(join(OUT, `${PROJECT}-ui-${MODE}.json`), JSON.stringify(record, null, 1), "utf8");
  log("完成", JSON.stringify(record.clicks));
} finally {
  ws.close();
  chrome.kill();
}
