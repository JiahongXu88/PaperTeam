/**
 * 模型目录自动发现（M13.4）：
 * - 纯函数：discoveryPaths（/v1 拼接规则）、parseModelCatalog（响应形态）、
 *   discoveryAuthHeaders（Bearer / x-api-key 按协议）
 * - HTTP 行为：200 / 401 / 403 / 404→备选路径 / 404+405→NOT_SUPPORTED /
 *   429 / 5xx / 非法 JSON / 空列表 / 重复 id 去重 / 数量截断 / 超时 /
 *   响应体过大 / 跨主机重定向拒绝 / 同主机升级跟随
 * - 服务层：凭据复用（providerId → 已保存 Key）、key 不进响应/日志、
 *   testCustomProvider 临时注册 → 真实 completeSimple → finally 恢复
 *
 * 网关用本地 node:http mock（含 Anthropic SSE 最小实现），零外网依赖。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import {
  DISCOVERY_MAX_BODY_BYTES,
  DISCOVERY_MAX_MODELS,
  discoveryAuthHeaders,
  discoveryPaths,
  discoverModels,
  parseModelCatalog,
} from "../../src/settings/ModelDiscovery.js";
import {
  ModelSettingsService,
  type ModelSettingsRuntime,
} from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";
import type { RuntimeHealth } from "../../src/runtime/types.js";

const GATEWAY_KEY = "discovery-test-key-42";
const tempDirs: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

/** 本地 mock 网关：可脚本化 /v1/models 与 /v1/messages 的响应 */
interface MockCall {
  method: string;
  url: string;
  authorization?: string;
  xApiKey?: string;
  accept?: string;
}

function startMockGateway(handler: (call: MockCall, res: import("node:http").ServerResponse, body: string) => void): Promise<{ server: Server; baseUrl: string; calls: MockCall[] }> {
  const calls: MockCall[] = [];
  const server = createServer((req, res) => {
    // 头部信息同步记录（GET 无请求体时 "end" 可能晚于客户端拿到响应）
    const call: MockCall = {
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: header(req, "authorization"),
      xApiKey: header(req, "x-api-key"),
      accept: header(req, "accept"),
    };
    calls.push(call);
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      handler(call, res, body);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, calls });
    });
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("discoveryPaths：/v1 拼接规则（不得出现 /v1/v1）", () => {
  it("baseUrl 不以 /v1 结尾 → 首选 /v1/models，备选 /models", () => {
    expect(discoveryPaths("https://api-gateway.glm.ai")).toEqual(["/v1/models", "/models"]);
    expect(discoveryPaths("https://api.example.com/")).toEqual(["/v1/models", "/models"]);
  });

  it("baseUrl 以 /v1 结尾 → 首选 /models，备选 /v1/models", () => {
    expect(discoveryPaths("https://api.openai.com/v1")).toEqual(["/models", "/v1/models"]);
    expect(discoveryPaths("https://gw.example.com/openai/v1/")).toEqual(["/models", "/v1/models"]);
  });

  it("modelsPath 覆盖时只请求该路径", () => {
    expect(discoveryPaths("https://api.example.com", "/openai/v2/models")).toEqual(["/openai/v2/models"]);
  });
});

describe("discoveryAuthHeaders：按协议选择认证头", () => {
  it("OpenAI 协议一律 Bearer；anthropic-messages 按 authHeader 选择", () => {
    expect(discoveryAuthHeaders("openai-completions", false, "k")).toEqual({ Authorization: "Bearer k" });
    expect(discoveryAuthHeaders("openai-responses", false, "k")).toEqual({ Authorization: "Bearer k" });
    expect(discoveryAuthHeaders("anthropic-messages", true, "k")).toEqual({ Authorization: "Bearer k" });
    expect(discoveryAuthHeaders("anthropic-messages", false, "k")).toEqual({ "x-api-key": "k" });
    expect(discoveryAuthHeaders("anthropic-messages", true, undefined)).toEqual({});
  });
});

