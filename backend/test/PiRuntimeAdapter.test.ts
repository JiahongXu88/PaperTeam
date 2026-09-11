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
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
import type { AgentEvent } from "../src/runtime/types.js";
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
  | {
      kind: "complete";
      output: string;
      streamEvents?: number;
      streamGapMs?: number;
      /** 每个 assistant turn 的 usage（message_end 携带；undefined = 该 turn 无 usage） */
      usageTurns?: (FakeUsage | undefined)[];
    }
  | { kind: "errorStop"; message: string; usageTurns?: (FakeUsage | undefined)[] }
  | { kind: "preflightReject"; message: string }
  | { kind: "hangUntilAbort" }
  /** 先产出若干带 usage 的 assistant turn（message_end），再挂起直到 abort（usage 保留路径测试） */
  | { kind: "turnsThenHang"; turnUsages: FakeUsage[] };

/** 单个 assistant turn 的 Pi 风格 usage（Level 1 usage 采集测试；结构对应 pi-ai Usage） */
interface FakeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** provider 返回的 list-price 成本；undefined = provider 未返回 cost */
  cost?: number;
}

/** FakeUsage → pi-ai Usage 形状（cost 缺省时整个 cost 对象缺省，模拟 provider 未返回） */
function toPiUsage(usage: FakeUsage): Record<string, unknown> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(usage.cost !== undefined
      ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost } }
      : {}),
  };
}

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
      if (behavior.kind === "turnsThenHang") {
        // 先产出带 usage 的 assistant turn（message_end + transcript），再挂起：
        // cancel / execution timeout 路径的「usage 保留」断言依赖这些先落盘
        behavior.turnUsages.forEach((usage, index) => {
          const message = {
            role: "assistant",
            content: [{ type: "text", text: `turn-${index + 1}` }],
            stopReason: "stop",
            usage: toPiUsage(usage),
          };
          this.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
          this.messages.push(message);
        });
        this.pending = true;
        await new Promise<void>((resolve) => {
          this.releasePending = resolve;
        });
        this.pending = false;
        return;
      }
      const isError = behavior.kind === "errorStop";
      const text2 = isError ? "" : behavior.kind === "complete" ? behavior.output : "";
      const usageTurns =
        behavior.kind === "complete"
          ? behavior.usageTurns
          : behavior.kind === "errorStop"
            ? behavior.usageTurns
            : undefined;
      if (usageTurns !== undefined && usageTurns.length > 0) {
        // 多 assistant turn（usage 采集测试）：每 turn 一条 message_end；
        // 最后一条承载最终输出/错误语义（与既有断言兼容）
        usageTurns.forEach((usage, index) => {
          const isLast = index === usageTurns.length - 1;
          const message = {
            role: "assistant",
            content: [{ type: "text", text: isLast && !isError ? text2 : `turn-${index + 1}` }],
            stopReason: isError ? "error" : "stop",
            ...(isError ? { errorMessage: (behavior as { message: string }).message } : {}),
            ...(usage !== undefined ? { usage: toPiUsage(usage) } : {}),
          };
          this.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
          this.messages.push(message);
        });
      } else {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: text2 }],
          stopReason: isError ? "error" : "stop",
          ...(isError ? { errorMessage: behavior.message } : {}),
        };
        if (behavior.kind === "complete" && behavior.streamEvents !== undefined) {
          // 批量流事件（事件缓冲测试）：每条 delta 唯一编号 e-<i>。
          // streamGapMs：undefined=同步突发（一个 tick 内全部落盘）；
          // 0=setImmediate 逐条让出事件循环（消费者可实时跟读）；
          // >0=setTimeout(ms) 间隔。
          for (let index = 0; index < behavior.streamEvents; index += 1) {
            this.emit({
              type: "message_update",
              message,
              assistantMessageEvent: { type: "text_delta", delta: `e-${index}` },
            } as unknown as AgentSessionEvent);
            if (behavior.streamGapMs === 0) {
              await new Promise((resolve) => setImmediate(resolve));
            } else if ((behavior.streamGapMs ?? 0) > 0) {
              await new Promise((resolve) => setTimeout(resolve, behavior.streamGapMs));
            }
          }
        } else {
          this.emit({
            type: "message_update",
            message,
            assistantMessageEvent: { type: "text_delta", delta: text2.slice(0, 10) },
          } as unknown as AgentSessionEvent);
        }
        this.messages.push(message);
      }
      this.emit({
        type: "agent_end",
        messages: [...this.messages],
        willRetry: false,
      } as AgentSessionEvent);
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

  /** 测试辅助：让 hangUntilAbort 挂起中的 prompt 以正常输出收尾（模拟 A 正常完成） */
  completePending(output: string): void {
    if (this.releasePending !== undefined) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: output }],
        stopReason: "stop",
      };
      this.messages.push(message);
      this.emit({ type: "agent_end", messages: [message], willRetry: false } as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
      const release = this.releasePending;
      this.releasePending = undefined;
      this.pending = false;
      release();
    }
  }

  /** 测试辅助：让 hangUntilAbort 挂起中的 prompt 以 error 终态收尾（模拟 A 运行中失败） */
  failPending(message: string): void {
    if (this.releasePending !== undefined) {
      const failed = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: message,
      };
      this.messages.push(failed);
      this.emit({ type: "agent_end", messages: [failed], willRetry: false } as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
      const release = this.releasePending;
      this.releasePending = undefined;
      this.pending = false;
      release();
    }
  }

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

/** Level 1 会话创建闸门工厂：创建挂起直到测试显式放行（session 阶段超时测试用） */
function createGatedFactory() {
  const pendingResolvers: Array<(session: FakeAgentSession) => void> = [];
  const createdSessions: FakeAgentSession[] = [];
  let requestedCount = 0;
  return {
    get created(): FakeAgentSession[] {
      return createdSessions;
    },
    /** factory 已被调用的次数（创建请求已发起、等待放行） */
    get requested(): number {
      return requestedCount;
    },
    /** 放行一次挂起的创建（迟到的会话由此刻才真正诞生） */
    release(): FakeAgentSession {
      const session = new FakeAgentSession({ kind: "complete", output: "late ok" });
      createdSessions.push(session);
      pendingResolvers.shift()?.(session);
      return session;
    },
    factory: () => {
      requestedCount += 1;
      return new Promise((resolve) => {
        pendingResolvers.push((session) => resolve(session as unknown as AgentSession));
      });
    },
  };
}

async function makeLevel1Adapter(
  factoryLike: { factory: unknown },
  extra: Partial<PiRuntimeOptions> = {},
): Promise<PiRuntimeAdapter> {
  const agentDir = await makeTempDir("pi-l1-agent-");
  const workspaceRoot = await makeTempDir("pi-l1-ws-");
  return new PiRuntimeAdapter({
    agentDir,
    workspaceRoot,
    modelRuntime: stubModelRuntime(),
    model: { provider: "fake", id: "fake-1" } as PiModel,
    createSession: factoryLike.factory as NonNullable<PiRuntimeOptions["createSession"]>,
    log: () => {},
    ...extra,
  });
}

/** 轮询等待条件成立（默认 5s；超时返回 false，由调用方断言失败原因） */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
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

  it("releaseProjectSessions：按 projectId 精确释放会话（边界不误伤 p-x1 / p-x12）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "ok" });
    const adapter = await makeLevel1Adapter(factory);
    // p-x1 两个 scope + p-x12 一个 + 无 projectId 的显式会话
    await adapter.runAgent({ agentId: "reviewer", task: "a", projectId: "p-x1", contextScope: "review/section/s1" });
    await adapter.runAgent({ agentId: "reviewer", task: "b", projectId: "p-x1" });
    await adapter.runAgent({ agentId: "reviewer", task: "c", projectId: "p-x12" });
    await adapter.runAgent({ agentId: "writer", task: "d", sessionKey: "agent:writer:paperteam-other" });
    expect(adapter.runtimeStats().managedSessions).toBe(4);

    const released = await adapter.releaseProjectSessions("p-x1");
    expect(released).toBe(2);
    expect(adapter.runtimeStats().managedSessions).toBe(2);
    // p-x1 的会话被 dispose；p-x12 与 other 会话保留（按创建顺序断言）
    expect(factory.created[0]?.session.disposed).toBe(true);
    expect(factory.created[1]?.session.disposed).toBe(true);
    expect(factory.created[2]?.session.disposed).toBe(false);
    expect(factory.created[3]?.session.disposed).toBe(false);
    // 幂等：再次释放返回 0
    await expect(adapter.releaseProjectSessions("p-x1")).resolves.toBe(0);
    // 释放后可正常复用（重建会话）
    const again = await adapter.runAgent({ agentId: "reviewer", task: "e", projectId: "p-x1" });
    expect(again.status).toBe("completed");
  });
});

