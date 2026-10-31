#!/usr/bin/env node
/**
 * M15.17 Phase D — 浏览器级 UI 验收（Chrome DevTools Protocol，真实点击）。
 *
 * 前置：e2e-acceptance.mjs 已跑完（acceptance-summary.json 含项目 id）；生产
 * backend（flag on）+ vite dev 前端已启动。脚本只做「打开页面 → 点按钮 → 断言」。
 *
 * 步骤（G5：用户能实际点击完成审计→计划→作者决策→合法修订→报告）：
 *   1. stale 项目（已审计、计划未决策）：点击「制定修改计划」→ 计划列表渲染
 *      → 点击「批准转入」→ 指令状态出现在 UI；
 *   2. case-R 项目：计划已全决策（作者裁决项）+ 复评报告渲染；
 *   3. b1 项目：决策 + 执行后的复评闭环报告（VALIDATED_FIXED / 守卫 / lineage）。
 *
 * 用法：node scripts/m1517/ui-acceptance.mjs
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.M1517_UI_BASE ?? "http://localhost:5177";
const OUT = "D:\\PaperTeamData\\M15\\M15_17\\e2e\\ui";
const SUMMARY = JSON.parse(readFileSync("D:\\PaperTeamData\\M15\\M15_17\\e2e\\acceptance-summary.json", "utf8"));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9337;

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

const checks = {};
const BACKEND = process.env.M1517_UI_API ?? "http://127.0.0.1:3117";
async function api(method, path, body) {
  const response = await fetch(`${BACKEND}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: response.status, body: parsed };
}
async function uploadJson(method, path, pdfPath, extra = {}) {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(pdfPath);
  return api(method, path, {
    fileName: pdfPath.split(/[\\/]/).pop(),
    contentBase64: content.toString("base64"),
    ...extra,
  });
}

// ---- 0. 全新项目（HTTP 准备：导入 + 指南 + 审计）→ 浏览器真实点击 生成计划 → 批准 ----
const freshSetup = await uploadJson("POST", "/api/projects/import-paper", "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples\\case-R.pdf", {
  format: "pdf",
  title: "M15.17 UI 全新点击场景",
  documentType: "journal_article",
  targetVenue: "中国图象图形学报",
  workflowKind: "existing_paper_review",
});
const freshProjectId = freshSetup.body.project.id;
const guidelineJson = JSON.parse(await readFile("D:\\PaperTeamData\\M15\\M15_9\\phase-c\\guideline-artifacts\\cjig.json", "utf8"));
await api("PUT", `/api/projects/${freshProjectId}/target/guideline`, { guideline: guidelineJson });
log("全新项目审计（真实模型 ~3 分钟）…");
const freshAudit = await api("POST", `/api/projects/${freshProjectId}/target/evidence-audit`);
if (freshAudit.status !== 200) throw new Error(`全新项目审计失败: ${freshAudit.status}`);

try {
  // ---- 1. stale 项目：计划区块 + 决策阻断断言 ----
  await goto(`${BASE_URL}/projects/${SUMMARY.projectIds.stale}?tab=target`);
  await waitFor('[data-testid="target-audit-revision-section"]', 30_000);
  const stalePlanBanner = await evaluate(`document.querySelector('[data-testid="target-audit-revision-stale"]') !== null`);
  checks.staleProjectPlanVisible = true;
  checks.staleProjectPlanBlocked = stalePlanBanner;
  await screenshot("01-stale-project-plan-blocked.png");
  log(`stale 项目（已换稿）：计划区块可见，决策阻断=${stalePlanBanner}`);

  // ---- 1b. 全新项目：真实点击 生成计划 → 批准转入 ----
  await goto(`${BASE_URL}/projects/${freshProjectId}?tab=target`);
  await waitFor('[data-testid="target-audit-revision-empty"]', 30_000);
  await evaluate(`document.querySelector('[data-testid="target-audit-revision-generate"]').click()`);
  log("已点击「制定修改计划」；等待生成…");
  await waitFor('[data-testid="target-audit-revision-items"]', 30_000);
  await sleep(800);
  const firstApprove = await evaluate(`(() => {
    const buttons = document.querySelectorAll('[data-testid^="target-audit-revision-approve-"]');
    if (buttons.length === 0) return null;
    buttons[0].click();
    return buttons[0].getAttribute("data-testid");
  })()`);
  if (firstApprove === null) throw new Error("未找到批准按钮（计划应 fresh 且未决策）");
  await waitFor(`[data-testid="target-audit-revision-dispatch-hint"]`, 30_000);
  checks.freshGenerateClick = true;
  checks.freshApproveClick = firstApprove;
  await screenshot("00-fresh-generate-approve.png");
  log(`全新项目：生成 + 批准（${firstApprove}）→ 转入提示可见`);

  // ---- 2. case-R：计划已决策（作者裁决项）+ 复评报告 ----
  await goto(`${BASE_URL}/projects/${SUMMARY.projectIds.caseR}?tab=target`);
  await waitFor('[data-testid="target-audit-revision-items"]', 30_000);
  await sleep(1200);
  const caseRText = String(await evaluate(`document.querySelector('[data-testid="target-audit-revision-section"]').innerText.slice(0, 5000)`));
  checks.caseRPlanDecided = /已批准/.test(caseRText);
  checks.caseRAuthorDecisionItems = /需真实实验 \/ 作者输入/.test(caseRText);
  checks.caseRInstructionsQueued = /已转入意见队列/.test(caseRText);
  // 点击复评（若按钮可用）
  const reassessClicked = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="target-audit-revision-reassess"]');
    if (button === null || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (reassessClicked === true) {
    await waitFor('[data-testid="target-audit-revision-report"]', 30_000);
  }
  checks.caseRReportRendered = await evaluate(`document.querySelector('[data-testid="target-audit-revision-report"]') !== null`);
  await screenshot("02-caseR-plan-authordecision.png");
  log(`case-R：计划决策=${checks.caseRPlanDecided}，作者裁决项=${checks.caseRAuthorDecisionItems}，报告=${checks.caseRReportRendered}`);

  // ---- 3. b1：执行后的闭环报告（VALIDATED_FIXED + lineage + 守卫） ----
  await goto(`${BASE_URL}/projects/${SUMMARY.projectIds.b1}?tab=target`);
  await waitFor('[data-testid="target-audit-revision-section"]', 30_000);
  await sleep(1500);
  const b1PlanText = String(await evaluate(`document.querySelector('[data-testid="target-audit-revision-section"]').innerText.slice(0, 6000)`));
  checks.b1PlanVisible = /审计差距 → 修订计划/.test(b1PlanText);
  checks.b1Decided = /已决策/.test(b1PlanText);
  const b1ReassessClicked = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="target-audit-revision-reassess"]');
    if (button === null || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (b1ReassessClicked === true) {
    await waitFor('[data-testid="target-audit-revision-report"]', 30_000);
    await sleep(1000);
  }
  const b1ReportText = String(await evaluate(`document.querySelector('[data-testid="target-audit-revision-report"]')?.innerText.slice(0, 6000) ?? ""`));
  checks.b1ReportRendered = b1ReportText !== "";
  checks.b1HasValidatedFixed = /已验证解决/.test(b1ReportText);
  checks.b1HasPatchLineage = /patch/.test(b1ReportText);
  checks.b1HasGuards = /守卫/.test(b1ReportText);
  checks.b1HasDisclaimer = /不构成期刊录用判断/.test(b1ReportText);
  await screenshot("03-b1-closure-report.png");
  log(`b1：报告=${checks.b1ReportRendered}，VALIDATED_FIXED=${checks.b1HasValidatedFixed}，lineage=${checks.b1HasPatchLineage}`);

  await writeFile(
    join(OUT, "ui-acceptance.json"),
    JSON.stringify({ checks, freshProjectId, finishedAt: new Date().toISOString() }, null, 1),
    "utf8",
  );
  const allPassed = checks.staleProjectPlanBlocked === true && checks.freshGenerateClick && checks.caseRPlanDecided
    && checks.caseRAuthorDecisionItems && checks.caseRReportRendered && checks.b1ReportRendered && checks.b1HasDisclaimer;
  log(allPassed ? "UI 验收关键断言通过" : "UI 验收存在未通过断言（见上）");
  if (!allPassed) process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
}
