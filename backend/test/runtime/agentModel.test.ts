/**
 * M5.7 per-Agent Provider/Model 配置（PiRuntimeAdapter 层）：
 * - scope 前缀 → 业务 Agent 键映射矩阵
 * - writer override → 会话与任务终态使用独立模型；无 override 的 Agent 继承默认
 * - 多 Agent 各自独立模型；override 失效 → 结构化失败（不静默回落）
 * - reconfigure 后 agentModelSpecs 重新读取（新 run 用新配置）
 * - modelStatusSnapshot 暴露 per-Agent 解析摘要
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import {
  agentModelKeyForScope,
  type AgentModelKey,
} from "../../src/settings/ModelSettingsStore.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MODEL_A = { provider: "prova", id: "model-a", contextWindow: 100_000, maxTokens: 8_192 };
const MODEL_B = { provider: "provb", id: "model-b", contextWindow: 60_000, maxTokens: 4_096 };
const MODEL_C = { provider: "provc", id: "model-c", contextWindow: 40_000, maxTokens: 4_096 };
const MODEL_D = { provider: "provd", id: "model-d", contextWindow: 80_000, maxTokens: 8_192 };

function fakeModelRuntime(models: Record<string, unknown>, missingAuth = new Set<string>()): unknown {
  return {
    getModel: (provider: string, id: string) => models[`${provider}/${id}`],
    hasConfiguredAuth: (provider: string) => !missingAuth.has(provider),
    getError: () => undefined,
  };
}

/** 记录每次会话创建使用的 model 的最小 fake session 工厂 */
function makeSessionFactory() {
  const models: unknown[] = [];
  const factory = async (params: { model?: unknown }): Promise<AgentSession> => {
    models.push(params.model);
    return {
      prompt: async () => {},
      abort: async () => {},
      waitForIdle: async () => {},
      dispose: () => {},
      subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
      getLastAssistantText: () => "ok",
      agent: {
        state: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
        },
      },
    } as never;
  };
  return { models, factory };
}

