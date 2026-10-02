/**
 * M10.4.4 First-Activity Watchdog 确定性测试（fake AgentSession，无真实 provider）：
 *
 * A. provider 永不产生事件 → 阈值后 abort → timed_out(FIRST_ACTIVITY_TIMEOUT)，
 *    不白等 executionTimeoutMs
 * B. message_start（assistant）先到 → watchdog 解除 → 长生成不被误杀
 * C. reasoning delta（message_update，无正文 token）也是有效活动 → 不误杀；
 *    user prompt 回声（本地事件）不算活动
 * D. 边界：活动先于 watchdog 到达（但晚于 prompt 开始）→ timer 回调置位检查
 *    生效，不 abort、无双终态
 * E. 用户 cancel 与 watchdog 竞态：first-wins，只有一个终态
 * F. Runtime close：在途 run 的 watchdog 定时器随 cancel/settle 清理，close 收敛
 * G. watchdog 超时后同一 Adapter 的下一次 run（会话 self-healing 重建）正常完成
 * H. 既有 execution 超时语义不回归（execution 更短 → EXECUTION_TIMEOUT 归因）
 *
 * 观测面：completed 任务 metadata.firstActivityMs 记录 prompt → 首活动时长；
 * timed_out 终态 errorCode=FIRST_ACTIVITY_TIMEOUT + timeoutPhase=first_activity。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** fake AgentSession 行为计划 */
interface FakeSessionPlan {
  /** prompt 后注入的（provider）事件；缺省 = 0 事件（挂起） */
  events?: Array<(emit: (event: unknown) => void) => void>;
  /** 事件注入延迟（毫秒；缺省 prompt 开始即注入） */
  eventsAfterMs?: number;
  /** 事件注入后 prompt 正常收敛延迟（毫秒）；未设置则挂起直到 abort */
  settleAfterMs?: number;
}

interface FakeSessionControl {
  promptSettled: boolean;
  aborted: boolean;
}

function fakeSessionFactory(plan: FakeSessionPlan): { factory: () => Promise<never>; control: FakeSessionControl } {
  const control: FakeSessionControl = { promptSettled: false, aborted: false };
  const factory = async () => {
    let listener: ((event: unknown) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const session = {
      prompt: async () => {
        const emit = (event: unknown) => listener?.(event);
        const inject = () => {
          for (const entry of plan.events ?? []) {
            entry(emit);
          }
          if (plan.settleAfterMs !== undefined) {
            settleTimer = setTimeout(() => resolvePrompt?.(), plan.settleAfterMs);
          }
        };
        if ((plan.events ?? []).length > 0 && (plan.eventsAfterMs ?? 0) > 0) {
          eventTimer = setTimeout(inject, plan.eventsAfterMs);
        } else if ((plan.events ?? []).length > 0) {
          inject();
        }
        // 0 事件：纯挂起（settleAfterMs 不适用——测的就是无 activity）
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        control.promptSettled = true;
      },
      abort: async () => {
        control.aborted = true;
        clearTimeout(settleTimer);
        clearTimeout(eventTimer);
        resolvePrompt?.();
      },
      waitForIdle: async () => {},
      dispose: () => {},
      subscribe: (fn: (event: unknown) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      getLastAssistantText: () => "ok",
      agent: {
        // abort 后终态如实镜像真实 Pi（stopReason="aborted"），供 adapter 归因
        get state() {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                stopReason: control.aborted ? "aborted" : "end_turn",
              },
            ],
          };
        },
      },
    };
    return session as never;
  };
  return { factory, control };
}

type SessionFactory = () => Promise<never>;

async function newAdapter(
  factory: SessionFactory,
  firstActivityTimeoutMs: number,
  executionTimeoutMs = 10_000,
): Promise<PiRuntimeAdapter> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-fa-agent-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-fa-ws-"));
  dirs.push(agentDir, workspaceRoot);
  return new PiRuntimeAdapter({
    agentDir,
    workspaceRoot,
    firstActivityTimeoutMs,
    executionTimeoutMs,
    modelRuntime: {
      getModel: () => ({ provider: "fake", id: "fake-1" }),
      hasConfiguredAuth: () => true,
      getError: () => undefined,
    } as never,
    model: { provider: "fake", id: "fake-1" } as never,
    createSession: factory as never,
    log: () => {},
  });
}

