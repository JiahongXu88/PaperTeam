#!/usr/bin/env node
/**
 * M15.8 预检：P 稿件 LaTeX 构建（Build Gate）——在续跑前验证编译链，
 * 避免预算耗尽后才发现 build 失败。零模型调用；走产品 POST /build。
 * 用法：node scripts/m158-p-buildcheck.mjs
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, "budget-ledger-buildcheck.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const journal = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-journal.json"), "utf8"));
const projectId = journal.projectId;
await mkdir(EVAL_DIR, { recursive: true });

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



const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));
const config = loadConfig();
// M15.8.1：Research 代理装配（与生产 index.ts 同一 helper；env > network.json > 直连）
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: (m) => console.log(m),
});
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8 buildcheck (0)",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: P_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (r, s) => skillRegistry.skillAssignmentsFor(r, s),
  roleCustomTools: () => [],
  log: () => {},
});
const projects = new ProjectStore({ root: P_ROOT });
const stack = buildServiceStack({
  // M15.8.1：学术出口统一经 ResearchFetchRouter（防直连漏线复发）
  researchFetch: researchNet.router.fetch,
  runtime: adapter, projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents, stageTimeoutMs: config.stageTimeoutMs, stageMaxAttempts: config.stageMaxAttempts,
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: (m) => console.log(m),
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

const res = await fetch(`${base}/api/projects/${projectId}/build`, { method: "POST" });
const body = await res.json().catch(() => ({ raw: true }));
const report = { schema: "m158-buildcheck/v1", projectId, status: res.status, body };
const outPath = join(EVAL_DIR, "m158-p-buildcheck.json");
const tmp = `${outPath}.tmp`;
await writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
await rename(tmp, outPath);
const build = body.build ?? body.record ?? {};
console.log(`BUILD CHECK: HTTP ${res.status} passed=${build.passed} reasons=${JSON.stringify(build.reasons ?? body.reasons ?? []).slice(0, 300)}`);
server.close();
process.exit(res.status === 200 || res.status === 201 || res.status === 202 ? 0 : 5);
