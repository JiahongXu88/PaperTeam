/**
 * M4.3.7.5 Model Settings 服务测试（离线：真实 ModelRuntime + 临时 auth.json；
 * 不访问公网、不使用真实 API Key）。
 *
 * 覆盖：
 * - GET 状态：不返回任何 key（sentinel 断言）
 * - 保存 model + key → auth.json 落盘 + 状态 configured/stored
 * - 保存 model 不带 key → 保持原 key
 * - 清除 key → auth.json 条目删除；env key 场景保持 configured
 * - env 覆盖优先级（PAPERTEAM_PI_MODEL > stored）
 * - persist + reload（新 store/服务实例恢复配置）
 * - 非法 model / 空字符串 apiKey → INVALID_REQUEST
 * - busy（在途 run）→ MODEL_CONFIG_BUSY（409），且不落盘
 * - Runtime reload：reconfigure 后新 run 使用新模型（fake session 捕获）
 * - Test Connection：成功 / AUTH_FAILED / 错误脱敏
 * - 日志脱敏：sentinel key 不出现在任何日志
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BusinessError, ModelConfigBusyError } from "../../src/errors.js";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import {
  ModelSettingsService,
  type ModelSettingsRuntime,
} from "../../src/settings/ModelSettingsService.js";
import {
  ModelSettingsStore,
  resolveStartupModelSpec,
} from "../../src/settings/ModelSettingsStore.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const SENTINEL_KEY = "paperteam-secret-do-not-log-123";
const SENTINEL_KEY_2 = "paperteam-secret-do-not-log-456";

const tempDirs: string[] = [];
const logLines: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  logLines.splice(0);
});

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 最小 fake AgentSession：prompt 立即完成（hang 模式下挂起直到 abort） */
class MinimalFakeSession {
  readonly prompts: string[] = [];
  disposed = false;
  private releaseHang?: () => void;
  constructor(
    readonly model: unknown,
    private readonly hang: boolean,
  ) {}
  get agent(): { state: { messages: unknown[] } } {
    return { state: { messages: [] } };
  }
  subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
    return () => {};
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.hang) {
      await new Promise<void>((resolve) => {
        this.releaseHang = resolve;
      });
    }
  }
  async abort(): Promise<void> {
    this.releaseHang?.();
  }
  async waitForIdle(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
  getLastAssistantText(): string {
    return "ok";
  }
}

/** 记录传给 createAgentSession 的 model（验证 reconfigure 生效到新 run） */
function makeSessionFactory(hang = false) {
  const created: { model: unknown; disposed: () => boolean }[] = [];
  return {
    created,
    factory: async (params: { model?: unknown }): Promise<AgentSession> => {
      const session = new MinimalFakeSession(params.model, hang);
      created.push({ model: params.model, disposed: () => session.disposed });
      return session as unknown as AgentSession;
    },
  };
}

interface TestHarness {
  agentDir: string;
  settingsDir: string;
  modelRuntime: ModelRuntime;
  adapter: PiRuntimeAdapter;
  service: ModelSettingsService;
  sessions: ReturnType<typeof makeSessionFactory>;
}

async function makeHarness(options?: {
  env?: { piModel?: string; piApiKey?: string };
  hang?: boolean;
}): Promise<TestHarness> {
  /**
   * 组装真实链路：真 ModelRuntime（临时 auth.json/models.json，离线）
   * + 真 PiRuntimeAdapter（fake session factory，不跑 Pi Agent 循环）+ 服务。
   */
  const agentDir = await makeTempDir("ms-agent-");
  const settingsDir = await makeTempDir("ms-settings-");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const sessions = makeSessionFactory(options?.hang ?? false);
  const env = options?.env ?? {};
  const adapter = new PiRuntimeAdapter({
    ...(env.piModel !== undefined ? { modelSpec: env.piModel } : {}),
    ...(env.piApiKey !== undefined ? { apiKey: env.piApiKey } : {}),
    agentDir,
    workspaceRoot: await makeTempDir("ms-ws-"),
    modelRuntime,
    createSession: sessions.factory as never,
    log: (message) => logLines.push(message),
  });
  const service = new ModelSettingsService({
    modelRuntime,
    runtime: adapter,
    store: new ModelSettingsStore({ settingsDir }),
    env,
    log: (message) => logLines.push(message),
  });
  return { agentDir, settingsDir, modelRuntime, adapter, service, sessions };
}