describe("PiRuntimeAdapter（Level 1：并发 section review 语义）", () => {
  it("三个 scope 同时 active：3 个独立会话（sessionKey 互异）、activeRuns=3、全部 settle", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handles = await Promise.all(
      ["review/section/s1", "review/section/s2", "review/section/s3"].map((scope) =>
        adapter.startAgent({ agentId: "reviewer", task: "review", projectId: "p-conc", contextScope: scope }),
      ),
    );
    // 句柄立即返回且 sessionKey 各不相同（projectId × agentId × contextScope）
    const keys = handles.map((handle) => handle.sessionKey);
    expect(new Set(keys).size).toBe(3);
    expect(adapter.runtimeStats().activeRuns).toBe(3);
    // 会话创建在后台链异步完成：等到 3 个会话都已建好并开始 prompt（真正 running）
    const deadline = Date.now() + 5_000;
    while (
      (factory.created.length < 3 || factory.created.some((entry) => entry.session.prompts.length < 1)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(adapter.runtimeStats().managedSessions).toBe(3);
    expect(adapter.runtimeStats().activeRuns).toBe(3);
    await Promise.all(handles.map((handle) => handle.cancel()));
    expect(adapter.runtimeStats().activeRuns).toBe(0);
    for (const handle of handles) {
      const task = await handle.result();
      expect(task.status).toBe("cancelled");
    }
    await adapter.close();
  });

  it("并发 review 在途时 reconfigure → MODEL_CONFIG_BUSY（409 语义不回归）；settle 后可重配", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handles = await Promise.all(
      ["review/section/s1", "review/section/s2", "review/section/s3"].map((scope) =>
        adapter.startAgent({ agentId: "reviewer", task: "review", projectId: "p-busy", contextScope: scope }),
      ),
    );
    expect(adapter.runtimeStats().activeRuns).toBe(3);
    // activeRuns > 0：Save 必须被拒绝，且不中断在途任务
    await expect(adapter.reconfigure("fake/fake-2")).rejects.toMatchObject({
      code: "MODEL_CONFIG_BUSY",
    });
    expect(adapter.runtimeStats().activeRuns).toBe(3);
    await Promise.all(handles.map((handle) => handle.cancel()));
    // 全部 settle 后重配不再拒绝（session 释放语义不变）
    await expect(adapter.reconfigure("fake/fake-2")).resolves.toMatchObject({ phase: "configured" });
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// AbortSignal 语义（M5.1 任务 B：startAgent 与 runAgent 两入口统一）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（AbortSignal 语义：startAgent 统一消费 input.signal）", () => {
  it("startAgent + pre-aborted signal：不执行 prompt，终态 cancelled", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    controller.abort();
    const handle = await adapter.startAgent({
      agentId: "writer",
      task: "永远不该执行",
      projectId: "p",
      signal: controller.signal,
    });
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    // prompt 从未执行；abort 从未触发（任务没进 running）
    expect(factory.created[0]?.session.prompts).toEqual([]);
    expect(factory.created[0]?.session.abortedCount).toBe(0);
    await adapter.close();
  });

  it("startAgent 运行中 abort signal → session.abort 传导 → cancelled", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    const handle = await adapter.startAgent({
      agentId: "reviewer",
      task: "慢审稿",
      projectId: "p",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(factory.created[0]?.session.pending).toBe(true);
    controller.abort();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    await adapter.close();
  });

  it("startAgent 排队中 abort signal（同会话前序任务运行中）：进入取消语义，前序不误伤", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({
      agentId: "w",
      task: "第一个",
      projectId: "p",
      contextScope: "writing/x",
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const controller = new AbortController();
    const second = await adapter.startAgent({
      agentId: "w",
      task: "第二个",
      projectId: "p",
      contextScope: "writing/x",
      signal: controller.signal,
    });
    controller.abort();
    // 前序任务未受影响（仍 pending）；随后正常收敛
    expect(factory.created[0]?.session.pending).toBe(true);
    await first.cancel();
    const secondTask = await second.result();
    expect(secondTask.status).toBe("cancelled");
    expect((await first.result()).status).toBe("cancelled");
    expect(factory.created[0]?.session.prompts).toEqual(["第一个"]);
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    await adapter.close();
  });

  it("runAgent + pre-aborted signal：终态 cancelled（与 startAgent 同一语义）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "不该出现" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    controller.abort();
    const task = await adapter.runAgent({
      agentId: "writer",
      task: "x",
      projectId: "p",
      signal: controller.signal,
    });
    expect(task.status).toBe("cancelled");
    expect(factory.created[0]?.session.prompts).toEqual([]);
    await adapter.close();
  });

  it("runAgent 运行中 abort → cancelled + abort 传导", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    const taskPromise = adapter.runAgent({
      agentId: "writer",
      task: "慢任务",
      projectId: "p",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const task = await taskPromise;
    expect(task.status).toBe("cancelled");
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    await adapter.close();
  });

  it("cancel 幂等：signal abort 与 handle.cancel 并发只触发一次 session.abort；settle 后 abort 无副作用", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "慢",
      projectId: "p",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await handle.cancel(); // 并发重复取消
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    await handle.cancel(); // 终态后再次 cancel：幂等 no-op
    expect((await handle.result()).status).toBe("cancelled");
    await adapter.close();
  });

  it("监听器清理：运行期间恰好一个 abort listener，settle 后归零（无 leak）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "慢",
      projectId: "p",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await adapter.close();
  });

  it("任务正常完成后 signal 才 abort：终态不被改变，监听器已被移除", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done" });
    const adapter = await makeLevel1Adapter(factory);
    const controller = new AbortController();
    const task = await adapter.runAgent({
      agentId: "w",
      task: "x",
      projectId: "p",
      signal: controller.signal,
    });
    expect(task.status).toBe("completed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort(); // settle 后的 abort：不抛错、不改变终态
    expect((await adapter.getTask(task.taskId)).status).toBe("completed");
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 事件缓冲（M5.1 任务 C：seq 逻辑游标 + gap 显式暴露）
// ---------------------------------------------------------------------------

/** 收集一个迭代器的全部剩余事件（到 done 为止） */
async function drainEvents(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
  }
  return collected;
}

/**
 * 断言事件交付序列按 seq 连续：真实事件 seq 逐 +1；缺口只能以 event_gap
 * 标记出现，且必须紧跟其后精确报告被跳过的区间——「静默跳到缓冲头」
 * （M5.1 修复前的缺陷）无法通过本断言。startAfter：流中间开始的序列
 * （如慢消费者 gap 后的尾部）传入其前一个已读 seq。
 */
function expectContiguousSeq(events: AgentEvent[], startAfter = 0): void {
  let expected = startAfter;
  for (const event of events) {
    if (event.type === "event_gap") {
      const missedFrom = event.data?.["missedFrom"];
      const missedTo = event.data?.["missedTo"];
      const missedCount = event.data?.["missedCount"];
      expect(missedFrom).toBe(expected + 1);
      expect(missedTo).toBeGreaterThan(missedFrom as number);
      expect(missedCount).toBe((missedTo as number) - (missedFrom as number) + 1);
      expected = missedTo as number;
      continue;
    }
    const seq = event.seq;
    expect(typeof seq).toBe("number");
    expect(seq).toBe(expected + 1);
    expected = seq as number;
  }
}

describe("PiRuntimeAdapter（事件缓冲：慢消费者不静默漏事件）", () => {
  it("消费者已订阅但停读，缓冲整体轮转后：先收到头部 gap（1..703），再连续读尾部", async () => {
    // 无 pacing：1203 个事件在一个同步突发内落盘（共 1 agent_start +
    // 1200 update + agent_end + agent_settled），消费者首读发生在裁剪之后。
    // 修复前：cursor 是数组下标，静默从缓冲头（704）继续，漏 703 条无提示。
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 1200 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    const iterator = handle.events()[Symbol.asyncIterator]();
    // 读 10 个交付：第一个必须是显式 gap（订阅后未读区间 1..703 已被淘汰）
    const head: AgentEvent[] = [];
    for (let index = 0; index < 10; index += 1) {
      const step = await iterator.next();
      expect(step.done).toBe(false);
      head.push(step.value as AgentEvent);
    }
    const task = await handle.result();
    expect(task.status).toBe("completed");
    expect(head[0]?.type).toBe("event_gap");
    expect(head[0]?.data).toMatchObject({ missedFrom: 1, missedTo: 703, missedCount: 703 });
    // 排空到结束：全部交付（含 gap 标记）按 seq 连续，终结于 1203
    const tail: AgentEvent[] = [];
    while (true) {
      const step = await iterator.next();
      if (step.done) {
        break;
      }
      tail.push(step.value as AgentEvent);
    }
    expectContiguousSeq([...head, ...tail]);
    expect(tail[tail.length - 1]?.seq).toBe(1203);
    await adapter.close();
  });

  it("慢消费者读 10 个后停读（逐条 pacing）：gap 精确报告 11..703，再从 704 连续到底", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 1200, streamGapMs: 0 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const head: AgentEvent[] = [];
    for (let index = 0; index < 10; index += 1) {
      const step = await iterator.next();
      head.push(step.value as AgentEvent);
    }
    // 此时确实读到了 seq 1..10（逐条 pacing 下实时跟读）
    expectContiguousSeq(head);
    expect(head[head.length - 1]?.seq).toBe(10);
    await handle.result();
    const tail: AgentEvent[] = [];
    while (true) {
      const step = await iterator.next();
      if (step.done) {
        break;
      }
      tail.push(step.value as AgentEvent);
    }
    // 第 11 个交付：gap 精确报告 11..703（693 条被淘汰）
    expect(tail[0]?.type).toBe("event_gap");
    expect(tail[0]?.data).toMatchObject({ missedFrom: 11, missedTo: 703, missedCount: 693 });
    // gap 后从 704 连续到 1203；settle 后排空即结束（头部已读到 seq 10）
    expectContiguousSeq(tail, 10);
    expect(tail[tail.length - 1]?.seq).toBe(1203);
    expect(tail).toHaveLength(1 + 500);
    await adapter.close();
  }, 30_000);

  it("快消费者（live 跟读）：>1000 事件全部送达，seq 1..N 连续、零 gap", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 1200, streamGapMs: 0 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    const events = await drainEvents(handle.events());
    const task = await handle.result();
    expect(task.status).toBe("completed");
    // agent_start + 1200 message_update + agent_end + agent_settled
    expect(events).toHaveLength(1203);
    expect(events.some((event) => event.type === "event_gap")).toBe(false);
    expectContiguousSeq(events);
    expect(events[0]?.type).toBe("agent_start");
    expect(events[events.length - 1]?.seq).toBe(1203);
    expect(events[events.length - 1]?.type).toBe("agent_settled");
    await adapter.close();
  }, 30_000);

  it("订阅晚于截断（settle 后 drain）：先收到头部 gap（1..103），再 replay 尾部 500", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 600 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    await handle.result();
    const events = await drainEvents(handle.events());
    // 603 事件 → 缓冲保留 104..603；首个交付显式报告 1..103 已被淘汰
    expect(events[0]?.type).toBe("event_gap");
    expect(events[0]?.data).toMatchObject({ missedFrom: 1, missedTo: 103, missedCount: 103 });
    expectContiguousSeq(events);
    expect(events[events.length - 1]?.seq).toBe(603);
    expect(events).toHaveLength(1 + 500);
    await adapter.close();
  });

  it("同一 run 两个速度不同的消费者互不干扰：快者零 gap 全量、慢者 gap + 尾部", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 600, streamGapMs: 0 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    // 快消费者：live 跟读全部
    const fastPromise = drainEvents(handle.events());
    // 慢消费者：读 3 个后停下等任务结束
    const slowIterator = handle.events()[Symbol.asyncIterator]();
    const slowHead: AgentEvent[] = [];
    for (let index = 0; index < 3; index += 1) {
      const step = await slowIterator.next();
      slowHead.push(step.value as AgentEvent);
    }
    await handle.result();
    const slowTail: AgentEvent[] = [];
    while (true) {
      const step = await slowIterator.next();
      if (step.done) {
        break;
      }
      slowTail.push(step.value as AgentEvent);
    }
    const fast = await fastPromise;
    // 快消费者：603 个事件、seq 1..603、零 gap
    expect(fast).toHaveLength(603);
    expect(fast.some((event) => event.type === "event_gap")).toBe(false);
    expectContiguousSeq(fast);
    // 慢消费者：3 个（seq 1..3）+ gap（4..103）+ 尾部 104..603
    expectContiguousSeq(slowHead);
    expect(slowHead[slowHead.length - 1]?.seq).toBe(3);
    expect(slowTail[0]?.data).toMatchObject({ missedFrom: 4, missedTo: 103, missedCount: 100 });
    expectContiguousSeq(slowTail, 3);
    expect(slowTail[slowTail.length - 1]?.seq).toBe(603);
    await adapter.close();
  }, 30_000);

  it("settle 后 drain（无截断的小任务）：全量 replay、seq 连续、自然结束", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 8 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    await handle.result();
    const events = await drainEvents(handle.events());
    expect(events.some((event) => event.type === "event_gap")).toBe(false);
    expectContiguousSeq(events);
    expect(events).toHaveLength(11); // agent_start + 8 update + agent_end + agent_settled
    await adapter.close();
  });

  it("迭代器提前 break：waiter 清理、settle 不悬挂、后续新订阅可正常 replay", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done", streamEvents: 50, streamGapMs: 0 });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "main", task: "x", projectId: "p" });
    let consumed = 0;
    for await (const _event of handle.events()) {
      consumed += 1;
      if (consumed === 5) {
        break; // 触发 iterator.return()：清理 waiter
      }
    }
    expect(consumed).toBe(5);
    const task = await handle.result(); // settle 不受悬挂 waiter 影响
    expect(task.status).toBe("completed");
    // 新订阅：完整 replay（53 事件 < 500，无截断）
    const events = await drainEvents(handle.events());
    expect(events).toHaveLength(53);
    expectContiguousSeq(events);
    await adapter.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// queued cancellation（M5.1 任务 D：排队任务取消不等前序 run）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（queued cancellation：取消排队任务无需等待前序 run）", () => {
  it("A running / B queued / cancel B → B 在 A 结束前得到 cancelled 终态；A 不受影响", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(factory.created[0]?.session.pending).toBe(true);
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    const secondCancelled = second.cancel();
    // 关键断言：B 不等 A（A 仍 pending 时 B 已终态 cancelled）
    const secondTask = await Promise.race([
      second.result(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("排队任务 B 未在前序 run 完成前终态")), 1_000).unref?.();
      }),
    ]);
    expect(secondTask.status).toBe("cancelled");
    // A 未被误伤：仍 pending、从未被 abort
    expect(factory.created[0]?.session.pending).toBe(true);
    expect(factory.created[0]?.session.abortedCount).toBe(0);
    await secondCancelled;
    // 随后 A 正常收敛
    await first.cancel();
    expect((await first.result()).status).toBe("cancelled");
    expect(factory.created[0]?.session.prompts).toEqual(["A"]);
    await adapter.close();
  });

  it("A running / B queued / C queued / cancel B / A 正常完成 → C 照常执行", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    const third = await adapter.startAgent({
      agentId: "w",
      task: "C",
      projectId: "p",
      contextScope: "writing/x",
    });
    await second.cancel();
    expect((await second.result()).status).toBe("cancelled");
    // A 正常完成（非 abort）；C 随后以正常行为执行
    factory.setBehavior({ kind: "complete", output: "C done" });
    factory.created[0]?.session.completePending("A done");
    expect((await first.result()).status).toBe("completed");
    // C 排在 B 之后，B 被摘除后 C 正常获得会话并执行
    const session = factory.created[0];
    expect(session).toBeDefined();
    for (let attempt = 0; attempt < 100 && session!.session.prompts.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const thirdTask = await third.result();
    expect(thirdTask.status).toBe("completed");
    expect(factory.created[0]?.session.prompts).toEqual(["A", "C"]);
    expect(factory.created[0]?.session.abortedCount).toBe(0);
    await adapter.close();
  });

  it("runAgent(input.signal) 触发排队取消：同样不等前序 run", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    for (let attempt = 0; attempt < 100 && !factory.created[0]?.session.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const controller = new AbortController();
    const secondTaskPromise = adapter.runAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
      signal: controller.signal,
    });
    controller.abort();
    const secondTask = await Promise.race([
      secondTaskPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("signal 取消的排队任务未在前序 run 完成前终态")), 1_000).unref?.();
      }),
    ]);
    expect(secondTask.status).toBe("cancelled");
    expect(factory.created[0]?.session.pending).toBe(true);
    expect(factory.created[0]?.session.prompts).toEqual(["A"]);
    await first.cancel();
    await adapter.close();
  });

  it("close：排队中任务即时收敛 cancelled（不等前序），无遗留 active run", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    await adapter.close();
    expect((await first.result()).status).toBe("cancelled");
    expect((await second.result()).status).toBe("cancelled");
    expect(adapter.listActiveTasks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout 分层（M5.1 任务 E：queue / execution / session / init 四阶段归因）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（Timeout 分层：queue / execution 阶段）", () => {
  it("QUEUE_TIMEOUT：A running / B queued(超时) / C queued → B 即时 timed_out，A/C 不受影响", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { queueTimeoutMs: 200 });
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    const third = await adapter.startAgent({
      agentId: "w",
      task: "C",
      projectId: "p",
      contextScope: "writing/x",
    });
    // B 不等 A：A 仍 pending 时 B 已 timed_out（reject 通道）
    const bFailure = await second.result().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(bFailure).toBeInstanceOf(AgentTimeoutError);
    expect((bFailure as AgentTimeoutError).phase).toBe("queue");
    expect(factory.created[0]?.session.pending).toBe(true); // A 未被误伤
    expect(factory.created[0]?.session.abortedCount).toBe(0); // B 的超时不 abort 会话
    // 结构化终态可查：QUEUE_TIMEOUT + queue 归因 + 计时
    const bTask = await adapter.getTask(second.taskId);
    expect(bTask.status).toBe("timed_out");
    expect(bTask.errorCode).toBe("QUEUE_TIMEOUT");
    expect(bTask.timeoutPhase).toBe("queue");
    expect(bTask.queueDurationMs).toBeGreaterThanOrEqual(150);
    expect(bTask.startedAt).toBeUndefined(); // 从未进入执行
    expect(bTask.executionDurationMs).toBeUndefined();
    expect(bTask.totalDurationMs).toBeGreaterThanOrEqual(bTask.queueDurationMs ?? 0);
    // A 正常完成后 C 照常执行（B 被摘除不阻塞队列）
    factory.setBehavior({ kind: "complete", output: "C done" });
    factory.created[0]?.session.completePending("A done");
    expect((await first.result()).status).toBe("completed");
    expect((await third.result()).status).toBe("completed");
    expect(factory.created[0]?.session.prompts).toEqual(["A", "C"]);
    expect(adapter.runtimeStats().managedSessions).toBe(1);
    await adapter.close();
    expect(adapter.listActiveTasks()).toHaveLength(0);
  });

  it("QUEUE_TIMEOUT 与 manual cancel 竞态（cancel 先到）：终态保持 cancelled，超时定时器不翻案", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { queueTimeoutMs: 250 });
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    await second.cancel();
    expect((await second.result()).status).toBe("cancelled");
    // 穿过超时窗口后终态不被定时器改写（settle 只发生一次）
    await new Promise((resolve) => setTimeout(resolve, 400));
    const bTask = await adapter.getTask(second.taskId);
    expect(bTask.status).toBe("cancelled");
    expect(bTask.errorCode).toBeUndefined();
    await first.cancel();
    await adapter.close();
  });

  it("QUEUE_TIMEOUT 与 manual cancel 竞态（timeout 先到）：终态保持 timed_out，cancel 幂等 no-op", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { queueTimeoutMs: 150 });
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    await expect(second.result()).rejects.toMatchObject({ phase: "queue" });
    await second.cancel(); // 超时后的 cancel：幂等 no-op
    const bTask = await adapter.getTask(second.taskId);
    expect(bTask.status).toBe("timed_out");
    expect(bTask.errorCode).toBe("QUEUE_TIMEOUT");
    await first.cancel();
    await adapter.close();
  });

  it("EXECUTION_TIMEOUT：真实 session.abort + timed_out 终态可查（含计时）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({
      agentId: "writer",
      task: "慢任务",
      projectId: "p",
      timeoutMs: 150,
    });
    const failure = await handle.result().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentTimeoutError);
    expect((failure as AgentTimeoutError).phase).toBe("execution");
    expect(factory.created[0]?.session.abortedCount).toBe(1); // 真实调用 Pi session.abort
    const task = await adapter.getTask(handle.taskId);
    expect(task.status).toBe("timed_out");
    expect(task.errorCode).toBe("EXECUTION_TIMEOUT");
    expect(task.timeoutPhase).toBe("execution");
    expect(task.startedAt).toBeDefined(); // 进入过执行
    expect(task.executionDurationMs).toBeGreaterThanOrEqual(100);
    expect(task.queueDurationMs).toBeDefined(); // 经历过（瞬时）排队
    expect(task.totalDurationMs).toBeGreaterThanOrEqual(task.executionDurationMs ?? 0);
    await adapter.close();
  });

  it("EXECUTION_TIMEOUT 与 cancel 竞态（cancel 先到 abort）：归因 cancelled，deadline 到点不翻案", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "慢",
      projectId: "p",
      timeoutMs: 200,
    });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    await handle.cancel(); // 先于 deadline 发起 abort → 归因 cancel
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(task.errorCode).toBeUndefined();
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    // 穿过 deadline 后终态不变（首个 abort 发起者唯一归因）
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await adapter.getTask(handle.taskId)).status).toBe("cancelled");
    await adapter.close();
  });

  it("EXECUTION_TIMEOUT 与 cancel 竞态（timeout 先到 abort）：归因 timed_out，随后 cancel no-op", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "慢",
      projectId: "p",
      timeoutMs: 120,
    });
    await expect(handle.result()).rejects.toMatchObject({ phase: "execution" });
    await handle.cancel(); // timeout 已发起 abort：cancel 不重复 abort、不覆盖归因
    expect(factory.created[0]?.session.abortedCount).toBe(1);
    const task = await adapter.getTask(handle.taskId);
    expect(task.status).toBe("timed_out");
    expect(task.errorCode).toBe("EXECUTION_TIMEOUT");
    await adapter.close();
  });

  it("任务在 deadline 前完成：completed（定时器不产生任何影响）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "complete", output: "done" });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({
      agentId: "w",
      task: "快任务",
      projectId: "p",
      timeoutMs: 10_000,
    });
    expect(task.status).toBe("completed");
    expect(task.output).toBe("done");
    expect(task.errorCode).toBeUndefined();
    expect((await adapter.getTask(task.taskId)).status).toBe("completed");
    await adapter.close();
  });

  it("close 与 execution timeout 并发：单一归因（先 close → cancelled；先 timeout → timed_out）", async () => {
    // 先 close（deadline 未到）：取消归因
    {
      const factory = createFakeFactory();
      factory.setBehavior({ kind: "hangUntilAbort" });
      const adapter = await makeLevel1Adapter(factory);
      const handle = await adapter.startAgent({
        agentId: "w",
        task: "慢",
        projectId: "p",
        timeoutMs: 5_000,
      });
      expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
      await adapter.close();
      const task = await handle.result();
      expect(task.status).toBe("cancelled");
      expect(task.errorCode).toBeUndefined();
    }
    // 先 timeout 再 close：超时归因不被 close 覆盖
    {
      const factory = createFakeFactory();
      factory.setBehavior({ kind: "hangUntilAbort" });
      const adapter = await makeLevel1Adapter(factory);
      const handle = await adapter.startAgent({
        agentId: "w",
        task: "慢",
        projectId: "p",
        timeoutMs: 120,
      });
      await expect(handle.result()).rejects.toBeInstanceOf(AgentTimeoutError);
      await adapter.close();
      const task = await adapter.getTask(handle.taskId);
      expect(task.status).toBe("timed_out");
      expect(task.errorCode).toBe("EXECUTION_TIMEOUT");
    }
  });
});

