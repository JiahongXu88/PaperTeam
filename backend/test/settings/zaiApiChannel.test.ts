/**
 * Z.AI API 通道（Coding Plan / General API）+ GLM-5.3 Test Connection reasoning 修复测试。
 *
 * 离线：真实 ModelRuntime（临时 auth.json/models.json，真实 Pi 静态目录）+
 * 真 PiRuntimeAdapter（fake session factory）；不访问公网——请求体经
 * onPayload / fetch 注入捕获后立即抛错，Test Connection 走真实错误分类路径。
 *
 * 覆盖（对应验收 A–J）：
 * - GLM-5.3 Test Connection：thinking enabled + reasoning_effort low（payload 级），
 *   不再发送 thinking.type=disabled（回归对照：不传 reasoning 时 Pi 的编码行为）
 * - reasoning 选择完全由模型 metadata 驱动（off 可用 → off；不支持 reasoning → 不注入）
 * - Coding Plan 默认：不注册 baseUrl override（Pi 内置 coding endpoint）
 * - General API：baseUrl override 到按量 endpoint（zai / zai-coding-cn 两家）
 * - Test Connection 与保存后真实 Runtime（fake session 捕获的模型）同一 endpoint
 * - 旧 settings 无 apiChannel → 默认 Coding Plan；General → Coding 切换清除 override
 * - 非双通道 provider / 非法值 / 在途 run（409）拒绝
 * - 日志含 channel/code/detail 且不泄漏 key
 * - classifyFailure：400 → BAD_REQUEST、Connection error → PROVIDER_UNAVAILABLE
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  applyStoredApiChannels,
  resolveApiChannelBaseUrl,
  supportsApiChannels,
} from "../../src/settings/apiChannels.js";
import { BusinessError } from "../../src/errors.js";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import {
  ModelSettingsService,
  type ModelSettingsRuntime,
} from "../../src/settings/ModelSettingsService.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";

const SENTINEL_KEY = "zai-channel-secret-do-not-log-789";

const ZAI_CODING_CN_DEFAULT = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_CODING_CN_GENERAL = "https://open.bigmodel.cn/api/paas/v4";
const ZAI_GLOBAL_CODING = "https://api.z.ai/api/coding/paas/v4";
const ZAI_GLOBAL_GENERAL = "https://api.z.ai/api/paas/v4";

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

/** 最小 fake AgentSession：prompt 立即完成（hang 模式挂起直到 abort） */
class FakeSession {
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
  async prompt(_text: string): Promise<void> {
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

interface Harness {
  agentDir: string;
  settingsDir: string;
  modelRuntime: ModelRuntime;
  adapter: PiRuntimeAdapter;
  service: ModelSettingsService;
  sessions: { created: { model: unknown; glm53ThinkingLevel?: unknown }[]; factory: unknown };
}

async function makeHarness(options?: { hang?: boolean }): Promise<Harness> {
  const agentDir = await makeTempDir("zac-agent-");
  const settingsDir = await makeTempDir("zac-settings-");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const created: { model: unknown; glm53ThinkingLevel?: unknown; disposed: () => boolean }[] = [];
  const factory = async (params: {
    model?: unknown;
    settingsManager?: { getModelThinkingLevel(provider: string, modelId: string): unknown };
  }): Promise<AgentSession> => {
    const session = new FakeSession(params.model, options?.hang ?? false);
    created.push({
      model: params.model,
      glm53ThinkingLevel: params.settingsManager?.getModelThinkingLevel("zai-coding-cn", "glm-5.3"),
      disposed: () => session.disposed,
    });
    return session as unknown as AgentSession;
  };
  const adapter = new PiRuntimeAdapter({
    modelSpec: "zai-coding-cn/glm-5.3",
    agentDir,
    workspaceRoot: await makeTempDir("zac-ws-"),
    modelRuntime,
    createSession: factory as never,
    log: (message) => logLines.push(message),
  });
  const service = new ModelSettingsService({
    modelRuntime,
    runtime: adapter,
    store: new ModelSettingsStore({ settingsDir }),
    customProviders: new CustomProviderStore({ settingsDir }),
    env: {},
    log: (message) => logLines.push(message),
  });
  return { agentDir, settingsDir, modelRuntime, adapter, service, sessions: { created, factory } };
}

/** 捕获 completeSimple 实际发出的 URL 与请求体（离线：fetch 立即抛错） */
interface CapturedRequest {
  url?: string;
  body?: Record<string, unknown>;
}

function captureCompleteSimpleRequests(
  modelRuntime: ModelRuntime,
  captured: CapturedRequest,
): () => void {
  const original = modelRuntime.completeSimple.bind(modelRuntime);
  modelRuntime.completeSimple = ((model: unknown, context: unknown, options = {}) =>
    (original as never as (...args: unknown[]) => Promise<unknown>)(model, context, {
      ...(options as Record<string, unknown>),
      fetch: (async (input: unknown) => {
        captured.url = String(input);
        throw new Error("Connection error. offline capture");
      }) as never,
      onPayload: (payload: unknown) => {
        captured.body = payload as Record<string, unknown>;
        return undefined;
      },
    })) as never;
  return () => {
    modelRuntime.completeSimple = original as never;
  };
}

/** 独立 runtime（stub completeSimple）的服务：直接断言传给 Pi 的 options */
function serviceWithCapturedCompleteSimple(
  capturedCalls: { model: unknown; options: Record<string, unknown> }[],
  options?: { model?: unknown },
): ModelSettingsService {
  const modelRuntime = {
    getModel: () =>
      options?.model ?? {
        provider: "zai-coding-cn",
        id: "glm-5.3",
        baseUrl: ZAI_CODING_CN_DEFAULT,
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      },
    getProvider: () => ({ id: "zai-coding-cn", auth: { apiKey: { login: () => {} } } }),
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    completeSimple: async (model: unknown, _context: unknown, opts: Record<string, unknown> = {}) => {
      capturedCalls.push({ model, options: opts });
      return { stopReason: "stop" };
    },
  } as unknown as ModelRuntime;
  const runtime: ModelSettingsRuntime = {
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    modelStatusSnapshot: async () => ({ phase: "configured", providers: ["zai-coding-cn"], detail: "ok" }),
    resolvedModel: "zai-coding-cn/glm-5.3",
    reconfigure: async () => ({}),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
  };
  return new ModelSettingsService({
    modelRuntime,
    runtime,
    store: new ModelSettingsStore({ settingsDir: "unused" }),
    customProviders: new CustomProviderStore({ settingsDir: "unused" }),
    env: {},
    log: (message) => logLines.push(message),
  });
}

// ---- GLM-5.3 reasoning 修复（验收 A/B：payload 级） ----

describe("Z.AI 通道：GLM-5.3 Test Connection reasoning", () => {
  it("GLM-5.3：thinking enabled + reasoning_effort low（不再发送 thinking.disabled）", async () => {
    const harness = await makeHarness();
    const captured: CapturedRequest = {};
    const restore = captureCompleteSimpleRequests(harness.modelRuntime, captured);
    try {
      const result = await harness.service.testConnection({
        model: "zai-coding-cn/glm-5.3",
        apiKey: SENTINEL_KEY,
      });
      expect(result.ok).toBe(false); // 离线：fetch 捕获后抛错
      expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    } finally {
      restore();
    }
    expect(captured.url).toContain(`${ZAI_CODING_CN_DEFAULT}/chat/completions`);
    expect(captured.body).toBeDefined();
    expect(captured.body!["thinking"]).toEqual({ type: "enabled", clear_thinking: false });
    expect(captured.body!["reasoning_effort"]).toBe("low");
    expect(captured.body!["max_tokens"]).toBe(64);
    // 修复回归对照：不显式给 reasoning 时 Pi 会编码 disabled（GLM-5.3 400 的根因）
    const regression = {} as CapturedRequest;
    const restoreRegression = captureCompleteSimpleRequests(harness.modelRuntime, regression);
    try {
      await harness.modelRuntime.completeSimple(
        harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3")!,
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
          ],
        } as never,
        { apiKey: SENTINEL_KEY },
      );
    } catch {
      // 离线捕获：预期抛错
    } finally {
      restoreRegression();
    }
    expect(regression.body!["thinking"]).toEqual({ type: "disabled" });
  });

  it("reasoning 选择由模型 metadata 驱动：off 可用 → off；不支持 reasoning → 不注入", async () => {
    const calls: { model: unknown; options: Record<string, unknown> }[] = [];
    // glm-5.2：thinkingLevelMap.off = "none"（off 可用）→ 不注入 reasoning
    const offCapable = serviceWithCapturedCompleteSimple(calls, {
      model: {
        provider: "zai-coding-cn",
        id: "glm-5.2",
        baseUrl: ZAI_CODING_CN_DEFAULT,
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
      },
    });
    await offCapable.testConnection({ model: "zai-coding-cn/glm-5.2", apiKey: "k" });
    expect(calls[0]!.options["reasoning"]).toBeUndefined();

    // 非 reasoning 模型：不注入 reasoning
    calls.splice(0);
    const nonReasoning = serviceWithCapturedCompleteSimple(calls, {
      model: { provider: "zai-coding-cn", id: "glm-air", baseUrl: ZAI_CODING_CN_DEFAULT, reasoning: false },
    });
    await nonReasoning.testConnection({ model: "zai-coding-cn/glm-air", apiKey: "k" });
    expect("reasoning" in calls[0]!.options ? calls[0]!.options["reasoning"] : undefined).toBeUndefined();

    // 仅高档位可用（metadata 变化后不依赖模型 id 硬编码）：最低可用档位 = high
    calls.splice(0);
    const highOnly = serviceWithCapturedCompleteSimple(calls, {
      model: {
        provider: "zai-coding-cn",
        id: "glm-future",
        baseUrl: ZAI_CODING_CN_DEFAULT,
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
      },
    });
    await highOnly.testConnection({ model: "zai-coding-cn/glm-future", apiKey: "k" });
    expect(calls[0]!.options["reasoning"]).toBe("high");
  });

  it("真实 Pi 目录回归：glm-5.3 → low；off 可用的模型 → 不注入", async () => {
    const calls: { model: unknown; options: Record<string, unknown> }[] = [];
    const harness = await makeHarness();
    const glm53 = harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3");
    expect(glm53).toBeDefined();
    const service = serviceWithCapturedCompleteSimple(calls, { model: glm53 });
    await service.testConnection({ model: "zai-coding-cn/glm-5.3", apiKey: "k" });
    expect(calls[0]!.options["reasoning"]).toBe("low");

    // zai-coding-cn/glm-4.6v：reasoning 但无 thinkingLevelMap → off 可用 → off
    const glm46v = harness.modelRuntime.getModel("zai-coding-cn", "glm-4.6v");
    expect(glm46v).toBeDefined();
    calls.splice(0);
    const glm46vService = serviceWithCapturedCompleteSimple(calls, { model: glm46v });
    await glm46vService.testConnection({ model: "zai-coding-cn/glm-4.6v", apiKey: "k" });
    expect(calls[0]!.options["reasoning"]).toBeUndefined();

    // zai/glm-5.2（全球目录）：thinkingLevelMap.off = "none" → off 可用 → off
    const glm52 = harness.modelRuntime.getModel("zai", "glm-5.2");
    expect(glm52).toBeDefined();
    calls.splice(0);
    const glm52Service = serviceWithCapturedCompleteSimple(calls, { model: glm52 });
    await glm52Service.testConnection({ model: "zai/glm-5.2", apiKey: "k" });
    expect(calls[0]!.options["reasoning"]).toBeUndefined();
  });
});

