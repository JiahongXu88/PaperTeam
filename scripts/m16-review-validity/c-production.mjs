#!/usr/bin/env node
/**
 * M16 · C：生产链路臂 P（当前 main 的 LaTeX review.run → quality.gate；PROTOCOL §5；完整评估 workflow 上限 2 次）。
 *
 *   node scripts/m16-review-validity/c-production.mjs --mode dry|live --case <CoCoReview id>
 *
 * 由 M15 QualityGateCalibration/scripts/run_job.mjs 派生，只改：输入 = 封存集 MD 经 M15 md_to_tex.mjs 确定性转 main.tex；
 * 构建 = 当前仓库 backend/dist（运行前记录 git HEAD 与 dist 指纹）；模型 = 产品 Settings 当前模型（须等于 M16 MODEL_SPEC，
 * 否则 MODEL_VALIDATION_BLOCKED）；每次运行用 GlobalBudgetLedger 硬限在 M16 剩余额度与单次 45 次之内；
 * 运行后把物理子调用逐条补记进 M16 账本。reviewPurpose = published_paper_assessment（第三方已发表/投稿稿只读口径）。
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_CALLS, MODEL_SPEC, REPO, ROOT, appendLedger, callsUsed, readJson } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mode = opt("--mode");
const caseId = opt("--case");
if (!["dry", "live"].includes(mode) || !caseId) throw new Error("用法：--mode dry|live --case <id>");
const PER_RUN_CAP = 45;

const selection = readJson(join(ROOT, "B", "sealed-selection.json"));
const paper = selection.selected.find((p) => p.id === caseId);
if (paper === undefined) throw new Error(`${caseId} 不在封存集`);
if (mode === "live" && paper.productionArm !== true) throw new Error(`${caseId} 未被指派生产臂（PROTOCOL §5）`);

const OUT = join(ROOT, "C", "production", `${caseId}${mode === "dry" ? "__dry" : ""}`);
const resultPath = join(OUT, "run-result.json");
if (existsSync(resultPath) && readJson(resultPath).status === "completed") {
  console.log(`[skip-completed] ${caseId}`);
  process.exit(0);
}
// PROTOCOL §6：为盲评裁判预留 JUDGE_RESERVE 次；单次运行上限 = min(45, 剩余 − 预留)，不足 MIN_RUN_CAP 不启动
const JUDGE_RESERVE = 10;
const MIN_RUN_CAP = 30;
const remaining = MAX_CALLS - callsUsed();
const runCap = mode === "live" ? Math.min(PER_RUN_CAP, remaining - JUDGE_RESERVE) : PER_RUN_CAP;
if (runCap < MIN_RUN_CAP) {
  console.error(`[budget] M16 剩余 ${remaining} 次，扣除裁判预留 ${JUDGE_RESERVE} 后不足 ${MIN_RUN_CAP}，按 PROTOCOL §6 不启动`);
  process.exit(4);
}
await mkdir(join(OUT, "projects"), { recursive: true });
process.env.PROJECTS_ROOT = join(OUT, "projects");
const LEDGER_PATH = join(OUT, "global-budget-ledger.json");
process.env.PAPERTEAM_GLOBAL_BUDGET_LEDGER = LEDGER_PATH;
process.env.PAPERTEAM_GLOBAL_MAX_MODEL_CALLS = String(runCap);
process.env.PAPERTEAM_GLOBAL_MAX_TOKENS = "0";
const LIMITS = { maxCalls: runCap, maxTokens: 0 };

const DIST = join(REPO, "backend", "dist");
const dist = (p) => pathToFileURL(join(DIST, p)).href;
const { loadConfig } = await import(dist("config/config.js"));
const { buildServiceStack } = await import(dist("serviceStack.js"));
const { ProjectStore } = await import(dist("project/ProjectStore.js"));
const { LatexCompiler } = await import(dist("latex/LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(dist("runtime/globalBudgetLedger.js"));
const { createIdeaToPaperDefinition } = await import(dist("workflow/definitions.js"));
const { markdownToLatex } = await import(pathToFileURL("D:\\PaperTeamData\\M15\\QualityGateCalibration\\scripts\\md_to_tex.mjs").href);

const config = loadConfig();
const ledger = new GlobalBudgetLedger({ path: LEDGER_PATH, limits: LIMITS, label: `M16 production arm (${mode})` });
let runtime;
let modelSpec = "scripted";
let stackRef;
if (mode === "dry") {
  const { createScriptedRuntime } = await import(dist("runtime/scriptedRuntime.js"));
  const scripted = createScriptedRuntime().runtime;
  runtime = { ...scripted, describeAgentContext: async () => ({ model: "scripted/dry", skills: [] }) };
} else {
  const { ModelRuntime } = await import(pathToFileURL(join(REPO, "backend", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const { PiRuntimeAdapter } = await import(dist("runtime/PiRuntimeAdapter.js"));
  const { createWorkspaceGuardPolicy, createWorkspaceGuardTools } = await import(dist("runtime/pi/workspaceGuard.js"));
  const { CustomProviderStore } = await import(dist("settings/CustomProviderStore.js"));
  const { applyStoredApiChannels } = await import(dist("settings/apiChannels.js"));
  const { registerStoredCustomProviders } = await import(dist("settings/ModelSettingsService.js"));
  const { ModelSettingsStore, resolveStartupModelSpec } = await import(dist("settings/ModelSettingsStore.js"));
  const { SkillRegistry } = await import(dist("skills/SkillRegistry.js"));
  const { createRetrieveLibraryTool } = await import(dist("retrieval/tools.js"));
  const { evidenceToolsForRole } = await import(dist("evidence/tools.js"));
  const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
  await skillRegistry.ensureInstalled();
  const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
  modelSpec = await resolveStartupModelSpec(config.pi.model, modelSettingsStore);
  const agentSpecs = (await modelSettingsStore.load()).agents ?? {};
  if (modelSpec !== MODEL_SPEC || Object.values(agentSpecs).some((spec) => spec && spec !== MODEL_SPEC)) {
    console.error(`MODEL_VALIDATION_BLOCKED：产品模型 ${modelSpec} / agents ${JSON.stringify(agentSpecs)} ≠ ${MODEL_SPEC}`);
    process.exit(3);
  }
  const modelRuntime = await ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
  await registerStoredCustomProviders(modelRuntime, new CustomProviderStore({ settingsDir: join(config.runtimeRoot, "settings") }), () => {});
  await applyStoredApiChannels(modelRuntime, modelSettingsStore, () => {});
  runtime = new PiRuntimeAdapter({
    modelSpec,
    ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
    agentDir: config.pi.agentDir,
    workspaceRoot: config.projectsRoot,
    runTimeoutMs: config.pi.runTimeoutMs,
    ...(config.pi.executionTimeoutMs !== undefined ? { executionTimeoutMs: config.pi.executionTimeoutMs } : {}),
    firstActivityTimeoutMs: config.pi.firstActivityTimeoutMs,
    ...(config.pi.queueTimeoutMs !== undefined ? { queueTimeoutMs: config.pi.queueTimeoutMs } : {}),
    ...(config.pi.sessionTimeoutMs !== undefined ? { sessionTimeoutMs: config.pi.sessionTimeoutMs } : {}),
    ...(config.pi.initTimeoutMs !== undefined ? { initTimeoutMs: config.pi.initTimeoutMs } : {}),
    maxConcurrentRuns: config.pi.maxConcurrentRuns,
    maxQueuedRuns: config.pi.maxQueuedRuns,
    maxRunsPerSession: config.pi.maxRunsPerSession,
    sessionIdleTtlMs: config.pi.sessionIdleTtlMs,
    maxSessions: config.pi.maxSessions,
    ...(config.pi.outputReserveTokens !== undefined ? { outputReserveTokens: config.pi.outputReserveTokens } : {}),
    modelRuntime,
    agentModelSpecs: async () => agentSpecs,
    roleSkills: (role, scope, language) => skillRegistry.skillAssignmentsFor(role, scope, language),
    roleCustomTools: (role, projectId) => {
      const tools = [];
      if ((role === "researcher" || role === "writer" || role === "reviewer") && stackRef !== undefined && projectId !== undefined) tools.push(createRetrieveLibraryTool(stackRef.retrieval, projectId));
      if (stackRef !== undefined && projectId !== undefined) tools.push(...evidenceToolsForRole(role, { chunkAccess: stackRef.chunkAccess, grounding: stackRef.evidenceGrounding, evidence: stackRef.evidence }, projectId));
      return tools;
    },
    workspaceGuard: async ({ projectId, cwd, skillDirs, toolNames }) => {
      let protectedSourceIds = [];
      let protectAllSources = false;
      if (projectId !== undefined) {
        try {
          protectedSourceIds = (await stackRef.sources.list(projectId)).filter((i) => i.origin === "EXPERIMENT_PACKAGE").map((i) => i.sourceId);
        } catch {
          protectAllSources = true;
        }
      }
      return createWorkspaceGuardTools(createWorkspaceGuardPolicy({ projectDir: cwd, readOnlyRoots: skillDirs, protectedSourceIds, protectAllSources }), { cwd, toolNames });
    },
    log: () => {},
  });
}

// 调用记录器：逐次保存 prompt / 输出 / usage（成本账 + 丢失路径取证）
const calls = [];
const recorded = (inner) => ({
  ...Object.fromEntries(["provider", "resolvedModel"].map((k) => [k, inner[k]])),
  startAgent: (input) => inner.startAgent(input),
  getTask: (id) => inner.getTask(id),
  healthCheck: () => inner.healthCheck(),
  close: () => inner.close?.(),
  modelStatusSnapshot: inner.modelStatusSnapshot?.bind(inner),
  releaseProjectSessions: inner.releaseProjectSessions?.bind(inner),
  rotateProjectIdleSessions: inner.rotateProjectIdleSessions?.bind(inner),
  runtimeStats: inner.runtimeStats?.bind(inner),
  sessionDiagnostics: inner.sessionDiagnostics?.bind(inner),
  describeAgentContext: inner.describeAgentContext?.bind(inner),
  runAgent: async (input) => {
    const rec = { n: calls.length + 1, scope: input.contextScope ?? null, unit: input.metadata?.unit ?? null, promptChars: input.task.length, promptSha256: createHash("sha256").update(input.task).digest("hex"), startedAt: new Date().toISOString() };
    calls.push(rec);
    const n = String(rec.n).padStart(2, "0");
    await mkdir(join(OUT, "calls"), { recursive: true });
    await writeFile(join(OUT, "calls", `${n}.prompt.txt`), input.task, "utf8");
    const t0 = Date.now();
    try {
      let task;
      if (mode === "live" && typeof inner.startAgent === "function") {
        const handle = await inner.startAgent(input);
        const pump = (async () => {
          for await (const _event of handle.events()) {
            // 只需消费事件流
          }
        })().catch(() => {});
        try {
          task = await handle.result();
        } finally {
          await pump;
        }
      } else {
        task = await inner.runAgent(input);
      }
      Object.assign(rec, { status: task.status, ms: Date.now() - t0, usage: task.usage ?? null, model: task.metadata?.model ?? null, ...(task.error !== undefined ? { error: String(task.error).slice(0, 400) } : {}) });
      await writeFile(join(OUT, "calls", `${n}.output.txt`), task.output ?? task.error ?? "", "utf8");
      return task;
    } catch (error) {
      Object.assign(rec, { status: "error", ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 400) });
      throw error;
    }
  },
});

const projects = new ProjectStore({ root: config.projectsRoot });
const stack = buildServiceStack({
  runtime: recorded(runtime),
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  latexTimeoutMs: config.latex.compileTimeoutMs,
  agentIds: config.agents,
  stageTimeoutMs: config.workflow.stageTimeoutMs,
  stageMaxAttempts: config.workflow.stageMaxAttempts,
  writing: { argumentUnits: config.workflow.argumentUnitWriting },
  globalBudget: { ledger, outputReserveTokens: 81_536 },
  longRunTimeoutMs: config.pi.longRunTimeoutMs,
  review: {
    maxRevisionRounds: config.review.maxRevisionRounds,
    academicPassScore: config.review.academicPassScore,
    styleRiskMax: config.review.styleRiskMax,
    academicConfirmationBand: config.review.academicConfirmationBand,
    academicConfirmationSamples: config.review.academicConfirmationSamples,
    reviewConcurrency: config.review.reviewConcurrency,
    reviewSectionLimit: config.review.reviewSectionLimit,
    incrementalUnitReuse: config.review.incrementalUnitReuse,
    inputMode: config.review.inputMode,
    neutralityPolicy: config.review.neutralityPolicy,
    unitContextPolicy: config.review.unitContextPolicy,
    unitDependencyBudgetChars: config.review.unitDependencyBudgetChars,
    revisionTask: config.review.revisionTask,
    ...(config.review.scoreRubric !== undefined ? { scoreRubric: config.review.scoreRubric } : {}),
  },
  summaryConcurrency: config.review.summaryConcurrency,
  citation: { metadataEnabled: false, scholarly: { providers: [] } },
  search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"] },
  fullText: { enabled: false },
  log: () => {},
});
stackRef = stack;

const gitHead = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
const gitDirty = execSync("git status --porcelain -- backend", { cwd: REPO }).toString().trim() !== "";
const md = readFileSync(join(ROOT, "external", "cocoreviewbench-md", paper.mdPath.replace(/^benchmark\/MD\//, "")), "utf8");
// CoCoReview MD（Marker 转写）所有标题都是一级 "# "；md_to_tex 只把 "## "+ 识别为章节——首个 "# " 保留为题名，其余降一级（PROTOCOL §4 适配规则，对所有论文相同）
let seenTitle = false;
const normalizedMd = md.replace(/^# (?=\S)/gm, (m) => (seenTitle ? "## " : ((seenTitle = true), m)));
const tex = markdownToLatex(normalizedMd, "en");
const result = {
  schema: "m16-production-run/v1", caseId, mode, modelSpec, gitHead, backendDirty: gitDirty, runCap,
  mdSha256: createHash("sha256").update(md).digest("hex"), texSha256: createHash("sha256").update(tex).digest("hex"), texChars: tex.length,
  reviewConfig: { ...config.review }, startedAt: new Date().toISOString(),
};
const t0 = Date.now();
try {
  const title = (/\\title\{([^{}]*)/.exec(tex)?.[1] ?? caseId).trim();
  const project = await projects.create(title.slice(0, 120), { language: "en", targetProfile: "general_journal" });
  result.projectId = project.id;
  await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), tex, "utf8");
  const definition = createIdeaToPaperDefinition(stack.workflowServices);
  const ctx = {
    projectId: project.id, runId: `m16-${caseId}`, attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "idea_to_paper", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: { reviewPurpose: "published_paper_assessment" } },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  };
  result.stages = {};
  for (const id of ["review.run", "quality.gate"]) {
    const stage = definition.stages.find((s) => s.id === id);
    const out = await stage.execute(ctx);
    result.stages[id] = out;
    ctx.state.stageResults[id] = out;
    ctx.state.completedStages.push(id);
  }
  const reviewsDir = join(projects.projectDir(project.id), "reviews");
  await mkdir(join(OUT, "artifacts", "review-units"), { recursive: true });
  for (const f of await readdir(reviewsDir)) if (f.endsWith(".json")) await copyFile(join(reviewsDir, f), join(OUT, "artifacts", f));
  if (existsSync(join(reviewsDir, "review-units", "r1"))) for (const f of await readdir(join(reviewsDir, "review-units", "r1"))) await copyFile(join(reviewsDir, "review-units", "r1", f), join(OUT, "artifacts", "review-units", f));
  const artDir = join(projects.projectDir(project.id), "artifacts");
  if (existsSync(artDir)) for (const f of await readdir(artDir)) if (/gate|quality|published|claim/i.test(f) && f.endsWith(".json")) await copyFile(join(artDir, f), join(OUT, "artifacts", f));
  result.status = "completed";
} catch (error) {
  result.status = /MODEL_BUDGET_EXCEEDED|任务级模型预算|global budget/i.test(String(error?.message)) ? "refused_budget" : "failed";
  result.error = String(error?.stack ?? error).slice(0, 3000);
}
result.endedAt = new Date().toISOString();
result.ms = Date.now() - t0;
result.calls = calls;
result.callCount = calls.length;
result.failedCalls = calls.filter((c) => c.status !== "completed").length;
await writeFile(resultPath, JSON.stringify(result, null, 1), "utf8");
if (mode === "live") for (const c of calls) appendLedger({ purpose: `production/${caseId}/${c.scope ?? "?"}`, model: c.model ?? modelSpec, durationMs: c.ms ?? null, usage: c.usage ?? null, ...(c.status !== "completed" ? { error: c.error ?? c.status } : {}) });
console.log(`[${result.status}] ${caseId} calls=${result.callCount} failed=${result.failedCalls} ms=${result.ms} ${result.error ? result.error.slice(0, 400) : ""}`);
await runtime.close?.();
process.exit(0);
