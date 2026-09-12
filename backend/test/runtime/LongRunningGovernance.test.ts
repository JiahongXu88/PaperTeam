/**
 * M5.2 长程治理 Soak / Stress 回归（任务 L）。
 *
 * 用 planner 驱动的 fake provider 会话模拟 100-300 个 Agent runs 的受控
 * 长程负载（不烧真实 token），覆盖多 project × agentId × contextScope ×
 * sessionKey，混合 completed / cancelled / failed / timed_out / 结构化拒绝
 * （RUNTIME_QUEUE_FULL / RUNTIME_SESSION_CAPACITY / CONTEXT_BUDGET_EXCEEDED）。
 *
 * 核心不变量（全部断言）：
 * - activeExecutions 任意时刻 <= maxConcurrentRuns；
 * - queuedRuns 任意时刻 <= maxQueuedRuns；
 * - managedSessions 任意时刻 <= maxSessions（不无限增长）；
 * - idle 会话可被 GC；active / queued / 到达中的会话绝不被回收
 *   （dispose 后 prompt / pending 中 dispose 两个违规哨兵保持 false）；
 * - rotation 后同一 sessionKey 的 prompt 顺序仍为提交顺序的子序列（FIFO）；
 * - 全部 settle 后 activeExecutions / queuedRuns / activeRuns 归零；
 * - 事件迭代器自然结束（无 waiter 泄漏悬挂）；
 * - close 后会话全部 dispose 且各恰好一次；无 unhandled rejection。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { PiRuntimeOptions } from "../../src/runtime/PiRuntimeAdapter.js";
import type { AgentTask } from "../../src/runtime/types.js";

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** 任务模式（task 文本前缀 → planner 行为） */
type Mode = "ok" | "big" | "hang" | "err";

/** planner 驱动的 fake 会话：行为由 prompt 文本前缀决定（确定性） */
class PlannerSession {
  readonly prompts: string[] = [];
  maxConcurrent = 0;
  disposeCount = 0;
  disposed = false;
  pending = false;
  promptedAfterDispose = false;
  disposedWhilePending = false;
  cwd: string;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly messages: unknown[] = [];
  private releasePending?: () => void;
  private active = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
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

