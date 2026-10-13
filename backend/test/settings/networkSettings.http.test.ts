/**
 * Network Settings HTTP 层（M13.8）：路由 / 状态码 / 形状校验 / 503 未配置。
 * 组装：真 Store（临时目录）+ 真 Service（假 router / 假探测）+ createBackendHttpServer。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";

import type { Dispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";

import { createBackendHttpServer } from "../../src/httpServer.js";
import { ResearchFetchRouter } from "../../src/network/researchProxy.js";
import { NetworkSettingsService } from "../../src/settings/NetworkSettingsService.js";
import { NetworkSettingsStore } from "../../src/settings/NetworkSettingsStore.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

async function makeServer(withService = true): Promise<{ server: Server; router: ResearchFetchRouter }> {
  const settingsDir = await mkdtemp(join(tmpdir(), "net-http-settings-"));
  tempDirs.push(settingsDir);
  const router = new ResearchFetchRouter({
    directFetch: (async () => new Response("direct")) as typeof fetch,
    proxiedFetch: async () => new Response("proxied"),
    createDispatcher: () => ({ close: async () => {}, destroy: async () => {} }) as unknown as Dispatcher,
  });
  const service = new NetworkSettingsService({
    store: new NetworkSettingsStore({ settingsDir }),
    router,
    createProbeRouter: () => ({
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("arxiv.org/pdf")) {
          return new Response(Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(1024)]), { status: 200 });
        }
        if (url.includes("export.arxiv.org")) return new Response("<feed/>", { status: 200 });
        if (url.includes("openalex")) return new Response('{"results":[]}', { status: 429, headers: { "retry-after": "120" } });
        if (url.includes("semanticscholar")) return new Response('{"data":[]}', { status: 200 });
        return new Response('{"status":"ok"}', { status: 200 });
      }) as typeof fetch,
      close: async () => {},
    }),
    connectProbe: async (_host, port) => (port === 7890 ? { ok: true } : { ok: false, code: "ECONNREFUSED" }),
  });
  const server = createBackendHttpServer({
    runtime: {} as never,
    projects: {} as never,
    generation: {} as never,
    orchestrator: {} as never,
    ...(withService ? { networkSettings: service } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { server, router };
}

async function call(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> {
  const address = server.address() as { port: number };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers: payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

describe("HTTP /api/settings/network", () => {
  it("GET 初态 none；PUT 保存 → stored 并切换 router；GET 读回；形状错误 400；405", async () => {
    const { server, router } = await makeServer();
    const initial = await call(server, "GET", "/api/settings/network");
    expect(initial.status).toBe(200);
    const settings = initial.body["settings"] as Record<string, unknown>;
    expect(settings["source"]).toBe("none");
    expect(settings["effective"]).toBeNull();
    expect(Array.isArray((settings["scope"] as Record<string, unknown>)["appliesTo"])).toBe(true);

    const saved = await call(server, "PUT", "/api/settings/network", { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(saved.status).toBe(200);
    expect((saved.body["settings"] as Record<string, unknown>)["source"]).toBe("stored");
    expect((saved.body["settings"] as Record<string, unknown>)["effectiveUrl"]).toBe("http://127.0.0.1:7890");
    expect(router.current()).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });

    const readBack = await call(server, "GET", "/api/settings/network");
    expect((readBack.body["settings"] as Record<string, unknown>)["saved"]).toEqual({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });

    const badShape = await call(server, "PUT", "/api/settings/network", { enabled: "yes", protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(badShape.status).toBe(400);
    const badValue = await call(server, "PUT", "/api/settings/network", { enabled: true, protocol: "http", host: "127.0.0.1", port: 70000 });
    expect(badValue.status).toBe(400);
    expect(String(badValue.body["message"] ?? badValue.body["detail"] ?? JSON.stringify(badValue.body))).toContain("端口");
    const userinfo = await call(server, "PUT", "/api/settings/network", { enabled: true, protocol: "http", host: "u:p@127.0.0.1", port: 7890 });
    expect(userinfo.status).toBe(400);

    const notAllowed = await call(server, "DELETE", "/api/settings/network");
    expect(notAllowed.status).toBe(405);
    const unknown = await call(server, "GET", "/api/settings/network/whatever");
    expect(unknown.status).toBe(404);
  });

  it("POST /test：候选配置 → 分类结果；空体 = 测当前生效；代理不可达 → ok=false", async () => {
    const { server } = await makeServer();
    const candidate = await call(server, "POST", "/api/settings/network/test", { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(candidate.status).toBe(200);
    const result = candidate.body["result"] as Record<string, unknown>;
    expect(result["mode"]).toBe("proxy");
    expect(result["ok"]).toBe(true);
    const checks = result["checks"] as Array<Record<string, unknown>>;
    expect(checks.find((check) => check["id"] === "openalex")?.["status"]).toBe("rate_limited");
    expect(checks.find((check) => check["id"] === "arxiv_pdf")?.["status"]).toBe("ok");

    const effective = await call(server, "POST", "/api/settings/network/test", {});
    expect(effective.status).toBe(200);
    expect((effective.body["result"] as Record<string, unknown>)["mode"]).toBe("direct");

    const down = await call(server, "POST", "/api/settings/network/test", { enabled: true, protocol: "http", host: "127.0.0.1", port: 7899 });
    expect((down.body["result"] as Record<string, unknown>)["ok"]).toBe(false);

    const wrongMethod = await call(server, "GET", "/api/settings/network/test");
    expect(wrongMethod.status).toBe(405);
  });

  it("未装配 NetworkSettingsService → 503", async () => {
    const { server } = await makeServer(false);
    const response = await call(server, "GET", "/api/settings/network");
    expect(response.status).toBe(503);
  });
});
