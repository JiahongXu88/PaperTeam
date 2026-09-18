/**
 * Live Evaluation Runtime（M6.9.1）：为真实模型评估构建 AgentRuntime。
 *
 * 禁区（任务纪律）：不新增 HTTP 调用、不新增 provider、不绕过 ModelRuntime。
 * 构造路径与 backend/src/index.ts 完全同源，只是少了 Web 服务与 workflow 装配：
 *
 *   applyEnvFile（.env 只补缺，真实环境变量优先）
 *   → loadConfig（PAPERTEAM_RUNTIME_ROOT / PAPERTEAM_PI_* 等）
 *   → ModelSettingsStore（<runtimeRoot>/settings/model.json 本地偏好）
 *   → resolveStartupModelSpec（--model > env PAPERTEAM_PI_MODEL > model.json）
 *   → ModelRuntime.create（auth.json / models.json 在 config.pi.agentDir）
 *   → registerStoredCustomProviders（Settings UI 自定义 provider 先注入）
 *   → new PiRuntimeAdapter（evaluation 不注入 skills / 角色工具面：
 *     live 臂只用自包含 prompt 的生成与 judge，不依赖工作区工具）
 *
 * API Key 仍由 Pi 官方 credential store（auth.json）解析，本文件不接触
 * key 本体；evaluaton 进程结束前必须 close()（收敛会话、释放资源）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/config.js";
import { applyEnvFile, findEnvFile } from "../config/envFile.js";
import { PiRuntimeAdapter, parseModelSpec } from "../runtime/PiRuntimeAdapter.js";
import { CustomProviderStore } from "../settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../settings/ModelSettingsStore.js";

/** .env 候选路径（npm run evaluation 从仓库根起跑：cwd → backend → 仓库根兜底） */
function loadDotEnvBestEffort(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "backend", ".env"),
    resolve(".env"),
  ];
  const envFile = findEnvFile(candidates);
  if (envFile !== null) {
    applyEnvFile(process.env, envFile.values);
  }
}

export interface LiveRuntimeHandle {
  runtime: PiRuntimeAdapter;
  /** 实际生效的模型规格（"provider/model-id"） */
  modelSpec: string;
  provider: string;
  modelId: string;
  /** 规格来源（报告可审计） */
  specSource: "cli" | "env" | "settings";
  /** Pi 凭据 / 模型目录（不含 key 本体） */
  agentDir: string;
  /** 会话 cwd 解析根（跑完即删） */
  workspaceRoot: string;
  /** 释放 Runtime 与临时 workspace（幂等语义由 Adapter.close 保证） */
  close: () => Promise<void>;
}

export async function createLiveEvaluationRuntime(options: {
  /** CLI 显式模型规格（"provider/model-id"）；缺省走产品解析链 */
  modelSpec?: string;
  log?: (message: string) => void;
}): Promise<LiveRuntimeHandle> {
  const log = options.log ?? (() => {});
  loadDotEnvBestEffort();
  const config = loadConfig();

  const modelSettingsStore = new ModelSettingsStore({
    settingsDir: join(config.runtimeRoot, "settings"),
  });
  const stored = await modelSettingsStore.load();
  const specSource: LiveRuntimeHandle["specSource"] =
    options.modelSpec !== undefined
      ? "cli"
      : config.pi.model !== undefined
        ? "env"
        : stored.model !== undefined
          ? "settings"
          : "cli";
  const resolvedSpec = options.modelSpec ?? (await resolveStartupModelSpec(config.pi.model, modelSettingsStore));
  if (resolvedSpec === undefined) {
    throw new Error(
      "live 模式未解析到模型：--model <provider/model-id>、PAPERTEAM_PI_MODEL、" +
        `<runtimeRoot>/settings/model.json 均为空（runtimeRoot=${config.runtimeRoot}）`,
    );
  }
  const parsed = parseModelSpec(resolvedSpec);
  if (parsed === undefined) {
    throw new Error(`模型规格非法："${resolvedSpec}"（应为 provider/model-id）`);
  }

  // 共享 ModelRuntime：与产品同一 credential store（auth.json 优先 > 标准环境变量）
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.pi.agentDir, "auth.json"),
    modelsPath: join(config.pi.agentDir, "models.json"),
  });
  // Settings 保存的自定义 provider 先注入（真实链路同序）
  const customProviderStore = new CustomProviderStore({
    settingsDir: join(config.runtimeRoot, "settings"),
  });
  const customProviderCount = await registerStoredCustomProviders(modelRuntime, customProviderStore, log);
  if (customProviderCount > 0) {
    log(`[live-eval] 自定义 provider 已注入：${customProviderCount} 个`);
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), "paperteam-eval-live-"));
  const runtime = new PiRuntimeAdapter({
    modelSpec: resolvedSpec,
    agentDir: config.pi.agentDir,
    workspaceRoot,
    runTimeoutMs: config.pi.runTimeoutMs,
    modelRuntime,
    // per-Agent override 与产品同源（model.json agents 字段；缺省键继承默认模型）
    agentModelSpecs: async () => (await modelSettingsStore.load()).agents ?? {},
    log,
  });

  // 预检：Runtime 健康 + 模型就绪（auth 缺失在这里暴露，不拖到首臂运行）
  const health = await runtime.healthCheck();
  if (!health.ok) {
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    throw new Error(`live Runtime 预检失败（${health.status}）：${health.detail}`);
  }
  const modelStatus = await runtime.modelStatusSnapshot?.();
  if (modelStatus !== undefined && modelStatus.phase === "not_configured") {
    const detail = modelStatus.detail;
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    throw new Error(`模型未就绪（provider ${parsed.provider} 需要有效凭据）：${detail}`);
  }
  log(
    `[live-eval] Runtime 就绪：model=${resolvedSpec}（来源 ${specSource}）` +
      `${modelStatus !== undefined ? `；provider 凭据：${modelStatus.providers.join(", ") || "(无)"}` : ""}`,
  );

  return {
    runtime,
    modelSpec: resolvedSpec,
    provider: parsed.provider,
    modelId: parsed.modelId,
    specSource,
    agentDir: config.pi.agentDir,
    workspaceRoot,
    close: async () => {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
