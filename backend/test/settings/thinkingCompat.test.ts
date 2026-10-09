import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import {
  CustomProviderStore,
  toProviderConfigInput,
  validateCustomProviderInput,
  type CustomProviderInput,
} from "../../src/settings/CustomProviderStore.js";
import { ModelSettingsService, registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { minimumReasoningLevel } from "../../src/experiments/semanticUnderstanding.js";

/**
 * M13.5 thinking 兼容性回归（受控 Mock Gateway，HTTP 请求体级断言）：
 * 根因——Pi anthropic-messages 编码层对 reasoning:true 的模型在未请求
 * 档位时仍发送 thinking:{type:"disabled"}；new-api 类网关按「字段存在」
 * 路由渠道，分组下无 thinking 渠道时 enabled/disabled 同样 500。
 * 修复——thinkingRequest:"omit" 在注册层把该模型 reasoning 置 false，
 * 单点覆盖 Test Connection / 语义理解 / 摘要 / Vision / 真实 Agent 会话。
 *
 * 这里不断言最终 PASS/FAIL，而是断言真实请求体里 thinking 字段的存在性
 * 与内容，以及 thinking 相关 beta 头。
 */

const MOCK_KEY = "thinking-compat-test-key";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  betaHeader: string | undefined;
}

let gateway: Server | null = null;
let gatewayBaseUrl = "";
let captured: CapturedRequest[] = [];
/** 可编程响应：默认 200 SSE；测试可切为错误响应 */
let respondWith: { status: number; json: unknown } | null = null;

function sse(res: import("node:http").ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_tc", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
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

beforeAll(async () => {
  gateway = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      if (url !== "/v1/messages") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* 保持空 */ }
      const beta = req.headers["anthropic-beta"];
      captured.push({ url, body, betaHeader: Array.isArray(beta) ? beta.join(",") : beta });
      if (respondWith !== null) {
        res.writeHead(respondWith.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respondWith.json));
        return;
      }
      sse(res, "OK");
    });
  });
  await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
  const address = gateway.address() as { port: number };
  gatewayBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  captured = [];
  respondWith = null;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway?.close(() => resolve()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function providerInput(models: Array<Record<string, unknown>>): unknown {
  return {
    id: "tc-gw",
    name: "Thinking Compat Gateway",
    baseUrl: gatewayBaseUrl,
    api: "anthropic-messages",
    authHeader: true,
    headers: {},
    models,
  };
}

async function makeService(): Promise<{ service: ModelSettingsService; modelRuntime: ModelRuntime; store: CustomProviderStore }> {
  const settingsDir = await makeTempDir("tc-settings-");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(await makeTempDir("tc-agent-"), "auth.json"),
    modelsPath: join(settingsDir, "models.json"),
  });
  const store = new CustomProviderStore({ settingsDir });
  const service = new ModelSettingsService({
    modelRuntime,
    runtime: {} as never,
    store: new (await import("../../src/settings/ModelSettingsStore.js")).ModelSettingsStore({ settingsDir }),
    customProviders: store,
    env: {},
    log: () => {},
  });
  return { service, modelRuntime, store };
}

