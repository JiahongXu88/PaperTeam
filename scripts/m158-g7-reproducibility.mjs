#!/usr/bin/env node
/**
 * M15.8 G7 — P 冻结产物的确定性 Gate + Finalize 复跑对照（零模型）。
 *
 * 语义（预登记 §4/G7）：同一份冻结 artifact（P 项目逐字节副本）上，
 *  - POST /quality-gate（manual 双入口，与 workflow stage 共用 evaluateProjectQualityGate）
 *    重新评估同一轮 → 与 run 内产出的 gate 规则逐条比对（status/detail/reason 全等；
 *    checkedAt 除外）；
 *  - POST /build + POST /finalize → Final 再次真实产出；
 *  - Final PDF sha256 与 P 原 Final 比对（LaTeX 时间戳可能引入字节差——如实报告，
 *    源级一致性以 gate + manuscript sha 为准）。
 *
 * 用法：node scripts/m158-g7-reproducibility.mjs
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
const G7_ROOT = join(DATA_ROOT, "projects-root-g7");

const pReport = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-report.json"), "utf8"));
const SOURCE_PROJECT = pReport.projectId;
if (pReport.finalStatus !== "completed" || pReport.gatePassed !== true) {
  console.error("[refuse] P 未通过（G7 对照只针对正向通过稿）");
  process.exit(2);
}

process.env["PROJECTS_ROOT"] = G7_ROOT;
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, "budget-ledger-g7.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1"; // 硬顶 1：本脚本必须零模型（防意外）
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

await mkdir(G7_ROOT, { recursive: true });
const REPORT_PATH = join(EVAL_DIR, "m158-g7-report.json");

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const { createTopicSurveyDefinition } = await import(distUrl("workflow", "definitions.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8 G7 (must stay 0)",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: G7_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: () => [],
  log: () => {},
});
const projects = new ProjectStore({ root: G7_ROOT });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: () => {},
});
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => createTopicSurveyDefinition(stack.workflowServices),
  log: () => {},
});
const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
}

const projectDir = join(G7_ROOT, SOURCE_PROJECT);
await cp(join(P_ROOT, SOURCE_PROJECT), projectDir, { recursive: true, force: true });

// 取消既有 run 记录避免互斥（副本上的 stale run 状态会被恢复为活跃——m113 同款坑）
const runs = await request("GET", `/runs?projectId=${SOURCE_PROJECT}`);
for (const orphan of runs.body["runs"] ?? []) {
  if (["running", "pending", "awaiting_input"].includes(orphan.status)) {
    await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
  }
}

const safeReadJson = async (rel) => {
  try { return JSON.parse(await readFile(join(projectDir, rel), "utf8")); } catch { return null; }
};
const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

// 1) in-run gate（P 原产物，复制过来）
const gateFiles = (await readdir(join(projectDir, "reviews"))).filter((f) => /^quality-gate-r\d+\.json$/.test(f)).sort();
const inRunGate = gateFiles.length > 0 ? await safeReadJson(`reviews/${gateFiles[gateFiles.length - 1]}`) : null;
if (inRunGate === null) throw new Error("副本内无 in-run gate 产物");

// 2) manual 双入口重评（同轮覆盖）
const gateRes = await request("POST", `/projects/${SOURCE_PROJECT}/quality-gate`);
if (gateRes.status !== 200) throw new Error(`quality-gate 重评失败：${gateRes.status} ${JSON.stringify(gateRes.body).slice(0, 300)}`);
const manualGate = gateRes.body;

// 3) 规则逐条对照
const inRunRules = (inRunGate.gate?.rules ?? []).map((r) => ({ rule: r.rule, status: r.status ?? String(r.passed), detail: r.detail }));
const manualRules = (manualGate.gate?.rules ?? []).map((r) => ({ rule: r.rule, status: r.status ?? String(r.passed), detail: r.detail }));
const ruleDiff = [];
for (let i = 0; i < Math.max(inRunRules.length, manualRules.length); i += 1) {
  const a = inRunRules[i];
  const b = manualRules[i];
  if (a?.rule !== b?.rule || a?.status !== b?.status || a?.detail !== b?.detail) {
    ruleDiff.push({ index: i, inRun: a, manual: b });
  }
}

// 4) build + finalize
const buildRes = await request("POST", `/projects/${SOURCE_PROJECT}/build`);
const finalizeRes = await request("POST", `/projects/${SOURCE_PROJECT}/finalize`);

// 5) Final PDF 对照
const collectPdfs = async (root) => {
  const out = {};
  try {
    for (const f of await readdir(root, { recursive: true })) {
      if (String(f).endsWith(".pdf")) out[String(f)] = await sha256File(join(root, String(f)));
    }
  } catch { /* none */ }
  return out;
};
const pPdfs = await collectPdfs(join(P_ROOT, SOURCE_PROJECT, "artifacts"));
const g7Pdfs = await collectPdfs(join(projectDir, "artifacts"));

const report = {
  schema: "m158-g7-report/v1",
  sourceProject: SOURCE_PROJECT,
  gateRoundInRun: inRunGate.round ?? null,
  inRunPassed: inRunGate.gate?.passed ?? null,
  manualPassed: manualGate.gate?.passed ?? null,
  rulesIdentical: ruleDiff.length === 0,
  ruleDiff,
  buildStatus: buildRes.status,
  finalizeStatus: finalizeRes.status,
  finalizeBody: finalizeRes.body ?? null,
  pdfsOriginal: pPdfs,
  pdfsRepro: g7Pdfs,
  pdfByteIdentical: JSON.stringify(pPdfs) === JSON.stringify(g7Pdfs),
};
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
console.log(`DONE G7: rulesIdentical=${report.rulesIdentical} manualPassed=${report.manualPassed} finalize=${report.finalizeStatus} pdfByteIdentical=${report.pdfByteIdentical}`);
server.close();
process.exit(report.rulesIdentical && report.manualPassed === true && report.finalizeStatus === 200 ? 0 : 5);
