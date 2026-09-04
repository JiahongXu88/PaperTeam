/** 测试辅助：构造 AgentTask 与脚本化 AgentRuntime（Contract v2） */

import type {
  AgentRuntime,
  AgentRunHandle,
  AgentTask,
  RunAgentInput,
  RuntimeHealth,
} from "../../src/runtime/types.js";

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
    provider: "pi",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "ok" : "down",
    latencyMs: ok ? 5 : null,
    checkedAt: new Date().toISOString(),
  };
}

/** 从终态任务构造 v2 handle（events 为空流；cancel 幂等 no-op） */
export function handleFromTask(task: AgentTask, sessionKey = `agent:${task.agentId}:paperteam-fake`): AgentRunHandle {
  return {
    taskId: task.taskId,
    sessionKey,
    events: async function* () {},
    cancel: async () => {},
    result: async () => task,
  };
}

/** 按 (agentId, contextScope) 脚本化输出；抛错则 runAgent 抛出 */
export function runtimeFromScript(
  script: (input: { agentId: string; task: string; contextScope?: string }) => string,
): AgentRuntime {
  return {
    provider: "pi",
    healthCheck: async () => makeHealth(true),
    startAgent: async (input: RunAgentInput) => {
      const output = script(input);
      const task = makeAgentTask(output, input.agentId);
      return handleFromTask(task);
    },
    runAgent: async (input: RunAgentInput) => {
      const output = script(input);
      return makeAgentTask(output, input.agentId);
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}