describe("PiRuntimeAdapter（Timeout 分层：session 创建阶段）", () => {
  it("SESSION_TIMEOUT：创建挂起超时 → timed_out；迟到会话销毁不入池；后续任务正常", async () => {
    const gated = createGatedFactory();
    const adapter = await makeLevel1Adapter(gated, { sessionTimeoutMs: 150 });
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "等会话",
      projectId: "p",
      contextScope: "writing/x",
    });
    const failure = await handle.result().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentTimeoutError);
    expect((failure as AgentTimeoutError).phase).toBe("session");
    const task = await adapter.getTask(handle.taskId);
    expect(task.status).toBe("timed_out");
    expect(task.errorCode).toBe("SESSION_TIMEOUT");
    expect(task.timeoutPhase).toBe("session");
    expect(task.startedAt).toBeUndefined(); // 从未获得会话
    expect(task.queuedAt).toBeUndefined(); // 从未进入队列
    expect(task.executionDurationMs).toBeUndefined();
    expect(task.queueDurationMs).toBeUndefined();

    // 迟到的创建成功：识别为已被放弃 → 销毁、不入池（无幽灵会话）
    gated.release();
    expect(await waitFor(() => gated.created[0]?.disposed === true)).toBe(true);
    expect(adapter.runtimeStats().managedSessions).toBe(0);

    // 后续任务不受影响：新创建请求发起 → 放行 → 入池执行
    const next = adapter.runAgent({
      agentId: "w",
      task: "第二次",
      projectId: "p",
      contextScope: "writing/x",
    });
    expect(await waitFor(() => gated.requested >= 2)).toBe(true);
    gated.release();
    const nextTask = await next;
    expect(nextTask.status).toBe("completed");
    expect(nextTask.output).toBe("late ok");
    expect(adapter.runtimeStats().managedSessions).toBe(1);
    expect(gated.created[1]?.disposed).toBe(false);
    await adapter.close();
  });

  it("会话创建共享：一个等待者超时离开后仍有新等待者 → 迟到会话正常入池不被销毁", async () => {
    const gated = createGatedFactory();
    const adapter = await makeLevel1Adapter(gated, { sessionTimeoutMs: 150 });
    // A 先发起（150ms 后将超时放弃）
    const first = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p",
      contextScope: "writing/x",
    });
    await expect(first.result()).rejects.toMatchObject({ phase: "session" });
    // B 在 A 放弃后、创建完成前加入同一创建槽
    const second = await adapter.startAgent({
      agentId: "w",
      task: "B",
      projectId: "p",
      contextScope: "writing/x",
    });
    gated.release(); // 仍有等待者（B）→ 入池
    const secondTask = await second.result();
    expect(secondTask.status).toBe("completed");
    expect(gated.created[0]?.disposed).toBe(false);
    expect(adapter.runtimeStats().managedSessions).toBe(1);
    const firstTask = await adapter.getTask(first.taskId);
    expect(firstTask.status).toBe("timed_out");
    expect(firstTask.errorCode).toBe("SESSION_TIMEOUT");
    await adapter.close();
  });
});

