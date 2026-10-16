/**
 * M14.4 P0-3 集成：run 级模型预算账本（RunBudgetLedgerRuntime）。
 *
 * 场景 F（预算耗尽）的确定性回放：
 *  - ALS trace scope（stage 上下文）内的调用按 run 归因计数；
 *  - 达到上限后 startAgent/runAgent 启动前抛 MODEL_BUDGET_EXCEEDED（不启动新任务）；
 *  - scope 外（API 直连 / 诊断）只透传不计预算；
 *  - 账本落盘 research/model-ledger.json——新实例（进程重启）不重置计数器；
 *  - token 预算与调用数预算同一账本。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { runInTraceScope } from "../../src/observability/trace.js";
import { RunBudgetLedgerRuntime } from "../../src/runtime/runBudget.js";
import { BusinessError } from "../../src/errors.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function fakeTask(usage?: Partial<{ inputTokens: number; outputTokens: number; cacheWriteTokens: number }>) {
  const now = new Date().toISOString();
  return {
    taskId: `t-${Math.random().toString(36).slice(2)}`, agentId: "writer", status: "completed" as const,
    createdAt: now, updatedAt: now, output: "ok", events: [],
    ...(usage !== undefined ? { usage: { assistantTurns: 1, ...usage } } : {}),
  };
}

describe("RunBudgetLedgerRuntime（run 级模型预算硬约束）", () => {
  it("场景 F：达到调用上限后不再启动新模型任务；scope 外调用不消耗预算；重启不重置计数", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack({ ...scripted.runtime, runAgent: async () => fakeTask() as never }, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      runBudget: { maxModelCallsPerRun: 2, maxRunTokensPerRun: 0 },
    });
    const projectId = (await stack.store.create("Budget fixture", { language: "zh" })).id;
    const runtime = stack.stack.runtime as RunBudgetLedgerRuntime;
    const runId = "w-budget-test";
    const scope = { projectId, runId, stageId: "writing.sections", attempt: 1, stageSpanId: null };
    const call = () => runtime.runAgent({ agentId: "writer", task: "x", projectId });

    // 前两次调用放行并计数
    await runInTraceScope(scope, call);
    await runInTraceScope(scope, call);
    let snapshot = await runtime.snapshot(projectId, runId);
    expect(snapshot.calls).toBe(2);
    expect(budgetStopped(runtime, projectId, runId)).toBe(true);

    // 第三次（上限 2）→ 启动前拒绝
    await expect(runInTraceScope(scope, call)).rejects.toBeInstanceOf(BusinessError);
    await expect(runInTraceScope(scope, call)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });

    // scope 外（无 stage 上下文）→ 透传不计预算
    await runtime.runAgent({ agentId: "writer", task: "adhoc", projectId });
    expect((await runtime.snapshot(projectId, runId)).calls).toBe(2);

    // 账本持久化：新实例（模拟进程重启）沿用计数器
    const ledgerFile = await readFile(join(stack.store.researchDir(projectId), "model-ledger.json"), "utf8");
    const parsed = JSON.parse(ledgerFile) as { entries: Record<string, { calls: number }> };
    expect(parsed.entries[runId]?.calls).toBe(2);
    const revived = new RunBudgetLedgerRuntime({
      runtime: { ...scripted.runtime, runAgent: async () => fakeTask() as never } as never,
      limits: { maxModelCallsPerRun: 2, maxRunTokensPerRun: 0 },
      resolveLedgerDir: (id) => stack.store.researchDir(id),
    });
    await expect(revived.runAgent({ agentId: "writer", task: "x", projectId }).then(() => "ok")).resolves.toBe("ok"); // 先触发账本加载
    const revivedScope = { projectId, runId, stageId: "review.run", attempt: 1, stageSpanId: null };
    await expect(runInTraceScope(revivedScope, () => revived.runAgent({ agentId: "writer", task: "x", projectId })))
      .rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
  });

  it("token 预算：settle 的 usage 累计入账，超过上限后拒绝新调用", async () => {
    const scripted = scriptedIdeaRuntime();
    let n = 0;
    const stack = await startTestStack({
      ...scripted.runtime,
      runAgent: async () => {
        n += 1;
        return fakeTask({ inputTokens: 600, outputTokens: 100, cacheWriteTokens: 0 }) as never;
      },
    }, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      runBudget: { maxModelCallsPerRun: 0, maxRunTokensPerRun: 1_000 },
    });
    const projectId = (await stack.store.create("Budget token fixture", { language: "zh" })).id;
    const runtime = stack.stack.runtime as RunBudgetLedgerRuntime;
    const runId = "w-budget-token";
    const scope = { projectId, runId, stageId: "review.run", attempt: 1, stageSpanId: null };
    const call = () => runtime.runAgent({ agentId: "writer", task: "x", projectId });
    await runInTraceScope(scope, call); // 700 tokens
    await runInTraceScope(scope, call); // 1400 > 1000 → 第三次拒绝
    await expect(runInTraceScope(scope, call)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    const snapshot = await runtime.snapshot(projectId, runId);
    expect(snapshot.tokens).toBe(1_400);
    expect(snapshot.calls).toBe(2);
    expect(n).toBe(2);
  });
});

function budgetStopped(runtime: RunBudgetLedgerRuntime, projectId: string, runId: string): boolean {
  const snapshot = runtime.snapshotSync(projectId, runId);
  if (snapshot === null) throw new Error("快照应已缓存");
  return snapshot.calls >= snapshot.limits.maxModelCallsPerRun;
}