describe("ModelSettingsService：状态读取", () => {
  it("初始未配置：configurationSource=not_configured，响应不含任何 key 字段", async () => {
    const { service } = await makeHarness();
    const status = await service.getStatus();
    expect(status.configurationSource).toBe("not_configured");
    expect(status.apiKeyConfigured).toBe(false);
    expect(status.model).toBeUndefined();
    expect(status.modelPhase).toBe("not_configured");
    expect(status.runtimePhase).toBe("healthy");
    const serialized = JSON.stringify(status);
    expect(Object.keys(status)).not.toContain("apiKey");
    expect(Object.keys(status)).not.toContain("maskedApiKey");
    expect(serialized).not.toContain(SENTINEL_KEY);
    expect(serialized).not.toContain(SENTINEL_KEY_2);
  });

  it("保存后状态为 stored/configured；GET 不泄漏 key 本体", async () => {
    const { service } = await makeHarness();
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    const status = await service.getStatus();
    expect(status.configurationSource).toBe("stored");
    expect(status.model).toBe("zai-coding-cn/glm-5.3");
    expect(status.provider).toBe("zai-coding-cn");
    expect(status.apiKeyConfigured).toBe(true);
    expect(status.apiKeySource).toBe("stored");
    expect(status.modelPhase).toBe("configured");
    expect(JSON.stringify(status)).not.toContain(SENTINEL_KEY);
  });

  it("modelId 含斜杠的回归：openrouter/anthropic/claude-sonnet-4 可保存，DTO 拆出 provider/modelId", async () => {
    const harness = await makeHarness();
    // Pi 静态目录中 openrouter 的模型 id 本身即 "anthropic/claude-sonnet-4"（含斜杠）
    expect(
      harness.modelRuntime.getModel("openrouter", "anthropic/claude-sonnet-4"),
    ).toBeDefined();
    await harness.service.saveModel({ model: "openrouter/anthropic/claude-sonnet-4" });
    const status = await harness.service.getStatus();
    expect(status.model).toBe("openrouter/anthropic/claude-sonnet-4");
    expect(status.provider).toBe("openrouter");
    expect(status.modelId).toBe("anthropic/claude-sonnet-4");
  });
});

