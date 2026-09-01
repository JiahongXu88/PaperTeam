import { afterEach, describe, expect, it } from "vitest";

import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
} from "../src/errors.js";
import { OpenClawRuntimeAdapter } from "../src/runtime/OpenClawRuntimeAdapter.js";
import {
  defaultHandler,
  startMockGateway,
  type MockGateway,
  type MockGatewayHandler,
} from "./helpers/mockGateway.js";

/**
 * runAgent 集成测试：通过本地真实 WebSocket mock Gateway 验证
 * connect 挑战/握手 → agent（accepted 验收）→ agent.wait → chat.history
 * 的完整调用序列（对齐 OpenClaw 2026.8.1 官方协议），不依赖真实 Gateway。
 *
 * 协议层（挑战、握手、帧编解码、request 关联）由官方
 * @openclaw/gateway-client 负责，mock 只实现服务端必需子集；
 * 测试重点是 PaperTeam Adapter 的行为。
 */

const LATEX_DOC = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\title{RAG 简介}",
  "\\end{document}",
].join("\n");

/** 2026.8.1 官方 agent RPC 的验收 payload（agent-run-admission-phase.ts） */
function acceptance(runId: string, sessionKey: string): Record<string, unknown> {
  return {
    runId,
    sessionKey,
    agentId: "writer",
    status: "accepted",
    acceptedAt: Date.now(),
  };
}

let gateway: MockGateway | null = null;

afterEach(async () => {
  if (gateway !== null) {
    await gateway.close();
    gateway = null;
  }
});

function makeAdapter(overrides: Partial<ConstructorParameters<typeof OpenClawRuntimeAdapter>[0]> = {}) {
  return new OpenClawRuntimeAdapter({
    baseUrl: gateway!.httpUrl,
    rpcTimeoutMs: 2_000,
    runTimeoutMs: 2_000,
    log: () => {},
    ...overrides,
  });
}

