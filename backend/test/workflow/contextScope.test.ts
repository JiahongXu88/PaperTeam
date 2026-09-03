/**
 * Session contextScope（projectId × agentId × contextScope）测试（M3.0）。
 *
 * 验证 Adapter 的会话派生规则：
 * - 无 scope：保持 M2.1 行为（projectId 维度）
 * - 有 scope：不同 scope 派生不同 sessionKey，互不串会话
 * - 非法字符安全归一化（不破坏 sessionKey 结构、不注入 ":"）
 * - 显式 sessionKey 仍然优先
 * - 不同 project / 不同 agentId 隔离
 */

import { afterAll, describe, expect, it } from "vitest";

import { sanitizeContextScope } from "../../src/runtime/OpenClawRuntimeAdapter.js";
import { defaultHandler, startMockGateway, type MockGateway } from "../helpers/mockGateway.js";

const gateways: MockGateway[] = [];

afterAll(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()));
});

/** 启动一个记录 agent 请求 sessionKey 并回显的 mock Gateway */
async function startEchoGateway(): Promise<{ gateway: MockGateway; seenSessionKeys: string[] }> {
  const seenSessionKeys: string[] = [];
  const gateway = await startMockGateway({
    handler: (method, params) => {
      if (method === "agent") {
        const key = typeof params["sessionKey"] === "string" ? params["sessionKey"] : "";
        seenSessionKeys.push(key);
        return {
          ok: true,
          payload: {
            runId: `run-scope-${seenSessionKeys.length}`,
            sessionKey: key,
            agentId: "reviewer",
            status: "accepted",
            acceptedAt: Date.now(),
          },
        };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { runId: "run-scope", status: "ok" } };
      }
      if (method === "chat.history") {
        return { ok: true, payload: { messages: [{ role: "assistant", text: "ok" }] } };
      }
      return defaultHandler()(method, params);
    },
  });
  gateways.push(gateway);
  return { gateway, seenSessionKeys };
}

describe("sanitizeContextScope（纯函数）", () => {
  it("合法值保持不变（小写）", () => {
    expect(sanitizeContextScope("research")).toBe("research");
    expect(sanitizeContextScope("review/fact")).toBe("review/fact");
  });

  it("大写归一化为小写", () => {
    expect(sanitizeContextScope("Review/Fact")).toBe("review/fact");
  });

  it("非法字符折叠为 '-'，不注入 ':'，不产生空 scope", () => {
    const scope = sanitizeContextScope("review fact:injected");
    expect(scope).not.toContain(":");
    expect(scope).not.toContain(" ");
    expect(scope).toBeDefined();
  });

  it("空 / 仅非法字符 → undefined", () => {
    expect(sanitizeContextScope(undefined)).toBeUndefined();
    expect(sanitizeContextScope("")).toBeUndefined();
    expect(sanitizeContextScope("   ")).toBeUndefined();
  });
});

describe("contextScope 会话派生（mock Gateway 全链路）", () => {
  it("同一 agent 不同 scope 派生不同 sessionKey；同 scope 稳定复用", async () => {
    const { gateway, seenSessionKeys } = await startEchoGateway();
    const { OpenClawRuntimeAdapter } = await import("../../src/runtime/OpenClawRuntimeAdapter.js");
    const adapter = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      runTimeoutMs: 5_000,
      log: () => {},
    });

    const base = {
      agentId: "reviewer",
      task: "审查这段文字",
      projectId: "p-scope001",
    };
    await adapter.runAgent({ ...base, contextScope: "review/fact" });
    await adapter.runAgent({ ...base, contextScope: "review/academic" });
    await adapter.runAgent({ ...base, contextScope: "review/style" });
    await adapter.runAgent({ ...base, contextScope: "review/fact" }); // 重复 fact

    expect(seenSessionKeys).toEqual([
      "agent:reviewer:paperteam-p-scope001--review/fact",
      "agent:reviewer:paperteam-p-scope001--review/academic",
      "agent:reviewer:paperteam-p-scope001--review/style",
      "agent:reviewer:paperteam-p-scope001--review/fact", // 稳定复用
    ]);
    expect(new Set(seenSessionKeys).size).toBe(3); // 三个 scope 互不串会话
  });

  it("无 scope 保持 M2.1 派生规则（回归）", async () => {
    const { gateway, seenSessionKeys } = await startEchoGateway();
    const { OpenClawRuntimeAdapter } = await import("../../src/runtime/OpenClawRuntimeAdapter.js");
    const adapter = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });

    await adapter.runAgent({ agentId: "writer", task: "写作", projectId: "p-scope002" });
    expect(seenSessionKeys).toEqual(["agent:writer:paperteam-p-scope002"]);
  });

  it("不同 projectId 隔离；显式 sessionKey 优先", async () => {
    const { gateway, seenSessionKeys } = await startEchoGateway();
    const { OpenClawRuntimeAdapter } = await import("../../src/runtime/OpenClawRuntimeAdapter.js");
    const adapter = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });

    await adapter.runAgent({ agentId: "writer", task: "A", projectId: "p-scope003" });
    await adapter.runAgent({ agentId: "writer", task: "B", projectId: "p-scope004" });
    await adapter.runAgent({
      agentId: "writer",
      task: "C",
      projectId: "p-scope003",
      sessionKey: "agent:writer:custom-session",
    });

    expect(seenSessionKeys).toEqual([
      "agent:writer:paperteam-p-scope003",
      "agent:writer:paperteam-p-scope004",
      "agent:writer:custom-session",
    ]);
  });

  it("非法 scope 字符不会破坏 sessionKey 结构", async () => {
    const { gateway, seenSessionKeys } = await startEchoGateway();
    const { OpenClawRuntimeAdapter } = await import("../../src/runtime/OpenClawRuntimeAdapter.js");
    const adapter = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });

    await adapter.runAgent({
      agentId: "reviewer",
      task: "审查",
      projectId: "p-scope005",
      contextScope: "review:fact ../../evil",
    });

    const key = seenSessionKeys[0] ?? "";
    // 结构必须仍是 agent:{agentId}:{peer}，peer 内不再出现 ":" 或路径穿越
    expect(key.split(":")).toHaveLength(3);
    expect(key).toMatch(/^agent:reviewer:paperteam-p-scope005--[a-z0-9/_-]+$/);
    expect(key).not.toContain("..");
  });
});
