import { ConfigError, loadConfig } from "./config/config.js";
import { applyEnvFile, findEnvFile } from "./config/envFile.js";
import { createBackendHttpServer } from "./httpServer.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { ProjectStore } from "./project/ProjectStore.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "./runtime/PiRuntimeAdapter.js";
import { RuntimeStatusService } from "./runtime/statusService.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";
import { ModelSettingsService } from "./settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "./settings/ModelSettingsStore.js";
import { buildServiceStack } from "./serviceStack.js";
import { SkillRegistry } from "./skills/SkillRegistry.js";
import { SkillSummaryService } from "./skills/SkillSummaryService.js";
import { createScholarlyTools } from "./skills/scholarlyTools.js";
import { LatexImporter } from "./import/LatexImporter.js";
import {
  createExistingPaperDefinition,
  createIdeaToPaperDefinition,
} from "./workflow/definitions.js";
import { WorkflowOrchestrator } from "./workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "./workflow/runStore.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * PaperTeam Backend 启动入口（M3.0：Workflow Foundation；M3.8：Pi Runtime）。
 *
 * 启动流程：
 *   1. 加载 .env（可选，仅补缺，不覆盖真实环境变量）
 *   2. 加载并校验配置
 *   3. 装配 PiRuntimeAdapter（in-process SDK；无 Gateway 子进程 / 端口 / 握手）
 *   4. 执行一次 Runtime 健康检查并输出结果（模型就绪度独立报告）
 *   5. 装配 WorkflowOrchestrator 并恢复中断的 WorkflowRun（checkpoint 恢复）
 *   6. 启动 HTTP 服务；shutdown 时先停编排器再收敛 Runtime 在途 run
 */

export async function startBackend(): Promise<void> {
  console.log("PaperTeam Backend starting...");

  loadDotEnvBestEffort();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`配置加载失败：${error.message}`);
    }
    throw error;
  }

  console.log(`  env:          ${config.env}`);
  console.log(`  runtime:      pi（in-process，@earendil-works/pi-coding-agent）`);
  console.log(`  pi:           model=${config.pi.model ?? "(未配置)"} agentDir=${config.pi.agentDir}`);
  console.log(`  projectsRoot: ${config.projectsRoot}`);
  console.log(`  agents:       researcher=${config.agents.researcher} writer=${config.agents.writer} reviewer=${config.agents.reviewer} citation=${config.agents.citation}`);

  // M4.3.6 Skill Registry：安装仓库内审计过的 seed（pin revision + LICENSE +
  // PROVENANCE）到 PaperTeam 数据目录的 Skill Store；按角色注入 Pi Session。
  const skillRegistry = new SkillRegistry({
    storeRoot: join(config.runtimeRoot, "skills"),
    log: (message) => console.log(message),
  });
  const installedSkills = await skillRegistry.ensureInstalled();
  console.log(
    `  skills:       ${installedSkills.length} 个已安装（${installedSkills.map((s) => s.id).join(", ")}）`,
  );

  // 受控学术检索工具（paper-search skill 的工具面）：闭包延迟引用 stack，
  // 保证与 CitationIntegrityService 共享同一个 resolver（缓存 / telemetry）
  let stackRef: ReturnType<typeof buildServiceStack> | undefined;
  // M4.3.7.5 启动即解析生效模型：env（PAPERTEAM_PI_MODEL，含 .env）> Settings
  // 保存的本地偏好（<runtimeRoot>/settings/model.json）——否则重启后 stored
  // 配置只有展示、Runtime 仍 not_configured
  const modelSettingsStore = new ModelSettingsStore({
    settingsDir: join(config.runtimeRoot, "settings"),
  });
  const effectiveModelSpec = await resolveStartupModelSpec(config.pi.model, modelSettingsStore);
  // 共享 ModelRuntime（M4.3.7.5）：adapter 与 ModelSettingsService 用同一实例，
  // Settings 保存/清除 Key（login/logout）后 adapter 立即可见（同一 credential store）
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.pi.agentDir, "auth.json"),
    modelsPath: join(config.pi.agentDir, "models.json"),
  });
  const runtime: AgentRuntime = new PiRuntimeAdapter({
    ...(effectiveModelSpec !== undefined ? { modelSpec: effectiveModelSpec } : {}),
    ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
    agentDir: config.pi.agentDir,
    workspaceRoot: config.projectsRoot,
    runTimeoutMs: config.pi.runTimeoutMs,
    modelRuntime,
    // 只有 assigned 且 installed 的 skill 进入对应角色会话（progressive disclosure）
    roleSkillDirs: (role) => skillRegistry.skillDirsForAgent(role),
    roleCustomTools: (role) =>
      (role === "researcher" || role === "citation") && stackRef !== undefined
        ? createScholarlyTools(stackRef.citationIntegrity.scholarlyResolver)
        : [],
  });

  const projects = new ProjectStore({ root: config.projectsRoot });
  const latex = new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs });
  const stack = buildServiceStack({
    runtime,
    projects,
    latex,
    agentIds: config.agents,
    stageTimeoutMs: config.workflow.stageTimeoutMs,
    stageMaxAttempts: config.workflow.stageMaxAttempts,
    review: {
      maxRevisionRounds: config.review.maxRevisionRounds,
      academicPassScore: config.review.academicPassScore,
      styleRiskMax: config.review.styleRiskMax,
    },
    citation: {
      metadataEnabled: config.citation.metadataEnabled,
      maxMetadataLookups: config.citation.maxMetadataLookups,
      metadataTimeoutMs: config.citation.metadataTimeoutMs,
      ...(config.citation.contactEmail ? { contactEmail: config.citation.contactEmail } : {}),
    },
    log: (message) => console.log(message),
  });
  const importer = new LatexImporter({ projects, latex, log: (message) => console.log(message) });
  stackRef = stack;

  // M4.3.6 中文简介：模型可用时补齐（一次生成、持久化；失败保持 summary_pending）
  const skillSummaries = new SkillSummaryService({
    registry: skillRegistry,
    runtime,
    agentId: config.agents.researcher,
    log: (message) => console.log(message),
  });
  void skillSummaries
    .generateMissing()
    .then(({ generated, failed }) => {
      if (generated.length > 0 || failed.length > 0) {
        console.log(
          `  skills:       中文简介 generated=${generated.length} pending=${failed.length}`,
        );
      }
    })
    .catch(() => {});

  const health = await runtime.healthCheck();
  reportRuntimeHealth(health);

  // Runtime 诊断（GET /api/runtime/status）
  const runtimeStatus = new RuntimeStatusService({
    runtime,
    agentIds: config.agents,
    log: (message) => console.log(message),
  });

  const orchestrator = new WorkflowOrchestrator({
    projects,
    runStore: new WorkflowRunStore(projects),
    definitionFactory: (kind) => {
      switch (kind) {
        case "idea_to_paper":
          return createIdeaToPaperDefinition(stack.workflowServices);
        case "existing_paper_improvement":
          return createExistingPaperDefinition(stack.workflowServices);
      }
    },
    log: (message) => console.log(message),
  });

  // 进程重启后：恢复中断的 WorkflowRun（依据 checkpoint，不依赖对话历史）
  const recovered = await orchestrator.recoverInterruptedRuns();
  if (recovered.length > 0) {
    console.log(`  workflow:     恢复 ${recovered.length} 个中断的 WorkflowRun`);
  }

  // M4.3.7.5 Model Settings：env（PAPERTEAM_PI_*）> 本地保存（model.json + auth.json）
  const modelSettings = new ModelSettingsService({
    modelRuntime,
    runtime: runtime as PiRuntimeAdapter,
    store: modelSettingsStore,
    env: {
      ...(config.pi.model !== undefined ? { piModel: config.pi.model } : {}),
      ...(config.pi.apiKey !== undefined ? { piApiKey: config.pi.apiKey } : {}),
    },
    log: (message) => console.log(message),
  });

  const server = createBackendHttpServer({
    runtime,
    projects,
    generation: stack.generation,
    orchestrator,
    stack,
    importer,
    runtimeStatus,
    skills: skillRegistry,
    skillSummaries,
    modelSettings,
  });
  server.listen(config.port, () => {
    console.log(
      `PaperTeam Backend listening on http://localhost:${config.port}` +
        ` (GET /health, GET /api/runtime/status, GET|POST /api/projects,` +
        ` POST /api/projects/:id/generate, POST /api/projects/:id/workflows,` +
        ` GET /api/runs/:runId[/events])`,
    );
  });

  registerShutdown(server, runtime, orchestrator);
}

