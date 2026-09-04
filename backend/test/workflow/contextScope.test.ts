/**
 * Session contextScope（projectId × agentId × contextScope）测试（M3.0；
 * M3.8 载体迁移：mock Gateway → PiRuntimeAdapter Level 1 fake session）。
 *
 * 验证会话派生规则（PaperTeam 业务事实，与 Runtime 实现无关）：
 * - 无 scope：保持 M2.1 行为（projectId 维度）
 * - 有 scope：不同 scope 派生不同 sessionKey，互不串会话
 * - 非法字符安全归一化（不破坏 sessionKey 结构、不注入 ":"）
 * - 显式 sessionKey 仍然优先
 * - 不同 project / 不同 agentId 隔离
 * - 派生结果真实落到 Runtime 层（PiRuntimeAdapter 会话键与会话创建）
 */

import { afterAll, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { PiRuntimeOptions } from "../../src/runtime/PiRuntimeAdapter.js";
import {
  resolveSessionKey,
  sanitizeContextScope,
} from "../../src/runtime/sessionKey.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe("resolveSessionKey（派生规则）", () => {
  it("无 scope 保持 M2.1 派生规则（projectId 维度）", () => {
    expect(resolveSessionKey({ agentId: "writer", task: "t", projectId: "p1" })).toBe(
      "agent:writer:paperteam-p1",
    );
  });

  it("同一 agent 不同 scope 派生不同 sessionKey", () => {
    const base = { agentId: "reviewer", task: "t", projectId: "p1" };
    const fact = resolveSessionKey({ ...base, contextScope: "review/fact" });
    const academic = resolveSessionKey({ ...base, contextScope: "review/academic" });
    const style = resolveSessionKey({ ...base, contextScope: "review/style" });
    expect(fact).toBe("agent:reviewer:paperteam-p1--review/fact");
    expect(academic).toBe("agent:reviewer:paperteam-p1--review/academic");
    expect(style).toBe("agent:reviewer:paperteam-p1--review/style");
    expect(new Set([fact, academic, style]).size).toBe(3);
  });

  it("不同 projectId 隔离；显式 sessionKey 优先；缺 projectId 时交由实现兜底", () => {
    expect(resolveSessionKey({ agentId: "writer", task: "t", projectId: "p3" })).toBe(
      "agent:writer:paperteam-p3",
    );
    expect(resolveSessionKey({ agentId: "writer", task: "t", projectId: "p4" })).toBe(
      "agent:writer:paperteam-p4",
    );
    expect(
      resolveSessionKey({
        agentId: "writer",
        task: "t",
        projectId: "p3",
        sessionKey: "agent:writer:custom-session",
      }),
    ).toBe("agent:writer:custom-session");
    expect(resolveSessionKey({ agentId: "writer", task: "t" })).toBeUndefined();
  });

  it("非法 scope 字符不会破坏 sessionKey 结构", () => {
    const key = resolveSessionKey({
      agentId: "reviewer",
      task: "t",
      projectId: "p5",
      contextScope: "review:fact ../../evil",
    });
    expect(key).toBeDefined();
    // 结构必须仍是 agent:{agentId}:{peer}，peer 内不再出现 ":" 或路径穿越
    expect(key!.split(":")).toHaveLength(3);
    expect(key).toMatch(/^agent:reviewer:paperteam-p5--[a-z0-9/_-]+$/);
    expect(key).not.toContain("..");
  });
});

describe("contextScope 会话派生（PiRuntimeAdapter Level 1 全链路）", () => {
  /** 最小 fake session（prompt 立即完成；会话键由 Adapter 侧管理） */
  function fakeSessionFactory(): NonNullable<PiRuntimeOptions["createSession"]> {
    return async () => {
      const session = {
        prompt: async () => {
          const messages = [
            { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
          ];
          (session as { agent?: unknown }).agent = { state: { messages } };
        },
        subscribe: () => () => {},
        abort: async () => {},
        waitForIdle: async () => {},
        dispose: () => {},
        getLastAssistantText: () => "ok",
      };
      return session as unknown as AgentSession;
    };
  }

  async function makeAdapter(
    factory: NonNullable<PiRuntimeOptions["createSession"]>,
  ): Promise<PiRuntimeAdapter> {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-scope-agent-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-scope-ws-"));
    tempDirs.push(agentDir, workspaceRoot);
    return new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "fake", id: "fake-1" }) as PiModel,
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as unknown as PiRuntimeOptions["modelRuntime"],
      model: { provider: "fake", id: "fake-1" } as PiModel,
      createSession: factory,
      log: () => {},
    });
  }

  it("派生键真实落到 metadata.sessionKey；同 scope 复用会话、不同 scope 各建会话", async () => {
    const adapter = await makeAdapter(fakeSessionFactory());
    const base = { agentId: "reviewer", task: "审查", projectId: "p-scope001" };

    const tasks = await Promise.all([
      adapter.runAgent({ ...base, contextScope: "review/fact" }),
      adapter.runAgent({ ...base, contextScope: "review/academic" }),
      adapter.runAgent({ ...base, contextScope: "review/style" }),
      adapter.runAgent({ ...base, contextScope: "review/fact" }), // 重复 fact
    ]);

    const keys = tasks.map((task) => String(task.metadata?.["sessionKey"]));
    expect(keys.slice(0, 3)).toEqual([
      "agent:reviewer:paperteam-p-scope001--review/fact",
      "agent:reviewer:paperteam-p-scope001--review/academic",
      "agent:reviewer:paperteam-p-scope001--review/style",
    ]);
    // 同 scope 稳定复用（同一派生键）
    expect(keys[3]).toBe(keys[0]);
    // 三个 scope 互不串会话
    expect(new Set(keys).size).toBe(3);
    await adapter.close();
  });
});
