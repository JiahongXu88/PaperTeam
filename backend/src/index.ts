import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config/config.js";
import { applyEnvFile, findEnvFile } from "./config/envFile.js";
import { createBackendHttpServer } from "./httpServer.js";
import { OpenClawRuntimeAdapter } from "./runtime/OpenClawRuntimeAdapter.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";

/**
 * PaperTeam Backend 启动入口（M1：Runtime Skeleton）。
 *
 * 启动流程：
 *   1. 加载 .env（可选，仅补缺，不覆盖真实环境变量）
 *   2. 加载并校验配置
 *   3. 初始化 OpenClawRuntimeAdapter（AgentRuntime 第一版实现）
 *   4. 对 OpenClaw Gateway 执行一次健康检查并输出结果
 *   5. 启动最小 HTTP 服务（GET /health）
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

  console.log(`  env:     ${config.env}`);
  console.log(`  gateway: ${config.gateway.url}`);

  const runtime: AgentRuntime = new OpenClawRuntimeAdapter({
    baseUrl: config.gateway.url,
    apiKey: config.gateway.apiKey,
    timeoutMs: config.gateway.healthTimeoutMs,
  });

  const health = await runtime.healthCheck();
  reportGatewayHealth(health);

  const server = createBackendHttpServer({ runtime });
  server.listen(config.port, () => {
    console.log(`PaperTeam Backend listening on http://localhost:${config.port} (GET /health)`);
  });

  registerShutdown(server);
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
  console.log(`  dotenv:  ${envFile.path}（载入 ${applied.length} 个变量）`);
}

function reportGatewayHealth(health: RuntimeHealth): void {
  if (health.ok) {
    const latency = health.latencyMs === null ? "" : `（${health.latencyMs}ms）`;
    console.log(`OpenClaw Gateway: healthy${latency}`);
    return;
  }
  console.log("OpenClaw Gateway: unavailable");
  console.log(`  reason: ${health.detail}`);
  console.log("  提示：GET /health 会持续报告 Gateway 状态；请确认 Gateway 已启动并检查 OPENCLAW_GATEWAY_URL。");
}

function registerShutdown(server: import("node:http").Server): void {
  const shutdown = (signal: string) => {
    console.log(`\nPaperTeam Backend shutting down (${signal})...`);
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
