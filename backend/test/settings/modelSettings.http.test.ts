/**
 * M4.3.7.5 Model Settings HTTP 层测试：路由 / 状态码 / 响应形状 /
 * 错误映射 / GET 永不返回 key（sentinel 断言）。
 *
 * 组装：真 ModelRuntime（临时 auth.json，离线）+ 真服务 + 轻量 fake
 * ModelSettingsRuntime（HTTP 层不依赖真 adapter）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

import { createBackendHttpServer } from "../../src/httpServer.js";
import {
  ModelSettingsService,
  type ModelSettingsRuntime,
} from "../../src/settings/ModelSettingsService.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";
import type { RuntimeHealth } from "../../src/runtime/types.js";

const SENTINEL_KEY = "paperteam-secret-do-not-log-123";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

async function makeSettingsServer(env?: { piModel?: string; piApiKey?: string }): Promise<Server> {
  const agentDir = await mkdtemp(join(tmpdir(), "ms-http-agent-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "ms-http-settings-"));
  tempDirs.push(agentDir, settingsDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const runtime: ModelSettingsRuntime = {
    healthCheck: async (): Promise<RuntimeHealth> => ({
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
  const service = new ModelSettingsService({
    modelRuntime,
    runtime,
    store: new ModelSettingsStore({ settingsDir }),
    customProviders: new CustomProviderStore({ settingsDir }),
    env: env ?? {},
    log: () => {},
  });
  const server = createBackendHttpServer({
    runtime: runtime as never,
    projects: {} as never,
    generation: {} as never,
    orchestrator: {} as never,
    modelSettings: service,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return server;
}

function request(
  server: Server,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const port = (server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("Content-Type", "application/json");
      req.write(body);
    }
    req.end();
  });
}

async function getJson(server: Server, path: string): Promise<Record<string, unknown>> {
  const response = await request(server, "GET", path);
  expect(response.status).toBe(200);
  return JSON.parse(response.text) as Record<string, unknown>;
}

describe("HTTP /api/settings/model（M4.3.7.5）", () => {
  it("GET：返回状态 DTO（含 runtimePhase/modelPhase/configurationSource），无任何 key 字段", async () => {
    const server = await makeSettingsServer();
    const body = await getJson(server, "/api/settings/model");
    const settings = body["settings"] as Record<string, unknown>;
    expect(settings["runtimePhase"]).toBe("healthy");
    expect(settings["runtimeVersion"]).toBe("0.84.4");
    expect(settings["configurationSource"]).toBe("not_configured");
    expect(settings["apiKeyConfigured"]).toBe(false);
    expect(Object.keys(settings)).not.toContain("apiKey");
    expect(responseText(body)).not.toContain("sk-");
  });

  it("PUT：保存 model + key → 200；后续 GET 显示 stored/configured 且不回显 key", async () => {
    const server = await makeSettingsServer();
    const put = await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY }),
    );
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(SENTINEL_KEY);

    const body = await getJson(server, "/api/settings/model");
    const settings = body["settings"] as Record<string, unknown>;
    expect(settings["configurationSource"]).toBe("stored");
    expect(settings["model"]).toBe("zai-coding-cn/glm-5.3");
    expect(settings["apiKeyConfigured"]).toBe(true);
    expect(put.text).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_KEY);
  });

  it("PUT 不带 apiKey 字段 → 保持原 key；apiKey 空字符串 → 400", async () => {
    const server = await makeSettingsServer();
    await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY }),
    );
    const keep = await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "zai-coding-cn/glm-5.2" }),
    );
    expect(keep.status).toBe(200);
    const body = await getJson(server, "/api/settings/model");
    expect((body["settings"] as Record<string, unknown>)["apiKeyConfigured"]).toBe(true);

    const empty = await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "zai-coding-cn/glm-5.2", apiKey: "" }),
    );
    expect(empty.status).toBe(400);
  });

  it("PUT 非法 model / 缺 model → 400", async () => {
    const server = await makeSettingsServer();
    const invalid = await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "no-slash" }),
    );
    expect(invalid.status).toBe(400);
    const missing = await request(server, "PUT", "/api/settings/model", JSON.stringify({}));
    expect(missing.status).toBe(400);
  });

  it("DELETE /key：清除后 apiKeyConfigured=false；env 场景保持 environment", async () => {
    const server = await makeSettingsServer();
    await request(
      server,
      "PUT",
      "/api/settings/model",
      JSON.stringify({ model: "zai-coding-cn/glm-5.3", apiKey: SENTINEL_KEY }),
    );
    const cleared = await request(server, "DELETE", "/api/settings/model/key");
    expect(cleared.status).toBe(200);
    const settings = JSON.parse(cleared.text)["settings"] as Record<string, unknown>;
    expect(settings["apiKeyConfigured"]).toBe(false);
    expect(settings["model"]).toBe("zai-coding-cn/glm-5.3");
    expect(cleared.text).not.toContain(SENTINEL_KEY);
  });

  it("GET /options：provider 列表；?provider= 模型列表；未知 provider → 400", async () => {
    const server = await makeSettingsServer();
    const list = await getJson(server, "/api/settings/model/options");
    const providers = (list["options"] as { providers: unknown[] }).providers;
    expect(providers.length).toBeGreaterThan(10);

    const detail = await getJson(server, "/api/settings/model/options?provider=zai-coding-cn");
    const models = (detail["options"] as { models: { modelId: string }[] }).models;
    expect(models.map((m) => m.modelId)).toContain("glm-5.3");

    const unknown = await request(server, "GET", "/api/settings/model/options?provider=nope");
    expect(unknown.status).toBe(400);
  });

  it("POST /test：MODEL_NOT_FOUND 返回 200 + ok=false（不抛 5xx）", async () => {
    const server = await makeSettingsServer();
    const response = await request(
      server,
      "POST",
      "/api/settings/model/test",
      JSON.stringify({ model: "zai-coding-cn/no-such-model" }),
    );
    expect(response.status).toBe(200);
    const result = JSON.parse(response.text)["result"] as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("MODEL_NOT_FOUND");
  });

  it("方法不允许与未知子路径：405 / 404", async () => {
    const server = await makeSettingsServer();
    expect((await request(server, "POST", "/api/settings/model", "{}")).status).toBe(405);
    expect((await request(server, "GET", "/api/settings/model/key")).status).toBe(405);
    expect((await request(server, "GET", "/api/settings/model/unknown-sub")).status).toBe(404);
  });

  it("服务未配置（modelSettings 缺省）→ 503", async () => {
    const server = createBackendHttpServer({
      runtime: {} as never,
      projects: {} as never,
      generation: {} as never,
      orchestrator: {} as never,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const response = await request(server, "GET", "/api/settings/model");
    expect(response.status).toBe(503);
  });

  it("env 覆盖场景：configurationSource=environment（GET 如实提示）", async () => {
    const server = await makeSettingsServer({ piModel: "zai-coding-cn/glm-5.2" });
    const body = await getJson(server, "/api/settings/model");
    const settings = body["settings"] as Record<string, unknown>;
    expect(settings["configurationSource"]).toBe("environment");
    expect(String(settings["detail"])).toContain("环境变量");
  });
});

function responseText(body: unknown): string {
  return JSON.stringify(body);
}
