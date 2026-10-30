#!/usr/bin/env node
/**
 * M15.16 — UI 验收复核（无模型调用）：对已存在的审计工件断言行动清单语义
 * 与 advisory 免责声明在真实页面上渲染（首轮 ui-acceptance 的文本采样截断修正）。
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.M1516_UI_BASE ?? "http://127.0.0.1:5173";
const OUT = "D:/PaperTeamData/M15/M15_16/e2e/ui";
const UI_PROJECT = readFileSync("D:/PaperTeamData/M15/M15_16/e2e/ui-project-id.txt", "utf8").trim();
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9334;

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--user-data-dir=" + join(OUT, "chrome-profile2"),
  "--window-size=1440,2400",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        if (data.error !== undefined) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

let wsUrl;
for (let i = 0; i < 30; i += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find((t) => t["type"] === "page");
    if (page !== undefined) {
      wsUrl = page["webSocketDebuggerUrl"];
      break;
    }
  } catch {
    // chrome starting
  }
  await sleep(500);
}
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let msgId = 0;
const evaluate = async (expression) =>
  (await cdpSend(ws, (msgId += 1), "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

try {
  await cdpSend(ws, (msgId += 1), "Page.enable");
  await cdpSend(ws, (msgId += 1), "Page.navigate", { url: `${BASE_URL}/projects/${UI_PROJECT}?tab=target` });
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`document.querySelector('[data-testid="target-evidence-audit-contribution"]') !== null`)) break;
    await sleep(1500);
  }
  const gapText = await evaluate(`document.querySelector('[data-testid="target-evidence-audit-gapplan"]')?.innerText ?? ""`);
  const disclaimer = await evaluate(
    `(() => { const notes = [...document.querySelectorAll('.target-evidence-audit .section-note')]; return notes.map((n) => n.innerText).join("\\n"); })()`,
  );
  const result = {
    gapActionSemantics: gapText.includes("可基于现有证据改写") && gapText.includes("需真实实验/作者输入"),
    authorDecisionNote: gapText.includes("Author Decision"),
    advisoryDisclaimer: disclaimer.includes("不构成任何期刊录用判断"),
  };
  console.log(JSON.stringify(result));
  await writeFile(
    join(OUT, "ui-acceptance-recheck.json"),
    JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 1),
    "utf8",
  );
} finally {
  ws.close();
  chrome.kill();
}