describe("agentModelKeyForScope（scope → 业务 Agent 键）", () => {
  it.each([
    ["writing", "writer"],
    ["writing/revision", "writer"],
    ["writing/style-polish", "writer"],
    ["research", "researcher"],
    ["research/feasibility", "researcher"],
    ["review/fact", "factReviewer"],
    ["review/fact/x", "factReviewer"],
    ["review/academic", "academicReviewer"],
    ["review/section/sec3", "academicReviewer"],
    ["review/summary/introduction", "academicReviewer"],
    ["review/style", "styleReviewer"],
    ["citation", "citationReviewer"],
    ["citation/semantic/x1", "citationReviewer"],
  ] as const)("「%s」→ %s", (scope, expected) => {
    expect(agentModelKeyForScope(scope)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["sources/pdf-analysis"],
    ["skills/summary/x"],
    ["unknown-scope"],
  ])("非业务 Agent scope「%s」→ undefined（继承默认）", (scope) => {
    expect(agentModelKeyForScope(scope)).toBeUndefined();
  });
});

describe("PiRuntimeAdapter per-Agent 模型（M5.7）", () => {
  async function makeAdapter(
    overrides: Partial<Record<AgentModelKey, string>>,
    options?: { missingOverrideModel?: string; missingAuth?: string },
  ) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-model-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-agent-model-ws-"));
    dirs.push(agentDir, workspaceRoot);
    const sessions = makeSessionFactory();
    const models: Record<string, unknown> = {
      "prova/model-a": MODEL_A,
      "provb/model-b": MODEL_B,
      "provc/model-c": MODEL_C,
      "provd/model-d": MODEL_D,
    };
    if (options?.missingOverrideModel !== undefined) {
      delete models[options.missingOverrideModel];
    }
    let current = { ...overrides };
    const adapter = new PiRuntimeAdapter({
      modelSpec: "prova/model-a",
      agentDir,
      workspaceRoot,
      modelRuntime: fakeModelRuntime(
        models,
        options?.missingAuth !== undefined ? new Set([options.missingAuth]) : new Set(),
      ) as never,
      createSession: sessions.factory as never,
      agentModelSpecs: async () => current,
      log: () => {},
    });
    return {
      adapter,
      sessions,
      setOverrides: (next: Partial<Record<AgentModelKey, string>>) => {
        current = { ...next };
      },
    };
  }

  it("无 override：所有 Agent 继承默认模型（行为与旧版一致）", async () => {
    const { adapter, sessions } = await makeAdapter({});
    try {
      const writerTask = await adapter.runAgent({
        agentId: "writer",
        task: "写",
        contextScope: "writing/revision",
      });
      const reviewerTask = await adapter.runAgent({
        agentId: "reviewer",
        task: "审",
        contextScope: "review/academic",
      });
      expect(writerTask.status).toBe("completed");
      expect(reviewerTask.status).toBe("completed");
      expect(writerTask.metadata?.model).toBe("prova/model-a");
      expect(reviewerTask.metadata?.model).toBe("prova/model-a");
      expect((sessions.models[0] as { id: string }).id).toBe("model-a");
    } finally {
      await adapter.close();
    }
  });

  it("Writer override → Writer 用独立 provider/model；Academic Reviewer 继承默认", async () => {
    const { adapter, sessions } = await makeAdapter({ writer: "provb/model-b" });
    try {
      const writerTask = await adapter.runAgent({
        agentId: "writer",
        task: "写",
        contextScope: "writing/revision",
      });
      const reviewerTask = await adapter.runAgent({
        agentId: "reviewer",
        task: "审",
        contextScope: "review/academic",
      });
      expect(writerTask.metadata?.model).toBe("provb/model-b");
      expect(reviewerTask.metadata?.model).toBe("prova/model-a");
      expect((sessions.models[0] as { provider: string; id: string })).toMatchObject({
        provider: "provb",
        id: "model-b",
      });
      expect((sessions.models[1] as { provider: string; id: string })).toMatchObject({
        provider: "prova",
        id: "model-a",
      });
    } finally {
      await adapter.close();
    }
  });

  it("不同 Agent 使用不同模型（factReviewer / researcher 各自 override）", async () => {
    const { adapter } = await makeAdapter({
      factReviewer: "provc/model-c",
      researcher: "provd/model-d",
    });
    try {
      const fact = await adapter.runAgent({
        agentId: "reviewer",
        task: "核",
        contextScope: "review/fact",
      });
      const research = await adapter.runAgent({
        agentId: "researcher",
        task: "查",
        contextScope: "research",
      });
      expect(fact.metadata?.model).toBe("provc/model-c");
      expect(research.metadata?.model).toBe("provd/model-d");
    } finally {
      await adapter.close();
    }
  });

  it("override 指向不存在的模型 → 该 Agent 结构化失败；其他 Agent 不受影响", async () => {
    const { adapter } = await makeAdapter({ writer: "provb/model-b" }, { missingOverrideModel: "provb/model-b" });
    try {
      const writerTask = await adapter.runAgent({
        agentId: "writer",
        task: "写",
        contextScope: "writing/revision",
      });
      expect(writerTask.status).toBe("failed");
      expect(writerTask.errorCode).toBe("MODEL_NOT_CONFIGURED");
      expect(writerTask.error).toContain("Agent writer");
      expect(writerTask.error).toContain("不在注册表");
      const citationTask = await adapter.runAgent({
        agentId: "citation",
        task: "验",
        contextScope: "citation/semantic/x",
      });
      expect(citationTask.status).toBe("completed");
      expect(citationTask.metadata?.model).toBe("prova/model-a");
    } finally {
      await adapter.close();
    }
  });

  it("override provider 无凭据 → 结构化失败并说明修复路径", async () => {
    const { adapter } = await makeAdapter({ writer: "provb/model-b" }, { missingAuth: "provb" });
    try {
      const writerTask = await adapter.runAgent({
        agentId: "writer",
        task: "写",
        contextScope: "writing/revision",
      });
      expect(writerTask.status).toBe("failed");
      expect(writerTask.error).toContain("无可用凭据");
      expect(writerTask.error).toContain("继承默认");
    } finally {
      await adapter.close();
    }
  });

  it("reconfigure 重新读取 agentModelSpecs：新增 override 后新 run 使用新模型", async () => {
    const { adapter, sessions, setOverrides } = await makeAdapter({});
    try {
      await adapter.runAgent({ agentId: "writer", task: "a", contextScope: "writing/revision" });
      expect((sessions.models[0] as { id: string }).id).toBe("model-a");
      setOverrides({ writer: "provb/model-b" });
      await adapter.reconfigure("prova/model-a");
      await adapter.runAgent({ agentId: "writer", task: "b", contextScope: "writing/revision" });
      expect((sessions.models[1] as { id: string }).id).toBe("model-b");
    } finally {
      await adapter.close();
    }
  });

  it("modelStatusSnapshot 暴露 per-Agent 解析摘要（无 key）", async () => {
    const { adapter } = await makeAdapter({ writer: "provb/model-b" });
    try {
      const status = await adapter.modelStatusSnapshot();
      expect(status.agents).toEqual([{ key: "writer", model: "provb/model-b" }]);
    } finally {
      await adapter.close();
    }
  });
});
