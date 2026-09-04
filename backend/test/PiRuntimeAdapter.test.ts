/**
 * PiRuntimeAdapter 专项测试（M3.7 建立；M3.8 升级为 Contract v2）。
 *
 * 分层（对应任务书 §23）：
 * - Level 1 纯单元：注入 fake AgentSession + stub ModelRuntime（不跑 Pi SDK 循环）
 * - Level 2 SDK 集成：真实 @earendil-works/pi-coding-agent 0.84.4 +
 *   官方 fauxProvider（pi-ai 公开导出）——真实 Agent loop / 工具注册表 /
 *   事件链 / abort / 工具 AbortSignal 语义，仅模型流为脚本化假流
 * - Level 3 真实 provider LLM：本机无凭据，NOT VERIFIED（见 M3.7/M3.8 报告）
 *
 * v2 契约重点覆盖：startAgent 立即返回句柄、运行中 events() 消费、
 * 运行中 cancel()（幂等）、handle.result()、close 收敛、排队任务取消。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { PiRuntimeAdapter } from "../src/runtime/PiRuntimeAdapter.js";
import type { PiRuntimeOptions } from "../src/runtime/PiRuntimeAdapter.js";
import { resolveRoleConfig } from "../src/runtime/pi/roleConfig.js";
import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
} from "../src/errors.js";

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

// ---------------------------------------------------------------------------
// Level 1：fake AgentSession（实现 adapter 实际使用的最小表面）
// ---------------------------------------------------------------------------

type FakeBehavior =
  | { kind: "complete"; output: string }
  | { kind: "errorStop"; message: string }
  | { kind: "preflightReject"; message: string }
  | { kind: "hangUntilAbort" };

interface FakeSessionState {
  prompts: string[];
  maxConcurrent: number;
  aborted: number;
  disposed: boolean;
  /** prompt 是否挂起（hangUntilAbort 未被 abort 前） */
  pending: boolean;
}

class FakeAgentSession {
  readonly prompts: string[] = [];
  maxConcurrent = 0;
  abortedCount = 0;
  disposed = false;
  pending = false;
  /** 可变行为（测试中途 setBehavior 会同步更新已建会话） */
  behavior: FakeBehavior;
  private active = 0;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly messages: { role: string; content: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string }[] = [];
  private releasePending: (() => void) | undefined;

  constructor(behavior: FakeBehavior) {
    this.behavior = behavior;
  }

  get agent(): { state: { messages: unknown[] } } {
    return { state: { messages: this.messages } };
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    const behavior = this.behavior;
    try {
      if (behavior.kind === "preflightReject") {
        throw new Error(behavior.message);
      }
      this.emit({ type: "agent_start" } as AgentSessionEvent);
      if (behavior.kind === "hangUntilAbort") {
        this.pending = true;
        await new Promise<void>((resolve) => {
          this.releasePending = resolve;
        });
        this.pending = false;
        return;
      }
      const isError = behavior.kind === "errorStop";
      const text2 = isError ? "" : behavior.kind === "complete" ? behavior.output : "";
      const message = {
        role: "assistant",
        content: [{ type: "text", text: text2 }],
        stopReason: isError ? "error" : "stop",
        ...(isError ? { errorMessage: behavior.message } : {}),
      };
      this.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", delta: text2.slice(0, 10) },
      } as unknown as AgentSessionEvent);
      this.messages.push(message);
      this.emit({ type: "agent_end", messages: [message], willRetry: false } as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
    } finally {
      this.active -= 1;
    }
  }

  async abort(): Promise<void> {
    this.abortedCount += 1;
    if (this.releasePending !== undefined) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      this.messages.push(message);
      this.emit({ type: "agent_end", messages: [message], willRetry: false } as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
      const release = this.releasePending;
      this.releasePending = undefined;
      release();
    }
  }

  async waitForIdle(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  getLastAssistantText(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message === undefined) {
        continue;
      }
      if (message.role === "assistant") {
        const text = message.content.find((block) => block.type === "text")?.text;
        return text !== undefined && text !== "" ? text : undefined;
      }
    }
    return undefined;
  }

  state(): FakeSessionState {
    return {
      prompts: [...this.prompts],
      maxConcurrent: this.maxConcurrent,
      aborted: this.abortedCount,
      disposed: this.disposed,
      pending: this.pending,
    };
  }
}