describe("PiRuntimeAdapter（Timeout 分层：Runtime 初始化阶段）", () => {
  it("INIT_TIMEOUT：初始化挂起超时 → timed_out(INIT_TIMEOUT)；迟到初始化惠及后续任务", async () => {
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    // 受控初始化：挂起直到测试放行，随后走真实初始化路径（注入 model 生效）
    class HangingInitAdapter extends PiRuntimeAdapter {
      protected override async doInitialize(): Promise<void> {
        await initGate;
        await super.doInitialize();
      }
    }
    const agentDir = await makeTempDir("pi-l1-initgate-");
    const workspaceRoot = await makeTempDir("pi-l1-ws-");
    const adapter = new HangingInitAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: stubModelRuntime(),
      model: { provider: "fake", id: "fake-1" } as PiModel,
      createSession:
        createFakeFactory().factory as NonNullable<PiRuntimeOptions["createSession"]>,
      initTimeoutMs: 150,
      log: () => {},
    });
    // 超时：句柄仍返回，result reject + 结构化终态可查
    const handle = await adapter.startAgent({ agentId: "w", task: "x", projectId: "p" });
    const failure = await handle.result().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentTimeoutError);
    expect((failure as AgentTimeoutError).phase).toBe("init");
    const task = await adapter.getTask(handle.taskId);
    expect(task.status).toBe("timed_out");
    expect(task.errorCode).toBe("INIT_TIMEOUT");
    expect(task.timeoutPhase).toBe("init");
    expect(task.startedAt).toBeUndefined();
    // 迟到初始化（共享 initPromise）完成 → 后续任务正常执行
    releaseInit();
    const next = await adapter.runAgent({ agentId: "w", task: "y", projectId: "p" });
    expect(next.status).toBe("completed");
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 结构化终态（M5.1 任务 F：reject 不丢状态、全终态可查、计时非负）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（结构化终态：completed / cancelled / failed / timed_out 全可查）", () => {
  it("四种终态都可经 getTask 查询；计时字段非负、ISO 时间可解析、单调", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);

    const assertTimingSound = (task: {
      totalDurationMs?: number;
      queueDurationMs?: number;
      executionDurationMs?: number;
      createdAt: string;
      completedAt?: string;
    }): void => {
      expect(task.totalDurationMs).toBeGreaterThanOrEqual(0);
      for (const ms of [task.queueDurationMs, task.executionDurationMs]) {
        if (ms !== undefined) {
          expect(ms).toBeGreaterThanOrEqual(0);
        }
      }
      expect(new Date(task.createdAt).getTime()).not.toBeNaN();
      expect(new Date(task.completedAt ?? "").getTime()).not.toBeNaN();
    };

    // completed
    factory.setBehavior({ kind: "complete", output: "ok" });
    const done = await adapter.runAgent({ agentId: "w", task: "1", projectId: "p" });
    const doneFetched = await adapter.getTask(done.taskId);
    expect(doneFetched.status).toBe("completed");
    expect(doneFetched.startedAt).toBeDefined();
    assertTimingSound(doneFetched);

    // failed（transcript stopReason=error）
    factory.setBehavior({ kind: "errorStop", message: "provider 502" });
    const failed = await adapter.runAgent({ agentId: "w", task: "2", projectId: "p" });
    expect(failed.status).toBe("failed");
    const failedFetched = await adapter.getTask(failed.taskId);
    expect(failedFetched.status).toBe("failed");
    expect(failedFetched.errorCode).toBe("RUN_FAILED");
    expect(failedFetched.error).toContain("provider 502");
    assertTimingSound(failedFetched);

    // cancelled（运行中取消）
    factory.setBehavior({ kind: "hangUntilAbort" });
    const cancelHandle = await adapter.startAgent({ agentId: "w", task: "3", projectId: "p" });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    await cancelHandle.cancel();
    const cancelledFetched = await adapter.getTask(cancelHandle.taskId);
    expect(cancelledFetched.status).toBe("cancelled");
    expect(cancelledFetched.errorCode).toBeUndefined();
    expect(cancelledFetched.startedAt).toBeDefined();
    assertTimingSound(cancelledFetched);

    // timed_out（reject 路径也不丢状态）
    const timeoutHandle = await adapter.startAgent({
      agentId: "w",
      task: "4",
      projectId: "p",
      timeoutMs: 120,
    });
    await expect(timeoutHandle.result()).rejects.toBeInstanceOf(AgentTimeoutError);
    const timedOutFetched = await adapter.getTask(timeoutHandle.taskId);
    expect(timedOutFetched.status).toBe("timed_out");
    expect(timedOutFetched.errorCode).toBe("EXECUTION_TIMEOUT");
    assertTimingSound(timedOutFetched);
    await adapter.close();
  });

  it("模型未配置的立即失败：结构化 failed（MODEL_NOT_CONFIGURED）可查，不进会话", async () => {
    const agentDir = await makeTempDir("pi-l1-nomodel2-");
    const workspaceRoot = await makeTempDir("pi-l1-ws-");
    const adapter = new PiRuntimeAdapter({ agentDir, workspaceRoot, log: () => {} });
    const handle = await adapter.startAgent({ agentId: "w", task: "x", projectId: "p" });
    const task = await handle.result();
    expect(task.status).toBe("failed");
    expect(task.errorCode).toBe("MODEL_NOT_CONFIGURED");
    expect((await adapter.getTask(handle.taskId)).status).toBe("failed");
    expect(adapter.runtimeStats().managedSessions).toBe(0);
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// Run 级 usage 采集（M5.2 第一步：Pi 原生 usage，跨 turn 累加 / 快照不累加）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（Run 级 usage 采集：Level 1）", () => {
  // 与任务书示例同构的两 turn 数据：contextTokens 必须取 310（最后一个
  // 有效 totalTokens），绝不能跨 turn 累加成 470
  const turn1: FakeUsage = {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 10,
    totalTokens: 160,
    cost: 0.01,
  };
  const turn2: FakeUsage = {
    input: 200,
    output: 40,
    cacheRead: 50,
    cacheWrite: 20,
    totalTokens: 310,
    cost: 0.02,
  };

  it("两个 assistant turn：增量项求和、contextTokens 取最后值、assistantTurns=2", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({
      kind: "complete",
      output: "最终输出",
      usageTurns: [turn1, turn2],
    });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({ agentId: "w", task: "x", projectId: "p" });
    expect(task.status).toBe("completed");
    expect(task.output).toBe("最终输出");
    expect(task.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 80,
      cacheWriteTokens: 30,
      contextTokens: 310, // 不是 470：totalTokens 是上下文规模快照
      assistantTurns: 2,
    });
    expect(task.usage?.estimatedCost).toBeCloseTo(0.03, 10);
    await adapter.close();
  });

  it("provider 未返回 cost：estimatedCost 缺省，token 统计不受影响（不伪造 0 成本结论）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({
      kind: "complete",
      output: "ok",
      usageTurns: [{ ...turn1, cost: undefined }, { ...turn2, cost: undefined }],
    });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({ agentId: "w", task: "x", projectId: "p" });
    expect(task.usage).toBeDefined();
    expect(task.usage?.estimatedCost).toBeUndefined();
    expect(task.usage?.inputTokens).toBe(300);
    await adapter.close();
  });

  it("message_end 不携带 usage：task.usage 整体缺省（不伪造 0）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({
      kind: "complete",
      output: "ok",
      usageTurns: [undefined, undefined],
    });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({ agentId: "w", task: "x", projectId: "p" });
    expect(task.status).toBe("completed");
    expect(task.usage).toBeUndefined();
    // getTask 回溯同样不携带
    expect((await adapter.getTask(task.taskId)).usage).toBeUndefined();
    await adapter.close();
  });

  it("cancelled run 保留已产生的 usage（cancel 前的 turn 已累计）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "turnsThenHang", turnUsages: [turn1, turn2] });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({ agentId: "w", task: "x", projectId: "p" });
    expect(await waitFor(() => factory.created[0]?.session.pending === true)).toBe(true);
    await handle.cancel();
    const task = await handle.result();
    expect(task.status).toBe("cancelled");
    expect(task.usage).toMatchObject({ inputTokens: 300, outputTokens: 60, contextTokens: 310 });
    await adapter.close();
  });

  it("timed_out run 保留已产生的 usage", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "turnsThenHang", turnUsages: [turn1, turn2] });
    const adapter = await makeLevel1Adapter(factory);
    const handle = await adapter.startAgent({
      agentId: "w",
      task: "x",
      projectId: "p",
      timeoutMs: 150,
    });
    await expect(handle.result()).rejects.toBeInstanceOf(AgentTimeoutError);
    const task = await adapter.getTask(handle.taskId);
    expect(task.status).toBe("timed_out");
    expect(task.usage).toMatchObject({ inputTokens: 300, outputTokens: 60, contextTokens: 310 });
    await adapter.close();
  });

  it("failed run 保留已产生的 usage（stopReason=error 的 turn 也消耗了 token）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({
      kind: "errorStop",
      message: "provider 502",
      usageTurns: [turn1],
    });
    const adapter = await makeLevel1Adapter(factory);
    const task = await adapter.runAgent({ agentId: "w", task: "x", projectId: "p" });
    expect(task.status).toBe("failed");
    expect(task.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      contextTokens: 160,
      assistantTurns: 1,
    });
    await adapter.close();
  });

  it("会话复用：第二个 run 只统计本 run 新 turn（历史 usage 不重复计入）", async () => {
    const factory = createFakeFactory();
    const adapter = await makeLevel1Adapter(factory);
    factory.setBehavior({ kind: "complete", output: "第一轮", usageTurns: [turn1] });
    const first = await adapter.runAgent({
      agentId: "w",
      task: "1",
      projectId: "p",
      contextScope: "writing/x",
    });
    expect(first.usage).toMatchObject({ inputTokens: 100, contextTokens: 160 });
    factory.setBehavior({ kind: "complete", output: "第二轮", usageTurns: [turn2] });
    const second = await adapter.runAgent({
      agentId: "w",
      task: "2",
      projectId: "p",
      contextScope: "writing/x",
    });
    // 同一会话（created 仍为 1）；第二轮 usage 只含 turn2，绝不是 turn1+turn2
    expect(factory.created).toHaveLength(1);
    expect(second.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      contextTokens: 310,
      assistantTurns: 1,
    });
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 全局并发与有界受理（M5.2：Runtime 层最后一道 admission / execution guard）
// ---------------------------------------------------------------------------

describe("PiRuntimeAdapter（全局并发与有界受理：M5.2）", () => {
  /** 周期采样活跃数（hangUntilAbort 场景下 pending ≙ 正在 prompt） */
  function startActiveProbe(
    factory: ReturnType<typeof createFakeFactory>,
  ): { maxActive: () => number; stop: () => void } {
    let maxActive = 0;
    const timer = setInterval(() => {
      const active = factory.created.filter(({ session }) => session.pending).length;
      maxActive = Math.max(maxActive, active);
    }, 5);
    return { maxActive: () => maxActive, stop: () => clearInterval(timer) };
  }

  it("Case 1 全局并发上限：maxConcurrentRuns=2 时任意时刻真实 prompt <= 2，FIFO 续跑", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 2, maxQueuedRuns: 8 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    const probe = startActiveProbe(factory);
    try {
      // A/B 先占满 2 个 permit（真实执行、挂起中）
      const [a, b] = await Promise.all([
        adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" }),
        adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" }),
      ]);
      expect(await waitFor(() => sessionOf("p-a")?.pending === true && sessionOf("p-b")?.pending === true)).toBe(true);
      expect(adapter.runtimeStats().activeExecutions).toBe(2);
      // C/D 顺序启动（间隔一个 settle 周期，保证 C 先注册为 permit 等待者：
      // 等待 FIFO 按「就绪顺序」派发，会话创建完成的先后不保证与启动顺序一致）
      const c = await adapter.startAgent({ agentId: "w", task: "C", projectId: "p-c", contextScope: "writing/x" });
      expect(await waitFor(() => sessionOf("p-c") !== undefined && adapter.runtimeStats().queuedRuns === 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const d = await adapter.startAgent({ agentId: "w", task: "D", projectId: "p-d", contextScope: "writing/x" });
      expect(await waitFor(() => sessionOf("p-d") !== undefined && adapter.runtimeStats().queuedRuns === 2)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // C/D 会话已创建（会话创建不受 permit 限制），但绝不 prompt
      expect(factory.created).toHaveLength(4);
      expect(sessionOf("p-a")?.prompts).toHaveLength(1);
      expect(sessionOf("p-b")?.prompts).toHaveLength(1);
      expect(sessionOf("p-c")?.prompts).toHaveLength(0);
      expect(sessionOf("p-d")?.prompts).toHaveLength(0);
      // 完成 A → C（先注册的等待者，FIFO）续跑；D 仍未 prompt
      sessionOf("p-a")?.completePending("A done");
      expect(await waitFor(() => sessionOf("p-c")?.pending === true)).toBe(true);
      expect(sessionOf("p-d")?.prompts).toHaveLength(0);
      // 完成 B → D 续跑
      sessionOf("p-b")?.completePending("B done");
      expect(await waitFor(() => sessionOf("p-d")?.pending === true)).toBe(true);
      // 全程任意时刻真实并发 <= 2（若无限流，开局即 4）
      expect(probe.maxActive()).toBeLessThanOrEqual(2);
      sessionOf("p-c")?.completePending("C done");
      sessionOf("p-d")?.completePending("D done");
      const [aTask, bTask, cTask, dTask] = await Promise.all([
        a.result(),
        b.result(),
        c.result(),
        d.result(),
      ]);
      expect([aTask.status, bTask.status, cTask.status, dTask.status]).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
      expect(adapter.runtimeStats().activeExecutions).toBe(0);
      expect(adapter.runtimeStats().queuedRuns).toBe(0);
      await adapter.close();
    } finally {
      probe.stop();
    }
  });

  it("Case 2 同 session 排队任务不提前占用全局 permit：A1+A2 同会话 / B1 立即并行", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 2, maxQueuedRuns: 8 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    // A1 先占住 p-a 会话与 1 个 permit（确定性：等待真实挂起后再启动后续任务）
    const a1 = await adapter.startAgent({ agentId: "w", task: "A1", projectId: "p-a", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true)).toBe(true);
    // 同 sessionKey（p-a × writing/x）：A2 在 per-session FIFO 中排在 A1 后
    const a2 = await adapter.startAgent({ agentId: "w", task: "A2", projectId: "p-a", contextScope: "writing/x" });
    const b1 = await adapter.startAgent({ agentId: "w", task: "B1", projectId: "p-b", contextScope: "writing/x" });
    // 关键：A2 虽排不上队，但绝不提前占走第二个 permit —— B1 照常并行执行
    expect(await waitFor(() => sessionOf("p-b")?.pending === true)).toBe(true);
    expect(sessionOf("p-a")?.prompts).toEqual(["A1"]);
    expect(adapter.runtimeStats().activeExecutions).toBe(2);
    expect(adapter.runtimeStats().queuedRuns).toBe(1); // 只有 A2 在等待
    // A1 完成 → A2 经会话队列泵 + 空闲 permit 正常接续
    sessionOf("p-a")?.completePending("A1 done");
    expect(await waitFor(() => sessionOf("p-a")?.prompts.length === 2)).toBe(true);
    sessionOf("p-b")?.completePending("B1 done");
    sessionOf("p-a")?.completePending("A2 done");
    const [t1, t2, t3] = await Promise.all([a1.result(), a2.result(), b1.result()]);
    expect([t1.status, t2.status, t3.status]).toEqual(["completed", "completed", "completed"]);
    await adapter.close();
  });

  it("Case 3 有界受理：maxQueuedRuns 占满后新任务立即 RUNTIME_QUEUE_FULL（不建会话不 prompt）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 2, maxQueuedRuns: 2 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    // A/B 占满执行容量（真实运行中），等待容量此刻为 0
    const a = await adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true && sessionOf("p-b")?.pending === true)).toBe(true);
    expect(adapter.runtimeStats().queuedRuns).toBe(0);
    // C/D：占满 2 个等待容量（等全局 permit）
    const c = await adapter.startAgent({ agentId: "w", task: "C", projectId: "p-c", contextScope: "writing/x" });
    const d = await adapter.startAgent({ agentId: "w", task: "D", projectId: "p-d", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 2)).toBe(true);
    // E：等待容量已满 → 立即结构化失败（句柄返回，result resolve failed 任务）
    const e = await adapter.startAgent({ agentId: "w", task: "E", projectId: "p-e", contextScope: "writing/x" });
    const eTask = await e.result();
    expect(eTask.status).toBe("failed");
    expect(eTask.errorCode).toBe("RUNTIME_QUEUE_FULL");
    expect(eTask.error).toContain("queued=2/2");
    expect(eTask.error).toContain("active=2/2");
    // 不创建会话、不进入任何队列、不 prompt（C/D 会话在等 permit，E 的会话从未创建）
    expect(await waitFor(() => factory.created.length === 4)).toBe(true);
    expect(factory.created.every(({ session }) => session.prompts.length <= 1)).toBe(true);
    // getTask 可回溯该结构化失败
    const fetched = await adapter.getTask(e.taskId);
    expect(fetched.status).toBe("failed");
    expect(fetched.errorCode).toBe("RUNTIME_QUEUE_FULL");
    // 释放一个等待容量（取消 C）后，新任务恢复受理（不被 QUEUE_FULL 拒绝）
    await c.cancel();
    expect(adapter.runtimeStats().queuedRuns).toBe(1);
    const f = await adapter.startAgent({ agentId: "w", task: "F", projectId: "p-f", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 2)).toBe(true);
    await Promise.all([a.cancel(), b.cancel(), d.cancel(), f.cancel()]);
    expect(adapter.runtimeStats().activeExecutions).toBe(0);
    expect(adapter.runtimeStats().queuedRuns).toBe(0);
    await adapter.close();
  });

  it("Case 4 cancel 全局 permit 等待者（AbortSignal）：立即 cancelled、释放受理容量、永不复活", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 2, maxQueuedRuns: 4 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    const a = await adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true && sessionOf("p-b")?.pending === true)).toBe(true);
    const controller = new AbortController();
    const c = await adapter.startAgent({
      agentId: "w",
      task: "C",
      projectId: "p-c",
      contextScope: "writing/x",
      signal: controller.signal,
    });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 1 && sessionOf("p-c") !== undefined)).toBe(true);
    // signal abort 与 handle.cancel 同一取消链路：等待中的 C 立即终态
    controller.abort();
    const cTask = await c.result();
    expect(cTask.status).toBe("cancelled");
    expect(sessionOf("p-c")?.prompts).toHaveLength(0);
    expect(adapter.runtimeStats().queuedRuns).toBe(0);
    // 释放出来的受理容量可被新任务 D 占用（不被 QUEUE_FULL 拒绝）
    const d = await adapter.startAgent({ agentId: "w", task: "D", projectId: "p-d", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 1)).toBe(true);
    // A 完成 → D 获得 permit 执行；C 不复活（从未 prompt）
    sessionOf("p-a")?.completePending("A done");
    expect(await waitFor(() => sessionOf("p-d")?.pending === true)).toBe(true);
    expect(sessionOf("p-c")?.prompts).toHaveLength(0);
    const aTask = await a.result();
    expect(aTask.status).toBe("completed");
    sessionOf("p-b")?.completePending("B done");
    sessionOf("p-d")?.completePending("D done");
    const [bTask, dTask] = await Promise.all([b.result(), d.result()]);
    expect([bTask.status, dTask.status]).toEqual(["completed", "completed"]);
    await adapter.close();
  });

  it("Case 5 QUEUE_TIMEOUT 覆盖全局 permit 等待：沿用原 deadline（不因转入 permit 队列重置）", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, {
      maxConcurrentRuns: 2,
      maxQueuedRuns: 8,
      queueTimeoutMs: 600,
    });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    // A/B 占满 2 个 permit
    const a = await adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true && sessionOf("p-b")?.pending === true)).toBe(true);
    // C（独立会话）注册为 permit 等待者；A2 在 A 的会话 FIFO 排队（deadline 同刻起算）
    const c = await adapter.startAgent({ agentId: "w", task: "C", projectId: "p-c", contextScope: "writing/x" });
    const a2 = await adapter.startAgent({ agentId: "w", task: "A2", projectId: "p-a", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 2)).toBe(true);
    expect(sessionOf("p-a")?.prompts).toEqual(["A"]);
    // t≈250ms：A 完成 → 释放的 permit 按 FIFO 给 C（先注册的等待者）
    await new Promise((resolve) => setTimeout(resolve, 250));
    sessionOf("p-a")?.completePending("A done");
    expect(await waitFor(() => sessionOf("p-c")?.pending === true)).toBe(true);
    // A2 此刻才从会话队列出队、转入 permit 等待（B/C 占满）——deadline 仍是入队起算的 600ms
    await expect(a2.result()).rejects.toMatchObject({ phase: "queue" });
    const a2Task = await adapter.getTask(a2.taskId);
    expect(a2Task.status).toBe("timed_out");
    expect(a2Task.errorCode).toBe("QUEUE_TIMEOUT");
    expect(a2Task.timeoutPhase).toBe("queue");
    // 原始 deadline 的证据：排队时长 ≈ 600ms（若转入 permit 队列时被重置，将 ≥ 850ms）
    expect(a2Task.queueDurationMs).toBeGreaterThanOrEqual(550);
    expect(a2Task.queueDurationMs).toBeLessThan(820);
    // A/B/C 不受影响；记账无泄漏
    expect(sessionOf("p-c")?.prompts).toEqual(["C"]);
    sessionOf("p-b")?.completePending("B done");
    sessionOf("p-c")?.completePending("C done");
    const [aTask, bTask, cTask] = await Promise.all([a.result(), b.result(), c.result()]);
    expect([aTask.status, bTask.status, cTask.status]).toEqual(["completed", "completed", "completed"]);
    expect(adapter.runtimeStats().activeExecutions).toBe(0);
    expect(adapter.runtimeStats().queuedRuns).toBe(0);
    await adapter.close();
  });

  it("Case 6 EXECUTION_TIMEOUT 释放 permit：A 超时 abort 后等待中的 B 接续执行", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 1, maxQueuedRuns: 4 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    const a = await adapter.startAgent({
      agentId: "w",
      task: "A",
      projectId: "p-a",
      contextScope: "writing/x",
      timeoutMs: 250,
    });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true)).toBe(true);
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 1)).toBe(true);
    await expect(a.result()).rejects.toBeInstanceOf(AgentTimeoutError);
    const aTask = await adapter.getTask(a.taskId);
    expect(aTask.status).toBe("timed_out");
    expect(aTask.errorCode).toBe("EXECUTION_TIMEOUT");
    expect(sessionOf("p-a")?.abortedCount).toBe(1);
    // permit 已随超时终态释放：B 立即开始
    expect(await waitFor(() => sessionOf("p-b")?.pending === true)).toBe(true);
    expect(adapter.runtimeStats().activeExecutions).toBe(1);
    sessionOf("p-b")?.completePending("B done");
    const bTask = await b.result();
    expect(bTask.status).toBe("completed");
    expect(adapter.runtimeStats().activeExecutions).toBe(0);
    await adapter.close();
  });

  it("Case 7a failure 释放 permit（prompt 前置 throw → PROMPT_REJECTED）：后续任务照常执行", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "preflightReject", message: "No API key for fake/x" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 1, maxQueuedRuns: 4 });
    const first = await adapter.runAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    expect(first.status).toBe("failed");
    expect(first.errorCode).toBe("PROMPT_REJECTED");
    // throw 路径没有卡死 permit：第二个任务仍被受理并真实执行（同样 throw）
    const second = await adapter.runAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(second.status).toBe("failed");
    expect(second.errorCode).toBe("PROMPT_REJECTED");
    expect(factory.created[1]?.session.prompts).toHaveLength(1);
    expect(adapter.runtimeStats().activeExecutions).toBe(0);
    await adapter.close();
  });

  it("Case 7b failure 释放 permit（运行中 errorStop → RUN_FAILED）：等待中的 B 接续", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 1, maxQueuedRuns: 4 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    const a = await adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true)).toBe(true);
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 1)).toBe(true);
    // A 在运行中失败（transcript stopReason=error）
    sessionOf("p-a")?.failPending("provider 502");
    const aTask = await a.result();
    expect(aTask.status).toBe("failed");
    expect(aTask.errorCode).toBe("RUN_FAILED");
    expect(await waitFor(() => sessionOf("p-b")?.pending === true)).toBe(true);
    sessionOf("p-b")?.completePending("B done");
    const bTask = await b.result();
    expect(bTask.status).toBe("completed");
    expect(adapter.runtimeStats().activeExecutions).toBe(0);
    await adapter.close();
  });

  it("Case 8 close：运行中 abort、等待者即时终态、记账归零、无悬挂", async () => {
    const factory = createFakeFactory();
    factory.setBehavior({ kind: "hangUntilAbort" });
    const adapter = await makeLevel1Adapter(factory, { maxConcurrentRuns: 2, maxQueuedRuns: 8 });
    const sessionOf = (pid: string) =>
      factory.created.find(({ params }) => params.cwd.split(sep).pop() === pid)?.session;
    const a = await adapter.startAgent({ agentId: "w", task: "A", projectId: "p-a", contextScope: "writing/x" });
    const b = await adapter.startAgent({ agentId: "w", task: "B", projectId: "p-b", contextScope: "writing/x" });
    expect(await waitFor(() => sessionOf("p-a")?.pending === true && sessionOf("p-b")?.pending === true)).toBe(true);
    const c = await adapter.startAgent({ agentId: "w", task: "C", projectId: "p-c", contextScope: "writing/x" });
    const d = await adapter.startAgent({ agentId: "w", task: "D", projectId: "p-d", contextScope: "writing/x" });
    expect(await waitFor(() => adapter.runtimeStats().queuedRuns === 2)).toBe(true);
    // close 必须收敛返回（等待者即时终态，不依赖运行中任务）
    await adapter.close();
    const [aTask, bTask, cTask, dTask] = await Promise.all([
      a.result(),
      b.result(),
      c.result(),
      d.result(),
    ]);
    expect([aTask.status, bTask.status, cTask.status, dTask.status]).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(sessionOf("p-c")?.prompts).toHaveLength(0);
    expect(sessionOf("p-d")?.prompts).toHaveLength(0);
    // 调度记账最终归零；会话全部 dispose
    const stats = adapter.runtimeStats();
    expect(stats.activeRuns).toBe(0);
    expect(stats.activeExecutions).toBe(0);
    expect(stats.queuedRuns).toBe(0);
    expect(factory.created.every(({ session }) => session.disposed)).toBe(true);
  });

  it("maxConcurrentRuns / maxQueuedRuns 非法构造直接拒绝（容量契约是正确性约束）", async () => {
    const factory = createFakeFactory();
    await expect(makeLevel1Adapter(factory, { maxConcurrentRuns: 0 })).rejects.toThrow(RangeError);
    await expect(makeLevel1Adapter(factory, { maxQueuedRuns: -1 })).rejects.toThrow(RangeError);
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

  it("usage（真实 SDK 链路）：faux provider 的原生 usage 进入 run 级统计", async () => {
    const { adapter, faux } = await makeLevel2Adapter();
    faux.setResponses([fauxAssistantMessage([fauxText("一段真实链路的输出")])]);
    const task = await adapter.runAgent({
      agentId: "writer",
      task: "写",
      projectId: "p-usage",
      contextScope: "writing/x",
    });
    expect(task.status).toBe("completed");
    // faux 按文本长度估算 token（list-price 成本恒 0）——验证的是「Pi 原生
    // usage 直通 run 级统计」，不是具体数值
    expect(task.usage).toBeDefined();
    expect(task.usage?.inputTokens).toBeGreaterThan(0);
    expect(task.usage?.outputTokens).toBeGreaterThan(0);
    expect(task.usage?.contextTokens).toBeGreaterThan(0);
    expect(task.usage?.assistantTurns).toBe(1);
    expect(task.usage?.estimatedCost).toBe(0); // faux 的 list-price 为 0，如实透传
    await adapter.close();
  }, 30_000);

  it("usage 多 turn（真实 SDK + 工具调用）：两个 assistant turn 正确累计", async () => {
    // 简单 echo 工具：第一轮模型请求调用工具，第二轮输出文本（真实 agent loop
    // 产生两条 assistant message_end）
    const echoTool = defineTool({
      name: "paperteam_echo",
      label: "Echo（测试专用）",
      description: "测试专用：原样返回 text",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_toolCallId, params) => {
        return { content: [{ type: "text", text: params.text }], details: {} };
      },
    });
    const { adapter, faux } = await makeLevel2Adapter({
      adapterExtra: { customTools: [echoTool as ToolDefinition] },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("paperteam_echo", { text: "ping" })]),
      fauxAssistantMessage([fauxText("两轮完成")]),
    ]);
    const task = await adapter.runAgent({
      agentId: "researcher",
      task: "先调工具再回答",
      projectId: "p-usage-2",
      contextScope: "research",
    });
    expect(task.status).toBe("completed");
    expect(task.output).toContain("两轮完成");
    expect(task.usage?.assistantTurns).toBe(2);
    expect(task.usage?.inputTokens).toBeGreaterThan(0);
    expect(task.usage?.outputTokens).toBeGreaterThan(0);
    await adapter.close();
  }, 60_000);
});