describe("OpenClawRuntimeAdapter.runAgent", () => {
  it("正常路径：agent(accepted) → agent.wait(ok) → chat.history 返回完整 LaTeX", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          expect(params["sessionKey"]).toBe("agent:writer:paperteam-p-test");
          return { ok: true, payload: acceptance("run-1", "agent:writer:paperteam-p-test") };
        }
        if (method === "agent.wait") {
          return { ok: true, payload: { runId: "run-1", status: "ok" } };
        }
        if (method === "chat.history") {
          expect(params["sessionKey"]).toBe("agent:writer:paperteam-p-test");
          return {
            ok: true,
            payload: {
              sessionKey: "agent:writer:paperteam-p-test",
              messages: [
                { role: "user", text: "写论文" },
                { role: "assistant", text: "中间回复" },
                { role: "assistant", text: LATEX_DOC },
              ],
            },
          };
        }
        return defaultHandler()(method, params);
      },
    });

    const task = await makeAdapter().runAgent({
      agentId: "writer",
      task: "写一篇关于 RAG 的短文",
      projectId: "p-test",
    });

    expect(task.taskId).toBe("run-1");
    expect(task.agentId).toBe("writer");
    expect(task.status).toBe("completed");
    expect(task.output).toBe(LATEX_DOC);
    expect(task.startedAt).toBeTruthy();
    expect(task.completedAt).toBeTruthy();
    // OpenClaw 细节只应存在于诊断 metadata
    expect(task.metadata).toEqual({ sessionKey: "agent:writer:paperteam-p-test" });

    // 请求序列与参数校验（connect 由官方客户端在收到挑战后发出）
    expect(gateway.requests.map((r) => r.method)).toEqual([
      "connect",
      "agent",
      "agent.wait",
      "chat.history",
    ]);
    const connectParams = gateway.requests[0]!.params;
    expect(connectParams["role"]).toBe("operator");
    expect(connectParams["scopes"]).toEqual(["operator.read", "operator.write"]);
    expect(connectParams["minProtocol"]).toBe(4);
    expect(connectParams["maxProtocol"]).toBe(4);
    const agentParams = gateway.requests[1]!.params;
    expect(agentParams["message"]).toContain("RAG");
    expect(agentParams["agentId"]).toBe("writer");
    expect(typeof agentParams["idempotencyKey"]).toBe("string");
  });

  it("会话派生：不同 Project 派生不同 sessionKey，同一 Project 稳定复用", async () => {
    const seenKeys: string[] = [];
    const handler: MockGatewayHandler = (method, params) => {
      if (method === "agent") {
        seenKeys.push(String(params["sessionKey"]));
        return {
          ok: true,
          payload: acceptance(`run-${seenKeys.length}`, String(params["sessionKey"])),
        };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { status: "ok" } };
      }
      if (method === "chat.history") {
        return { ok: true, payload: { messages: [{ role: "assistant", text: LATEX_DOC }] } };
      }
      return defaultHandler()(method, params);
    };
    gateway = await startMockGateway({ handler });
    const adapter = makeAdapter();

    await adapter.runAgent({ agentId: "writer", task: "写", projectId: "p-a" });
    await adapter.runAgent({ agentId: "writer", task: "写", projectId: "p-b" });
    // 同一 Project 第二次：显式传入上次返回的 sessionKey 时原样复用
    await adapter.runAgent({
      agentId: "writer",
      task: "写",
      projectId: "p-a",
      sessionKey: "agent:writer:paperteam-p-a",
    });

    expect(seenKeys).toEqual([
      "agent:writer:paperteam-p-a",
      "agent:writer:paperteam-p-b",
      "agent:writer:paperteam-p-a",
    ]);
  });

  it("第一次 agent.wait 未终态（pending / 等待窗口耗尽）时继续轮询直到 ok", async () => {
    let waitCalls = 0;
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: acceptance("run-2", "agent:writer:paperteam-s2") };
        }
        if (method === "agent.wait") {
          waitCalls += 1;
          return {
            ok: true,
            payload:
              waitCalls === 1
                ? { runId: "run-2", status: "pending", timeoutPhase: "queue" }
                : waitCalls === 2
                  // 等待窗口耗尽但运行未终结（无 endedAt）→ 仍需继续轮询
                  ? { runId: "run-2", status: "timeout", timeoutPhase: "queue" }
                  : { runId: "run-2", status: "ok" },
          };
        }
        if (method === "chat.history") {
          return {
            ok: true,
            payload: { messages: [{ role: "assistant", text: LATEX_DOC }] },
          };
        }
        return defaultHandler()(method, params);
      },
    });

    const task = await makeAdapter().runAgent({ agentId: "writer", task: "写", projectId: "p-s2" });
    expect(task.status).toBe("completed");
    expect(waitCalls).toBe(3);
    expect(params_of(gateway, "agent.wait")["runId"]).toBe("run-2");
  });

  it("运行以 error 终态结束：返回 status=failed 的任务（不抛异常）", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: acceptance("run-3", "agent:writer:paperteam-s3") };
        }
        if (method === "agent.wait") {
          return {
            ok: true,
            payload: { runId: "run-3", status: "error", error: "model provider 500" },
          };
        }
        return defaultHandler()(method, params);
      },
    });

    const task = await makeAdapter().runAgent({ agentId: "writer", task: "写" });
    expect(task.status).toBe("failed");
    expect(task.error).toContain("model provider 500");
  });

  it("Gateway RPC 拒绝（agent 返回错误响应）：抛 AgentRunFailedError", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return {
            ok: false,
            error: { code: "INVALID_REQUEST", message: "unknown agent: writer" },
          };
        }
        return defaultHandler()(method, params);
      },
    });

    await expect(
      makeAdapter().runAgent({ agentId: "writer", task: "写" }),
    ).rejects.toMatchObject({
      name: "BusinessError",
      code: "AGENT_RUN_FAILED",
      detail: expect.stringContaining("INVALID_REQUEST"),
    });
    expect(AgentRunFailedError).toBeDefined();
  });

  it("握手鉴权失败（connect 返回错误）：抛 AgentRuntimeUnavailableError", async () => {
    gateway = await startMockGateway({
      handler: (method) => {
        if (method === "connect") {
          return {
            ok: false,
            error: { code: "AUTH_TOKEN_MISMATCH", message: "token mismatch" },
          };
        }
        return defaultHandler()(method, {});
      },
    });

    await expect(makeAdapter().runAgent({ agentId: "writer", task: "写" })).rejects.toMatchObject({
      code: "AGENT_RUNTIME_UNAVAILABLE",
      detail: expect.stringContaining("AUTH_TOKEN_MISMATCH"),
    });
    expect(AgentRuntimeUnavailableError).toBeDefined();
  });

  it("connect 无响应：连接超时抛 AgentRuntimeUnavailableError（时间受预算约束）", async () => {
    gateway = await startMockGateway({
      handler: () => undefined, // 全部不响应
    });

    const startedAt = Date.now();
    await expect(
      makeAdapter({ rpcTimeoutMs: 200 }).runAgent({ agentId: "writer", task: "写" }),
    ).rejects.toMatchObject({ code: "AGENT_RUNTIME_UNAVAILABLE" });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(3_000);
  });

  it("agent 响应缺少 runId（畸形响应）：抛 AgentRunFailedError", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: { status: "accepted" } }; // 没有 runId
        }
        return defaultHandler()(method, params);
      },
    });

    await expect(makeAdapter().runAgent({ agentId: "writer", task: "写" })).rejects.toMatchObject({
      code: "AGENT_RUN_FAILED",
      message: expect.stringContaining("runId"),
    });
  });

  it("运行一直不结束：整体超时抛 AgentTimeoutError", async () => {
    gateway = await startMockGateway({
      responseDelayMs: 30,
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: acceptance("run-9", "agent:writer:paperteam-s9") };
        }
        if (method === "agent.wait") {
          return { ok: true, payload: { runId: "run-9", status: "pending" } };
        }
        return defaultHandler()(method, params);
      },
    });

    await expect(
      makeAdapter({ runTimeoutMs: 400, rpcTimeoutMs: 2_000 }).runAgent({
        agentId: "writer",
        task: "写",
      }),
    ).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
    expect(AgentTimeoutError).toBeDefined();
  });

  it("chat.history 失败时退回 terminalReply 文本", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: acceptance("run-a", "agent:writer:paperteam-sa") };
        }
        if (method === "agent.wait") {
          return {
            ok: true,
            payload: {
              runId: "run-a",
              status: "ok",
              endedAt: Date.now(),
              terminalReply: { disposition: "visible", text: LATEX_DOC },
            },
          };
        }
        if (method === "chat.history") {
          return { ok: false, error: { code: "UNAVAILABLE", message: "history rebuilding" } };
        }
        return defaultHandler()(method, params);
      },
    });

    const task = await makeAdapter().runAgent({ agentId: "writer", task: "写" });
    expect(task.status).toBe("completed");
    expect(task.output).toBe(LATEX_DOC);
  });

  it("运行成功但没有任何文本：抛 AgentRunFailedError", async () => {
    gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: true, payload: acceptance("run-b", "agent:writer:paperteam-sb") };
        }
        if (method === "agent.wait") {
          return { ok: true, payload: { runId: "run-b", status: "ok" } };
        }
        if (method === "chat.history") {
          return { ok: true, payload: { messages: [{ role: "user", text: "写" }] } };
        }
        return defaultHandler()(method, params);
      },
    });

    await expect(makeAdapter().runAgent({ agentId: "writer", task: "写" })).rejects.toMatchObject({
      code: "AGENT_RUN_FAILED",
      message: expect.stringContaining("没有返回任何文本"),
    });
  });

  it("连接被 Gateway 立即断开：抛 AgentRuntimeUnavailableError", async () => {
    // 启动后立即关闭：连接会被拒绝
    const deadGateway = await startMockGateway({ handler: defaultHandler() });
    const deadUrl = deadGateway.httpUrl;
    await deadGateway.close();

    const adapter = new OpenClawRuntimeAdapter({
      baseUrl: deadUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });
    await expect(adapter.runAgent({ agentId: "writer", task: "写" })).rejects.toMatchObject({
      code: "AGENT_RUNTIME_UNAVAILABLE",
    });
  });

  it("close() 后再 runAgent：抛 AgentRuntimeUnavailableError；close 幂等", async () => {
    gateway = await startMockGateway({ handler: defaultHandler() });
    const adapter = makeAdapter();
    await adapter.close();
    await adapter.close();
    await expect(adapter.runAgent({ agentId: "writer", task: "写" })).rejects.toMatchObject({
      code: "AGENT_RUNTIME_UNAVAILABLE",
    });
  });
});

function params_of(gw: MockGateway, method: string): Record<string, unknown> {
  const found = gw.requests.find((request) => request.method === method);
  if (!found) {
    throw new Error(`no request for ${method}`);
  }
  return found.params;
}
