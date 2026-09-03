/**
 * Runtime Bootstrap CLI（M3.5）：`npm run dev` 的实际执行体。
 *
 * 由仓库根 scripts/dev.mjs 在确保依赖与构建后调用（node dist/dev/cli.js）。
 * 完整流程：
 *
 *   1. 解析 PaperTeam 用户级 Runtime 路径（默认 ~/.paperteam，与 ~/.openclaw 硬隔离）
 *   2. 读取/生成 runtime.json（精确 OpenClaw 版本、Gateway 端口、随机 token）
 *   3. 校验项目本地 openclaw 安装与锁定的版本一致
 *   4. 准备独立 OpenClaw state 目录 + 最小 config（gateway.mode=local）
 *   5. 启动 Gateway（OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH / OPENCLAW_GATEWAY_TOKEN）
 *   6. 等待 /health 就绪（超时报错并附 Gateway 日志提示）
 *   7. 启动 Backend（注入 OPENCLAW_GATEWAY_URL / API Key / 端口）
 *   8. Ctrl+C / SIGTERM → 先停 Backend 再停 Gateway（无孤儿进程）
 *
 * 模型凭据不属于 Bootstrap：Gateway 无凭据也能健康启动，Agent 调用阶段的
 * “model not configured” 由 GET /api/runtime/status 如实报告。
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveOpenClawInstall, gatewayProcessEnv, prepareOpenClawState } from "./openclawState.js";
import { waitForGatewayHealth } from "./gatewayHealth.js";
import { loadRuntimeConfig, summarizeRuntimeConfig } from "./runtimeConfig.js";
import { BootstrapError, resolveRuntimePaths } from "./runtimePaths.js";
import { DevSupervisor } from "./supervisor.js";

function repoRootFromDist(distDir: string): string {
  // dist/dev/cli.ts → <repoRoot>/backend/dist/dev → backend → repoRoot
  return dirname(dirname(dirname(distDir)));
}

export async function runBootstrap(options: {
  log?: (message: string) => void;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<void> {
  const log = options.log ?? ((message) => console.log(message));
  const env = options.env ?? process.env;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = options.repoRoot ?? repoRootFromDist(here);

  console.log("PaperTeam Runtime Bootstrap");
  console.log(`  node:         ${process.version}`);
  console.log(`  repoRoot:     ${repoRoot}`);

  // 1. 路径与隔离
  const paths = resolveRuntimePaths(env);
  console.log(`  runtimeRoot:  ${paths.root}`);

  // 2. runtime.json（端口 / token / 版本）
  const runtimeConfig = await loadRuntimeConfig(paths.runtimeConfigPath, env);
  console.log(`  openclaw:     ${runtimeConfig.openclawVersion}（本地安装校验中...）`);

  // 3. 项目本地 OpenClaw 安装（版本精确一致）
  const install = await resolveOpenClawInstall(repoRoot, runtimeConfig.openclawVersion);
  console.log(`  gatewayBin:   ${install.entryPath}`);

  // 4. 独立 state / config
  const state = await prepareOpenClawState(paths);
  if (state.created) {
    console.log(`  stateDir:     ${state.stateDir}（首次初始化）`);
  } else {
    console.log(`  stateDir:     ${state.stateDir}`);
  }
  console.log(`  config:       ${state.configPath}`);
  const configSummary = summarizeRuntimeConfig(runtimeConfig);
  console.log(
    `  gatewayPort:  ${String(configSummary.gatewayPort)}  backendPort: ${String(configSummary.backendPort)}  token: ${String(configSummary.gatewayToken)}`,
  );

  // 5-6. Gateway + 健康等待
  const gatewayUrl = `http://127.0.0.1:${runtimeConfig.gatewayPort}`;
  const supervisor = new DevSupervisor({ log });
  supervisor.registerSignalHandlers();

  const gatewayEnv = gatewayProcessEnv(state, runtimeConfig, env);
  const backendEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENCLAW_GATEWAY_URL: gatewayUrl,
    OPENCLAW_GATEWAY_API_KEY: runtimeConfig.gatewayToken,
    PAPERTEAM_PORT: String(runtimeConfig.backendPort),
    NODE_ENV: env["NODE_ENV"] ?? "development",
  };

  console.log(`  gateway:      ${gatewayUrl}`);
  console.log("  ── 启动 OpenClaw Gateway ──");

  const backendDistEntry = join(repoRoot, "backend", "dist", "index.js");
  await supervisor.run(
    {
      command: process.execPath,
      args: [install.entryPath, "gateway", "--port", String(runtimeConfig.gatewayPort)],
      cwd: repoRoot,
      env: gatewayEnv,
    },
    async () => {
      await waitForGatewayHealth(gatewayUrl, {
        onPoll: (attempt, detail) => {
          if (attempt % 20 === 0) {
            log(`[gateway] 仍在等待就绪（第 ${attempt} 次探测：${detail}）`);
          }
        },
      });
    },
    {
      command: process.execPath,
      args: [backendDistEntry],
      cwd: join(repoRoot, "backend"),
      env: backendEnv,
    },
  );

  console.log("PaperTeam dev 已退出。");
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;

if (isDirectRun) {
  runBootstrap().catch((error: unknown) => {
    if (error instanceof BootstrapError) {
      console.error(`[paperteam-dev] ${error.message}`);
    } else {
      console.error("[paperteam-dev] 启动失败：", error);
    }
    process.exitCode = 1;
  });
}
