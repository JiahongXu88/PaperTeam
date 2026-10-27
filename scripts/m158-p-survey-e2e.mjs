#!/usr/bin/env node
/**
 * M15.8 阶段 E — P 场景：真实正向 topic_survey E2E 驱动。
 *
 * 语义（预登记 §3.P，D:\PaperTeamData\M15\M15_8\PRE_REGISTERED_E2E_GATES.md）：
 *  - 只输入 Topic 创建项目（真实 HTTP server + 真实 orchestrator，非 stage 直调）；
 *  - 全链 topic_survey：research.plan → … → survey.synthesis（verified evidence）
 *    → writing.sections → citation.verify → review.run → quality.gate
 *    → bounded revision → build.draft → build.final（FinalizeService 真实执行）；
 *  - HITL 策略（预登记冻结）：research_plan/literature_selection/matrix/outline
 *    = approve（literature_selection 缺省 payload = 系统推荐集）；stalled 先
 *    revise_more 一轮再 accept_draft；overflow 直接 accept_draft；
 *  - 预算：GlobalBudgetLedger 系统级硬停（maxCalls 由 PAPERTEAM_GLOBAL_MAX_MODEL_CALLS
 *    注入；物理 runAgent 计数含重试/失败，ping 不回减）；
 *  - crash-safe journal：runId/projectId/阶段进度原子落盘；--resume 重附着既有 run。
 *
 * 用法：
 *   node scripts/m158-p-survey-e2e.mjs --dry-run   # 0 模型：校验脚本自身逻辑/写盘/恢复路径
 *   node scripts/m158-p-survey-e2e.mjs --fresh     # 真实运行（显式）
 *   node scripts/m158-p-survey-e2e.mjs --resume    # 续跑既有 run
 *
 * 产物（D:\PaperTeamData\M15\M15_8\evaluation\）：
 *   m158-p-journal.json / m158-p-report.json / m158-p-driver-log.txt
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const PROJECTS_ROOT = join(DATA_ROOT, "projects-root");
const JOURNAL_PATH = join(EVAL_DIR, "m158-p-journal.json");
const REPORT_PATH = join(EVAL_DIR, "m158-p-report.json");
const DRIVER_LOG = join(EVAL_DIR, "m158-p-driver-log.txt");

const TOPIC = process.env["M158_P_TOPIC"]
  ?? "多目标跟踪评测指标体系综述：MOTA、MOTP、HOTA 与 IDF1 的演进、互补性与适用边界";
const SESSION_MAX_CALLS = Number(process.env["M158_SESSION_MAX_CALLS"] ?? "96");
const RUN_DEADLINE_MS = Number(process.env["M158_RUN_DEADLINE_MS"] ?? String(5 * 60 * 60 * 1000));

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const fresh = args.has("--fresh");
const resume = args.has("--resume");
const continueRun = args.has("--continue");
const proxyPreflight = args.has("--proxy-preflight");
if (Number(dryRun) + Number(fresh) + Number(resume) + Number(continueRun) + Number(proxyPreflight) !== 1) {
  console.error("用法：--dry-run | --fresh | --resume | --continue | --proxy-preflight（五选一）");
  process.exit(2);
}
// Dev #1：续跑 tail 账本（原 96 账本封存；--continue 必须显式给出 tail 账本路径与上限）
if (continueRun) {
  process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = process.env["M158_TAIL_LEDGER"] ?? join(EVAL_DIR, "budget-ledger-p-tail.json");
  process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = process.env["M158_TAIL_MAX_CALLS"] ?? "72";
}

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] ??= join(EVAL_DIR, "budget-ledger.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] ??= String(SESSION_MAX_CALLS);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0"; // 只按调用数硬停（token 上限交给 Coding Plan 订阅额度）

await mkdir(EVAL_DIR, { recursive: true });
await mkdir(PROJECTS_ROOT, { recursive: true });

async function appendDriverLog(line) {
  const stamp = new Date().toISOString();
  await writeFile(DRIVER_LOG, `[${stamp}] ${line}\n`, { flag: "a" });
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJournal() {
  if (!existsSync(JOURNAL_PATH)) return null;
  try {
    return JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
  } catch (error) {
    await appendDriverLog(`journal 损坏（${error.message}）——按无 journal 处理`);
    return null;
  }
}

const sha256File = async (path) => {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
};

// ---- 装配（真实生产束；dry-run 下同样装配但只做自检，不创建 run）----

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
if (config.workflow.globalBudget === undefined) {
  console.error("[fatal] globalBudget 未装配（PAPERTEAM_GLOBAL_BUDGET_LEDGER 未生效）");
  process.exit(1);
}
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: {
    maxCalls: config.workflow.globalBudget.maxCalls,
    maxTokens: config.workflow.globalBudget.maxTokens,
  },
  label: "M15.8 P survey E2E",
});

// M15.8.1：Research 代理装配（与生产 index.ts 同一 helper）——env > network.json > 直连。
// researchFetch 只接到学术检索 / 全文下载 / 元数据核验客户端；模型 Runtime / 本机
// HTTP API / docling 不经过它。M15.8 曾因脚本漏配 researchFetch 全程直连，19 篇全文
// 获取失败（D:\PaperTeamData\M15\M15_8\network-repair\proxy-diagnosis.json）。
const { initResearchNetwork, probeResearchNetwork } = await import(
  distUrl("network", "researchNetworkBootstrap.js")
);
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  hints: {
    ...(config.search.openalexMailto !== undefined ? { openalexMailto: config.search.openalexMailto } : {}),
    ...(config.search.semanticScholarApiKey !== undefined
      ? { semanticScholarApiKey: config.search.semanticScholarApiKey }
      : {}),
    ...(config.citation.contactEmail !== undefined ? { crossrefMailto: config.citation.contactEmail } : {}),
  },
  log: (message) => console.log(message),
});

let physicalCalls = 0;
const taskUsage = [];
let stackRef;
const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
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
  const startedAt = Date.now();
  const result = await originalRunAgent(...callArgs);
  taskUsage.push({
    call: physicalCalls,
    scope: callArgs[0]?.contextScope ?? null,
    status: result.status,
    durationMs: Date.now() - startedAt,
    ...(result.usage ?? {}),
  });
  if (result.status !== "completed") {
    await appendDriverLog(`runAgent #${physicalCalls} → ${result.status}: ${String(result.error ?? "").slice(0, 160)}`);
  }
  return result;
};

const projects = new ProjectStore({ root: PROJECTS_ROOT });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  // M15.8.1：学术出口统一经 ResearchFetchRouter（缺省曾为内建 fetch 直连）
  researchFetch: researchNet.router.fetch,
  globalBudget: {
    ledger: budgetLedger,
    outputReserveTokens: config.workflow.globalBudget.outputReserveTokens,
  },
  log: (message) => console.log(message),
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
await appendDriverLog(`backend http 就绪 ${base}（mode=${dryRun ? "dry-run" : fresh ? "fresh" : "resume"}）`);

async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
}

// ---- 统一退出：先关 HTTP server 与代理 dispatcher（在途请求自然结束），再 exit ----
async function finish(code) {
  server.close();
  await researchNet.router.close().catch(() => {});
  process.exit(code);
}
process.on("unhandledRejection", async (reason) => {
  console.error("[fatal] unhandledRejection", reason);
  await appendDriverLog(`fatal unhandledRejection：${String(reason).slice(0, 200)}`).catch(() => {});
  await finish(1);
});

// ---- proxy-preflight：0 模型学术链路预检（经 ResearchFetchRouter 的六项探测），然后退出 ----
if (proxyPreflight) {
  const diagnosis = await probeResearchNetwork(researchNet);
  await appendDriverLog(
    `proxy-preflight ${diagnosis.status}（mode=${diagnosis.mode}${diagnosis.proxyUrl ? ` proxy=${diagnosis.proxyUrl}` : ""}；source=${researchNet.source}）：${diagnosis.detail}`,
  );
  console.log(
    `PROXY_PREFLIGHT ${diagnosis.status} mode=${diagnosis.mode} proxy=${diagnosis.proxyUrl ?? "-"} source=${researchNet.source}`,
  );
  console.log(`  ${diagnosis.detail}`);
  await finish(diagnosis.status === "PASS" ? 0 : 4);
}

// ---- dry-run：0 模型自检（脚本写盘 / journal / 报告路径 / HTTP 装配），然后退出 ----
if (dryRun) {
  const probe = { schema: "m158-p-dry/v1", at: new Date().toISOString(), steps: [] };
  probe.steps.push(["http-ok", true]);
  const { status } = await request("GET", "/projects");
  probe.steps.push(["projects-list", status === 200]);
  await writeJsonAtomic(JOURNAL_PATH + ".dry", probe); // 故意写错后缀：自检原子写与读回
  const back = JSON.parse(await readFile(JOURNAL_PATH + ".dry", "utf8"));
  probe.steps.push(["journal-roundtrip", back.schema === "m158-p-dry/v1"]);
  const budget = budgetLedger.snapshot();
  probe.steps.push(["budget-zero", budget.calls === 0]);
  probe.steps.push(["topic", TOPIC.length > 10]);
  probe.steps.push(["research-fetch-wired", typeof researchNet.router.fetch === "function" && researchNet.source !== undefined]);
  await writeJsonAtomic(join(EVAL_DIR, "m158-p-dry.json"), probe);
  console.log(`[dry-run] ${probe.steps.map(([k, ok]) => `${k}=${ok ? "OK" : "FAIL"}`).join(" ")}`);
  await appendDriverLog(
    `research net source=${researchNet.source} effective=${researchNet.effectiveUrl ?? "direct"} stats=${JSON.stringify(researchNet.router.stats())}`,
  );
  await finish(probe.steps.every(([, ok]) => ok) ? 0 : 3);
}

// ---- fresh / resume / continue ----

let journal = await readJournal();
if (fresh && journal !== null && journal.runId !== undefined && !process.env["M158_ALLOW_REFRESH"]) {
  console.error(`[refuse] journal 已有 run ${journal.runId}：用 --resume 续跑，或设 M158_ALLOW_REFRESH=1 显式重建`);
  await finish(2);
}
if (resume && (journal === null || journal.runId === undefined)) {
  console.error("[refuse] --resume 但 journal 无既有 run：先用 --fresh");
  await finish(2);
}
if (continueRun && (journal === null || journal.projectId === undefined)) {
  console.error("[refuse] --continue 但 journal 无既有项目：先用 --fresh");
  await finish(2);
}

let projectId = journal?.projectId;
let runId = journal?.runId;

if (fresh) {
  // ---- preflight 1：学术 provider 可达（纯 HTTP，0 模型调用；arxiv 端点实测间歇性 000——重试 3 次）----
  {
    // M15.8.1：经 ResearchFetchRouter 的六项探测 + 结构化诊断（PROXY_UNREACHABLE /
    // ARXIV_PDF_TIMEOUT / TARGET_RATE_LIMITED / ACADEMIC_UNREACHABLE）。代理已配置
    // 但核心路径不可用 → fail-fast，不静默降级直连、不消耗模型预算；直连模式保留
    // 旧 openalex 兜底语义（ACADEMIC_UNREACHABLE 时 10s 后重试一次）。
    const diagnosis = await probeResearchNetwork(researchNet);
    await appendDriverLog(
      `preflight-1 ${diagnosis.status}（mode=${diagnosis.mode}${diagnosis.proxyUrl ? ` proxy=${diagnosis.proxyUrl}` : ""}）：${diagnosis.detail}`,
    );
    let pass = diagnosis.status === "PASS";
    if (!pass && diagnosis.mode === "direct" && diagnosis.status === "ACADEMIC_UNREACHABLE") {
      await new Promise((r) => setTimeout(r, 10_000));
      const retry = await probeResearchNetwork(researchNet);
      await appendDriverLog(`preflight-1 retry ${retry.status}：${retry.detail}`);
      pass = retry.status === "PASS";
    }
    if (!pass) {
      await appendDriverLog(`prefail: ${diagnosis.status}（${diagnosis.detail}）——不启动 run`);
      console.error(`[prefail] ${diagnosis.status}：${diagnosis.detail}`);
      await finish(4);
    }
  }
  // ---- preflight 2：模型通道 ping（1 次物理调用，计入账本）----
  const pingReserveId = budgetLedger.reserve({ label: "m158-p-ping", estimatedTokens: 200 });
  const ping = await adapter.runAgent({
    agentId: config.agents.reviewer,
    timeoutMs: 120_000,
    task: '回复 JSON：{"ok":true}（连通性检查，不要做任何其他事）',
    projectId: "m158-p-ping",
    contextScope: "review/m158-p-ping",
    metadata: { role: "reviewer" },
  });
  budgetLedger.settle(pingReserveId, ping.usage);
  if (ping.status !== "completed") {
    await appendDriverLog(`ping ✘ ${ping.status}（已计入账本；物理 ${physicalCalls}/${SESSION_MAX_CALLS}）`);
    console.error("[prefail] 模型通道不可用");
    await finish(4);
  }
  await appendDriverLog(`ping ✔（已计入账本；账本 ${budgetLedger.snapshot().calls}/${SESSION_MAX_CALLS}；物理 ${physicalCalls}）`);

  const created = await request("POST", "/projects", { title: TOPIC, workflowKind: "topic_survey", language: "zh" });
  if (created.status !== 201) throw new Error(`项目创建失败：${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  projectId = created.body.project.id;
  await appendDriverLog(`项目创建 ${projectId}（topic=${TOPIC}）`);
  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "topic_survey" });
  if (started.status !== 202) throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
  runId = started.body.runId;
  await appendDriverLog(`run 启动 ${runId}`);
  journal = { schema: "m158-p/v1", projectId, runId, startedAt: new Date().toISOString(), hitl: [], updatedAt: new Date().toISOString() };
  await writeJsonAtomic(JOURNAL_PATH, journal);
} else if (continueRun) {
  // 同项目新 run（front 阶段指纹幂等复用；Dev #1 续跑通道）：先取消可能残留的孤儿 run
  const orphans = await request("GET", `/runs?projectId=${projectId}`);
  for (const orphan of orphans.body["runs"] ?? []) {
    if (["running", "pending", "awaiting_input"].includes(orphan.status)) {
      await appendDriverLog(`[cleanup] 取消孤儿 run ${orphan.runId}（${orphan.status}）`);
      await request("POST", `/runs/${orphan.runId}/cancel`).catch(() => {});
    }
  }
  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "topic_survey" });
  if (started.status !== 202) throw new Error(`run 启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
  runId = started.body.runId;
  await appendDriverLog(`--continue 新 run ${runId}（project=${projectId}；tail 账本 ${process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"]}）`);
  journal = { ...(journal ?? { schema: "m158-p/v1" }), projectId, runId, continuedAt: new Date().toISOString(), hitl: journal?.hitl ?? [], updatedAt: new Date().toISOString() };
  await writeJsonAtomic(JOURNAL_PATH, journal);
} else {
  await appendDriverLog(`--resume 重附着 project=${projectId} run=${runId}`);
}

const runStartedAt = Date.now();
let stalledSeen = 0;
let run;
for (;;) {
  const { body } = await request("GET", `/runs/${runId}`);
  run = body.run;
  if (run === undefined) throw new Error(`run 查询失败：${JSON.stringify(body).slice(0, 200)}`);
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId ?? "";
    let decision = "approve";
    if (stageId === "hitl.revision_stalled") {
      stalledSeen += 1;
      decision = stalledSeen <= 2 ? "revise_more" : "accept_draft"; // 预登记 §3.P：先追加 ≤2 轮，再 accept_draft（不无限追）
    } else if (stageId === "hitl.revision_overflow") {
      decision = "accept_draft";
    } // literature_selection：缺省 payload = 系统推荐集（预登记 §3.P）
    const payload = run.awaiting?.payload ?? {};
    await appendDriverLog(
      `[hitl] ${stageId} → ${decision}（elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min；物理 ${physicalCalls}/${SESSION_MAX_CALLS}；convergence=${payload["convergence"] ?? "-"}；outcome=${payload["outcome"] ?? "-"}）`,
    );
    const resumeRes = await request("POST", `/runs/${runId}/resume`, { decision });
    if (resumeRes.status !== 200) {
      throw new Error(`resume ${stageId} 失败：${resumeRes.status} ${JSON.stringify(resumeRes.body).slice(0, 300)}`);
    }
    journal.hitl.push({ at: new Date().toISOString(), stageId, decision });
    journal.updatedAt = new Date().toISOString();
    await writeJsonAtomic(JOURNAL_PATH, journal);
    continue;
  }
  if (Date.now() - runStartedAt > RUN_DEADLINE_MS) {
    await appendDriverLog(`超时（${run.status} / ${run.currentStage}；物理 ${physicalCalls}）——journal 保留，可 --resume`);
    throw new Error(`run 超时（${run.status} / ${run.currentStage}）`);
  }
  if (physicalCalls > SESSION_MAX_CALLS) {
    await appendDriverLog(`物理调用 ${physicalCalls} 超过硬顶 ${SESSION_MAX_CALLS}——停止驱动（journal 保留）`);
    throw new Error("budget hard stop");
  }
  await new Promise((r) => setTimeout(r, 5_000));
}

journal.finalStatus = run.status;
journal.completion = run.completion ?? null;
journal.updatedAt = new Date().toISOString();
await writeJsonAtomic(JOURNAL_PATH, journal);
await appendDriverLog(`run 终态 ${run.status}（label=${run.completion?.label ?? "-"}；qualityStatus=${run.completion?.summary?.qualityStatus ?? "-"}；物理 ${physicalCalls}；elapsed ${Math.round((Date.now() - runStartedAt) / 60000)}min）`);

// ---- 产物采集（只读） ----
const report = {
  schema: "m158-p-report/v1",
  topic: TOPIC,
  projectId,
  runId,
  finalStatus: run.status,
  completion: run.completion ?? null,
  physicalModelCalls: physicalCalls,
  taskUsage,
  budgetTotals: budgetLedger.snapshot(),
  hitl: journal.hitl,
  gate: null,
  citation: null,
  evidence: null,
  build: null,
  finalArtifact: null,
  draftArtifact: null,
  errors: [],
};

try {
  const gateRounds = await request("GET", `/projects/${projectId}/quality-gate`).catch(() => null);
  report.gateApi = gateRounds?.body ?? null;
} catch (error) { report.errors.push(`gate api: ${error.message}`); }

const fs = await import("node:fs/promises");
const projectDir = join(PROJECTS_ROOT, projectId);
const safeReadJson = async (rel) => {
  try { return JSON.parse(await readFile(join(projectDir, rel), "utf8")); } catch { return null; }
};
const reviewsDir = join(projectDir, "reviews");
let gateFiles = [];
try { gateFiles = (await fs.readdir(reviewsDir)).filter((f) => /^quality-gate-r\d+\.json$/.test(f)).sort(); } catch {}
if (gateFiles.length > 0) {
  const last = await safeReadJson(`reviews/${gateFiles[gateFiles.length - 1]}`);
  report.gate = last;
  report.gateRound = Number(gateFiles[gateFiles.length - 1].match(/r(\d+)/)?.[1] ?? 0);
}
report.citation = await safeReadJson("reviews/citation-report.json");
try {
  const evidenceList = await stack.evidence.list(projectId);
  report.evidence = {
    total: evidenceList.length,
    byStatus: evidenceList.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}),
    byVerification: evidenceList.reduce((acc, r) => { const v = r.verification?.status ?? r.verification ?? "unknown"; acc[String(v)] = (acc[String(v)] ?? 0) + 1; return acc; }, {}),
  };
} catch (error) { report.errors.push(`evidence: ${error.message}`); }
report.buildGate = await safeReadJson("build/build-gate.json");
try {
  const artifactsDir = join(projectDir, "artifacts");
  const entries = await fs.readdir(artifactsDir, { recursive: true });
  report.artifactFiles = entries.filter((f) => String(f).endsWith(".pdf"));
  for (const rel of report.artifactFiles) {
    const sha = await sha256File(join(artifactsDir, rel));
    (rel.includes("final") ? (report.finalArtifact ??= {}) : (report.draftArtifact ??= {}))[rel] = sha;
  }
  if (report.finalArtifact && Object.keys(report.finalArtifact).length === 0 && report.artifactFiles.length > 0) {
    // 命名不含 final 时按 manifest 区分
    const manifest = await safeReadJson("artifacts/manifest.json");
    report.artifactManifest = manifest;
  }
} catch (error) { report.errors.push(`artifacts: ${error.message}`); }
report.revisions = await safeReadJson("manuscript/revisions.json");
report.manuscriptOutline = await safeReadJson("manuscript/outline.json");
try {
  const msFiles = await fs.readdir(join(projectDir, "manuscript"));
  report.manuscriptFiles = msFiles;
} catch (error) { report.errors.push(`manuscript: ${error.message}`); }

await writeJsonAtomic(REPORT_PATH, report);
await appendDriverLog(`报告落盘 ${REPORT_PATH}（物理 ${physicalCalls}/${SESSION_MAX_CALLS}）`);
console.log(`DONE status=${run.status} physical=${physicalCalls}/${SESSION_MAX_CALLS} gateRound=${report.gateRound ?? "-"} gatePassed=${report.gate?.gate?.passed ?? "?"} final=${report.finalArtifact ? Object.keys(report.finalArtifact).join(",") : "NONE"}`);
await finish(0);
