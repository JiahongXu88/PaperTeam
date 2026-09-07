/**
 * 自定义模型提供商（Settings UI 添加的 Anthropic / OpenAI 兼容网关）：
 * 校验、注入 ModelRuntime、持久化、重启重放、Key 隔离、删除连带清理。
 * 全部离线：真实 ModelRuntime + 临时 auth.json，不发网络请求。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { createBackendHttpServer } from "../../src/httpServer.js";
import type { RuntimeHealth } from "../../src/runtime/types.js";
import {
  CustomProviderStore,
  validateCustomProviderInput,
} from "../../src/settings/CustomProviderStore.js";
import {
  ModelSettingsService,
  registerStoredCustomProviders,
  type ModelSettingsRuntime,
} from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";

const SENTINEL_KEY = "paperteam-custom-secret-789";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

const GATEWAY = {
  id: "my-gateway",
  name: "My Gateway",
  baseUrl: "https://gateway.example.test/",
  api: "anthropic-messages",
  authHeader: true,
  headers: { "X-Tenant": "paperteam" },
  models: [
    { id: "claude-x", name: "Claude X (gateway)", reasoning: false, contextWindow: 200000, maxTokens: 8192, input: ["text"] },
    { id: "haiku-y", contextWindow: 100000 },
  ],
};

function fakeRuntime(active = 0): ModelSettingsRuntime & { reconfigured: (string | undefined)[] } {
  const reconfigured: (string | undefined)[] = [];
  return {
    reconfigured,
    healthCheck: async (): Promise<RuntimeHealth> => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    modelStatusSnapshot: async () => ({ phase: "configured", providers: [], detail: "ok" }),
    reconfigure: async (spec) => {
      reconfigured.push(spec);
      return {};
    },
    runtimeStats: () => ({ activeRuns: active, managedSessions: 0 }),
  };
}

async function makeHarness(options?: { active?: number; env?: { piModel?: string } }) {
  const agentDir = await mkdtemp(join(tmpdir(), "cp-agent-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "cp-settings-"));
  tempDirs.push(agentDir, settingsDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const customProviders = new CustomProviderStore({ settingsDir });
  const store = new ModelSettingsStore({ settingsDir });
  const runtime = fakeRuntime(options?.active ?? 0);
  const logs: string[] = [];
  const service = new ModelSettingsService({
    modelRuntime,
    runtime,
    store,
    customProviders,
    env: options?.env ?? {},
    log: (message) => logs.push(message),
  });
  return { agentDir, settingsDir, modelRuntime, customProviders, store, runtime, service, logs };
}

describe("validateCustomProviderInput", () => {
  it("补齐缺省字段（name=id、reasoning=false、input=[text]、authHeader=false）并去掉 baseUrl 尾斜杠", () => {
    const input = validateCustomProviderInput(GATEWAY);
    expect(input.baseUrl).toBe("https://gateway.example.test");
    expect(input.models[1]).toEqual({ id: "haiku-y", name: "haiku-y", reasoning: false, contextWindow: 100000, maxTokens: 8192, input: ["text"] });
    expect(validateCustomProviderInput({ ...GATEWAY, authHeader: undefined }).authHeader).toBe(false);
  });

  it.each([
    [{ ...GATEWAY, id: "My Gateway" }, /id 只能包含/],
    [{ ...GATEWAY, baseUrl: "ftp://x" }, /http/],
    [{ ...GATEWAY, baseUrl: "not a url" }, /URL/],
    [{ ...GATEWAY, api: "grpc" }, /api 必须是/],
    [{ ...GATEWAY, models: [] }, /至少需要一个模型/],
    [{ ...GATEWAY, models: [{ id: "a" }, { id: "a" }] }, /重复/],
    [{ ...GATEWAY, models: [{ id: "a", contextWindow: -1 }] }, /正整数/],
    [{ ...GATEWAY, headers: { Authorization: "Bearer x" } }, /认证头/],
    [{ ...GATEWAY, headers: { "x-api-key": "x" } }, /认证头/],
    [{ ...GATEWAY, headers: { "Bad Header": "x" } }, /请求头名不合法/],
  ])("拒绝非法输入 %#：%s", (raw, pattern) => {
    expect(() => validateCustomProviderInput(raw)).toThrowError(pattern);
    try {
      validateCustomProviderInput(raw);
    } catch (error) {
      expect((error as BusinessError).code).toBe("INVALID_REQUEST");
    }
  });
});

describe("ModelSettingsService：自定义提供商", () => {
  it("保存 → 出现在 provider 目录（source=custom）与模型目录；落盘文件不含 key", async () => {
    const { service, settingsDir, agentDir, modelRuntime } = await makeHarness();
    const { provider } = await service.saveCustomProvider(GATEWAY, SENTINEL_KEY);
    expect(provider.id).toBe("my-gateway");
    expect(provider.authConfigured).toBe(true);
    expect(JSON.stringify(provider)).not.toContain(SENTINEL_KEY);

    const options = await service.getOptions();
    const listed = ("providers" in options ? options.providers : []).find((entry) => entry.id === "my-gateway");
    expect(listed).toMatchObject({ source: "custom", name: "My Gateway", modelCount: 2, authConfigured: true });
    const anthropic = ("providers" in options ? options.providers : []).find((entry) => entry.id === "anthropic");
    expect(anthropic?.source).toBe("builtin");

    const models = await service.getOptions("my-gateway");
    expect("models" in models ? models.models.map((model) => model.modelId) : []).toEqual(["claude-x", "haiku-y"]);
    expect(modelRuntime.getModel("my-gateway", "claude-x")?.baseUrl).toBe("https://gateway.example.test");

    const file = await readFile(join(settingsDir, "custom-providers.json"), "utf8");
    expect(file).toContain('"my-gateway"');
    expect(file).not.toContain(SENTINEL_KEY);
    // Key 只在 Pi 官方 credential storage
    expect(await readFile(join(agentDir, "auth.json"), "utf8")).toContain("my-gateway");
  });

  it("可作为模型偏好保存并 Test Connection 找到模型定义；重启后 registerStoredCustomProviders 重放", async () => {
    const harness = await makeHarness();
    await harness.service.saveCustomProvider(GATEWAY, SENTINEL_KEY);
    await harness.service.saveModel({ model: "my-gateway/claude-x" });
    expect((await harness.service.getStatus()).model).toBe("my-gateway/claude-x");

    // 模拟重启：新 ModelRuntime 不认识 my-gateway，重放后可解析
    const modelRuntime2 = await ModelRuntime.create({
      authPath: join(harness.agentDir, "auth.json"),
      modelsPath: join(harness.agentDir, "models.json"),
    });
    expect(modelRuntime2.getProvider("my-gateway")).toBeUndefined();
    expect(await registerStoredCustomProviders(modelRuntime2, harness.customProviders)).toBe(1);
    expect(modelRuntime2.getModel("my-gateway", "haiku-y")?.name).toBe("haiku-y");
    expect(modelRuntime2.getProviderAuthStatus("my-gateway").configured).toBe(true);
  });

  it("整体替换：模型目录以新配置为准（不与旧定义合并）；当前偏好属于该提供商时触发 reconfigure", async () => {
    const { service, runtime, modelRuntime } = await makeHarness();
    await service.saveCustomProvider(GATEWAY);
    await service.saveModel({ model: "my-gateway/claude-x" });
    runtime.reconfigured.splice(0);

    await service.saveCustomProvider({ ...GATEWAY, models: [{ id: "claude-x", name: "Renamed" }], headers: {} });
    expect(modelRuntime.getModels("my-gateway").map((model) => model.id)).toEqual(["claude-x"]);
    expect(modelRuntime.getModel("my-gateway", "claude-x")?.name).toBe("Renamed");
    expect(runtime.reconfigured).toEqual(["my-gateway/claude-x"]);
  });

  it("id 与内置提供商冲突 → INVALID_REQUEST；在途 run → MODEL_CONFIG_BUSY 且不落盘", async () => {
    const { service } = await makeHarness();
    await expect(service.saveCustomProvider({ ...GATEWAY, id: "anthropic" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const busy = await makeHarness({ active: 1 });
    await expect(busy.service.saveCustomProvider(GATEWAY)).rejects.toMatchObject({ code: "MODEL_CONFIG_BUSY" });
    expect(await busy.customProviders.load()).toEqual([]);
  });

  it("删除：注销 Runtime、删除凭据、清掉指向它的模型偏好；未知 id → NOT_FOUND", async () => {
    const { service, modelRuntime, agentDir, store, runtime } = await makeHarness();
    await service.saveCustomProvider(GATEWAY, SENTINEL_KEY);
    await service.saveModel({ model: "my-gateway/claude-x" });
    runtime.reconfigured.splice(0);

    const status = await service.deleteCustomProvider("my-gateway");
    expect(modelRuntime.getProvider("my-gateway")).toBeUndefined();
    expect(await readFile(join(agentDir, "auth.json"), "utf8")).not.toContain(SENTINEL_KEY);
    expect((await store.load()).model).toBeUndefined();
    expect(status.configurationSource).toBe("not_configured");
    expect(runtime.reconfigured).toEqual([undefined]);
    expect(await service.listCustomProviders()).toEqual([]);

    await expect(service.deleteCustomProvider("my-gateway")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("HTTP /api/settings/model/custom-providers", () => {
  async function makeServer() {
    const harness = await makeHarness();
    const server = createBackendHttpServer({
      runtime: harness.runtime as never,
      modelSettings: harness.service,
    } as never);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, harness };
  }

  function request(server: Server, method: string, path: string, body?: unknown) {
    const port = (server.address() as { port: number }).port;
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) }));
      });
      req.on("error", reject);
      if (body !== undefined) {
        req.setHeader("Content-Type", "application/json");
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  it("PUT → 200 {provider, settings}；GET 列表不含 key；路径 id 与 body 不一致 → 400；DELETE → 200；再 DELETE → 404", async () => {
    const { server } = await makeServer();
    const saved = await request(server, "PUT", "/api/settings/model/custom-providers/my-gateway", { provider: GATEWAY, apiKey: SENTINEL_KEY });
    expect(saved.status).toBe(200);
    expect((saved.body["provider"] as Record<string, unknown>)["authConfigured"]).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(SENTINEL_KEY);

    const list = await request(server, "GET", "/api/settings/model/custom-providers");
    expect(list.status).toBe(200);
    expect((list.body["providers"] as unknown[]).length).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain(SENTINEL_KEY);

    const mismatch = await request(server, "PUT", "/api/settings/model/custom-providers/other", { provider: GATEWAY });
    expect(mismatch.status).toBe(400);

    const invalid = await request(server, "PUT", "/api/settings/model/custom-providers/my-gateway", { provider: { ...GATEWAY, models: [] } });
    expect(invalid.status).toBe(400);

    expect((await request(server, "DELETE", "/api/settings/model/custom-providers/my-gateway")).status).toBe(200);
    expect((await request(server, "DELETE", "/api/settings/model/custom-providers/my-gateway")).status).toBe(404);
    expect((await request(server, "POST", "/api/settings/model/custom-providers")).status).toBe(405);
  });
});