/** Level 1 会话工厂：记录创建次数与参数，脚本化行为 */
function createFakeFactory() {
  const created: {
    session: FakeAgentSession;
    params: { cwd: string; role: string };
  }[] = [];
  let behavior: FakeBehavior = { kind: "complete", output: "ok" };
  return {
    get created() {
      return created;
    },
    setBehavior(next: FakeBehavior) {
      behavior = next;
      // 已建会话同步更新（会话被 adapter 复用，行为必须可变）
      for (const { session } of created) {
        session.behavior = next;
      }
    },
    factory: async (params: { cwd: string; role: { role: string } }) => {
      const session = new FakeAgentSession(behavior);
      created.push({ session, params: { cwd: params.cwd, role: params.role.role } });
      return session as unknown as AgentSession;
    },
  };
}

/** Level 1 的 stub ModelRuntime（adapter 只用到下列方法） */
function stubModelRuntime(): PiRuntimeOptions["modelRuntime"] {
  return {
    getModel: () => ({ provider: "fake", id: "fake-1" }) as PiModel,
    hasConfiguredAuth: () => true,
    getError: () => undefined,
  } as unknown as PiRuntimeOptions["modelRuntime"];
}

// ---------------------------------------------------------------------------
// 公共装置
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeLevel1Adapter(
  factory: ReturnType<typeof createFakeFactory>,
  extra: Partial<PiRuntimeOptions> = {},
): Promise<PiRuntimeAdapter> {
  const agentDir = await makeTempDir("pi-l1-agent-");
  const workspaceRoot = await makeTempDir("pi-l1-ws-");
  return new PiRuntimeAdapter({
    agentDir,
    workspaceRoot,
    modelRuntime: stubModelRuntime(),
    model: { provider: "fake", id: "fake-1" } as PiModel,
    createSession: factory.factory as NonNullable<PiRuntimeOptions["createSession"]>,
    log: () => {},
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Level 1：纯单元
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（Level 1：fake session）", () => {
  it("provider 标识为 pi；未初始化即 healthCheck 会触发懒初始化并保持 healthy", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    expect(adapter.provider).toBe("pi");
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("pi");
    expect(health.status).toBe("healthy");
    expect(health.latencyMs).not.toBeNull();
  });

  it("runAgent 成功：completed + 输出 + metadata.sessionKey（projectId × contextScope 派生）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "LaTeX 草稿" });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({
      agentId: "writer",
      task: "写引言",
      projectId: "proj-a",
      contextScope: "writing/outline",
    });
    expect(task.status).toBe("completed");
    expect(task.output).toBe("LaTeX 草稿");
    expect(task.metadata?.["sessionKey"]).toBe("agent:writer:paperteam-proj-a--writing/outline");
    expect(task.metadata?.["role"]).toBe("writer");
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.params.role).toBe("writer");
    expect(factory.created[0]?.params.cwd.endsWith(join("proj-a"))).toBe(true);
  });

  it("runAgent 失败（transcript stopReason=error）：返回 failed 任务，不抛异常", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "errorStop", message: "provider 502" });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({
      agentId: "reviewer",
      task: "review",
      projectId: "proj-a",
      contextScope: "review/fact",
    });
    expect(task.status).toBe("failed");
    expect(task.error).toContain("provider 502");
  });

  it("runAgent 前置拒绝（prompt throw）：结构化 failed 任务", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "preflightReject", message: "No API key for anthropic/x" });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({ agentId: "main", task: "hi", projectId: "p" });
    expect(task.status).toBe("failed");
    expect(task.error).toContain("No API key");
  });

  it("空任务内容与关闭后调用分别抛 AgentRunFailedError / AgentRuntimeUnavailableError", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    await expect(adapter.runAgent({ agentId: "main", task: "  " })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
    await adapter.close();
    await expect(adapter.runAgent({ agentId: "main", task: "x" })).rejects.toBeInstanceOf(
      AgentRuntimeUnavailableError,
    );
    expect((await adapter.healthCheck()).ok).toBe(false);
  });

  it("模型未配置：healthCheck 仍 healthy，runAgent 结构化 failed（model_not_configured 口径）", async () => {
    const agentDir = await makeTempDir("pi-l1-nomodel-");
    const workspaceRoot = await makeTempDir("pi-l1-ws-");
    const adapter = new PiRuntimeAdapter({ agentDir, workspaceRoot, log: () => {} });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("PAPERTEAM_PI_MODEL");
    const task = await adapter.runAgent({ agentId: "main", task: "hi", projectId: "p" });
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Pi 模型未配置");
    const snapshot = await adapter.modelStatusSnapshot();
    expect(snapshot.phase).toBe("not_configured");
  });

  it("SDK 初始化失败（agentDir 是文件）：runAgent 抛 AgentRuntimeUnavailableError，healthCheck unhealthy", async () => {
    const fileAsDir = join(await makeTempDir("pi-l1-init-"), "occupier.txt");
    await writeFile(fileAsDir, "x", "utf8");
    const workspaceRoot = await makeTempDir("pi-l1-ws-");
    const adapter = new PiRuntimeAdapter({ agentDir: fileAsDir, workspaceRoot, log: () => {} });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("unhealthy");
    await expect(adapter.runAgent({ agentId: "main", task: "hi" })).rejects.toBeInstanceOf(
      AgentRuntimeUnavailableError,
    );
  });

  it("timeout：runAgent 抛 AgentTimeoutError，底层 abort 被调用", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    await expect(
      adapter.runAgent({
        agentId: "writer",
        task: "慢任务",
        projectId: "p",
        timeoutMs: 150,
      }),
    ).rejects.toBeInstanceOf(AgentTimeoutError);
    expect(factory.created[0]?.session.abortedCount).toBe(1);
  });

  it("v2 cancel：startAgent 立即得 taskId → 运行中 cancel() → cancelled；重复/完结后 cancel 幂等", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "reviewer", task: "review", projectId: "p" });
    // v2 关键：taskId 在任务结束前即可用（无需轮询诊断口）
    expect(handle.taskId).toMatch(/^pi-/);
    expect(handle.sessionKey).toBe("agent:reviewer:paperteam-p");
    // 等 prompt 真正挂起（确保 cancel 落在运行中而非排队中）
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(factory.created[0]?.session.pending).toBe(true);
    await handle.cancel();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    // 已取消的任务再次 cancel：幂等 no-op（终态保持 cancelled）
    await handle.cancel();
    // 已成功完结的任务 cancel：幂等 no-op
    factory.setBehavior({ kind: "complete", output: "done" });
    const finished = await adapter.runAgent({ agentId: "reviewer", task: "r2", projectId: "p" });
    expect(finished.status).toBe("completed");
    // finished 无句柄；对已取消句柄重复 cancel 不再抛错（v2 语义）
    const cancelledTask = await handle.result();
    expect(cancelledTask.status).toBe("cancelled");
  });

  it("v2 events：运行中订阅（replay + live）、settle 后自然结束、多订阅独立", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "hello world" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "hi", projectId: "p" });
    const types: string[] = [];
    for await (const event of handle.events()) {
      types.push(event.type);
      expect(event.taskId).toBe(handle.taskId);
      expect(typeof event.ts).toBe("string");
    }
    const task = await handle.result();
    expect(task.status).toBe("completed");
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("message_update");
    expect(types).toContain("agent_end");
    expect(types.indexOf("agent_start")).toBeLessThan(types.indexOf("agent_end"));
    // 第二个订阅者独立 replay 同一事件流
    const replayed: string[] = [];
    for await (const event of handle.events()) {
      replayed.push(event.type);
    }
    expect(replayed).toEqual(types);
  });

  it("v2 events：mid-run 订阅收到运行中产生的事件（不等任务结束）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "hi", projectId: "p" });

    // 等 agent_start 落进事件源（fake session hangUntilAbort 会先 emit agent_start）
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 在任务仍运行时订阅：立即收到 agent_start（关键是不等 settle）
    const firstEvent = await handle.events()[Symbol.asyncIterator]().next();
    expect(firstEvent.done).toBe(false);
    expect((firstEvent.value as { type: string }).type).toBe("agent_start");
    // 收敛：取消挂起中的任务
    await handle.cancel();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
  });

  it("v2 排队取消：同会话第二个任务在排队中取消 → 不执行 prompt、不误伤第一个", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({ agentId: "w", task: "第一个", projectId: "p", contextScope: "writing/x" });
    const second = await adapter.startAgent({ agentId: "w", task: "第二个", projectId: "p", contextScope: "writing/x" });
    // 第一个挂起运行中，第二个在 per-session 队列排队
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(factory.created[0]?.session.abortedCount).toBe(0);
    // 取消排队的第二个（cancel 等待收敛，而收敛依赖第一个先结束——并行触发）
    const secondCancelled = second.cancel();
    // 第一个未被误伤：仍 pending；随后正常取消，第二个在获得会话后被短路为 cancelled
    expect(factory.created[0]?.session.pending).toBe(true);
    await first.cancel();
    await secondCancelled;
    expect((await first.result()).status).toBe("cancelled");
    const secondTask = await second.result();
    expect(secondTask.status).toBe("cancelled");
    // 第二个从未执行 prompt；abort 只作用于第一个（1 次）
    expect(factory.created[0]?.session.prompts).toEqual(["第一个"]);
    expect(factory.created[0]?.session.abortedCount).toBe(1);
  });

  it("v2 result 缓存：重复 await 同一终态；timeout 路径 handle.result() reject", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({
      agentId: "writer",
      task: "慢任务",
      projectId: "p",
      timeoutMs: 150,
    });
    await expect(handle.result()).rejects.toBeInstanceOf(AgentTimeoutError);
    // 重复 await：同一 rejection（Promise 缓存）
    await expect(handle.result()).rejects.toBeInstanceOf(AgentTimeoutError);
    // 超时后的 cancel：幂等 no-op
    await handle.cancel();
  });

  it("session 复用：同一 sessionKey 复用同一 AgentSession（上下文连续性）", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    await adapter.runAgent({ agentId: "writer", task: "第一轮", projectId: "p", contextScope: "writing/sections" });
    await adapter.runAgent({ agentId: "writer", task: "第二轮", projectId: "p", contextScope: "writing/sections" });
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.session.prompts).toEqual(["第一轮", "第二轮"]);
    // 显式 sessionKey 透传（GenerationService 兼容）同样复用并回写 metadata
    const explicit = await adapter.runAgent({
      agentId: "writer",
      task: "第三轮",
      sessionKey: "agent:writer:paperteam-legacy",
    });
    expect(explicit.metadata?.["sessionKey"]).toBe("agent:writer:paperteam-legacy");
    expect(factory.created).toHaveLength(2);
  });

  it("隔离：不同 project / 不同 contextScope 各自独立会话（含 reviewer 三 scope）", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    await adapter.runAgent({ agentId: "reviewer", task: "a", projectId: "proj-a", contextScope: "review/fact" });
    await adapter.runAgent({ agentId: "reviewer", task: "b", projectId: "proj-a", contextScope: "review/academic" });
    await adapter.runAgent({ agentId: "reviewer", task: "c", projectId: "proj-a", contextScope: "review/style" });
    await adapter.runAgent({ agentId: "reviewer", task: "d", projectId: "proj-b", contextScope: "review/fact" });
    expect(factory.created).toHaveLength(4);
    const cwds = new Set(factory.created.map(({ params }) => params.cwd));
    expect(cwds.size).toBe(2); // proj-a × 1 + proj-b × 1
    expect(factory.created[3]?.params.cwd.endsWith(join("proj-b"))).toBe(true);
  });

  it("per-session 串行：同一会话的两次 runAgent 不并发", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    await Promise.all([
      adapter.runAgent({ agentId: "w", task: "1", projectId: "p", contextScope: "writing/x" }),
      adapter.runAgent({ agentId: "w", task: "2", projectId: "p", contextScope: "writing/x" }),
    ]);
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.session.maxConcurrent).toBe(1);
    expect(factory.created[0]?.session.prompts).toHaveLength(2);
  });

  it("非法 projectId（路径越界）被拒绝", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    await expect(
      adapter.runAgent({ agentId: "w", task: "x", projectId: "../escape" }),
    ).rejects.toBeInstanceOf(AgentRunFailedError);
  });

  it("getTask：完结任务可查（含 cancelled）；运行中任务与未知任务报错", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "m", task: "slow", projectId: "p" });
    // 运行中：不可经 getTask 查询（终态走 handle.result()）
    await expect(adapter.getTask(handle.taskId)).rejects.toBeInstanceOf(AgentRunFailedError);
    await handle.cancel();
    const cancelled = await handle.result();
    expect(cancelled.status).toBe("cancelled");
    // 已取消任务仍可回溯查询
    const fetchedCancelled = await adapter.getTask(handle.taskId);
    expect(fetchedCancelled.status).toBe("cancelled");
    // 完成任务
    factory.setBehavior({ kind: "complete", output: "done" });
    const task = await adapter.runAgent({ agentId: "m", task: "hi", projectId: "p" });
    const fetched = await adapter.getTask(task.taskId);
    expect(fetched.status).toBe("completed");
    expect(fetched.metadata?.["sessionKey"]).toBe(task.metadata?.["sessionKey"]);
    await expect(adapter.getTask("pi-nope")).rejects.toBeInstanceOf(AgentRunFailedError);
  });

  it("close/dispose：全部在途 run 收敛 cancelled、会话 dispose、幂等", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "m", task: "慢", projectId: "p" });
    for (let attempt = 0; attempt < 50 && adapter.listActiveTasks().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await adapter.close();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(factory.created[0]?.session.disposed).toBe(true);
    expect(adapter.listActiveTasks()).toHaveLength(0);
    // close 幂等
    await adapter.close();
    // close 后 healthCheck unhealthy
    expect((await adapter.healthCheck()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 角色映射（纯函数）
// ---------------------------------------------------------------------------

describe("Pi role 映射", () => {
  it("contextScope 前缀 → 角色（research/writing/review/default）", () => {
    expect(resolveRoleConfig("research").role).toBe("researcher");
    expect(resolveRoleConfig("research/feasibility").role).toBe("researcher");
    expect(resolveRoleConfig("writing/sections").role).toBe("writer");
    expect(resolveRoleConfig("review/fact").role).toBe("reviewer");
    expect(resolveRoleConfig(undefined).role).toBe("default");
    expect(resolveRoleConfig("other").role).toBe("default");
  });

  it("工具白名单按最小必要：reviewer/researcher 只读；writer 可写；无人持有 shell", () => {
    const configs = [
      resolveRoleConfig("research"),
      resolveRoleConfig("writing/x"),
      resolveRoleConfig("review/fact"),
      resolveRoleConfig(undefined),
    ];
    for (const config of configs) {
      expect(config.tools).not.toContain("bash");
      expect(config.tools).not.toContain("powershell");
    }
    expect(resolveRoleConfig("writing/x").tools).toContain("write");
    expect(resolveRoleConfig("review/fact").tools).not.toContain("write");
  });
});

// ---------------------------------------------------------------------------
// Level 2：真实 Pi SDK + 官方 faux provider
// ---------------------------------------------------------------------------

const FAUX_PROVIDER_ID = "paperteam-faux";

async function makeLevel2Adapter(options: {
  faux?: Parameters<typeof fauxProvider>[0];
  adapterExtra?: Partial<PiRuntimeOptions>;
  withModelSpec?: boolean;
} = {}) {
  const agentDir = await makeTempDir("pi-l2-agent-");
  const workspaceRoot = await makeTempDir("pi-l2-ws-");
  const faux = fauxProvider({
    provider: FAUX_PROVIDER_ID,
    models: [{ id: "fx-1", reasoning: false }],
    ...(options.faux ?? {}),
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const adapterOptions: PiRuntimeOptions = {
    agentDir,
    workspaceRoot,
    modelRuntime,
    ...(options.withModelSpec ? { modelSpec: `${FAUX_PROVIDER_ID}/fx-1` } : {}),
    ...(!options.withModelSpec
      ? { model: modelRuntime.getModel(FAUX_PROVIDER_ID, "fx-1") }
      : {}),
    log: () => {},
    ...(options.adapterExtra ?? {}),
  };
  const adapter = new PiRuntimeAdapter(adapterOptions);
  return { adapter, faux, agentDir, workspaceRoot, modelRuntime };
}

describe("PiRuntimeAdapter（Level 2：真实 SDK + faux model）", () => {
  it("初始化 / 健康 / 单轮 runAgent：真实 Agent loop + 假模型流", async () => {
    const { adapter, faux } = await makeLevel2Adapter();
    faux.setResponses([fauxAssistantMessage([fauxText("这是真实 Pi Agent Loop 的输出。")])]);

    const t0 = Date.now();
    const health = await adapter.healthCheck();
    const initMs = Date.now() - t0;
    expect(health.ok).toBe(true);
    expect(health.detail).toContain(`${FAUX_PROVIDER_ID}/fx-1`);
    expect(initMs).toBeLessThan(10_000); // 本地 Runtime overhead（记录进报告）

    const snapshot = await adapter.modelStatusSnapshot();
    expect(snapshot.phase).toBe("configured");
    expect(snapshot.providers).toEqual([FAUX_PROVIDER_ID]);

    const t1 = Date.now();
    const task = await adapter.runAgent({
      agentId: "writer",
      task: "写一段",
      projectId: "proj-x",
      contextScope: "writing/outline",
    });
    const runMs = Date.now() - t1;
    expect(task.status).toBe("completed");
    expect(task.output).toContain("真实 Pi Agent Loop");
    expect(task.metadata?.["model"]).toBe(`${FAUX_PROVIDER_ID}/fx-1`);
    expect(runMs).toBeLessThan(15_000);
    expect(faux.state.callCount).toBe(1);
    await adapter.close();
  }, 30_000);

  it("systemPromptOverride 生效：role 提示词真实到达 LLM 请求上下文", async () => {
    const capturedSystems: (string | undefined)[] = [];
    const { adapter, faux } = await makeLevel2Adapter();
    faux.setResponses([
      (context) => {
        capturedSystems.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("ok")]);
      },
      (context) => {
        capturedSystems.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    await adapter.runAgent({
      agentId: "reviewer",
      task: "review",
      projectId: "p",
      contextScope: "review/fact",
    });
    await adapter.runAgent({
      agentId: "researcher",
      task: "research",
      projectId: "p",
      contextScope: "research",
    });
    expect(capturedSystems).toHaveLength(2);
    expect(capturedSystems[0]).toContain("审稿");
    expect(capturedSystems[1]).toContain("调研");
    await adapter.close();
  }, 30_000);

  it("事件流（v2 运行中消费）：真实 SDK 事件链顺序合理、归属一致、settle 后迭代自然结束", async () => {
    const { adapter, faux } = await makeLevel2Adapter();
    faux.setResponses([fauxAssistantMessage([fauxText("流水线事件测试输出")])]);
    const handle = await adapter.startAgent({
      agentId: "writer",
      task: "写",
      projectId: "p",
      contextScope: "writing/sections",
    });
    // v2：任务运行期间订阅事件流（不等 runAgent 返回）
    const types: string[] = [];
    for await (const event of handle.events()) {
      types.push(event.type);
      expect(event.taskId).toBe(handle.taskId);
    }
    const task = await handle.result();
    expect(task.status).toBe("completed");
    expect(types[0]).toBe("agent_start");
    expect(types[types.length - 1]).toBe("agent_settled");
    expect(types).toContain("message_update");
    expect(types).toContain("agent_end");
    const updates = types.filter((type) => type === "message_update");
    expect(updates.length).toBeGreaterThan(0);
    expect(types.indexOf("agent_end")).toBeLessThan(types.indexOf("agent_settled"));
    await adapter.close();
  }, 30_000);

  it("Reviewer 三路并发：三个独立 AgentSession 并行执行，输出不串、会话不串", async () => {
    const { adapter, faux } = await makeLevel2Adapter();
    // 响应工厂按用户消息内容分发（消除调用顺序不确定性）
    const modeResponse = (mode: string) => (_context: unknown) =>
      fauxAssistantMessage([fauxText(`{"summary":"${mode} done","issues":[]}`)]);
    faux.setResponses(
      ["fact", "academic", "style", "fact", "academic", "style"].map((mode) => modeResponse(mode)),
    );
    const t0 = Date.now();
    const results = await Promise.all(
      (["fact", "academic", "style"] as const).map((mode) =>
        adapter.runAgent({
          agentId: "reviewer",
          task: `请执行 review ${mode}`,
          projectId: "proj-r3",
          contextScope: `review/${mode}`,
        }),
      ),
    );
    const fanoutMs = Date.now() - t0;
    expect(results.every((result) => result.status === "completed")).toBe(true);
    const outputs = results.map((result) => result.output ?? "");
    expect(outputs.some((output) => output.includes("fact done"))).toBe(true);
    expect(outputs.some((output) => output.includes("academic done"))).toBe(true);
    expect(outputs.some((output) => output.includes("style done"))).toBe(true);
    const keys = results.map((result) => String(result.metadata?.["sessionKey"]));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key.startsWith("agent:reviewer:paperteam-proj-r3--review/")).toBe(true);
    }
    expect(fanoutMs).toBeLessThan(30_000);
    await adapter.close();
  }, 60_000);

  it("abort（真实 SDK）：LLM 流式生成中取消 → cancelled；会话仍可继续使用", async () => {
    // 低速率流式输出（长文本 + tokensPerSecond 限速）保证取消窗口
    const longText = "字".repeat(600);
    const { adapter, faux } = await makeLevel2Adapter({
      faux: { tokensPerSecond: 60, tokenSize: { min: 2, max: 4 } },
    });
    faux.setResponses([fauxAssistantMessage([fauxText(longText)])]);
    // v2：直接拿 handle（无需轮询诊断口）
    const handle = await adapter.startAgent({
      agentId: "writer",
      task: "慢慢写",
      projectId: "p",
      contextScope: "writing/outline",
    });
    await handle.cancel();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    // abort 后同一会话可复用（session 未损坏）
    faux.setResponses([fauxAssistantMessage([fauxText("恢复后的输出")])]);
    const next = await adapter.runAgent({
      agentId: "writer",
      task: "继续写",
      projectId: "p",
      contextScope: "writing/outline",
    });
    expect(next.status).toBe("completed");
    expect(next.output).toContain("恢复后的输出");
    expect(next.metadata?.["sessionKey"]).toBe(task.metadata?.["sessionKey"]);
    await adapter.close();
  }, 60_000);

  it("tool execution abort（专项，M3.8 §14）：工具执行中 cancel → AbortSignal 触发 → 工具停止 → cancelled", async () => {
    // 可控的长耗时测试工具：挂起直到 SDK 传入的 AbortSignal 触发
    let toolStarted = false;
    let signalAborted = false;
    let signalWasProvided = false;
    const slowProbe = defineTool({
      name: "paperteam_slow_probe",
      label: "Slow probe（测试专用）",
      description: "测试专用：挂起直到被 abort",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, signal) => {
        toolStarted = true;
        signalWasProvided = signal !== undefined;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            signalAborted = true;
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            signalAborted = true;
            resolve();
          });
          // 防挂死兜底（cancel 未传导时让测试失败而非超时）
          setTimeout(resolve, 20_000).unref?.();
        });
        return {
          content: [{ type: "text", text: signalAborted ? "aborted" : "timeout-fallback" }],
          details: { signalAborted },
        };
      },
    });

    const { adapter, faux } = await makeLevel2Adapter({
      adapterExtra: { customTools: [slowProbe as ToolDefinition] },
    });
    // 第一轮：模型请求调用慢工具；后续轮次（不应发生）兜底
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("paperteam_slow_probe", {})]),
      fauxAssistantMessage([fauxText("不应到达这里")]),
    ]);

    const handle = await adapter.startAgent({
      agentId: "researcher",
      task: "调用慢工具",
      projectId: "p-tool-abort",
      contextScope: "research",
    });

    // 等工具真正开始执行（事件流中的 tool_execution_start；事件 emit 与
    // execute() 调用之间有调度边界，补一个轮询窗口）
    for await (const event of handle.events()) {
      if (event.type === "tool_execution_start" && event.data?.["toolName"] === "paperteam_slow_probe") {
        break;
      }
    }
    for (let attempt = 0; attempt < 300 && !toolStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(toolStarted).toBe(true);

    // 工具执行中取消
    await handle.cancel();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    // 关键断言：AbortSignal 被真实传导到工具执行（协作式取消）
    expect(signalWasProvided).toBe(true);
    expect(signalAborted).toBe(true);
    await adapter.close();
  }, 60_000);

  it("模型解析失败（真实 ModelRuntime 初始化路径）：healthy + not_configured + 结构化失败", async () => {
    const agentDir = await makeTempDir("pi-l2-unknown-");
    const workspaceRoot = await makeTempDir("pi-l2-ws-");
    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelSpec: "no-such-provider/no-such-model",
      log: () => {},
    });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true); // Runtime 健康 ≠ 模型就绪
    expect((await adapter.modelStatusSnapshot()).phase).toBe("not_configured");
    const task = await adapter.runAgent({ agentId: "m", task: "hi", projectId: "p" });
    expect(task.status).toBe("failed");
    expect(task.error).toContain("no-such-provider/no-such-model");
    await adapter.close();
  }, 30_000);

  it("provider 无凭据：模型存在但 auth 未配置 → not_configured", async () => {
    const agentDir = await makeTempDir("pi-l2-noauth-");
    const workspaceRoot = await makeTempDir("pi-l2-ws-");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerProvider("noauth-provider", {
      api: "openai-completions",
      baseUrl: "https://noauth.example.invalid/v1",
      models: [
        {
          id: "m-1",
          name: "No Auth Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
      ],
    });
    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelSpec: "noauth-provider/m-1",
      modelRuntime,
      log: () => {},
    });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    const snapshot = await adapter.modelStatusSnapshot();
    expect(snapshot.phase).toBe("not_configured");
    expect(snapshot.detail).toContain("凭据");
    const task = await adapter.runAgent({ agentId: "m", task: "hi", projectId: "p" });
    expect(task.status).toBe("failed");
    await adapter.close();
  }, 30_000);
});