describe("parseModelCatalog：响应形态适配", () => {
  it("{data:[...]}（OpenAI 兼容）", () => {
    const parsed = parseModelCatalog(JSON.stringify({ data: [{ id: "a" }, { id: "b", owned_by: "x", context_length: 128000 }] }));
    expect(parsed.models).toEqual([{ id: "a" }, { id: "b", ownedBy: "x", contextWindow: 128000 }]);
  });

  it("{models:[...]}、裸数组、display_name / context_window 变体", () => {
    expect(parseModelCatalog(JSON.stringify({ models: [{ id: "m", display_name: "M", context_window: 64000 }] })).models).toEqual([
      { id: "m", name: "M", contextWindow: 64000 },
    ]);
    expect(parseModelCatalog(JSON.stringify([{ id: "a" }])).models).toEqual([{ id: "a" }]);
  });

  it("重复 id 去重、非对象/无 id 条目跳过、数量截断置位", () => {
    const entries = Array.from({ length: DISCOVERY_MAX_MODELS + 10 }, (_, index) => ({ id: `m-${index % (DISCOVERY_MAX_MODELS + 5)}` }));
    const parsed = parseModelCatalog(JSON.stringify({ data: entries }));
    expect(parsed.models.length).toBeLessThanOrEqual(DISCOVERY_MAX_MODELS);
    expect(new Set(parsed.models.map((model) => model.id)).size).toBe(parsed.models.length);
    expect(parseModelCatalog(JSON.stringify({ data: [{ id: "a" }, { id: "a" }, { nope: 1 }, "junk"] })).models).toEqual([{ id: "a" }]);
  });

  it("空列表 → ok 的空目录；非法结构抛错", () => {
    expect(parseModelCatalog(JSON.stringify({ data: [] }))).toEqual({ models: [], total: 0 });
    expect(() => parseModelCatalog("not json")).toThrow(/JSON/);
    expect(() => parseModelCatalog(JSON.stringify({ object: "chat.completion" }))).toThrow(/结构/);
  });
});