function assistantStart(emit: (event: unknown) => void): void {
  emit({ type: "message_start", message: { role: "assistant" } });
}

function reasoningDelta(emit: (event: unknown) => void): void {
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "思考" },
    message: { role: "assistant" },
  });
}

function userEcho(emit: (event: unknown) => void): void {
  emit({ type: "message_start", message: { role: "user" } });
  emit({ type: "message_end", message: { role: "user" } });
}

describe("First-Activity Watchdog（M10.4.4，deterministic fake）", () => {
  it("A：provider 永不产生事件 → 阈值后 timed_out(FIRST_ACTIVITY_TIMEOUT)，不白等 execution 超时", async () => {
    const { factory } = fakeSessionFactory({});
    const adapter = await newAdapter(factory, 60);
    try {
      const startedAt = Date.now();
      await expect(
        adapter.runAgent({ agentId: "writer", task: "hang", contextScope: "writing/sections" }),
      ).rejects.toMatchObject({ code: "AGENT_TIMEOUT", phase: "first_activity" });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(5_000); // 远小于 executionTimeoutMs=10s
    } finally {
      await adapter.close();
    }
  });

  it("A+：结构化终态可回溯（errorCode=FIRST_ACTIVITY_TIMEOUT + timeoutPhase）", async () => {
    const { factory } = fakeSessionFactory({});
    const adapter = await newAdapter(factory, 60);
    try {
      const handle = await adapter.startAgent({
        agentId: "writer",
        task: "hang",
        contextScope: "writing/sections",
      });
      await expect(handle.result()).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
      const record = await adapter.getTask(handle.taskId);
      expect(record.status).toBe("timed_out");
      expect(record.errorCode).toBe("FIRST_ACTIVITY_TIMEOUT");
      expect(record.timeoutPhase).toBe("first_activity");
    } finally {
      await adapter.close();
    }
  });

  it("B：message_start（assistant）先到 → watchdog 解除 → 长生成不被误杀", async () => {
    const { factory } = fakeSessionFactory({ events: [assistantStart], settleAfterMs: 300 });
    const adapter = await newAdapter(factory, 60);
    try {
      const task = await adapter.runAgent({
        agentId: "writer",
        task: "long-gen",
        contextScope: "writing/sections",
      });
      expect(task.status).toBe("completed");
      expect(task.output).toBe("ok");
      expect(task.metadata?.["firstActivityMs"]).toBeDefined();
      expect(task.metadata?.["firstActivityMs"] as number).toBeLessThan(200);
    } finally {
      await adapter.close();
    }
  });

  it("C：reasoning delta（无正文 token）是有效活动 → 不误杀", async () => {
    const { factory } = fakeSessionFactory({ events: [reasoningDelta], settleAfterMs: 250 });
    const adapter = await newAdapter(factory, 60);
    try {
      const task = await adapter.runAgent({ agentId: "reviewer", task: "reasoning", contextScope: "review/fact" });
      expect(task.status).toBe("completed");
    } finally {
      await adapter.close();
    }
  });

  it("C2：user prompt 回声（本地事件）不算 provider 活动 → 仍按 first_activity 超时", async () => {
    const { factory } = fakeSessionFactory({ events: [userEcho] });
    const adapter = await newAdapter(factory, 60);
    try {
      await expect(
        adapter.runAgent({ agentId: "writer", task: "echo-only", contextScope: "writing/sections" }),
      ).rejects.toMatchObject({ phase: "first_activity" });
    } finally {
      await adapter.close();
    }
  });

  it("D：活动晚于 prompt 但早于 watchdog 到达 → timer 回调置位检查生效（不 abort、无双终态）", async () => {
    // watchdog 90ms；活动 40ms 注入；生成持续到 250ms 才收敛——watchdog 在
    // 活动之后触发，必须因 sawProviderActivity=true 而不动作
    const { factory } = fakeSessionFactory({ events: [assistantStart], eventsAfterMs: 40, settleAfterMs: 210 });
    const adapter = await newAdapter(factory, 90);
    try {
      const task = await adapter.runAgent({
        agentId: "writer",
        task: "boundary",
        contextScope: "writing/sections",
      });
      expect(task.status).toBe("completed");
    } finally {
      await adapter.close();
    }
  });

  it("E：cancel 与 watchdog 竞态 first-wins——cancel 先到 → cancelled；watchdog 先到 → 迟到 cancel 不改终态", async () => {
    // E1：cancel 25ms < watchdog 60ms
    const first = fakeSessionFactory({});
    const adapter = await newAdapter(first.factory, 60);
    try {
      const controller = new AbortController();
      const pending = adapter.runAgent({
        agentId: "writer",
        task: "cancel-first",
        contextScope: "writing/sections",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);
      const task = await pending;
      expect(task.status).toBe("cancelled");
    } finally {
      await adapter.close();
    }

    // E2：watchdog 30ms 先 abort；cancel 120ms 迟到 → timed_out(first_activity)
    const second = fakeSessionFactory({});
    const adapter2 = await newAdapter(second.factory, 30);
    try {
      const controller = new AbortController();
      const pending = adapter2.runAgent({
        agentId: "writer",
        task: "timeout-first",
        contextScope: "writing/sections",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 120);
      await expect(pending).rejects.toMatchObject({ phase: "first_activity" });
    } finally {
      await adapter2.close();
    }
  });

  it("F：Runtime close 在途清理——close 后 watchdog 定时器不遗留，run 收敛", async () => {
    const { factory, control } = fakeSessionFactory({});
    const adapter = await newAdapter(factory, 5_000); // 长 watchdog：靠 close 收敛
    try {
      const handle = await adapter.startAgent({
        agentId: "writer",
        task: "close-cleanup",
        contextScope: "writing/sections",
      });
      await new Promise((resolve) => setTimeout(resolve, 30)); // watchdog 已武装
      await adapter.close();
      const task = await handle.result();
      expect(["cancelled", "timed_out"]).toContain(task.status);
      expect(control.promptSettled).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("G：watchdog 超时后同一 Adapter 下一次 run 正常完成（self-healing 重建会话）", async () => {
    const bad = fakeSessionFactory({});
    const good = fakeSessionFactory({ events: [assistantStart], settleAfterMs: 10 });
    let call = 0;
    const switchingFactory: SessionFactory = async () => {
      call += 1;
      return call === 1 ? bad.factory() : good.factory();
    };
    const adapter = await newAdapter(switchingFactory, 50);
    try {
      await expect(
        adapter.runAgent({ agentId: "writer", task: "first", contextScope: "writing/sections" }),
      ).rejects.toMatchObject({ phase: "first_activity" });
      const task = await adapter.runAgent({ agentId: "writer", task: "second", contextScope: "writing/sections" });
      expect(task.status).toBe("completed");
    } finally {
      await adapter.close();
    }
  });

  it("H：execution 超时语义不回归——execution 更短时 0 活动按 EXECUTION_TIMEOUT 归因", async () => {
    const { factory } = fakeSessionFactory({});
    const adapter = await newAdapter(factory, 60, 40); // execution 40ms < watchdog 60ms
    try {
      await expect(
        adapter.runAgent({ agentId: "writer", task: "exec-timeout", contextScope: "writing/sections" }),
      ).rejects.toMatchObject({ phase: "execution" });
    } finally {
      await adapter.close();
    }
  });

  it("配置：0 = 关闭 watchdog；非法值构造期拒绝", async () => {
    const { factory } = fakeSessionFactory({});
    const adapter = await newAdapter(factory, 0, 80);
    try {
      await expect(
        adapter.runAgent({ agentId: "writer", task: "disabled", contextScope: "writing/sections" }),
      ).rejects.toMatchObject({ phase: "execution" });
    } finally {
      await adapter.close();
    }
    const agentDir = await mkdtemp(join(tmpdir(), "pi-fa-invalid-"));
    dirs.push(agentDir);
    expect(
      () =>
        new PiRuntimeAdapter({
          agentDir,
          workspaceRoot: agentDir,
          firstActivityTimeoutMs: -1,
          modelRuntime: {} as never,
          model: {} as never,
          createSession: factory as never,
          log: () => {},
        }),
    ).toThrow(RangeError);
  });
});
