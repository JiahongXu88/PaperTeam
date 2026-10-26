#!/usr/bin/env node
/**
 * M15.8 阶段 E — N 场景：真实负例（同族隔离破坏）E2E 驱动。
 *
 * 语义（预登记 §3.N）：
 *  - 基底 = P 冻结通过后的项目（逐字节副本到隔离 PROJECTS_ROOT）；
 *  - N1（CE1 型）：摘要/结论侧数值 ↔ 表格唯一绑定值确定性矛盾（同量纲同指标）；
 *  - N2（CE2 型）：references.bib 重命名一个被引 key（正文 \cite 不动）；
 *  - 执行：真实 orchestrator run（topic_survey，front 幂等复用，尾部因改稿
 *    新鲜度强制重走 citation.verify → review.run → quality.gate）；
 *  - 断言：gate FAIL、Finalize 拒绝、阻断规则指向注入缺陷；逐字节变异 manifest
 *    （before/after sha256 + 精确 offset）。
 *
 * 用法：node scripts/m158-n-negative-e2e.mjs --case n1|n2 [--dry-run]
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
const N_ROOT = join(DATA_ROOT, "projects-root-negative");
const SESSION_MAX_CALLS = Number(process.env["M158_SESSION_MAX_CALLS_N"] ?? "14");

const args = process.argv.slice(2);
const caseId = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const dryRun = args.includes("--dry-run");
if (caseId !== "n1" && caseId !== "n2") {
  console.error("用法：--case n1|n2 [--dry-run]");
  process.exit(2);
}

const pReportPath = join(EVAL_DIR, "m158-p-report.json");
if (!existsSync(pReportPath)) {
  console.error(`[refuse] P 报告不存在 ${pReportPath}（先完成 P）`);
  process.exit(2);
}
const pReport = JSON.parse(await readFile(pReportPath, "utf8"));
const SOURCE_PROJECT = pReport.projectId;
if (SOURCE_PROJECT === undefined || pReport.finalStatus !== "completed") {
  console.error(`[refuse] P 未完成（finalStatus=${pReport.finalStatus}）——N 只针对通过后的冻结稿`);
  process.exit(2);
}

process.env["PROJECTS_ROOT"] = N_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, `budget-ledger-${caseId}.json`);
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(SESSION_MAX_CALLS);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
// 负例：不进入自动修订循环（验证阻断与 Finalize 拒绝；修订闭环由 P 已实证）
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "0";

await mkdir(N_ROOT, { recursive: true });
const DRIVER_LOG = join(EVAL_DIR, `m158-${caseId}-driver-log.txt`);
const REPORT_PATH = join(EVAL_DIR, `m158-${caseId}-report.json`);
const MUTATION_PATH = join(EVAL_DIR, `m158-${caseId}-mutation.json`);

async function appendDriverLog(line) {
  await writeFile(DRIVER_LOG, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
}
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

// ---- 变异引擎（确定性；双向 sha256 manifest）----

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** N1：找「摘要/结论文本数值 ↔ 表格数值」可翻转对。实现：在正文 tex 中找一个
 *  出现恰好 2 次的小数（一次在表内、一次在表外文本），把表外那次改掉一位。 */
async function mutateN1(projectDir) {
  const msDir = join(projectDir, "manuscript");
  const sectionsDir = join(msDir, "sections");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(sectionsDir)).filter((f) => f.endsWith(".tex"));
  const tableRe = /(?:\\begin\{tabular\}|\\toprule|\\midrule)/;
  const candidates = [];
  for (const f of files) {
    const raw = await readFile(join(sectionsDir, f), "utf8");
    for (const match of raw.matchAll(/(\d{1,3}\.\d{1,3})/g)) {
      const value = match[1];
      const occurrences = raw.split(value).length - 1;
      if (occurrences === 2) {
        const firstIdx = raw.indexOf(value);
        const secondIdx = raw.indexOf(value, firstIdx + 1);
        const inTable = (idx) => tableRe.test(raw.slice(Math.max(0, idx - 3000), idx)) && raw.slice(idx, idx + 3000).split(/\\end\{tabular\}/)[0].includes("\\\\");
        // 简化判定：第二次出现若其前后 200 字符内含表格行分隔符 → 表内；翻转表外那次
        const ctx = (idx) => raw.slice(Math.max(0, idx - 200), idx + 200);
        const secondIsTable = /\\\\/.test(ctx(secondIdx)) || /&/.test(ctx(secondIdx));
        const firstIsTable = /\\\\/.test(ctx(firstIdx)) || /&/.test(ctx(firstIdx));
        const targetIdx = firstIsTable && !secondIsTable ? secondIdx : !firstIsTable && secondIsTable ? firstIdx : -1;
        if (targetIdx >= 0) {
          candidates.push({ file: join("sections", f), value, index: targetIdx });
        }
      }
    }
  }
  if (candidates.length === 0) return { ok: false, reason: "no-two-occurrence numeric pair found" };
  candidates.sort((a, b) => a.value.length - b.value.length); // 取最短（最像指标值）
  const target = candidates[0];
  // 翻转最后一位数字（保持长度与格式；确定性）
  const digits = target.value;
  const lastDigit = digits[digits.length - 1];
  const flipped = lastDigit === "9" ? "8" : String(Number(lastDigit) + 1);
  const mutatedValue = digits.slice(0, -1) + flipped;
  const absPath = join(msDir, target.file);
  const before = await readFile(absPath, "utf8");
  const after = before.slice(0, target.index) + mutatedValue + before.slice(target.index + digits.length);
  if (sha256(before) === sha256(after)) return { ok: false, reason: "mutation produced identical bytes" };
  await writeFile(absPath, after, "utf8");
  return {
    ok: true,
    kind: "n1-numeric-contradiction",
    file: `manuscript/${target.file.replaceAll("\\", "/")}`,
    originalValue: digits,
    mutatedValue,
    offset: target.index,
    beforeSha256: sha256(before),
    afterSha256: sha256(after),
  };
}

