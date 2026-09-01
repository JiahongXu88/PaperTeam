import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config/config.js";
import { applyEnvFile, findEnvFile } from "./config/envFile.js";
import { GenerationService } from "./generation/GenerationService.js";
import { createBackendHttpServer } from "./httpServer.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { ProjectStore } from "./project/ProjectStore.js";
import { OpenClawRuntimeAdapter } from "./runtime/OpenClawRuntimeAdapter.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";
import { WriterService } from "./writer/WriterService.js";

/**
 * PaperTeam Backend 启动入口（M2.1：OpenClaw 2.0 Runtime Upgrade）。
 *
 * 启动流程：
 *   1. 加载 .env（可选，仅补缺，不覆盖真实环境变量）
 *   2. 加载并校验配置
 *   3. 装配服务：ProjectStore / WriterService / GenerationService / LatexCompiler
 *   4. 初始化 OpenClawRuntimeAdapter（基于官方 @openclaw/gateway-client）
 *   5. 对 OpenClaw Gateway 执行一次健康检查并输出结果
 *   6. 启动 HTTP 服务（GET /health + 项目 API）；shutdown 时释放 Runtime 连接
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
  console.log(`  gateway:      ${config.gateway.url}`);
  console.log(`  projectsRoot: ${config.projectsRoot}`);
  console.log(`  writerAgent:  ${config.writerAgentId}`);

  const runtime: AgentRuntime = new OpenClawRuntimeAdapter({
    baseUrl: config.gateway.url,
    apiKey: config.gateway.apiKey,
    timeoutMs: config.gateway.healthTimeoutMs,
    rpcTimeoutMs: config.gateway.rpcTimeoutMs,
    runTimeoutMs: config.gateway.runTimeoutMs,
  });

  const projects = new ProjectStore({ root: config.projectsRoot });
  const writer = new WriterService({
    runtime,
    agentId: config.writerAgentId,
    log: (message) => console.log(message),
  });
  const latex = new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs });
  const generation = new GenerationService({
    projects,
    writer,
    latex,
    log: (message) => console.log(message),
  });

  const health = await runtime.healthCheck();
  reportGatewayHealth(health);

  const server = createBackendHttpServer({ runtime, projects, generation });
  server.listen(config.port, () => {
    console.log(
      `PaperTeam Backend listening on http://localhost:${config.port}` +
        ` (GET /health, POST /api/projects, POST /api/projects/:id/generate)`,
    );
  });

  registerShutdown(server, runtime);
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

function reportGatewayHealth(health: RuntimeHealth): void {
  if (health.ok) {
    const latency = health.latencyMs === null ? "" : `（${health.latencyMs}ms）`;
    console.log(`OpenClaw Gateway: healthy${latency}`);
    return;
  }
  console.log("OpenClaw Gateway: unavailable");
  console.log(`  reason: ${health.detail}`);
  console.log(
    "  提示：GET /health 会持续报告 Gateway 状态；请确认 Gateway 已启动并检查 OPENCLAW_GATEWAY_URL。",
  );
}

function registerShutdown(server: import("node:http").Server, runtime: AgentRuntime): void {
  const shutdown = (signal: string) => {
    console.log(`\nPaperTeam Backend shutting down (${signal})...`);
    // 先释放 Runtime 在途连接（避免 dangling WebSocket / 定时器残留），
    // 再关 HTTP 服务；两者并行，任一完成即可退出
    void runtime.close?.().catch(() => {});
    server.close(() => {
      process.exit(0);
    });
    // 兜底：close 回调因 keep-alive 连接悬挂时强制退出
    setTimeout(() => process.exit(0), 5000).unref();
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