// ---- API 通道：resolver / 持久化 / Runtime 一致性 ----

describe("Z.AI 通道：endpoint resolver 与注册", () => {
  it("resolver：coding_plan / 非双通道 → undefined；general_api → 按量 endpoint", () => {
    expect(supportsApiChannels("zai")).toBe(true);
    expect(supportsApiChannels("zai-coding-cn")).toBe(true);
    expect(supportsApiChannels("anthropic")).toBe(false);
    expect(resolveApiChannelBaseUrl("zai", "coding_plan")).toBeUndefined();
    expect(resolveApiChannelBaseUrl("zai", undefined)).toBeUndefined();
    expect(resolveApiChannelBaseUrl("anthropic", "general_api")).toBeUndefined();
    expect(resolveApiChannelBaseUrl("zai", "general_api")).toBe(ZAI_GLOBAL_GENERAL);
    expect(resolveApiChannelBaseUrl("zai-coding-cn", "general_api")).toBe(ZAI_CODING_CN_GENERAL);
  });

  it("默认（无 apiChannel）：不注册 override，使用 Pi 内置 Coding endpoint；状态显示 coding_plan", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    expect(harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(
      ZAI_CODING_CN_DEFAULT,
    );
    const status = await harness.service.getStatus();
    expect(status.apiChannel).toBe("coding_plan");
    const stored = JSON.parse(await readFile(join(harness.settingsDir, "model.json"), "utf8")) as {
      apiChannel?: unknown;
    };
    expect(stored.apiChannel).toBeUndefined();
  });

  it("保存 general_api：model.json 绑定 + Runtime 注册按量 endpoint + 状态 general_api", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiChannel: "general_api" });
    expect(harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(
      ZAI_CODING_CN_GENERAL,
    );
    expect((await harness.service.getStatus()).apiChannel).toBe("general_api");
    const stored = JSON.parse(await readFile(join(harness.settingsDir, "model.json"), "utf8")) as {
      apiChannel?: { provider?: string; channel?: string };
    };
    expect(stored.apiChannel).toEqual({ provider: "zai-coding-cn", channel: "general_api" });
  });

  it("General → Coding：override 清除，不残留按量 endpoint", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY });
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiChannel: "general_api" });
    await harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiChannel: "coding_plan" });
    expect(harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(
      ZAI_CODING_CN_DEFAULT,
    );
    expect((await harness.service.getStatus()).apiChannel).toBe("coding_plan");
    const stored = JSON.parse(await readFile(join(harness.settingsDir, "model.json"), "utf8")) as {
      apiChannel?: unknown;
    };
    expect(stored.apiChannel).toBeUndefined();
  });

  it("zai（全球）同样支持：general → api.z.ai 按量 endpoint", async () => {
    const harness = await makeHarness();
    expect(harness.modelRuntime.getModel("zai", "glm-5.3")!.baseUrl).toBe(ZAI_GLOBAL_CODING);
    await harness.service.saveModel({ model: "zai/glm-5.3", apiKey: SENTINEL_KEY, apiChannel: "general_api" });
    expect(harness.modelRuntime.getModel("zai", "glm-5.3")!.baseUrl).toBe(ZAI_GLOBAL_GENERAL);
  });

  it("Test Connection 与保存后真实 Runtime 使用同一 endpoint（fake session 捕获）", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
      apiChannel: "general_api",
    });
    // 真实 Agent 路径：reconfigure 后新 run 的会话模型来自同一 getModel
    const task = await harness.adapter.runAgent({ agentId: "writer", task: "写一段" });
    expect(task.status).toBe("completed");
    const sessionModel = harness.sessions.created[0]!.model as { baseUrl?: string; id?: string };
    expect(sessionModel.baseUrl).toBe(ZAI_CODING_CN_GENERAL);
    expect(harness.sessions.created[0]!.glm53ThinkingLevel).toBe("low");

    // Test Connection 路径：同样请求按量 endpoint（payload 级）
    const captured: CapturedRequest = {};
    const restore = captureCompleteSimpleRequests(harness.modelRuntime, captured);
    try {
      await harness.service.testConnection({
        model: "zai-coding-cn/glm-5.3",
        apiChannel: "general_api",
      });
    } finally {
      restore();
    }
    expect(captured.url).toContain(`${ZAI_CODING_CN_GENERAL}/chat/completions`);
  });

  it("未保存也按所选通道测试：general_api 请求体走按量 endpoint", async () => {
    const harness = await makeHarness();
    const captured: CapturedRequest = {};
    const restore = captureCompleteSimpleRequests(harness.modelRuntime, captured);
    try {
      await harness.service.testConnection({
        model: "zai-coding-cn/glm-5.3",
        apiKey: SENTINEL_KEY,
        apiChannel: "general_api",
      });
    } finally {
      restore();
    }
    expect(captured.url).toContain(`${ZAI_CODING_CN_GENERAL}/chat/completions`);
    expect(captured.body!["thinking"]).toEqual({ type: "enabled", clear_thinking: false });
  });

  it("Test Connection 未传通道时回落到存储绑定（旧客户端与 Runtime 一致）", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
      apiChannel: "general_api",
    });
    const captured: CapturedRequest = {};
    const restore = captureCompleteSimpleRequests(harness.modelRuntime, captured);
    try {
      await harness.service.testConnection({ model: "zai-coding-cn/glm-5.3" });
    } finally {
      restore();
    }
    expect(captured.url).toContain(`${ZAI_CODING_CN_GENERAL}/chat/completions`);
  });

  it("persist + reload：新 ModelRuntime 重放 stored 绑定；旧 settings（无 apiChannel）默认 Coding", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
      apiChannel: "general_api",
    });
    // 模拟进程重启：全新 ModelRuntime + 启动重放（index.ts 同序）
    const modelRuntime2 = await ModelRuntime.create({
      authPath: join(harness.agentDir, "auth.json"),
      modelsPath: join(harness.agentDir, "models.json"),
    });
    expect(modelRuntime2.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(ZAI_CODING_CN_DEFAULT);
    await applyStoredApiChannels(
      modelRuntime2,
      new ModelSettingsStore({ settingsDir: harness.settingsDir }),
      (message) => logLines.push(message),
    );
    expect(modelRuntime2.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(ZAI_CODING_CN_GENERAL);

    // 旧 settings（无 apiChannel 字段）→ 默认 Coding，不注册 override
    const emptyDir = await makeTempDir("zac-empty-");
    const modelRuntime3 = await ModelRuntime.create({
      authPath: join(emptyDir, "auth.json"),
      modelsPath: join(emptyDir, "models.json"),
    });
    await applyStoredApiChannels(
      modelRuntime3,
      new ModelSettingsStore({ settingsDir: emptyDir }),
      () => {},
    );
    expect(modelRuntime3.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(ZAI_CODING_CN_DEFAULT);
  });

  it("切换到其他 provider 的模型：zai 绑定保留（provider 级隔离），状态视图不误报", async () => {
    const harness = await makeHarness();
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
      apiChannel: "general_api",
    });
    const status = await harness.service.saveModel({ model: "zai/glm-5.3" });
    // zai（全球）保持自己的默认 Coding endpoint（绑定只作用于 zai-coding-cn）
    expect(harness.modelRuntime.getModel("zai", "glm-5.3")!.baseUrl).toBe(ZAI_GLOBAL_CODING);
    expect(harness.modelRuntime.getModel("zai-coding-cn", "glm-5.3")!.baseUrl).toBe(
      ZAI_CODING_CN_GENERAL,
    );
    expect(status.provider).toBe("zai");
    expect(status.apiChannel).toBe("coding_plan");
  });

  it("非双通道 provider 传 apiChannel / 非法值 → INVALID_REQUEST", async () => {
    const harness = await makeHarness();
    await expect(
      harness.service.saveModel({ model: "zai-coding-cn/glm-5.3", apiChannel: "premium" as never }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      harness.service.saveModel({ model: "anthropic/claude-opus-4-5", apiChannel: "general_api" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      harness.service.testConnection({ model: "anthropic/claude-opus-4-5", apiChannel: "general_api" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      harness.service.testConnection({ model: "zai-coding-cn/glm-5.3", apiChannel: "nope" as never }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("在途 run 存在时切换通道 → MODEL_CONFIG_BUSY（409），不落盘", async () => {
    const hangHarness = await makeHarness({ hang: true });
    await hangHarness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
    });
    const hanging = await hangHarness.adapter.startAgent({
      agentId: "writer",
      task: "长任务",
      projectId: "proj-x",
    });
    try {
      const busyError = await hangHarness.service
        .saveModel({ model: "zai-coding-cn/glm-5.3", apiChannel: "general_api" })
        .catch((error: unknown) => error);
      expect(busyError).toBeInstanceOf(BusinessError);
      expect((busyError as BusinessError).code).toBe("MODEL_CONFIG_BUSY");
      const stored = JSON.parse(
        await readFile(join(hangHarness.settingsDir, "model.json"), "utf8"),
      ) as { apiChannel?: unknown };
      expect(stored.apiChannel).toBeUndefined();
    } finally {
      await hanging.cancel();
    }
  });

  it("provider 目录：zai / zai-coding-cn 标记 apiChannelSupported，其他 provider 无该字段", async () => {
    const harness = await makeHarness();
    const result = await harness.service.getOptions();
    if (!("providers" in result)) {
      throw new Error("expected providers list");
    }
    expect(result.providers.find((p) => p.id === "zai")?.apiChannelSupported).toBe(true);
    expect(result.providers.find((p) => p.id === "zai-coding-cn")?.apiChannelSupported).toBe(true);
    expect(result.providers.find((p) => p.id === "anthropic")?.apiChannelSupported).toBeUndefined();
  });

  it("删除自定义提供商（偏好随之清理）不丢 Z.AI 通道绑定", async () => {
    const harness = await makeHarness();
    // 建自定义提供商（注册 + 落盘），默认模型指向它
    await harness.service.saveCustomProvider({
      id: "my-gateway",
      name: "My Gateway",
      baseUrl: "https://gw.example.test",
      api: "openai-completions",
      authHeader: true,
      headers: {},
      models: [
        {
          id: "m1",
          name: "M1",
          reasoning: false,
          contextWindow: 100000,
          maxTokens: 8192,
          input: ["text"],
        },
      ],
    });
    await harness.service.saveModel({ model: "my-gateway/m1" });
    // zai 通道绑定 general 后再切回自定义提供商，随后删除它（偏好随之清理）
    await harness.service.saveModel({
      model: "zai-coding-cn/glm-5.3",
      apiKey: SENTINEL_KEY,
      apiChannel: "general_api",
    });
    await harness.service.saveModel({ model: "my-gateway/m1" });
    await harness.service.deleteCustomProvider("my-gateway");
    const stored = await new ModelSettingsStore({ settingsDir: harness.settingsDir }).load();
    expect(stored.model).toBeUndefined(); // 指向被删 provider 的偏好被清
    expect(stored.apiChannel).toEqual({ provider: "zai-coding-cn", channel: "general_api" });
  });
});

// ---- 错误诊断与日志 ----

describe("Z.AI 通道：错误分类与日志", () => {
  it("400 → THINKING_INCOMPATIBLE（M13.5 细化：reasoning 模型的 thinking 类 400 单独分类）；Connection error → PROVIDER_UNAVAILABLE（不再 UNKNOWN）", async () => {
    const badService = serviceWithOutcome({
      stopReason: "error",
      errorMessage: "400 Bad Request: thinking type disabled is not supported",
    });
    const badResult = await badService.testConnection({ model: "zai-coding-cn/glm-5.3" });
    // M13.5：reasoning 模型上 thinking 参数被 400 拒绝 → THINKING_INCOMPATIBLE
    //（比笼统 BAD_REQUEST 更可行动；GLM-5.3 正常探测走显式 low 档不会走到这）
    expect(badResult.code).toBe("THINKING_INCOMPATIBLE");

    const connService = serviceWithOutcome({ stopReason: "error", errorMessage: "Connection error." });
    const connResult = await connService.testConnection({ model: "zai-coding-cn/glm-5.3" });
    expect(connResult.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("失败日志含 channel/code/detail，且不泄漏 key", async () => {
    const harness = await makeHarness();
    const captured: CapturedRequest = {};
    const restore = captureCompleteSimpleRequests(harness.modelRuntime, captured);
    try {
      await harness.service.testConnection({
        model: "zai-coding-cn/glm-5.3",
        apiKey: SENTINEL_KEY,
        apiChannel: "general_api",
      });
    } finally {
      restore();
    }
    const logs = logLines.join("\n");
    expect(logs).toContain("channel=general_api");
    expect(logs).toContain("code=PROVIDER_UNAVAILABLE");
    expect(logs).toContain("zai-coding-cn/glm-5.3");
    expect(logs).not.toContain(SENTINEL_KEY);
    // settings GET 全程无 key 本体
    expect(JSON.stringify(await harness.service.getStatus())).not.toContain(SENTINEL_KEY);
  });
});

/** 指定 stopReason 的最小 stub 服务（错误分类路径） */
function serviceWithOutcome(outcome: { stopReason: string; errorMessage?: string }): ModelSettingsService {
  const modelRuntime = {
    getModel: () => ({
      provider: "zai-coding-cn",
      id: "glm-5.3",
      baseUrl: ZAI_CODING_CN_DEFAULT,
      reasoning: true,
      thinkingLevelMap: { off: null, low: "low" },
    }),
    getProvider: () => ({ id: "zai-coding-cn", auth: { apiKey: { login: () => {} } } }),
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    completeSimple: async () => ({
      stopReason: outcome.stopReason,
      ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
    }),
  } as unknown as ModelRuntime;
  const runtime: ModelSettingsRuntime = {
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    modelStatusSnapshot: async () => ({ phase: "configured", providers: ["zai-coding-cn"], detail: "ok" }),
    resolvedModel: "zai-coding-cn/glm-5.3",
    reconfigure: async () => ({}),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
  };
  return new ModelSettingsService({
    modelRuntime,
    runtime,
    store: new ModelSettingsStore({ settingsDir: "unused" }),
    customProviders: new CustomProviderStore({ settingsDir: "unused" }),
    env: {},
    log: (message) => logLines.push(message),
  });
}