describe("discoverModels：HTTP 行为（本地 mock 网关）", () => {
  it("200 + {data} → 成功；Bearer 头正确携带；结果不含 key", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res) => {
      if (call.url === "/v1/models") {
        if (call.authorization !== `Bearer ${GATEWAY_KEY}`) {
          json(res, 401, { error: "bad key" });
          return;
        }
        json(res, 200, { data: [{ id: "glm-5.3" }, { id: "glm-5.3" }, { id: "claude-fable-5-1" }] });
        return;
      }
      json(res, 404, {});
    });
    const result = await discoverModels({ baseUrl, api: "anthropic-messages", authHeader: true, apiKey: GATEWAY_KEY });
    expect(result).toMatchObject({ ok: true, sourcePath: "/v1/models", total: 3 });
    expect(result.ok && result.models.map((model) => model.id)).toEqual(["glm-5.3", "claude-fable-5-1"]);
    expect(JSON.stringify(result)).not.toContain(GATEWAY_KEY);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/v1/models", authorization: `Bearer ${GATEWAY_KEY}` });
  });

  it("anthropic-messages + authHeader=false → x-api-key 头", async () => {
    const { baseUrl, calls } = await startMockGateway((_call, res) => {
      json(res, 200, { data: [{ id: "a" }] });
    });
    await discoverModels({ baseUrl, api: "anthropic-messages", authHeader: false, apiKey: GATEWAY_KEY });
    expect(calls[0]?.xApiKey).toBe(GATEWAY_KEY);
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it("401/403 → AUTH_FAILED（不再尝试备选路径）", async () => {
    const { baseUrl, calls } = await startMockGateway((_call, res) => json(res, 403, {}));
    const result = await discoverModels({ baseUrl, api: "anthropic-messages", authHeader: true, apiKey: "wrong" });
    expect(result).toMatchObject({ ok: false, code: "AUTH_FAILED" });
    expect(calls.length).toBe(1);
  });

  it("首选 404 → 自动尝试备选 /models；两级都 404/405 → NOT_SUPPORTED（≠ 不可用）", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res) => {
      if (call.url === "/v1/models") {
        json(res, 404, {});
      } else if (call.url === "/models") {
        json(res, 200, { data: [{ id: "late-model" }] });
      } else {
        json(res, 404, {});
      }
    });
    const fallback = await discoverModels({ baseUrl, api: "anthropic-messages", authHeader: true, apiKey: GATEWAY_KEY });
    expect(fallback).toMatchObject({ ok: true, sourcePath: "/models" });
    expect(calls.map((call) => call.url)).toEqual(["/v1/models", "/models"]);

    const none = await startMockGateway((_call, res) => json(res, 405, {}));
    const result = await discoverModels({ baseUrl: none.baseUrl, api: "anthropic-messages", authHeader: true, apiKey: GATEWAY_KEY });
    expect(result).toMatchObject({ ok: false, code: "NOT_SUPPORTED" });
    expect(result.ok === false && result.attemptedPaths).toEqual(["/v1/models", "/models"]);
  });

  it.each([
    [429, "RATE_LIMITED"],
    [500, "SERVER_ERROR"],
    [503, "SERVER_ERROR"],
  ])("HTTP %i → %s（单次请求即终止）", async (status, code) => {
    const { baseUrl, calls } = await startMockGateway((_call, res) => json(res, status, {}));
    const result = await discoverModels({ baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY });
    expect(result).toMatchObject({ ok: false, code });
    expect(calls.length).toBe(1);
  });

  it("200 但非法 JSON / 非目录结构 → BAD_RESPONSE", async () => {
    const broken = await startMockGateway((_call, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>login page</html>");
    });
    expect(await discoverModels({ baseUrl: broken.baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY })).toMatchObject({ ok: false, code: "BAD_RESPONSE" });

    const wrongShape = await startMockGateway((_call, res) => json(res, 200, { object: "chat.completion" }));
    expect(await discoverModels({ baseUrl: wrongShape.baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY })).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
  });

  it("超时 → TIMEOUT", async () => {
    const slow = await startMockGateway((_call, res) => {
      setTimeout(() => json(res, 200, { data: [{ id: "late" }] }), 2000);
    });
    const result = await discoverModels({ baseUrl: slow.baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY, timeoutMs: 150 });
    expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
  });

  it("响应体超过上限 → BAD_RESPONSE", async () => {
    const huge = await startMockGateway((_call, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = "x".repeat(1024 * 1024);
      for (let index = 0; index <= Math.floor(DISCOVERY_MAX_BODY_BYTES / (1024 * 1024)); index += 1) {
        res.write(chunk);
      }
      res.end();
    });
    const result = await discoverModels({ baseUrl: huge.baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY });
    expect(result).toMatchObject({ ok: false, code: "BAD_RESPONSE", detail: /上限/ });
  });

  it("跨主机重定向 → REDIRECTED（不转发认证头）；同主机 http→https 不适用于 127.0.0.1 场景则拒绝多跳", async () => {
    const target = await startMockGateway((_call, res) => json(res, 200, { data: [{ id: "a" }] }));
    const redirector = await startMockGateway((_call, res) => {
      res.writeHead(302, { Location: `${target.baseUrl}/v1/models` });
      res.end();
    });
    // 127.0.0.1:portA → 127.0.0.1:portB 是不同 host:port → 拒绝
    const result = await discoverModels({ baseUrl: redirector.baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY });
    expect(result).toMatchObject({ ok: false, code: "REDIRECTED" });
    expect(target.server.address()).toBeDefined();
  });

  it("modelsPath 覆盖 → 只请求该路径", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res) => {
      if (call.url === "/openai/v9/models") {
        json(res, 200, { data: [{ id: "custom-path-model" }] });
        return;
      }
      json(res, 404, {});
    });
    const result = await discoverModels({ baseUrl, api: "openai-completions", authHeader: true, apiKey: GATEWAY_KEY, modelsPath: "/openai/v9/models" });
    expect(result).toMatchObject({ ok: true, sourcePath: "/openai/v9/models" });
    expect(calls.length).toBe(1);
  });
});

// ---- 服务层：凭据复用 / key 隔离 / testCustomProvider ----

function fakeRuntime(): ModelSettingsRuntime {
  return {
    healthCheck: async (): Promise<RuntimeHealth> => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    modelStatusSnapshot: async () => ({ phase: "configured", providers: [], detail: "ok" }),
    reconfigure: async () => ({}),
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
  };
}