describe("M13.5 thinking 字段编码（Mock Gateway 请求体断言）", () => {
  it("reasoning:false 模型：探针请求体不含 thinking 字段", async () => {
    const { service } = await makeService();
    const result = await service.testCustomProvider({
      provider: providerInput([{ id: "plain-model" }]),
      modelId: "plain-model",
      apiKey: MOCK_KEY,
    });
    expect(result.ok).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]!.body).not.toHaveProperty("thinking");
  });

  it("reasoning:true（auto）模型：Pi 发送 thinking:{type:\"disabled\"}（根因复现）", async () => {
    const { service } = await makeService();
    const result = await service.testCustomProvider({
      provider: providerInput([{ id: "reasoning-model", reasoning: true }]),
      modelId: "reasoning-model",
      apiKey: MOCK_KEY,
    });
    expect(result.ok).toBe(true);
    expect(captured.length).toBe(1);
    // 这就是公司网关 500 的机制：字段存在（值是 disabled），路由层即拒绝
    expect(captured[0]!.body["thinking"]).toEqual({ type: "disabled" });
  });

  it("reasoning:true + thinkingRequest:\"omit\"：请求体不含 thinking 字段，无 interleaved-thinking beta 头", async () => {
    const { service } = await makeService();
    const result = await service.testCustomProvider({
      provider: providerInput([{ id: "omit-model", reasoning: true, thinkingRequest: "omit" }]),
      modelId: "omit-model",
      apiKey: MOCK_KEY,
    });
    expect(result.ok).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]!.body).not.toHaveProperty("thinking");
    expect(captured[0]!.betaHeader ?? "").not.toContain("interleaved-thinking");
  });

  it("omit 模型注册进 ModelRuntime 后 reasoning=false（覆盖 Agent 会话 / 语义理解 / 摘要 / Vision 全部调用路径的判定 seam）", async () => {
    const { service, modelRuntime } = await makeService();
    await service.testCustomProvider({
      provider: providerInput([{ id: "omit-model", reasoning: true, thinkingRequest: "omit" }]),
      modelId: "omit-model",
      apiKey: MOCK_KEY,
    });
    // 临时注册已在 finally 撤销；换持久化路径验证注册形态
    const { store } = await makeService();
    const validated = validateCustomProviderInput(providerInput([{ id: "omit-model", reasoning: true, thinkingRequest: "omit" }]));
    await store.save([{ ...validated, id: "tc-gw", updatedAt: new Date().toISOString() }]);
    const loaded = await store.load();
    expect(loaded[0]!.models[0]!.thinkingRequest).toBe("omit");
    const configInput = toProviderConfigInput(loaded[0] as CustomProviderInput);
    const firstModel = configInput.models?.[0] as { reasoning?: boolean } | undefined;
    expect(firstModel?.reasoning).toBe(false);
    await registerStoredCustomProviders(modelRuntime, store);
    const registered = modelRuntime.getModel("tc-gw", "omit-model");
    expect(registered?.reasoning).toBe(false);
    // 语义理解路径同一注册模型：不需要任何显式档位
    expect(minimumReasoningLevel(registered)).toBeUndefined();
    // 能力元数据在 store 层保留
    expect(loaded[0]!.models[0]!.reasoning).toBe(true);
  });

  it("网关 500 渠道不存在（reasoning:true）→ THINKING_INCOMPATIBLE + 可行动提示；auto 模型不误报", async () => {
    respondWith = {
      status: 500,
      json: { type: "error", error: { type: "new_api_error", message: "分组 claude-anthropic 下模型 reasoning-model 的可用渠道不存在（retry）" } },
    };
    const { service } = await makeService();
    const result = await service.testCustomProvider({
      provider: providerInput([{ id: "reasoning-model", reasoning: true }]),
      modelId: "reasoning-model",
      apiKey: MOCK_KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("THINKING_INCOMPATIBLE");
    expect(result.detail).toContain("thinking");
    expect(result.detail).toContain("不发送");

    // 同一错误对 reasoning:false 模型（thinking 字段确实没发过）不应归为 thinking 不兼容
    captured = [];
    const plain = await service.testCustomProvider({
      provider: providerInput([{ id: "plain-model" }]),
      modelId: "plain-model",
      apiKey: MOCK_KEY,
    });
    expect(plain.ok).toBe(false);
    expect(plain.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("thinkingRequest 非法值被拒绝；持久化往返保留 omit；缺省视作 auto", async () => {
    const { service } = await makeService();
    await expect(service.testCustomProvider({
      provider: providerInput([{ id: "m1", thinkingRequest: "never" }]),
      modelId: "m1",
      apiKey: MOCK_KEY,
    })).rejects.toThrow(BusinessError);

    const { store } = await makeService();
    const validated = validateCustomProviderInput(providerInput([
      { id: "omit-model", reasoning: true, thinkingRequest: "omit" },
      { id: "auto-model", reasoning: true, thinkingRequest: "auto" },
    ]));
    await store.save([{ ...validated, id: "tc-gw", updatedAt: new Date().toISOString() }]);
    const reloaded = await store.load();
    const [omitModel, autoModel] = reloaded[0]!.models;
    expect(omitModel!.thinkingRequest).toBe("omit");
    expect(autoModel!.thinkingRequest).toBeUndefined();
    // 落盘 JSON 里 auto 显式值不持久化（缺省即 auto）
    expect(JSON.parse(JSON.stringify(autoModel!)).thinkingRequest).toBeUndefined();
  });
});
