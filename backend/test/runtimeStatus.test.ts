/**
 * M3.5 Runtime 状态诊断（RuntimeStatusService / GET /api/runtime/status）测试。
 * 使用 fake AgentRuntime（healthCheck）+ fake StatusConnection（RPC），
 * 覆盖：healthy / unavailable / auth_error / protocol_mismatch /
 * model_not_configured / agent mapping configured|missing。
 */

import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { GatewayConnectionError } from "../src/runtime/openclaw/gatewayClient.js";
import {
  GATEWAY_CLIENT_SDK_VERSION,
  RuntimeStatusService,
  type ConnectionDeps,
  type StatusConnection,
} from "../src/runtime/statusService.js";
import { OPENCLAW_RUNTIME_VERSION } from "../src/dev/runtimeConfig.js";
import type { AgentRuntime, RuntimeHealth } from "../src/runtime/types.js";
import { createBackendHttpServer } from "../src/httpServer.js";
import { AGENT_IDS } from "./helpers/testStack.js";

const AGENT_IDS_MAIN = { writer: "main", researcher: "main", reviewer: "main", citation: "main" };

function makeRuntime(healthy: boolean): AgentRuntime & { connectionInfo?: () => { baseUrl: string } } {
  const health = (ok: boolean): RuntimeHealth => ({
    ok,
    provider: "openclaw",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "Gateway 在线" : "connect ECONNREFUSED",
    latencyMs: ok ? 3 : null,
    checkedAt: new Date().toISOString(),
  });
  const runtime = {
    provider: "openclaw" as const,
    healthCheck: async () => health(healthy),
    connectionInfo: () => ({ baseUrl: "http://127.0.0.1:18790" }),
  };
  return runtime as AgentRuntime & { connectionInfo?: () => { baseUrl: string } };
}

/** 脚本化诊断连接：connect 行为 + 各 RPC 响应可配置 */
function makeConnection(options: {
  connectError?: Error;
  responses?: Record<string, unknown>;
  rpcError?: { method: string; error: Error };
}): StatusConnection & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    connect: async () => {
      if (options.connectError) {
        throw options.connectError;
      }
    },
    request: async <T>(method: string): Promise<T> => {
      requests.push(method);
      if (options.rpcError && method === options.rpcError.method) {
        throw options.rpcError.error;
      }
      const response = options.responses?.[method];
      return (response === undefined ? {} : response) as T;
    },
    stop: async () => {},
  };
}

const IDENTITY = { version: OPENCLAW_RUNTIME_VERSION, protocol: 4 };
const AGENTS_LIST = {
  defaultId: "main",
  ownership: "sole",
  agents: [{ id: "main", kind: "agent" }],
};
const AGENTS_LIST_MULTI = {
  defaultId: "main",
  ownership: "explicit",
  agents: [{ id: "main" }, { id: "researcher" }, { id: "writer" }],
};
const MODEL_CONFIGURED = { providers: [{ provider: "anthropic" }, { provider: "openai" }] };
const MODEL_EMPTY = { providers: [] };

function makeService(connection: StatusConnection, agentIds = AGENT_IDS_MAIN) {
  return new RuntimeStatusService({
    runtime: makeRuntime(true),
    agentIds,
    expectedRuntimeVersion: OPENCLAW_RUNTIME_VERSION,
    createConnection: () => connection,
  });
}