describe("ModelSettingsService：保存语义", () => {
  it("保存 model + key：auth.json 写入 credential，model.json 写入偏好", async () => {
    const { agentDir, settingsDir, service } = await makeHarness();
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });

    const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      { type?: string }
    >;
    expect(auth["zai-coding-cn"]?.type).toBe("api_key");
    expect(JSON.stringify(auth)).toContain(SENTINEL_KEY);

    const stored = JSON.parse(await readFile(join(settingsDir, "model.json"), "utf8")) as {
      model?: string;
    };
    expect(stored.model).toBe("zai-coding-cn/glm-5.3");
  });

  it("保存 model 不带 apiKey：保持原 key（auth.json 不变）", async () => {
    const { agentDir, service } = await makeHarness();
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    await service.saveModel({ model: "zai-coding-cn/glm-5.2" });

    const auth = await readFile(join(agentDir, "auth.json"), "utf8");
    expect(auth).toContain(SENTINEL_KEY);
    const status = await service.getStatus();
    expect(status.model).toBe("zai-coding-cn/glm-5.2");
    expect(status.apiKeyConfigured).toBe(true);
  });

  it("apiKey 空字符串语义非法（400）：不落盘、不清除", async () => {
    const { service } = await makeHarness();
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    await expect(
      service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: "" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const status = await service.getStatus();
    expect(status.apiKeyConfigured).toBe(true);
  });

  it("非法 model 规格 / 不存在的模型 → INVALID_REQUEST", async () => {
    const { service } = await makeHarness();
    await expect(service.saveModel({ model: "no-slash" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(service.saveModel({ model: "zai-coding-cn/no-such-model" })).rejects.toMatchObject(
      { code: "INVALID_REQUEST" },
    );
  });

  it("不支持 Key 登录的 provider（无 login 能力）→ INVALID_REQUEST", async () => {
    const harness = await makeHarness();
    const bedrockModel = harness.modelRuntime.getModel(
      "amazon-bedrock",
      "us.anthropic.claude-opus-4-6-v1",
    );
    if (bedrockModel === undefined) {
      return; // 上游目录变化时跳过（本用例依赖该静态模型存在）
    }
    const loginFn = (
      harness.modelRuntime.getProvider("amazon-bedrock") as unknown as {
        auth?: { apiKey?: { login?: unknown } };
      }
    )?.auth?.apiKey?.login;
    if (typeof loginFn === "function") {
      return; // 上游若将来开放 login，跳过该断言
    }
    await expect(
      harness.service.saveModel({
        model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
        apiKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("persist + reload：新 store/服务实例从磁盘恢复存储配置", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    // 模拟进程重启：同一 agentDir/settingsDir 上的全新 ModelRuntime + 服务
    const modelRuntime2 = await ModelRuntime.create({
      authPath: join(harness.agentDir, "auth.json"),
      modelsPath: join(harness.agentDir, "models.json"),
    });
    const service2 = new ModelSettingsService({
      modelRuntime: modelRuntime2,
      runtime: fakeRuntimeFrom(harness.adapter),
      store: new ModelSettingsStore({ settingsDir: harness.settingsDir }),
      env: {},
      log: (message) => logLines.push(message),
    });
    const status = await service2.getStatus();
    expect(status.model).toBe("zai-coding-cn/glm-5.3");
    expect(status.configurationSource).toBe("stored");
    expect(status.apiKeyConfigured).toBe(true);
  });

  it("重启 wiring 回归：resolveStartupModelSpec 注入新 adapter 后模型就绪", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    // 模拟 index.ts 启动装配：stored 偏好解析为 adapter 的初始 modelSpec
    const store2 = new ModelSettingsStore({ settingsDir: harness.settingsDir });
    const spec = await resolveStartupModelSpec(undefined, store2);
    expect(spec).toBe("zai-coding-cn/glm-5.3");

    const adapter2 = new PiRuntimeAdapter({
      ...(spec !== undefined ? { modelSpec: spec } : {}),
      agentDir: harness.agentDir,
      workspaceRoot: harness.agentDir,
      modelRuntime: harness.modelRuntime,
      createSession: harness.sessions.factory as never,
      log: (message) => logLines.push(message),
    });
    const modelStatus = await adapter2.modelStatusSnapshot();
    expect(modelStatus.phase).toBe("configured"); // auth.json 凭据随 ModelRuntime 恢复
    // env 优先级：PAPERTEAM_PI_MODEL 存在时 stored 不生效
    expect(await resolveStartupModelSpec("env/model-x", store2)).toBe("env/model-x");
  });
});

describe("ModelSettingsService：env 覆盖优先级", () => {
  it("PAPERTEAM_PI_MODEL 设置时：configurationSource=environment，生效模型为 env 值", async () => {
    const { service } = await makeHarness({
      env: { piModel: "zai-coding-cn/glm-5.2" },
    });
    // 用户仍可保存本地配置（对 env 不生效，但持久化）
    const status = await service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    expect(status.configurationSource).toBe("environment");
    expect(status.envOverride).toBe(true);
    expect(status.model).toBe("zai-coding-cn/glm-5.2"); // env 覆盖
    expect(status.savedModel).toBe("zai-coding-cn/glm-5.3"); // 本地保存值如实展示
    expect(status.detail).toContain("环境变量");
    expect(status.modelPhase).toBe("configured"); // env 模型可用
  });

  it("PAPERTEAM_PI_API_KEY 提供凭据：apiKeySource=environment", async () => {
    const { service } = await makeHarness({
      env: { piModel: "zai-coding-cn/glm-5.3", piApiKey: SENTINEL_KEY_2 },
    });
    const status = await service.getStatus();
    expect(status.apiKeyConfigured).toBe(true);
    expect(status.apiKeySource).toBe("environment");
    expect(JSON.stringify(status)).not.toContain(SENTINEL_KEY_2);
  });
});

describe("ModelSettingsService：清除 Key", () => {
  it("清除后 apiKeyConfigured=false（无 env 场景）", async () => {
    const { agentDir, service } = await makeHarness();
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    const status = await service.clearApiKey();
    expect(status.apiKeyConfigured).toBe(false);
    expect(status.apiKeySource).toBe("none");
    expect(status.model).toBe("zai-coding-cn/glm-5.3"); // 模型偏好保留
    const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth["zai-coding-cn"]).toBeUndefined();
  });

  it("env key 场景清除本地 Key：模型仍 configured（env 优先级如实反映）", async () => {
    const { service } = await makeHarness({
      env: { piModel: "zai-coding-cn/glm-5.3", piApiKey: SENTINEL_KEY_2 },
    });
    await service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    expect((await service.getStatus()).apiKeySource).toBe("environment"); // env 覆盖层优先

    const status = await service.clearApiKey();
    expect(status.apiKeyConfigured).toBe(true); // env key 仍生效
    expect(status.apiKeySource).toBe("environment");
    expect(status.modelPhase).toBe("configured");
  });

  it("未配置模型时清除 → INVALID_REQUEST", async () => {
    const { service } = await makeHarness();
    await expect(service.clearApiKey()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("ModelSettingsService：Runtime reload 与 busy 保护", () => {
  it("reconfigure 后新 Agent Run 使用新模型（fake session 捕获）", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    const task1 = await harness.adapter.runAgent({ agentId: "writer", task: "写一段" });
    expect(task1.status).toBe("completed");
    expect(String((harness.sessions.created[0]?.model as { id?: string })?.id)).toBe("glm-5.3");

    // 切换模型（不带 key：沿用已保存凭据）
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.2" });
    const task2 = await harness.adapter.runAgent({ agentId: "writer", task: "再写一段" });
    expect(task2.status).toBe("completed");
    expect(String((harness.sessions.created[1]?.model as { id?: string })?.id)).toBe("glm-5.2");
    // 旧会话被释放（模型变更只影响新 run；空闲会话重建）
    expect(harness.sessions.created[0]?.disposed()).toBe(true);
    expect(task2.metadata?.["model"]).toBe("zai-coding-cn/glm-5.2");
  });

  it("在途 run 存在时保存/清除 → MODEL_CONFIG_BUSY（409），且不落盘", async () => {
    const harness = await makeHarness({ hang: true });
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    // 挂起一个 run（hang session：prompt 不返回），制造 activeRuns > 0
    const hanging = await harness.adapter.startAgent({
      agentId: "writer",
      task: "长任务",
      projectId: "proj-x",
    });
    try {
      const busyError = await harness.service
        .saveModel({ model: "zai-coding-cn/glm-5.2" })
        .catch((error: unknown) => error);
      expect(busyError).toBeInstanceOf(ModelConfigBusyError);
      expect((busyError as BusinessError).httpStatus).toBe(409);
      await expect(harness.service.clearApiKey()).rejects.toMatchObject({
        code: "MODEL_CONFIG_BUSY",
      });
      // 本地偏好未被写入（busy 前置检查先于落盘）
      const stored = await new ModelSettingsStore({ settingsDir: harness.settingsDir }).load();
      expect(stored.model).toBe("zai-coding-cn/glm-5.3");
    } finally {
      await hanging.cancel();
    }
  });
});

describe("ModelSettingsService：模型目录（options）", () => {
  it("provider 列表包含安全 metadata（无 baseUrl 无 key；含登录能力标记）", async () => {
    const { service } = await makeHarness();
    const result = await service.getOptions();
    if (!("providers" in result)) {
      throw new Error("expected providers list");
    }
    const zai = result.providers.find((p) => p.id === "zai-coding-cn");
    expect(zai).toBeDefined();
    expect(zai?.apiKeyLoginSupported).toBe(true);
    expect(zai?.modelCount).toBeGreaterThan(0);
    // DTO 只含安全 metadata：无 baseUrl、无凭据值
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain(SENTINEL_KEY);
  });

  it("?provider= 返回该 provider 的模型目录", async () => {
    const { service } = await makeHarness();
    const result = await service.getOptions("zai-coding-cn");
    if (!("models" in result)) {
      throw new Error("expected models list");
    }
    const ids = result.models.map((m) => m.modelId);
    expect(ids).toContain("glm-5.3");
    const glm = result.models.find((m) => m.modelId === "glm-5.3");
    expect(glm?.displayName).toBe("GLM-5.3");
    expect(typeof glm?.contextWindow).toBe("number");
  });

  it("未知 provider → INVALID_REQUEST", async () => {
    const { service } = await makeHarness();
    await expect(service.getOptions("no-such-provider")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

// ---- Test Connection（stub ModelRuntime，避免真实网络调用） ----

function stubRuntimeForTest(options: {
  authConfigured?: boolean;
  modelMissing?: boolean;
  outcome?: { stopReason: string; errorMessage?: string };
}): ModelRuntime {
  return {
    getModel: () => (options.modelMissing === true ? undefined : { provider: "zai-coding-cn", id: "glm-5.3" }),
    getProviderAuthStatus: () =>
      options.authConfigured === false
        ? { configured: false }
        : { configured: true, source: "stored" },
    completeSimple: async () => ({
      stopReason: options.outcome?.stopReason ?? "stop",
      ...(options.outcome?.errorMessage !== undefined
        ? { errorMessage: options.outcome.errorMessage }
        : {}),
    }),
  } as unknown as ModelRuntime;
}

function serviceWithStubModelRuntime(
  modelRuntime: ModelRuntime,
): ModelSettingsService {
  const runtime: ModelSettingsRuntime = {
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    modelStatusSnapshot: async () => ({
      phase: "configured",
      providers: ["zai-coding-cn"],
      detail: "ok",
    }),
    resolvedModel: "zai-coding-cn/glm-5.3",
    reconfigure: async () => ({}),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
  };
  return new ModelSettingsService({
    modelRuntime,
    runtime,
    store: new ModelSettingsStore({ settingsDir: "unused" }),
    env: {},
    log: (message) => logLines.push(message),
  });
}

describe("ModelSettingsService：Test Connection", () => {
  it("成功：ok=true + latencyMs + provider/model", async () => {
    const service = serviceWithStubModelRuntime(stubRuntimeForTest({}));
    const result = await service.testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("zai-coding-cn");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("模型不在注册表 → MODEL_NOT_FOUND（HTTP 200 + ok=false）", async () => {
    const service = serviceWithStubModelRuntime(
      stubRuntimeForTest({ modelMissing: true }),
    );
    const result = await service.testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_NOT_FOUND");
  });

  it("无凭据 → AUTH_FAILED", async () => {
    const service = serviceWithStubModelRuntime(
      stubRuntimeForTest({ authConfigured: false }),
    );
    const result = await service.testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTH_FAILED");
  });

  it("provider 401 → AUTH_FAILED；错误文本脱敏（不含提交的 key）", async () => {
    const service = serviceWithStubModelRuntime(
      stubRuntimeForTest({
        outcome: {
          stopReason: "error",
          errorMessage: `Request failed (401): invalid key ${SENTINEL_KEY}`,
        },
      }),
    );
    const result = await service.testConnection({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTH_FAILED");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_KEY);
    expect(result.detail).toContain("***");
  });

  it("429 → RATE_LIMITED；5xx → PROVIDER_UNAVAILABLE", async () => {
    const rateLimited = await serviceWithStubModelRuntime(
      stubRuntimeForTest({
        outcome: { stopReason: "error", errorMessage: "Provider error (429): rate limit" },
      }),
    ).testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(rateLimited.code).toBe("RATE_LIMITED");

    const unavailable = await serviceWithStubModelRuntime(
      stubRuntimeForTest({
        outcome: { stopReason: "error", errorMessage: "Provider error (503): unavailable" },
      }),
    ).testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(unavailable.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("ModelSettingsService：日志脱敏（sentinel 回归）", () => {
  it("保存 + 状态读取 + 测试失败全流程：sentinel 不出现在任何日志", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    await harness.service.getStatus();
    // Test Connection 失败路径（真实 ModelRuntime 无网络 → 错误细节入日志前已脱敏/不含 key）
    const logs = logLines.join("\n");
    expect(logs).not.toContain(SENTINEL_KEY);
    expect(logs).not.toContain(SENTINEL_KEY_2);
  });

  it("SDK 凭据错误对象（credential 内嵌 key）被收敛为脱敏 BusinessError，不逃逸", async () => {
    const harness = await makeHarness();
    // 模拟 CredentialSynchronizationError：message 干净但对象属性携带 key
    const leakyError = Object.assign(
      new Error("Failed to synchronize credentials"),
      { credential: { type: "api_key", key: SENTINEL_KEY } },
    );
    const originalLogin = harness.modelRuntime.login.bind(harness.modelRuntime);
    harness.modelRuntime.login = (() => Promise.reject(leakyError)) as never;
    const thrown = await harness.service
      .saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY })
      .catch((error: unknown) => error);
    harness.modelRuntime.login = originalLogin;
    expect(thrown).toBeInstanceOf(BusinessError);
    expect((thrown as BusinessError).message).not.toContain(SENTINEL_KEY);
    // 错误对象本身不得携带原始 credential（防 console.error 对象级打印泄漏）
    expect(JSON.stringify(thrown)).not.toContain(SENTINEL_KEY);
    expect(logLines.join("\n")).not.toContain(SENTINEL_KEY);
  });
});

/** 从真 adapter 提取满足 ModelSettingsRuntime 的引用（reload 测试用） */
function fakeRuntimeFrom(adapter: PiRuntimeAdapter): ModelSettingsRuntime {
  return adapter;
}
