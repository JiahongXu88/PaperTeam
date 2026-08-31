import { createServer, type Server } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { OpenClawRuntimeAdapter } from "../src/runtime/OpenClawRuntimeAdapter.js";
import { RuntimeCapabilityError } from "../src/runtime/types.js";

/**
 * 用本地真实 HTTP 服务模拟 Gateway 的各种行为，
 * 不依赖真实运行的 OpenClaw Gateway。
 */

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

describe("OpenClawRuntimeAdapter.healthCheck", () => {
  it("Gateway 正常：返回 healthy", async () => {
    const { baseUrl } = await startGatewayMock((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/health");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
    });

    const adapter = new OpenClawRuntimeAdapter({ baseUrl });
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(true);
    expect(health.provider).toBe("openclaw");
    expect(health.status).toBe("healthy");
    expect(health.detail).toContain("在线");
    expect(health.latencyMs).toEqual(expect.any(Number));
    expect(new Date(health.checkedAt).toString()).not.toBe("Invalid Date");
  });

  it("Gateway 返回 503：返回 unhealthy，detail 带状态码", async () => {
    const { baseUrl } = await startGatewayMock((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false }));
    });

    const adapter = new OpenClawRuntimeAdapter({ baseUrl });
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe("unhealthy");
    expect(health.detail).toContain("503");
  });

  it("Gateway 返回 200 但响应体不符合探针契约：返回 unhealthy", async () => {
    const { baseUrl } = await startGatewayMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    });

    const adapter = new OpenClawRuntimeAdapter({ baseUrl });
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe("unhealthy");
    expect(health.detail).toContain("响应异常");
  });

  it("Gateway 返回非 JSON 响应：返回 unhealthy", async () => {
    const { baseUrl } = await startGatewayMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>not the gateway</body></html>");
    });

    const adapter = new OpenClawRuntimeAdapter({ baseUrl });
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe("unhealthy");
    expect(health.detail).toContain("非 JSON");
  });

  it("连接被拒绝（端口无进程监听）：返回 unreachable 且不抛异常", async () => {
    const { baseUrl, server } = await startGatewayMock((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, status: "live" }));
    });
    // 关闭服务，让该端口回到无监听状态
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);

    const adapter = new OpenClawRuntimeAdapter({ baseUrl });
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe("unreachable");
    expect(health.detail).toContain("无法连接");
    expect(health.detail).not.toContain("\n");
  });

  it("请求超时：返回 timeout 且耗时受 timeoutMs 约束", async () => {
    const { baseUrl } = await startGatewayMock(() => {
      // 收到请求但永不响应
    });

    const adapter = new OpenClawRuntimeAdapter({ baseUrl, timeoutMs: 150 });
    const startedAt = Date.now();
    const health = await adapter.healthCheck();
    const elapsed = Date.now() - startedAt;

    expect(health.ok).toBe(false);
    expect(health.status).toBe("timeout");
    expect(health.detail).toContain("超时");
    expect(elapsed).toBeLessThan(3000);
  });

  it("baseUrl 非法时构造函数直接抛错", () => {
    expect(() => new OpenClawRuntimeAdapter({ baseUrl: "not-a-url" })).toThrow(/baseUrl/);
    expect(() => new OpenClawRuntimeAdapter({ baseUrl: "ftp://host:1" })).toThrow(/http/);
  });

  it("M1 范围外的方法抛出 RuntimeCapabilityError，而非假实现", () => {
    const adapter = new OpenClawRuntimeAdapter({ baseUrl: "http://127.0.0.1:18789" });

    expect(() => adapter.runAgent({ agentId: "writer", task: "t" })).toThrow(RuntimeCapabilityError);
    expect(() => adapter.getTask("t1")).toThrow(RuntimeCapabilityError);
    expect(() => adapter.cancelTask("t1")).toThrow(RuntimeCapabilityError);
    expect(() => adapter.sendMessage("s1", "hello")).toThrow(RuntimeCapabilityError);
    expect(() => adapter.streamEvents("t1", () => {})).toThrow(RuntimeCapabilityError);
  });
});

/** 启动一个模拟 Gateway 的本地 HTTP 服务 */
function startGatewayMock(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("unexpected listen address");
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
  });
}