describe("RuntimeStatusService", () => {
  it("全绿：gateway healthy、agents configured、model configured、版本一致", async () => {
    const connection = makeConnection({
      responses: {
        "gateway.identity.get": IDENTITY,
        "agents.list": AGENTS_LIST,
        "models.authStatus": MODEL_CONFIGURED,
      },
    });
    const status = await makeService(connection).getStatus();
    expect(status.gateway.phase).toBe("healthy");
    expect(status.runtime.phase).toBe("ready");
    expect(status.versions.gatewayRuntime).toBe(OPENCLAW_RUNTIME_VERSION);
    expect(status.versions.expectedRuntime).toBe(OPENCLAW_RUNTIME_VERSION);
    expect(status.versions.protocol).toBe(4);
    expect(status.versions.gatewayClientSdk).toBe(GATEWAY_CLIENT_SDK_VERSION);
    expect(status.agents.defaultId).toBe("main");
    expect(status.agents.ownership).toBe("sole");
    for (const role of status.agents.roles) {
      expect(role.status).toBe("configured");
      expect(role.agentId).toBe("main");
    }
    expect(status.model.phase).toBe("configured");
    expect(status.model.providers).toEqual(["anthropic", "openai"]);
    // 不泄露敏感信息
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("apiKey");
  });

  it("gateway 不可达 → gateway unavailable / runtime gateway_unavailable，roles 标记 missing", async () => {
    const connection = makeConnection({});
    const service = new RuntimeStatusService({
      runtime: makeRuntime(false),
      agentIds: AGENT_IDS_MAIN,
      createConnection: () => connection,
    });
    const status = await service.getStatus();
    expect(status.gateway.phase).toBe("unavailable");
    expect(status.runtime.phase).toBe("gateway_unavailable");
    expect(status.agents.roles.every((role) => role.status === "missing")).toBe(true);
    expect(connection.requests).toHaveLength(0); // 未发起 RPC
  });

  it("token 不匹配 → auth_error（gateway 与 runtime 同步）", async () => {
    const connection = makeConnection({
      connectError: new GatewayConnectionError("auth", "AUTH_TOKEN_MISMATCH"),
    });
    const status = await makeService(connection).getStatus();
    expect(status.gateway.phase).toBe("auth_error");
    expect(status.runtime.phase).toBe("auth_error");
    expect(status.runtime.detail).toContain("OPENCLAW_GATEWAY_API_KEY");
  });

  it("协议不匹配 → protocol_mismatch", async () => {
    const connection = makeConnection({
      connectError: new GatewayConnectionError("protocol", "PROTOCOL_MISMATCH"),
    });
    const status = await makeService(connection).getStatus();
    expect(status.gateway.phase).toBe("protocol_mismatch");
    expect(status.runtime.phase).toBe("protocol_mismatch");
  });

  it("模型未配置 → runtime phase = model_not_configured（gateway 仍 healthy）", async () => {
    const connection = makeConnection({
      responses: {
        "gateway.identity.get": IDENTITY,
        "agents.list": AGENTS_LIST,
        "models.authStatus": MODEL_EMPTY,
      },
    });
    const status = await makeService(connection).getStatus();
    expect(status.gateway.phase).toBe("healthy");
    expect(status.runtime.phase).toBe("model_not_configured");
    expect(status.model.phase).toBe("not_configured");
    expect(status.runtime.detail).toContain("模型未配置");
  });

  it("映射到未注册的 agentId → 该角色 missing（多 agent 注册表场景）", async () => {
    const connection = makeConnection({
      responses: {
        "gateway.identity.get": IDENTITY,
        "agents.list": AGENTS_LIST_MULTI, // 注册表：main / researcher / writer
        "models.authStatus": MODEL_CONFIGURED,
      },
    });
    // researcher/writer 映射到已注册的独立 agent；reviewer/citation 映射到不存在的 id
    const status = await makeService(connection, {
      researcher: "researcher",
      writer: "writer",
      reviewer: "reviewer",
      citation: "citation",
    }).getStatus();
    const byRole = new Map(status.agents.roles.map((role) => [role.role, role.status]));
    expect(byRole.get("researcher")).toBe("configured");
    expect(byRole.get("writer")).toBe("configured");
    expect(byRole.get("reviewer")).toBe("missing");
    expect(byRole.get("citation")).toBe("missing");
  });

  it("models.authStatus RPC 失败 → model unknown，但整体不失败", async () => {
    const connection = makeConnection({
      responses: {
        "gateway.identity.get": IDENTITY,
        "agents.list": AGENTS_LIST,
      },
      rpcError: { method: "models.authStatus", error: new Error("not available") },
    });
    const status = await makeService(connection).getStatus();
    expect(status.model.phase).toBe("unknown");
    expect(status.gateway.phase).toBe("healthy");
    expect(status.runtime.phase).toBe("ready");
  });

  it("agents.list RPC 失败 → gateway starting，roles 全部 missing", async () => {
    const connection = makeConnection({
      responses: { "gateway.identity.get": IDENTITY },
      rpcError: { method: "agents.list", error: new Error("boom") },
    });
    const status = await makeService(connection).getStatus();
    expect(status.gateway.phase).toBe("starting");
    expect(status.runtime.phase).toBe("gateway_unavailable");
    expect(status.agents.roles.every((role) => role.status === "missing")).toBe(true);
  });
});

// ---- HTTP 路由 ----

describe("GET /api/runtime/status（HTTP）", () => {
  it("配置了诊断服务 → 200 结构化状态", async () => {
    const connection = makeConnection({
      responses: {
        "gateway.identity.get": IDENTITY,
        "agents.list": AGENTS_LIST,
        "models.authStatus": MODEL_EMPTY,
      },
    });
    const service = new RuntimeStatusService({
      runtime: makeRuntime(true),
      agentIds: { ...AGENT_IDS },
      createConnection: () => connection,
    });
    const server = createBackendHttpServer({
      runtime: makeRuntime(true),
      projects: null as never,
      generation: null as never,
      orchestrator: null as never,
      runtimeStatus: service,
    });
    await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${portOf(server)}/api/runtime/status`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: { runtime: { phase: string } } };
      expect(body.status.runtime.phase).toBe("model_not_configured");
    } finally {
      await close(server);
    }
  });

  it("未配置诊断服务 → 503 明确提示", async () => {
    const server = createBackendHttpServer({
      runtime: makeRuntime(true),
      projects: null as never,
      generation: null as never,
      orchestrator: null as never,
    });
    await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${portOf(server)}/api/runtime/status`);
      expect(response.status).toBe(503);
    } finally {
      await close(server);
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function portOf(server: Server): number {
  return (server.address() as { port: number }).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
