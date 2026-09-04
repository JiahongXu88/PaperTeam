import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config/config.js";
import { applyEnvFile, findEnvFile } from "./config/envFile.js";
import { createBackendHttpServer } from "./httpServer.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { ProjectStore } from "./project/ProjectStore.js";
import { OpenClawRuntimeAdapter } from "./runtime/OpenClawRuntimeAdapter.js";
import { PiRuntimeAdapter } from "./runtime/PiRuntimeAdapter.js";
import { RuntimeStatusService } from "./runtime/statusService.js";
import { OPENCLAW_RUNTIME_VERSION } from "./dev/runtimeConfig.js";
import { resolveRuntimePaths } from "./dev/runtimePaths.js";
import { PI_RUNTIME_VERSION } from "./runtime/pi/version.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";
import { buildServiceStack } from "./serviceStack.js";
import { LatexImporter } from "./import/LatexImporter.js";
import {
  createExistingPaperDefinition,
  createIdeaToPaperDefinition,
} from "./workflow/definitions.js";
import { WorkflowOrchestrator } from "./workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "./workflow/runStore.js";

/**
 * PaperTeam Backend 启动入口（M3.0：Workflow Foundation）。
 *
 * 启动流程：
 *   1. 加载 .env（可选，仅补缺，不覆盖真实环境变量）
 *   2. 加载并校验配置
 *   3. 装配服务：ProjectStore / WriterService / GenerationService / LatexCompiler
 *   4. 初始化 OpenClawRuntimeAdapter（基于官方 @openclaw/gateway-client）
 *   5. 对 OpenClaw Gateway 执行一次健康检查并输出结果
 *   6. 装配 WorkflowOrchestrator 并恢复中断的 WorkflowRun（checkpoint 恢复）
 *   7. 启动 HTTP 服务；shutdown 时先停编排器再释放 Runtime 连接
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
  console.log(`  runtime:      ${config.agentRuntime}`);
  if (config.agentRuntime === "openclaw") {
    console.log(`  gateway:      ${config.gateway.url}`);
  } else {
    console.log(`  pi:           model=${config.pi.model ?? "(未配置)"} agentDir=${config.pi.agentDir ?? "(runtimeRoot/pi/agent)"}`);
  }
  console.log(`  projectsRoot: ${config.projectsRoot}`);
  console.log(`  agents:       researcher=${config.agents.researcher} writer=${config.agents.writer} reviewer=${config.agents.reviewer} citation=${config.agents.citation}`);

  // M3.7：Runtime 选择（默认 openclaw；PAPERTEAM_AGENT_RUNTIME=pi 时 in-process）
  let runtime: AgentRuntime;
  if (config.agentRuntime === "pi") {
    runtime = new PiRuntimeAdapter({
      ...(config.pi.model !== undefined ? { modelSpec: config.pi.model } : {}),
      ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
      agentDir: config.pi.agentDir ?? join(resolveRuntimePaths().root, "runtime", "pi", "agent"),
      workspaceRoot: config.projectsRoot,
      runTimeoutMs: config.pi.runTimeoutMs,
    });
  } else {
    runtime = new OpenClawRuntimeAdapter({
      baseUrl: config.gateway.url,
      apiKey: config.gateway.apiKey,
      timeoutMs: config.gateway.healthTimeoutMs,
      rpcTimeoutMs: config.gateway.rpcTimeoutMs,
      runTimeoutMs: config.gateway.runTimeoutMs,
    });
  }

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

  const health = await runtime.healthCheck();
  reportRuntimeHealth(health);

  // M3.5：Runtime 诊断（GET /api/runtime/status）
  const runtimeStatus = new RuntimeStatusService({
    runtime,
    agentIds: config.agents,
    expectedRuntimeVersion:
      config.agentRuntime === "pi" ? PI_RUNTIME_VERSION : OPENCLAW_RUNTIME_VERSION,
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

  const server = createBackendHttpServer({
    runtime,
    projects,
    generation: stack.generation,
    orchestrator,
    stack,
    importer,
    runtimeStatus,
  });
  server.listen(config.port, () => {
    console.log(
      `PaperTeam Backend listening on http://localhost:${config.port}` +
        ` (GET /health, GET /api/runtime/status, POST /api/projects,` +
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
  if (health.ok) {
    const latency = health.latencyMs === null ? "" : `（${health.latencyMs}ms）`;
    console.log(`${health.provider === "pi" ? "Pi Runtime" : "OpenClaw Gateway"}: healthy${latency}`);
    if (health.provider === "pi") {
      console.log(`  detail: ${health.detail}`);
    }
    return;
  }
  console.log(
    `${health.provider === "pi" ? "Pi Runtime" : "OpenClaw Gateway"}: unavailable（${health.status}）`,
  );
  console.log(`  reason: ${health.detail}`);
  if (health.provider === "openclaw") {
    console.log(
      "  提示：GET /health 会持续报告 Gateway 状态；请确认 Gateway 已启动并检查 OPENCLAW_GATEWAY_URL。",
    );
  }
}

function registerShutdown(
  server: import("node:http").Server,
  runtime: AgentRuntime,
  orchestrator: WorkflowOrchestrator,
): void {
  const shutdown = (signal: string) => {
    console.log(`\nPaperTeam Backend shutting down (${signal})...`);
    // 先停编排器（请求取消活跃 run 并等循环退出，checkpoint 已随执行落盘），
    // 再释放 Runtime 在途连接，最后关 HTTP 服务（SSE 长连接会阻止
    // server.close 完成，主动 closeAllConnections 让退出即时、干净）
    void orchestrator
      .close()
      .catch(() => {})
      .finally(() => {
        void runtime.close?.().catch(() => {});
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