/** N2：references.bib 重命名第一个被正文 \cite 的 key。 */
async function mutateN2(projectDir) {
  const msDir = join(projectDir, "manuscript");
  const { readdir } = await import("node:fs/promises");
  const bibPath = join(msDir, "references.bib");
  const sectionsDir = join(msDir, "sections");
  if (!existsSync(bibPath)) return { ok: false, reason: "references.bib missing" };
  const bib = await readFile(bibPath, "utf8");
  const cited = new Set();
  for (const f of (await readdir(sectionsDir)).filter((x) => x.endsWith(".tex"))) {
    const raw = await readFile(join(sectionsDir, f), "utf8");
    for (const m of raw.matchAll(/\\cite[tp]?\{([^}]*)\}/g)) {
      for (const key of m[1].split(",")) cited.add(key.trim());
    }
  }
  const entries = [...bib.matchAll(/@\w+\{([^,\s]+),/g)].map((m) => ({ key: m[1], index: m.index }));
  const target = entries.find((e) => cited.has(e.key));
  if (target === undefined) return { ok: false, reason: "no cited bib entry found" };
  const mutatedKey = `${target.key}x`;
  const after = bib.slice(0, target.index) + bib.slice(target.index).replace(`{${target.key},`, `{${mutatedKey},`, 1);
  if (after === bib) return { ok: false, reason: "bib mutation no-op" };
  await writeFile(bibPath, after, "utf8");
  return {
    ok: true,
    kind: "n2-citation-key-corruption",
    file: "manuscript/references.bib",
    originalKey: target.key,
    mutatedKey,
    offset: target.index,
    beforeSha256: sha256(bib),
    afterSha256: sha256(after),
  };
}

// ---- dry-run：只执行变异引擎自检（对临时副本），不装配服务 ----
if (dryRun) {
  const tmpDir = join(N_ROOT, "_dry");
  await cp(join(P_ROOT, SOURCE_PROJECT), tmpDir, { recursive: true, force: true });
  const result = caseId === "n1" ? await mutateN1(tmpDir) : await mutateN2(tmpDir);
  const cp2 = join(N_ROOT, "_dry2");
  await cp(join(P_ROOT, SOURCE_PROJECT), cp2, { recursive: true, force: true });
  const result2 = caseId === "n1" ? await mutateN1(cp2) : await mutateN2(cp2);
  const deterministic = JSON.stringify(result) === JSON.stringify(result2);
  console.log(`[dry-run] ${caseId} mutation ok=${result.ok} deterministic=${deterministic} detail=${JSON.stringify(result).slice(0, 220)}`);
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
  await rm(cp2, { recursive: true, force: true });
  process.exit(result.ok && deterministic ? 0 : 3);
}

// ---- 装配（同 P；topic_survey）----

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
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: `M15.8 ${caseId}`,
});
let physicalCalls = 0;
let stackRef;
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: N_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: (role, pid) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(...createScholarlyTools(stackRef.citationIntegrity.scholarlyResolver, stackRef.discovery, role === "researcher" ? pid : undefined));
    }
    if (stackRef !== undefined && pid !== undefined && (role === "researcher" || role === "writer" || role === "reviewer")) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, pid));
    }
    if (stackRef !== undefined && pid !== undefined) {
      tools.push(...evidenceToolsForRole(role, { chunkAccess: stackRef.chunkAccess, grounding: stackRef.evidenceGrounding, evidence: stackRef.evidence }, pid));
    }
    return tools;
  },
  log: () => {},
});
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const result = await originalRunAgent(...callArgs);
  if (result.status !== "completed") await appendDriverLog(`runAgent #${physicalCalls} → ${result.status}`);
  return result;
};
const projects = new ProjectStore({ root: N_ROOT });
const stack = buildServiceStack({
  runtime: adapter, projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents, stageTimeoutMs: config.stageTimeoutMs, stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: (m) => console.log(m),
});
stackRef = stack;
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") throw new Error(`本脚本只装配 topic_survey（收到 ${kind}）`);
    return createTopicSurveyDefinition(stack.workflowServices);
  },
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

// ---- 执行 ----

