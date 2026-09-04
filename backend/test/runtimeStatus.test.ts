/**
 * Runtime 状态诊断（RuntimeStatusService / GET /api/runtime/status，M3.8
 * 去 Gateway 化）测试。使用 fake AgentRuntime（healthCheck +
 * modelStatusSnapshot + runtimeStats），覆盖：runtime healthy/unhealthy、
 * model configured/not_configured/unknown、agents 映射、sessions 诊断、
 * 敏感信息不泄露。
 */

import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { RuntimeStatusService } from "../src/runtime/statusService.js";
import { PI_RUNTIME_VERSION } from "../src/runtime/pi/version.js";
import type { AgentRuntime, RuntimeHealth } from "../src/runtime/types.js";
import { createBackendHttpServer } from "../src/httpServer.js";
import { AGENT_IDS } from "./helpers/testStack.js";

const AGENT_IDS_MAIN = { writer: "main", researcher: "main", reviewer: "main", citation: "main" };

/** fake PiRuntimeAdapter 诊断表面：healthCheck + 模型就绪 + 会话统计 */
function makeRuntime(options: {
  healthy?: boolean;
  modelPhase?: "configured" | "not_configured" | "unknown";
  model?: string;
  providers?: string[];
  activeRuns?: number;
  managedSessions?: number;
}): AgentRuntime {
  const healthy = options.healthy ?? true;
  const modelPhase = options.modelPhase ?? (healthy ? "configured" : "unknown");
  const health = (ok: boolean): RuntimeHealth => ({
    ok,
    provider: "pi",
    status: ok ? "healthy" : "unhealthy",
    detail: ok ? "Pi in-process Runtime 正常" : "Pi Runtime 初始化失败：boom",
    latencyMs: ok ? 7 : null,
    checkedAt: new Date().toISOString(),
  });
  return {
    provider: "pi",
    healthCheck: async () => health(healthy),
    startAgent: () => {
      throw new Error("not needed in this test");
    },
    runAgent: () => {
      throw new Error("not needed in this test");
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
    ...(options.modelPhase !== "unknown"
      ? {
          modelStatusSnapshot: async () => ({
            phase: modelPhase,
            providers: options.providers ?? [],
            detail: modelPhase === "configured" ? "模型已配置" : "PAPERTEAM_PI_MODEL 未设置",
          }),
        }
      : {}),
    ...(options.model !== undefined ? { resolvedModel: options.model } : {}),
    runtimeStats: () => ({
      activeRuns: options.activeRuns ?? 0,
      managedSessions: options.managedSessions ?? 0,
    }),
  } as AgentRuntime;
}

function makeService(runtime: AgentRuntime, agentIds = AGENT_IDS_MAIN) {
  return new RuntimeStatusService({ runtime, agentIds });
}

describe("RuntimeStatusService（Pi 形状）", () => {
  it("全绿：runtime healthy + version、model configured（含标签与 providers）、agents 全 configured", async () => {
    const status = await makeService(
      makeRuntime({
        modelPhase: "configured",
        model: "anthropic/claude-opus-4-5",
        providers: ["anthropic"],
        activeRuns: 2,
        managedSessions: 3,
      }),
    ).getStatus();
    expect(status.backend.ok).toBe(true);
    expect(status.runtime.provider).toBe("pi");
    expect(status.runtime.phase).toBe("healthy");
    expect(status.runtime.version).toBe(PI_RUNTIME_VERSION);
    expect(status.runtime.latencyMs).toBe(7);
    expect(status.model.phase).toBe("configured");
    expect(status.model.model).toBe("anthropic/claude-opus-4-5");
    expect(status.model.providers).toEqual(["anthropic"]);
    expect(status.agents.roles).toHaveLength(4);
    for (const role of status.agents.roles) {
      expect(role.status).toBe("configured");
      expect(role.agentId).toBe("main");
    }
    expect(status.sessions).toEqual({ activeRuns: 2, managedSessions: 3 });
    // 新形状不再有 Gateway 概念
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("gateway");
    expect(serialized).not.toContain("not_applicable");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("apiKey");
  });

  it("Runtime 健康 ≠ 模型就绪：无 Key 时 runtime=healthy、model=not_configured", async () => {
    const status = await makeService(
      makeRuntime({ healthy: true, modelPhase: "not_configured" }),
    ).getStatus();
    expect(status.runtime.phase).toBe("healthy");
    expect(status.model.phase).toBe("not_configured");
    expect(status.model.model).toBeUndefined();
    expect(status.model.detail).toContain("PAPERTEAM_PI_MODEL");
  });

  it("Runtime 不健康（初始化失败 / 已关闭）→ runtime=unhealthy、model=unknown", async () => {
    const status = await makeService(makeRuntime({ healthy: false })).getStatus();
    expect(status.runtime.phase).toBe("unhealthy");
    expect(status.runtime.detail).toContain("初始化失败");
    expect(status.model.phase).toBe("unknown");
  });

  it("角色映射使用配置的会话标识（Pi 无 agent 注册表，映射恒存在）", async () => {
    const status = await makeService(
      makeRuntime({ modelPhase: "configured" }),
      {
        researcher: "researcher",
        writer: "writer",
        reviewer: "reviewer",
        citation: "citation",
      },
    ).getStatus();
    const byRole = new Map(status.agents.roles.map((role) => [role.role, role.agentId]));
    expect(byRole.get("researcher")).toBe("researcher");
    expect(byRole.get("writer")).toBe("writer");
    expect(byRole.get("reviewer")).toBe("reviewer");
    expect(byRole.get("citation")).toBe("citation");
    expect(status.agents.roles.every((role) => role.status === "configured")).toBe(true);
  });

  it("Runtime 未暴露模型摘要 → model=unknown，整体不失败", async () => {
    const status = await makeService(
      makeRuntime({ healthy: true, modelPhase: "unknown" }),
    ).getStatus();
    expect(status.model.phase).toBe("unknown");
    expect(status.model.detail).toContain("未暴露");
    expect(status.runtime.phase).toBe("healthy");
  });
});

// ---- HTTP 路由 ----

describe("GET /api/runtime/status（HTTP）", () => {
  it("配置了诊断服务 → 200 结构化状态", async () => {
    const service = new RuntimeStatusService({
      runtime: makeRuntime({ healthy: true, modelPhase: "not_configured" }),
      agentIds: { ...AGENT_IDS },
    });
    const server = createBackendHttpServer({
      runtime: makeRuntime({ healthy: true, modelPhase: "not_configured" }),
      projects: null as never,
      generation: null as never,
      orchestrator: null as never,
      runtimeStatus: service,
    });
    await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${portOf(server)}/api/runtime/status`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: { runtime: { phase: string }; model: { phase: string } } };
      expect(body.status.runtime.phase).toBe("healthy");
      expect(body.status.model.phase).toBe("not_configured");
    } finally {
      await close(server);
    }
  });

  it("未配置诊断服务 → 503 明确提示", async () => {
    const server = createBackendHttpServer({
      runtime: makeRuntime({ healthy: true, modelPhase: "configured" }),
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
