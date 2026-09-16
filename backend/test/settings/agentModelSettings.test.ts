/**
 * M5.7 per-Agent 模型配置（ModelSettingsService / ModelSettingsStore / HTTP 契约）：
 * - model.json 的 agents 字段持久化与兼容（旧文件无 agents → 正常加载）
 * - getStatus 的 per-Agent 视图（override / effective / source / authConfigured）
 * - saveModel：agents 缺省 = 保持现有（旧客户端不误清空）；整体替换；校验
 * - GET 不返回任何 key（sentinel）
 * - 端到端：Settings 保存 override → adapter（agentModelSpecs 读 store）的 writer run
 *   使用独立模型；删除自定义提供商 → 指向它的 override 一并清除
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { ModelSettingsService } from "../../src/settings/ModelSettingsService.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";

const SENTINEL_KEY = "paperteam-agent-model-secret-012";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const GATEWAY_B = {
  id: "provb",
  name: "Provider B",
  baseUrl: "https://provb.example.test/",
  api: "anthropic-messages",
  authHeader: true,
  headers: {},
  models: [
    { id: "model-b", name: "Model B", reasoning: false, contextWindow: 120000, maxTokens: 8192, input: ["text"] },
  ],
} as const;

const GATEWAY_C = {
  ...GATEWAY_B,
  id: "provc",
  name: "Provider C",
  baseUrl: "https://provc.example.test/",
  models: [
    { id: "model-c", name: "Model C", reasoning: false, contextWindow: 64000, maxTokens: 4096, input: ["text"] },
  ],
} as const;

function makeSessionFactory() {
  const models: unknown[] = [];
  const factory = async (params: { model?: unknown }): Promise<AgentSession> => {
    models.push(params.model);
    return {
      prompt: async () => {},
      abort: async () => {},
      waitForIdle: async () => {},
      dispose: () => {},
      subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
      getLastAssistantText: () => "ok",
      agent: {
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }] },
      },
    } as never;
  };
  return { models, factory };
}

async function makeHarness() {
  const agentDir = await mkdtemp(join(tmpdir(), "am-agent-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "am-settings-"));
  tempDirs.push(agentDir, settingsDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const store = new ModelSettingsStore({ settingsDir });
  const customProviders = new CustomProviderStore({ settingsDir });
  const sessions = makeSessionFactory();
  const logs: string[] = [];
  const adapter = new PiRuntimeAdapter({
    modelSpec: "anthropic/claude-haiku-4-5",
    agentDir,
    workspaceRoot: await mkdtemp(join(tmpdir(), "am-ws-")),
    modelRuntime,
    createSession: sessions.factory as never,
    agentModelSpecs: async () => (await store.load()).agents ?? {},
    log: (message) => logs.push(message),
  });
  const service = new ModelSettingsService({
    modelRuntime,
    runtime: adapter,
    store,
    customProviders,
    env: {},
    log: (message) => logs.push(message),
  });
  return { agentDir, settingsDir, modelRuntime, store, customProviders, adapter, service, sessions, logs };
}

describe("ModelSettingsStore agents 持久化（M5.7）", () => {
  it("save(model, agents) / load 往返；agents 缺省写入时清空 override", async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), "am-store-"));
    tempDirs.push(settingsDir);
    const store = new ModelSettingsStore({ settingsDir });
    await store.save("prova/model-a", { writer: "provb/model-b", researcher: "provc/model-c" });
    expect(await store.load()).toMatchObject({
      model: "prova/model-a",
      agents: { writer: "provb/model-b", researcher: "provc/model-c" },
    });
    await store.save("prova/model-a");
    expect((await store.load()).agents).toBeUndefined();
  });

  it("旧 model.json（无 agents 字段）正常加载；损坏的 agents 条目被丢弃", async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), "am-store-old-"));
    tempDirs.push(settingsDir);
    await writeFile(
      join(settingsDir, "model.json"),
      JSON.stringify({ model: "prova/model-a", savedAt: "2026-09-01T00:00:00.000Z" }),
      "utf8",
    );
    const store = new ModelSettingsStore({ settingsDir });
    expect(await store.load()).toEqual({
      model: "prova/model-a",
      savedAt: "2026-09-01T00:00:00.000Z",
    });
    await writeFile(
      join(settingsDir, "model.json"),
      JSON.stringify({
        model: "prova/model-a",
        agents: { writer: "provb/model-b", unknownAgent: "x/y", factReviewer: 42 },
      }),
      "utf8",
    );
    expect((await store.load()).agents).toEqual({ writer: "provb/model-b" });
  });
});

describe("ModelSettingsService per-Agent 配置（M5.7）", () => {
  it("getStatus 的 agents 视图：override / effective / source / authConfigured；不含任何 key", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      const settings = await harness.service.saveModel({
        model: "provb/model-b",
        agents: { writer: "provb/model-b" },
      });
      const writer = settings.agents?.find((agent) => agent.key === "writer");
      expect(writer).toMatchObject({
        key: "writer",
        override: "provb/model-b",
        overrideProvider: "provb",
        overrideModelId: "model-b",
        effective: "provb/model-b",
        source: "agent_override",
        authConfigured: true,
      });
      const academic = settings.agents?.find((agent) => agent.key === "academicReviewer");
      expect(academic).toMatchObject({ key: "academicReviewer", effective: "provb/model-b", source: "default" });
      // 无 key 本体（sentinel 不出现在任何返回里）
      expect(JSON.stringify(settings)).not.toContain(SENTINEL_KEY);
    } finally {
      await harness.adapter.close();
    }
  });

  it("saveModel 不带 agents → 保持现有 override（旧客户端兼容）", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      await harness.service.saveModel({
        model: "provb/model-b",
        agents: { writer: "provb/model-b", researcher: null },
      });
      // 只改默认模型（无 agents 字段）：override 保留
      await harness.service.saveModel({ model: "provb/model-b" });
      expect((await harness.store.load()).agents).toEqual({ writer: "provb/model-b" });
      // 带 agents 字段 = 整体替换：writer 改为继承
      await harness.service.saveModel({ model: "provb/model-b", agents: { writer: null } });
      expect((await harness.store.load()).agents).toBeUndefined();
    } finally {
      await harness.adapter.close();
    }
  });

  it("agents 校验：未知 Agent 键 / 非法规格 / 未知模型 → INVALID_REQUEST，且不落盘", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      await expect(
        harness.service.saveModel({ model: "provb/model-b", agents: { hacker: "provb/model-b" } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        harness.service.saveModel({ model: "provb/model-b", agents: { writer: "no-slash" } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        harness.service.saveModel({ model: "provb/model-b", agents: { writer: "provb/model-x" } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect((await harness.store.load()).agents).toBeUndefined();
    } finally {
      await harness.adapter.close();
    }
  });

  it("端到端：保存 writer override → adapter 的 writer run 用独立模型，reviewer 继承默认", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      await harness.service.saveCustomProvider(
        { ...GATEWAY_C, models: [...GATEWAY_C.models], headers: {} },
        SENTINEL_KEY,
      );
      // 默认 model-b；Writer 独立用 model-c（不同 provider / 模型）
      await harness.service.saveModel({
        model: "provb/model-b",
        agents: { writer: "provc/model-c" },
      });
      const writerTask = await harness.adapter.runAgent({
        agentId: "writer",
        task: "写",
        contextScope: "writing/revision",
      });
      const reviewerTask = await harness.adapter.runAgent({
        agentId: "reviewer",
        task: "审",
        contextScope: "review/academic",
      });
      expect(writerTask.status).toBe("completed");
      expect(reviewerTask.status).toBe("completed");
      expect(writerTask.metadata?.model).toBe("provc/model-c");
      expect(reviewerTask.metadata?.model).toBe("provb/model-b");
      expect((harness.sessions.models[0] as { id: string }).id).toBe("model-c");
      expect((harness.sessions.models[1] as { id: string }).id).toBe("model-b");
    } finally {
      await harness.adapter.close();
    }
  });

  it("删除自定义提供商 → 指向它的 agent override 一并清除（默认偏好与无关 override 保留）", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      await harness.service.saveCustomProvider(
        { ...GATEWAY_C, models: [...GATEWAY_C.models], headers: {} },
        SENTINEL_KEY,
      );
      await harness.service.saveModel({
        model: "provb/model-b",
        agents: { writer: "provc/model-c", researcher: "provb/model-b" },
      });
      expect((await harness.store.load()).agents).toEqual({
        writer: "provc/model-c",
        researcher: "provb/model-b",
      });
      // 删除 provc：writer override（指向 provc）被清除；默认偏好与 researcher 保留
      await harness.service.deleteCustomProvider("provc");
      expect((await harness.store.load()).agents).toEqual({ researcher: "provb/model-b" });
      expect((await harness.store.load()).model).toBe("provb/model-b");
    } finally {
      await harness.adapter.close();
    }
  });

  it("model.json 落盘内容不含任何 key（sentinel）", async () => {
    const harness = await makeHarness();
    try {
      await harness.service.saveCustomProvider(
        { ...GATEWAY_B, models: [...GATEWAY_B.models], headers: {} },
        SENTINEL_KEY,
      );
      await harness.service.saveModel({
        model: "provb/model-b",
        agents: { writer: "provb/model-b" },
      });
      const raw = await readFile(join(harness.settingsDir, "model.json"), "utf8");
      expect(raw).not.toContain(SENTINEL_KEY);
      expect(JSON.parse(raw)).toMatchObject({ agents: { writer: "provb/model-b" } });
    } finally {
      await harness.adapter.close();
    }
  });
});

describe("agentModelSpecs 缺省（未配置 override 的 Runtime）", () => {
  it("不注入回调时行为与旧版一致（全部默认模型）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "am-noop-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "am-noop-ws-"));
    tempDirs.push(agentDir, workspaceRoot);
    const sessions = makeSessionFactory();
    const adapter = new PiRuntimeAdapter({
      modelSpec: "anthropic/claude-haiku-4-5",
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "prova", id: "model-a" }),
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as never,
      createSession: sessions.factory as never,
      log: () => {},
    });
    try {
      const task = await adapter.runAgent({ agentId: "writer", task: "写", contextScope: "writing/revision" });
      expect(task.metadata?.model).toBe("anthropic/claude-haiku-4-5");
      expect(await adapter.modelStatusSnapshot()).toMatchObject({ phase: "configured" });
      expect((await adapter.modelStatusSnapshot()).agents).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it("agentModelSpecs 回调抛错 → 全部继承默认（配置读取失败不拒绝启动）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "am-err-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "am-err-ws-"));
    tempDirs.push(agentDir, workspaceRoot);
    const sessions = makeSessionFactory();
    const adapter = new PiRuntimeAdapter({
      modelSpec: "prova/model-a",
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "prova", id: "model-a" }),
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as never,
      createSession: sessions.factory as never,
      agentModelSpecs: async () => {
        throw new BusinessError("INTERNAL_ERROR", "store boom");
      },
      log: () => {},
    });
    try {
      const task = await adapter.runAgent({ agentId: "writer", task: "写", contextScope: "writing/revision" });
      expect(task.status).toBe("completed");
      expect(task.metadata?.model).toBe("prova/model-a");
    } finally {
      await adapter.close();
    }
  });
});
