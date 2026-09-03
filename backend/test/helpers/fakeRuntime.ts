/** 测试辅助：构造 AgentTask 与脚本化 AgentRuntime */

import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

export function makeAgentTask(output: string, agentId = "agent", status: AgentTask["status"] = "completed"): AgentTask {
  const now = new Date().toISOString();
  return {
    taskId: `run-${Math.random().toString(36).slice(2, 10)}`,
    agentId,
    status,
    createdAt: now,
    updatedAt: now,
    ...(status === "completed" ? { output } : { error: output }),
  };
}

export function makeHealth(ok: boolean): RuntimeHealth {
  return {
    ok,
    provider: "openclaw",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "ok" : "down",
    latencyMs: ok ? 5 : null,
    checkedAt: new Date().toISOString(),
  };
}

/** 按 (agentId, contextScope) 脚本化输出；抛错则 runAgent 抛出 */
export function runtimeFromScript(
  script: (input: { agentId: string; task: string; contextScope?: string }) => string,
): AgentRuntime {
  return {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true),
    runAgent: async (input) => {
      const output = script(input);
      return makeAgentTask(output, input.agentId);
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
