import type { Server } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { createBackendHttpServer } from "../src/httpServer.js";
import type { AgentRuntime, RuntimeHealth } from "../src/runtime/types.js";

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Backend HTTP /health", () => {
  it("runtime 健康时返回 200 与结构化状态", async () => {
    const server = await startBackend(healthyRuntime());
    const body = await getJson(server, "/health");

    expect(body.status).toBe("ok");
    expect(body.runtime?.provider).toBe("openclaw");
    expect(body.runtime?.ok).toBe(true);
    expect(body.runtime?.status).toBe("healthy");
    expect(typeof body.runtime?.detail).toBe("string");
    expect(typeof body.runtime?.latencyMs).toBe("number");
    expect(typeof body.runtime?.checkedAt).toBe("string");
  });

  it("runtime 不可用时仍返回 200，但 runtime.ok 为 false", async () => {
    const server = await startBackend({
      ...healthyRuntime(),
      healthCheck: async () => makeHealth(false, "unreachable", "无法连接 Gateway"),
    });
    const body = await getJson(server, "/health");

    expect(body.status).toBe("ok");
    expect(body.runtime?.ok).toBe(false);
    expect(body.runtime?.status).toBe("unreachable");
  });

  it("未知路径返回 404", async () => {
    const server = await startBackend(healthyRuntime());
    const response = await request(server, "GET", "/api/unknown");
    expect(response.status).toBe(404);
  });

  it("/health 只允许 GET/HEAD，POST 返回 405", async () => {
    const server = await startBackend(healthyRuntime());
    const response = await request(server, "POST", "/health");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

function healthyRuntime(): AgentRuntime {
  return {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true, "healthy", "Gateway 在线"),
    runAgent: () => {
      throw new Error("not implemented");
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    cancelTask: () => {
      throw new Error("not implemented");
    },
    sendMessage: () => {
      throw new Error("not implemented");
    },
    streamEvents: () => {
      throw new Error("not implemented");
    },
  };
}

function makeHealth(
  ok: boolean,
  status: RuntimeHealth["status"],
  detail: string,
): RuntimeHealth {
  return {
    ok,
    provider: "openclaw",
    status,
    detail,
    latencyMs: ok ? 12 : null,
    checkedAt: new Date().toISOString(),
  };
}

async function startBackend(runtime: AgentRuntime): Promise<Server> {
  const server = createBackendHttpServer({ runtime });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

async function request(
  server: Server,
  method: string,
  path: string,
): Promise<{ status: number; headers: Headers; text: string }> {
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

interface HealthResponseBody {
  status?: string;
  runtime?: {
    provider?: string;
    ok?: boolean;
    status?: string;
    detail?: string;
    latencyMs?: number | null;
    checkedAt?: string;
  };
}

async function getJson(server: Server, path: string): Promise<HealthResponseBody> {
  const response = await request(server, "GET", path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return JSON.parse(response.text) as HealthResponseBody;
}