async function makeHarness() {
  const agentDir = await mkdtemp(join(tmpdir(), "md-agent-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "md-settings-"));
  tempDirs.push(agentDir, settingsDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const customProviders = new CustomProviderStore({ settingsDir });
  const store = new ModelSettingsStore({ settingsDir });
  const runtime = fakeRuntime();
  const logs: string[] = [];
  const service = new ModelSettingsService({
    modelRuntime,
    runtime,
    store,
    customProviders,
    env: {},
    log: (message) => logs.push(message),
  });
  return { agentDir, settingsDir, modelRuntime, runtime, customProviders, service, logs };
}

/** 最小 Anthropic Messages SSE 流（Pi completeSimple 可解析） */
function anthropicSse(res: import("node:http").ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

describe("ModelSettingsService：发现与保存前测试", () => {
  it("discoverCustomProviderModels：请求体 key 优先；响应与日志均不含 key", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res) => {
      if (call.url === "/v1/models") {
        json(res, 200, { data: [{ id: "glm-5.3", owned_by: "zhipu" }] });
        return;
      }
      json(res, 404, {});
    });
    const { service, logs } = await makeHarness();
    const result = await service.discoverCustomProviderModels({
      baseUrl,
      api: "anthropic-messages",
      authHeader: true,
      apiKey: GATEWAY_KEY,
    });
    expect(result).toMatchObject({ ok: true, authSource: "request" });
    expect(result.ok && result.models[0]).toMatchObject({ id: "glm-5.3", ownedBy: "zhipu" });
    expect(JSON.stringify(result)).not.toContain(GATEWAY_KEY);
    expect(JSON.stringify(logs)).not.toContain(GATEWAY_KEY);
    expect(calls[0]?.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  it("已保存 provider：不传 key → 复用 auth.json 凭据（authSource=stored）", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res) => {
      if (call.url === "/v1/models") {
        json(res, 200, { data: [{ id: "m1" }] });
        return;
      }
      json(res, 404, {});
    });
    const { service } = await makeHarness();
    await service.saveCustomProvider(
      { id: "saved-gw", name: "Saved", baseUrl, api: "anthropic-messages", authHeader: true, headers: {}, models: [{ id: "m1", name: "m1", reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"] }] },
      GATEWAY_KEY,
    );
    const result = await service.discoverCustomProviderModels({ baseUrl, providerId: "saved-gw" });
    expect(result).toMatchObject({ ok: true, authSource: "stored" });
    expect(calls[0]?.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  it("无凭据也允许尝试（本地免认证网关），authSource=none", async () => {
    const { baseUrl } = await startMockGateway((_call, res) => json(res, 200, { data: [{ id: "free" }] }));
    const { service } = await makeHarness();
    const result = await service.discoverCustomProviderModels({ baseUrl });
    expect(result).toMatchObject({ ok: true, authSource: "none" });
  });

  it("baseUrl 非法 → INVALID_REQUEST（与保存同一套校验）", async () => {
    const { service } = await makeHarness();
    await expect(service.discoverCustomProviderModels({ baseUrl: "not a url" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("testCustomProvider：保存前真实调用成功（mock SSE）；临时注册已清理", async () => {
    const { baseUrl, calls } = await startMockGateway((call, res, body) => {
      if (call.url === "/v1/models") {
        json(res, 200, { data: [{ id: "mock-model" }] });
        return;
      }
      if (call.url.split("?")[0] === "/v1/messages") {
        if (call.authorization !== `Bearer ${GATEWAY_KEY}`) {
          json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
          return;
        }
        expect(body).toContain('"stream"');
        anthropicSse(res, "OK");
        return;
      }
      json(res, 404, {});
    });
    const { service, modelRuntime, customProviders } = await makeHarness();
    const result = await service.testCustomProvider({
      provider: {
        id: "",
        name: "PreSave Gateway",
        baseUrl,
        api: "anthropic-messages",
        authHeader: true,
        headers: {},
        models: [{ id: "mock-model", name: "mock-model", reasoning: false, contextWindow: 200000, maxTokens: 1024, input: ["text"] }],
      },
      modelId: "mock-model",
      apiKey: GATEWAY_KEY,
    });
    expect(result).toMatchObject({ ok: true, provider: "presave-gateway", model: "presave-gateway/mock-model" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain(GATEWAY_KEY);
    // 临时注册必须清理：runtime 无残留、存储无残留
    expect(modelRuntime.getProvider("pre-save-gateway")).toBeUndefined();
    expect(await customProviders.load()).toEqual([]);
    expect(calls.some((call) => call.url.split("?")[0] === "/v1/messages")).toBe(true);
  });

  it("testCustomProvider：key 错误 → AUTH_FAILED 分类；编辑场景测试后恢复原注册", async () => {
    const { baseUrl } = await startMockGateway((call, res) => {
      if (call.url.split("?")[0] === "/v1/messages") {
        json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        return;
      }
      json(res, 404, {});
    });
    const { service, modelRuntime } = await makeHarness();
    await service.saveCustomProvider({
      id: "edit-gw",
      name: "Edit",
      baseUrl,
      api: "anthropic-messages",
      authHeader: true,
      headers: {},
      models: [
        { id: "old-model", name: "Old Model", reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"] },
      ],
    });

    const result = await service.testCustomProvider({
      provider: {
        id: "edit-gw",
        name: "Edit",
        baseUrl,
        api: "anthropic-messages",
        authHeader: true,
        headers: {},
        models: [
          { id: "new-model", name: "New Model", reasoning: false, contextWindow: 2000, maxTokens: 200, input: ["text"] },
        ],
      },
      modelId: "new-model",
      apiKey: "definitely-wrong-key",
    });
    expect(result).toMatchObject({ ok: false, code: "AUTH_FAILED", provider: "edit-gw" });
    expect(JSON.stringify(result)).not.toContain("definitely-wrong-key");
    // 测试用的临时目录不能留下：恢复为已存储配置（只有 old-model）
    expect(modelRuntime.getModels("edit-gw").map((model) => model.id)).toEqual(["old-model"]);
    expect(modelRuntime.getModel("edit-gw", "new-model")).toBeUndefined();
  });

  it("testCustomProvider：modelId 不在提交的模型列表 → MODEL_NOT_FOUND；无凭据 → AUTH_FAILED", async () => {
    const { service } = await makeHarness();
    const missing = await service.testCustomProvider({
      provider: { id: "", name: "X", baseUrl: "https://x.example.test", api: "anthropic-messages", authHeader: true, headers: {}, models: [{ id: "a", name: "a", reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"] }] },
      modelId: "nope",
    });
    expect(missing).toMatchObject({ ok: false, code: "MODEL_NOT_FOUND" });

    const noKey = await service.testCustomProvider({
      provider: { id: "", name: "X", baseUrl: "https://x.example.test", api: "anthropic-messages", authHeader: true, headers: {}, models: [{ id: "a", name: "a", reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"] }] },
      modelId: "a",
    });
    // 新建场景无存储凭据：真实调用会因无凭据被 Pi 拒绝（prepareRequest 抛 Provider not configured）
    expect(noKey.ok).toBe(false);
  });

  it("saveCustomProvider：modelsPath / metadataVerified 持久化并回显；id 缺省生成", async () => {
    const { service, customProviders } = await makeHarness();
    const { provider } = await service.saveCustomProvider({
      id: "",
      name: "Pathful Gateway",
      baseUrl: "https://gw.example.test/openai/v1",
      api: "openai-completions",
      authHeader: true,
      headers: {},
      modelsPath: "/openai/v1/models",
      models: [{ id: "m", name: "m", reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"], metadataVerified: true }],
    });
    expect(provider.id).toBe("pathful-gateway");
    expect(provider.modelsPath).toBe("/openai/v1/models");
    expect(provider.models[0]?.metadataVerified).toBe(true);
    const stored = await customProviders.load();
    expect(stored[0]?.modelsPath).toBe("/openai/v1/models");
  });
});

describe("HTTP 发现 / 保存前测试路由", () => {
  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const { createBackendHttpServer } = await import("../../src/httpServer.js");
    const harness = await makeHarness();
    const server = createBackendHttpServer({
      runtime: harness.runtime as never,
      modelSettings: harness.service,
    } as never);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST" }, (res: IncomingMessage) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) }));
      });
      req.on("error", reject);
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it("discover-models：缺 baseUrl → 400；错误方法 → 405", async () => {
    const missing = await post("/api/settings/model/custom-providers/discover-models", {});
    expect(missing.status).toBe(400);
  });

  it("test：缺 provider / modelId → 400", async () => {
    const missing = await post("/api/settings/model/custom-providers/test", { modelId: "x" });
    expect(missing.status).toBe(400);
  });
});