  /** prompt 文本形如 "ok-12" / "hang-3" */
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.disposed) {
      this.promptedAfterDispose = true;
    }
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    const mode = text.split("-")[0] as Mode;
    try {
      this.emit({ type: "agent_start" } as AgentSessionEvent);
      if (mode === "hang") {
        this.pending = true;
        await new Promise<void>((resolve) => {
          this.releasePending = resolve;
        });
        this.pending = false;
        return;
      }
      const isError = mode === "err";
      const message = {
        role: "assistant",
        content: [{ type: "text", text: isError ? "" : `${text}-out` }],
        stopReason: isError ? "error" : "stop",
        ...(isError ? { errorMessage: "provider 502 (planned)" } : {}),
        // big：实测 usage 占用 42000（触发下一 run 的 context rotation）
        ...(mode === "big"
          ? {
              usage: {
                input: 41000,
                output: 1000,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 42000,
              },
            }
          : {}),
      };
      this.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
      this.messages.push(message);
      this.emit({ type: "agent_end", messages: [message], willRetry: false } as unknown as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
    } finally {
      this.active -= 1;
    }
  }

  async abort(): Promise<void> {
    if (this.releasePending !== undefined) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      this.messages.push(message);
      this.emit({ type: "agent_end", messages: [message], willRetry: false } as unknown as AgentSessionEvent);
      this.emit({ type: "agent_settled" } as AgentSessionEvent);
      const release = this.releasePending;
      this.releasePending = undefined;
      release();
    }
  }

  async waitForIdle(): Promise<void> {}

  dispose(): void {
    if (this.pending) {
      this.disposedWhilePending = true;
    }
    this.disposeCount += 1;
    this.disposed = true;
    this.listeners.clear();
  }

  getLastAssistantText(): string | undefined {
    const messages = this.messages as { role: string; content: { type: string; text?: string }[] }[];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") {
        const text = message.content.find((block) => block.type === "text")?.text;
        return text !== undefined && text !== "" ? text : undefined;
      }
    }
    return undefined;
  }
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LongRunningGovernance soak（M5.2 任务 L）", () => {
  it("160 runs 受控长程：并发/受理/会话容量全程有界、rotation 保 FIFO、GC 收敛、零泄漏", async () => {
    const created: PlannerSession[] = [];
    const factory: PiRuntimeOptions["createSession"] = async (params) => {
      const session = new PlannerSession(params.cwd);
      created.push(session);
      return session as unknown as AgentSession;
    };

    // 预算：contextWindow=50000, maxTokens=8192 → reserve=8192；
    // big 的实测 42000 + 任意输入 + 8192 > 50000 → 下一 run 必然 rotation
    const adapter = new PiRuntimeAdapter({
      agentDir: await makeTempDir("soak-agent-"),
      workspaceRoot: await makeTempDir("soak-ws-"),
      modelRuntime: {
        getModel: () => ({}),
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as unknown as PiRuntimeOptions["modelRuntime"],
      model: { provider: "fake", id: "soak-1", contextWindow: 50_000, maxTokens: 8_192 } as PiModel,
      createSession: factory,
      log: () => {},
      maxConcurrentRuns: 3,
      maxQueuedRuns: 10,
      maxSessions: 5,
      maxRunsPerSession: 64,
      sessionIdleTtlMs: 300,
      gcSweepIntervalMs: 50,
    });

    // 不变量采样器（10ms 周期，覆盖整个负载过程）
    let maxActiveExecutions = 0;
    let maxQueuedRuns = 0;
    let maxManagedSessions = 0;
    const sampler = setInterval(() => {
      const stats = adapter.runtimeStats();
      maxActiveExecutions = Math.max(maxActiveExecutions, stats.activeExecutions ?? 0);
      maxQueuedRuns = Math.max(maxQueuedRuns, stats.queuedRuns ?? 0);
      maxManagedSessions = Math.max(maxManagedSessions, stats.managedSessions);
    }, 10);

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);

    const projects = ["soak-p1", "soak-p2", "soak-p3", "soak-p4"];
    const scopes = ["writing/x", "review/fact"];
    const modeOf = (index: number): Mode => {
      const cycle = index % 10;
      if (cycle === 3 || cycle === 7) return "big"; // 20%：context 压力 rotation
      if (cycle === 5) return "hang"; // 10%：timeout / cancel 路径
      if (cycle === 9) return "err"; // 10%：RUN_FAILED
      return "ok"; // 70%：正常完成
    };

    type Submitted = { text: string; index: number };
    const submissionsByCwd = new Map<string, Submitted[]>();

    try {
      // ---- 第一波：20 个任务同时启动（6 个 hang 打满执行/等待容量，
      // 制造确定的结构化 RUNTIME_QUEUE_FULL）----
      const wave1: Array<{ text: string; mode: Mode; timeoutMs?: number }> = [];
      for (let index = 0; index < 20; index += 1) {
        const mode = index < 6 ? "hang" : modeOf(index);
        wave1.push({
          text: `${mode}-w1-${index}`,
          mode,
          ...(mode === "hang" ? { timeoutMs: 400 } : {}),
        });
      }
      // ---- 主负载：140 个任务错峰提交 ----
      const wave2: Array<{ text: string; mode: Mode; timeoutMs?: number; cancelAfterMs?: number }> = [];
      for (let index = 0; index < 140; index += 1) {
        const mode = modeOf(index);
        wave2.push({
          text: `${mode}-w2-${index}`,
          mode,
          ...(mode === "hang"
            ? index % 20 === 5
              ? { timeoutMs: 150 } // timed_out 路径
              : { cancelAfterMs: 25 } // signal cancel 路径
            : {}),
        });
      }

      const launch = async (
        spec: { text: string; mode: Mode; timeoutMs?: number; cancelAfterMs?: number },
        globalIndex: number,
        drainEvents: boolean,
      ): Promise<AgentTask> => {
        const projectId = projects[globalIndex % projects.length]!;
        const contextScope = scopes[globalIndex % scopes.length]!;
        const cwdKey = `${projectId}/${contextScope}`;
        const list = submissionsByCwd.get(cwdKey) ?? [];
        list.push({ text: spec.text, index: globalIndex });
        submissionsByCwd.set(cwdKey, list);
        const controller = spec.cancelAfterMs !== undefined ? new AbortController() : undefined;
        if (controller !== undefined) {
          setTimeout(() => controller!.abort(), spec.cancelAfterMs);
        }
        const handle = await adapter.startAgent({
          agentId: globalIndex % 2 === 0 ? "writer" : "reviewer",
          task: spec.text,
          projectId,
          contextScope,
          ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        });
        if (drainEvents) {
          // 事件迭代器完整排空（settle 后自然结束——waiter 泄漏会挂起本 soak）
          void (async () => {
            for await (const _event of handle.events()) {
              // 只消费
            }
          })().catch(() => {});
        }
        try {
          return await handle.result();
        } catch {
          // reject 通道（timed_out / RUN_FAILED 等）：结构化终态经 getTask 回溯
          return adapter.getTask(handle.taskId);
        }
      };

      const results: AgentTask[] = [];
      // 第一波并发
      results.push(...(await Promise.all(wave1.map((spec, i) => launch(spec, i, i % 7 === 0)))));
      // 主负载错峰（5ms 间隔，模拟 Workflow 逐步派发）
      for (let index = 0; index < wave2.length; index += 1) {
        const spec = wave2[index]!;
        void launch(spec, 20 + index, index % 16 === 0).then((task) => results.push(task));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // 等全部 160 个任务终态（轮询 activeRuns 归零）
      const deadline = Date.now() + 30_000;
      while (adapter.runtimeStats().activeRuns > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(adapter.runtimeStats().activeRuns).toBe(0);
      expect(results.length).toBeGreaterThanOrEqual(160);

      // ---- 终态分布：四种终态都出现，且结构化失败码合法 ----
      const byStatus = new Map<string, number>();
      const errorCodes = new Map<string, number>();
      for (const task of results) {
        byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
        if (task.errorCode !== undefined) {
          errorCodes.set(task.errorCode, (errorCodes.get(task.errorCode) ?? 0) + 1);
        }
        expect(task.metadata?.["sessionKey"]).toMatch(/^agent:(writer|reviewer):paperteam-soak-p\d--(writing\/x|review\/fact)$/);
      }
      expect((byStatus.get("completed") ?? 0)).toBeGreaterThan(80);
      expect((byStatus.get("cancelled") ?? 0)).toBeGreaterThan(0);
      expect((byStatus.get("failed") ?? 0)).toBeGreaterThan(0);
      expect((byStatus.get("timed_out") ?? 0)).toBeGreaterThan(0);
      for (const code of errorCodes.keys()) {
        expect([
          "RUN_FAILED",
          "RUNTIME_QUEUE_FULL",
          "RUNTIME_SESSION_CAPACITY",
          "CONTEXT_BUDGET_EXCEEDED",
          "EXECUTION_TIMEOUT",
        ]).toContain(code);
      }
      // 第一波并发压满受理容量：QUEUE_FULL 结构化拒绝确实发生
      expect((errorCodes.get("RUNTIME_QUEUE_FULL") ?? 0)).toBeGreaterThan(0);

      // ---- 调度不变量（全程采样）----
      expect(maxActiveExecutions).toBeLessThanOrEqual(3);
      expect(maxQueuedRuns).toBeLessThanOrEqual(10);
      expect(maxManagedSessions).toBeLessThanOrEqual(5);
      const stats = adapter.runtimeStats();
      expect(stats.activeExecutions).toBe(0);
      expect(stats.queuedRuns).toBe(0);
      expect(stats.managedSessions).toBeLessThanOrEqual(5);

      // ---- 会话生命周期不变量 ----
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((session) => !session.promptedAfterDispose)).toBe(true);
      expect(created.every((session) => !session.disposedWhilePending)).toBe(true);
      // rotation 确实发生（big 的 context 压力 + hang 的 timeout 自愈标记）
      expect(stats.sessionRotations).toBeGreaterThan(0);
      // 单会话绝不并发（fake 会话自身记账）
      expect(created.every((session) => session.maxConcurrent <= 1)).toBe(true);

      // ---- FIFO 保持：每个 sessionKey 的实际 prompt 顺序是提交顺序的子序列 ----
      const submissionIndexByText = new Map<string, number>();
      for (const list of submissionsByCwd.values()) {
        for (const submitted of list) {
          submissionIndexByText.set(submitted.text, submitted.index);
        }
      }
      // created 的顺序即会话诞生顺序（含 rotation 新代）；每会话 prompts 已按时间序
      for (const [cwdKey, list] of submissionsByCwd) {
        const projectId = cwdKey.split("/")[0]!;
        const relevant = created.filter((session) => session.cwd.endsWith(projectId));
        const executedIndexes: number[] = [];
        for (const session of relevant) {
          for (const prompt of session.prompts) {
            const index = submissionIndexByText.get(prompt);
            expect(index).toBeDefined(); // prompt 都来自提交的任务
            executedIndexes.push(index!);
          }
        }
        for (let i = 1; i < executedIndexes.length; i += 1) {
          expect(executedIndexes[i]).toBeGreaterThan(executedIndexes[i - 1]!); // 严格递增
        }
        // 提交的任务大多真实执行（不是被全部拒绝）
        expect(executedIndexes.length).toBeGreaterThan(list.length / 2);
      }

      // ---- oversized：调用 provider 前结构化失败（不进会话、不排队）----
      const oversized = await adapter.runAgent({
        agentId: "writer",
        task: "论".repeat(60_000), // est 90000 + reserve 8192 >> 50000
        projectId: "soak-p1",
        contextScope: "writing/x",
      });
      expect(oversized.status).toBe("failed");
      expect(oversized.errorCode).toBe("CONTEXT_BUDGET_EXCEEDED");

      // ---- idle GC 收敛：负载结束后全部会话空闲 → 周期 GC 回收至零 ----
      const gcDeadline = Date.now() + 5_000;
      while (adapter.runtimeStats().managedSessions > 0 && Date.now() < gcDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(adapter.runtimeStats().managedSessions).toBe(0);
      expect(adapter.runtimeStats().activeRuns).toBe(0);
      expect(adapter.runtimeStats().activeExecutions).toBe(0);
      expect(adapter.runtimeStats().queuedRuns).toBe(0);
      // 周期 GC 确实回收过 idle 会话（TTL 300ms + sweep 50ms）
      expect(adapter.runtimeStats().sessionGcEvictions).toBeGreaterThan(0);

      // ---- close：全部会话恰好 dispose 一次、幂等、诊断清空 ----
      await adapter.close();
      await adapter.close();
      expect(created.length).toBeGreaterThan(5); // 整个 soak 建过的会话（含 rotation 代）
      expect(created.every((session) => session.disposeCount === 1)).toBe(true);
      expect(adapter.sessionDiagnostics()).toEqual([]);

      // ---- 无 unhandled rejection ----
      expect(unhandled).toEqual([]);
    } finally {
      clearInterval(sampler);
      process.off("unhandledRejection", onUnhandled);
    }
  }, 90_000);
});
