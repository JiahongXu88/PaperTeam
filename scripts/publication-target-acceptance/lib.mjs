/**
 * 发表目标 / ReviewPolicy 真实模型验收：共享 harness（生产服务栈构建复制自 scripts/m16-engineering-closure/smoke.mjs）。
 * - 账本：<ROOT>\MODEL_CALL_LEDGER.jsonl（append-only，一次物理调用一行，调用结束立即写入）；本轮硬上限 24 次（任务书 §2.1）。
 * - 每次 live 调用前检查账本：已达上限 → 拒绝调用（抛错），不会越过预算。
 * - 历史目录（M15 / M16）只读：输入从那里读取，所有产物只写本轮 ROOT。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const ROOT = "D:\\PaperTeamData\\PublicationTargetPolicy\\RealModelAcceptance";
export const COCO_MD = "D:\\PaperTeamData\\M16\\VerifiedFindingsHybridReview\\external\\cocoreviewbench-md";
export const LEDGER = join(ROOT, "MODEL_CALL_LEDGER.jsonl");
export const MAX_CALLS = 24;
export const MODEL_SPEC = "zai-coding-cn/glm-5.3";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function callsUsed() {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

export function appendLedger(entry) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ n: callsUsed() + 1, at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

const DIST = join(REPO, "backend", "dist");
export const dist = (p) => pathToFileURL(join(DIST, p)).href;

/**
 * 生产服务栈（同 review.run 生产装配；检索 / 全文 / 元数据联网关闭——与 M16 smoke 相同，保证 A/B 可用证据条件一致）。
 * mode=dry → scripted runtime（零模型）；mode=live → PiRuntimeAdapter + 产品模型设置（校验全部角色 = MODEL_SPEC）。
 * purpose：账本用途前缀。outDir：逐次 prompt / output 落盘目录。
 */
export async function createStack({ mode, outDir, purpose, projectsRoot, runCap = MAX_CALLS, retry = false }) {
  process.env.PROJECTS_ROOT = projectsRoot;
  const { loadConfig } = await import(dist("config/config.js"));
  const { buildServiceStack } = await import(dist("serviceStack.js"));
  const { ProjectStore } = await import(dist("project/ProjectStore.js"));
  const { LatexCompiler } = await import(dist("latex/LatexCompiler.js"));
  const { GlobalBudgetLedger } = await import(dist("runtime/globalBudgetLedger.js"));
  const config = loadConfig();
  const ledgerPath = join(outDir, "global-budget-ledger.json");
  const ledger = new GlobalBudgetLedger({ path: ledgerPath, limits: { maxCalls: runCap, maxTokens: 0 }, label: `publication-target acceptance (${purpose})` });
  let runtime;
  let modelSpec = "scripted/dry";
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

  // 调用记录器：逐次保存 prompt / 输出 / usage；live 调用前检查本轮账本上限，调用结束立即写账本
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
      if (mode === "live" && callsUsed() >= MAX_CALLS) throw new Error(`[budget] 本轮账本已达 ${MAX_CALLS} 次上限，拒绝调用`);
      const rec = { n: calls.length + 1, projectId: input.projectId ?? null, scope: input.contextScope ?? null, skill: input.metadata?.skill ?? null, unit: input.metadata?.unit ?? null, sessionKey: input.sessionKey ?? null, promptChars: input.task.length, promptSha256: sha(input.task), startedAt: new Date().toISOString() };
      calls.push(rec);
      const n = String(rec.n).padStart(2, "0");
      await mkdir(join(outDir, "calls"), { recursive: true });
      await writeFile(join(outDir, "calls", `${n}.prompt.txt`), input.task, "utf8");
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
        const out = task.output ?? task.error ?? "";
        await writeFile(join(outDir, "calls", `${n}.output.txt`), out, "utf8");
        rec.outputSha256 = sha(out);
        return task;
      } catch (error) {
        Object.assign(rec, { status: "error", ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 400) });
        throw error;
      } finally {
        if (mode === "live") {
          appendLedger({ purpose: `${purpose}/${rec.skill ?? rec.scope ?? "?"}${rec.unit ? `/${rec.unit}` : ""}`, provider: "zai-coding-cn", model: rec.model ?? modelSpec, status: rec.status, durationMs: rec.ms ?? null, usage: rec.usage ?? null, promptSha256: rec.promptSha256, outputSha256: rec.outputSha256 ?? null, artifact: join(outDir, "calls", `${n}.output.txt`), retry, ...(rec.status !== "completed" ? { error: rec.error ?? rec.status } : {}) });
        }
      }
    },
  });

  const projects = new ProjectStore({ root: projectsRoot });
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
      wholePaperSynthesis: config.review.wholePaperSynthesis,
      wholePaperMaxChars: config.review.wholePaperMaxChars,
      ...(config.review.scoreRubric !== undefined ? { scoreRubric: config.review.scoreRubric } : {}),
    },
    summaryConcurrency: config.review.summaryConcurrency,
    citation: { metadataEnabled: false, scholarly: { providers: [] } },
    search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"] },
    fullText: { enabled: false },
    log: () => {},
  });
  stackRef = stack;
  return { stack, projects, config, calls, modelSpec, close: () => runtime.close?.() };
}