const projectDir = join(N_ROOT, SOURCE_PROJECT);
await cp(join(P_ROOT, SOURCE_PROJECT), projectDir, { recursive: true, force: true });
await appendDriverLog(`副本就绪 ${SOURCE_PROJECT}（隔离 root ${N_ROOT}）`);
const mutation = caseId === "n1" ? await mutateN1(projectDir) : await mutateN2(projectDir);
if (!mutation.ok) throw new Error(`变异失败：${mutation.reason}`);
await writeJsonAtomic(MUTATION_PATH, { schema: "m158-mutation/v1", caseId, sourceProject: SOURCE_PROJECT, ...mutation });
await appendDriverLog(`变异落盘 ${mutation.kind}：${JSON.stringify({ ...mutation, beforeSha256: mutation.beforeSha256.slice(0, 12), afterSha256: mutation.afterSha256.slice(0, 12) })}`);

const started = await request("POST", `/projects/${SOURCE_PROJECT}/workflows`, { kind: "topic_survey" });
if (started.status !== 202) throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
const runId = started.body.runId;
await appendDriverLog(`run 启动 ${runId}（WORKFLOW_MAX_REVISION_ROUNDS=0：负例不进自动修订）`);

const runStartedAt = Date.now();
let stalledSeen = 0;
let run;
for (;;) {
  const { body } = await request("GET", `/runs/${runId}`);
  run = body.run;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId ?? "";
    let decision = "approve";
    if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
      decision = "accept_draft"; // 负例：接受 Draft 终态（不 chase 修订）——验证 FAIL 语义与 Finalize 拒绝
      stalledSeen += 1;
    }
    await appendDriverLog(`[hitl] ${stageId} → ${decision}（物理 ${physicalCalls}/${SESSION_MAX_CALLS}）`);
    const resumeRes = await request("POST", `/runs/${runId}/resume`, { decision });
    if (resumeRes.status !== 200) throw new Error(`resume 失败：${resumeRes.status} ${JSON.stringify(resumeRes.body).slice(0, 200)}`);
    continue;
  }
  if (Date.now() - runStartedAt > 90 * 60 * 1000) throw new Error(`run 超时（${run.status} / ${run.currentStage}）`);
  await new Promise((r) => setTimeout(r, 5_000));
}
await appendDriverLog(`run 终态 ${run.status}（label=${run.completion?.label ?? "-"}；物理 ${physicalCalls}）`);

// ---- 断言：gate FAIL + Finalize 拒绝 ----
const fs = await import("node:fs/promises");
const safeReadJson = async (rel) => {
  try { return JSON.parse(await readFile(join(projectDir, rel), "utf8")); } catch { return null; }
};
const gateFiles = (await fs.readdir(join(projectDir, "reviews"))).filter((f) => /^quality-gate-r\d+\.json$/.test(f)).sort();
const lastGate = gateFiles.length > 0 ? await safeReadJson(`reviews/${gateFiles[gateFiles.length - 1]}`) : null;
const citation = await safeReadJson("reviews/citation-report.json");
let finalizeRejected = null;
try {
  const fin = await request("POST", `/projects/${SOURCE_PROJECT}/finalize`);
  finalizeRejected = { status: fin.status, body: fin.body };
} catch (error) {
  finalizeRejected = { thrown: error.message };
}
const report = {
  schema: `m158-${caseId}-report/v1`,
  caseId,
  sourceProject: SOURCE_PROJECT,
  projectId: SOURCE_PROJECT,
  runId,
  finalStatus: run.status,
  completion: run.completion ?? null,
  physicalModelCalls: physicalCalls,
  budget: budgetLedger.snapshot(),
  mutation,
  gateRound: gateFiles.length > 0 ? Number(gateFiles[gateFiles.length - 1].match(/r(\d+)/)?.[1] ?? 0) : 0,
  gatePassed: lastGate?.gate?.passed ?? null,
  gateFailedRules: (lastGate?.gate?.rules ?? []).filter((r) => r.status === "FAIL" || (r.status === "NOT_EVALUATED" && r.required)).map((r) => ({ rule: r.rule, status: r.status, detail: String(r.detail).slice(0, 300) })),
  citationSummary: citation?.summary ?? null,
  finalizeAttempt: finalizeRejected,
};
// 机器断言
report.assertions = {
  gateFailed: report.gatePassed === false,
  finalizeRefused: finalizeRejected.status !== 200 || finalizeRejected.thrown !== undefined,
  mutationTargetsRule: caseId === "n2"
    ? (report.gateFailedRules.some((r) => r.rule === "citation_structure_valid" && /missing=[1-9]/.test(r.detail)) || (citation?.summary?.missingKeys ?? 0) >= 1)
    : report.gateFailedRules.length > 0,
};
await writeJsonAtomic(REPORT_PATH, report);
await appendDriverLog(`报告落盘 ${REPORT_PATH}；断言 ${JSON.stringify(report.assertions)}`);
console.log(`DONE ${caseId}: gatePassed=${report.gatePassed} finalizeRefused=${report.assertions.finalizeRefused} targeted=${report.assertions.mutationTargetsRule} physical=${physicalCalls}`);
server.close();
process.exit(report.assertions.gateFailed && report.assertions.finalizeRefused ? 0 : 5);