function loadDotEnvBestEffort(): void {
  // 依次尝试：当前工作目录 → backend/ → 仓库根
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(here, "..", ".env"),
    resolve(here, "..", "..", ".env"),
  ];
  const envFile = findEnvFile(candidates);
  if (!envFile) {
    return;
  }
  const applied = applyEnvFile(process.env, envFile.values);
  console.log(`  dotenv:       ${envFile.path}（载入 ${applied.length} 个变量）`);
}

function reportRuntimeHealth(health: RuntimeHealth): void {
  const latency = health.latencyMs === null ? "" : `（${health.latencyMs}ms）`;
  if (health.ok) {
    console.log(`Pi Runtime: healthy${latency}`);
    console.log(`  detail: ${health.detail}`);
    return;
  }
  console.log(`Pi Runtime: unavailable（${health.status}）${latency}`);
  console.log(`  reason: ${health.detail}`);
}

function registerShutdown(
  server: import("node:http").Server,
  runtime: AgentRuntime,
  orchestrator: WorkflowOrchestrator,
): void {
  const shutdown = (signal: string) => {
    console.log(`\nPaperTeam Backend shutting down (${signal})...`);
    // 先停编排器（请求取消活跃 run 并等循环退出，checkpoint 已随执行落盘），
    // 再收敛 Runtime 在途 run / 释放全部 AgentSession，最后关 HTTP 服务
    // （SSE 长连接会阻止 server.close 完成，主动 closeAllConnections 让退出即时、干净）
    void orchestrator
      .close()
      .catch(() => {})
      .finally(() => {
        void runtime.close().catch(() => {});
        server.closeAllConnections?.();
        server.close(() => {
          process.exit(0);
        });
        // 兜底：close 回调因 keep-alive 连接悬挂时强制退出
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startBackend().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[paperteam] 启动失败：${message}`);
    process.exitCode = 1;
  });
}
