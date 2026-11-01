#!/usr/bin/env node
/**
 * M15 长程 E2 真实运行驱动（只按 D:\PaperTeamData\M15\LongRunClosure\E\PROTOCOL.md §3 决策 HITL）。
 * 用法：node scripts/m15-longrun/drive-real-run.mjs --base http://127.0.0.1:3121 --pdf <pdf> --out <dir>
 * 不读写模型凭据；只经本机 HTTP API。plan_confirm 不勾选任何结构化值变更；不批准任何数值修改请求。
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const BASE = arg("base", "http://127.0.0.1:3121");
const PDF = arg("pdf");
const OUT = arg("out");
const log = async (line) => {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  await appendFile(join(OUT, "drive.log"), `${entry}\n`, "utf8");
};
const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, body: json };
};

const pdf = await readFile(PDF);
const imported = await api("POST", "/api/projects/import-pdf", { fileName: "attention.pdf", contentBase64: pdf.toString("base64"), goal: "improvement" });
if (imported.status !== 201) throw new Error(`import failed ${imported.status} ${JSON.stringify(imported.body).slice(0, 400)}`);
const projectId = imported.body.project.id;
await log(`imported project=${projectId}`);
const started = await api("POST", `/api/projects/${projectId}/workflows`, { kind: "existing_paper_improvement" });
if (started.status >= 300) throw new Error(`start failed ${started.status} ${JSON.stringify(started.body).slice(0, 400)}`);
const runId = started.body.runId;
await log(`started run=${runId}`);
await writeFile(join(OUT, "run-ids.json"), JSON.stringify({ projectId, runId }, null, 2));

const DECISIONS = { "hitl.research_plan": "approve", "hitl.evidence_supply": "continue", "hitl.revision_overflow": "accept_draft", "hitl.revision_stalled": "accept_draft" };
let lastStage = "";
const deadline = Date.now() + 3 * 3600_000;
for (;;) {
  const { body } = await api("GET", `/api/runs/${runId}`);
  const run = body.run;
  if (run.currentStage !== lastStage) {
    lastStage = run.currentStage;
    await log(`stage=${run.currentStage} status=${run.status}`);
  }
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    await log(`terminal status=${run.status} label=${run.completion?.label ?? "-"} error=${run.error?.message?.slice(0, 300) ?? "-"}`);
    break;
  }
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId;
    let decision = DECISIONS[stageId];
    let payload;
    if (stageId === "hitl.plan_confirm") {
      // M15.20 P0 批准绑定：回传计划哈希 + 令牌；approvedFactChanges 为空（不授权任何数值变更）
      const awaitingPayload = run.awaiting?.payload ?? {};
      const contracts = awaitingPayload.editContracts ?? awaitingPayload.contracts ?? {};
      payload = {
        ...(contracts.planHash !== undefined ? { planHash: contracts.planHash } : awaitingPayload.planHash !== undefined ? { planHash: awaitingPayload.planHash } : {}),
        ...(contracts.approvalToken !== undefined ? { approvalToken: contracts.approvalToken } : awaitingPayload.approvalToken !== undefined ? { approvalToken: awaitingPayload.approvalToken } : {}),
        approvedFactChanges: [],
        acknowledgedNotices: true,
        acknowledgedUndispatched: true,
      };
      decision = "approve";
      await writeFile(join(OUT, "plan-confirm-payload.json"), JSON.stringify(awaitingPayload, null, 2));
    }
    if (decision === undefined) {
      await log(`STOP: 未在协议中的 HITL ${stageId}（不擅自决策）`);
      break;
    }
    const resumed = await api("POST", `/api/runs/${runId}/resume`, { decision, ...(payload !== undefined ? { payload } : {}) });
    await log(`resume ${stageId} → ${decision} status=${resumed.status}${resumed.status >= 300 ? ` ${JSON.stringify(resumed.body).slice(0, 300)}` : ""}`);
    if (resumed.status >= 300) break;
  }
  if (Date.now() > deadline) {
    await log("STOP: 3h 墙钟上限");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
