/**
 * M14.9.1 C1：任务级（跨 run / 跨进程）模型预算账本。
 *
 * 失败形态（M14.9 真实返修）：3 个 improvement run 各自受 per-run 上限约束，外层任务
 * 合计 154 次（建议 110）——per-run 账本天然无法约束跨 run 合计。本文件先用 per-run
 * 上限复现「合计越过任务预算」，再证明任务级账本在**启动前**拒绝第 N+1 次请求、
 * 持久化 BUDGET_EXHAUSTED、让 planner 的预算信号转为耗尽（走既有 Draft 降级）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { runInTraceScope } from "../../src/observability/trace.js";
import { GlobalBudgetLedger, estimatePromptTokens } from "../../src/runtime/globalBudgetLedger.js";
import { budgetExhausted, RunBudgetLedgerRuntime } from "../../src/runtime/runBudget.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-task-budget-"));
  dirs.push(dir);
  return dir;
}

function fakeRuntime(options: { usage?: Partial<NonNullable<AgentTask["usage"]>>; fail?: boolean; gate?: Promise<void> } = {}) {
  const calls: RunAgentInput[] = [];
  const task = (input: RunAgentInput): AgentTask => {
    const now = new Date().toISOString();
    return {
      taskId: `t-${calls.length}`, agentId: input.agentId, status: "completed", createdAt: now, updatedAt: now, output: "{}", events: [],
      ...(options.usage !== undefined ? { usage: { assistantTurns: 1, ...options.usage } } : {}),
    } as AgentTask;
  };
  const runtime = {
    provider: "fake", resolvedModel: "fake/model",
    runAgent: async (input: RunAgentInput) => {
      calls.push(input);
      if (options.gate !== undefined) await options.gate;
      if (options.fail === true) throw new Error("network down");
      return task(input);
    },
    startAgent: async (input: RunAgentInput) => {
      calls.push(input);
      return { taskId: `t-${calls.length}`, result: async () => task(input), cancel: async () => undefined };
    },
    getTask: async () => { throw new Error("unused"); },
    healthCheck: async () => ({ ok: true, status: "ok", detail: "" }),
    close: async () => undefined,
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

function scope(projectId: string, runId: string) {
  return { projectId, runId, stageId: "review.run", attempt: 1, stageSpanId: null };
}

describe("任务级预算账本（跨 run 硬上限）", () => {
  it("失败前重现：只有 per-run 上限时，两个 run 合计越过任务预算（3+3=6 > 4）", async () => {
    const root = await tempDir();
    const { runtime: inner, calls } = fakeRuntime();
    const runtime = new RunBudgetLedgerRuntime({ runtime: inner, limits: { maxModelCallsPerRun: 3, maxRunTokensPerRun: 0 }, resolveLedgerDir: () => root });
    for (const runId of ["w-run-1", "w-run-2"]) {
      for (let index = 0; index < 3; index += 1) {
        await runInTraceScope(scope("p-1", runId), () => runtime.runAgent({ agentId: "reviewer", task: "x", projectId: "p-1" }));
      }
    }
    // 每个 run 都守住了自己的 3 次，但外层任务合计 6 次——per-run 账本无法表达「任务预算 4」
    expect(calls.length).toBe(6);
  });

  it("修复后：任务级上限 4 → 第 5 次请求启动前被拒（inner 不被调用），BUDGET_EXHAUSTED 持久化，planner 视为耗尽", async () => {
    const root = await tempDir();
    const ledgerPath = join(root, "task-ledger.json");
    const ledger = new GlobalBudgetLedger({ path: ledgerPath, limits: { maxCalls: 4, maxTokens: 0 }, label: "test" });
    const { runtime: inner, calls } = fakeRuntime({ usage: { inputTokens: 10, outputTokens: 5 } });
    const runtime = new RunBudgetLedgerRuntime({
      runtime: inner, limits: { maxModelCallsPerRun: 3, maxRunTokensPerRun: 0 }, resolveLedgerDir: () => root,
      global: { ledger, outputReserveTokens: 0 },
    });
    const call = (runId: string) => runInTraceScope(scope("p-1", runId), () => runtime.runAgent({ agentId: "reviewer", task: "x", projectId: "p-1" }));
    await call("w-run-1");
    await call("w-run-1");
    await call("w-run-1");
    await call("w-run-2");
    await expect(call("w-run-2")).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    expect(calls.length).toBe(4);
    const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(persisted.status).toBe("BUDGET_EXHAUSTED");
    expect(persisted.totals.calls).toBe(4);
    expect(persisted.totals.inputTokens + persisted.totals.outputTokens).toBe(60);
    expect(persisted.stops.length).toBe(1);
    // run 级账本没有为被拒请求多记一次（run-2 只有 1 次真实调用）
    expect((await runtime.snapshot("p-1", "w-run-2")).calls).toBe(1);
    // planner 优雅降级信号：新 run 也立即视为耗尽（不会自动开启新的恢复 run 去烧预算）
    const fresh = runtime.snapshotSync("p-2", "w-run-3");
    expect(fresh).not.toBeNull();
    expect(budgetExhausted(fresh!)).toBe(true);
    expect(fresh!.exceededReason).toContain("任务级预算");
  });

  it("scope 外（脚本 / API 直连）请求同样计入任务账本；失败请求记 1 次调用、0 token", async () => {
    const root = await tempDir();
    const ledger = new GlobalBudgetLedger({ path: join(root, "l.json"), limits: { maxCalls: 2, maxTokens: 0 } });
    const failing = fakeRuntime({ fail: true });
    const runtime = new RunBudgetLedgerRuntime({ runtime: failing.runtime, limits: { maxModelCallsPerRun: 0, maxRunTokensPerRun: 0 }, resolveLedgerDir: () => root, global: { ledger, outputReserveTokens: 0 } });
    await expect(runtime.runAgent({ agentId: "reviewer", task: "x" })).rejects.toThrow("network down");
    const file = ledger.read();
    expect(file.totals.calls).toBe(1);
    expect(file.calls[0]!.status).toBe("failed_no_usage");
    await expect(runtime.runAgent({ agentId: "reviewer", task: "x" })).rejects.toThrow("network down");
    await expect(runtime.runAgent({ agentId: "reviewer", task: "x" })).rejects.toBeInstanceOf(BusinessError);
    expect(failing.calls.length).toBe(2);
  });

  it("token 预留：在途请求的预留计入，超出即拒绝；结算后按真实 usage 释放", async () => {
    const root = await tempDir();
    const ledger = new GlobalBudgetLedger({ path: join(root, "l.json"), limits: { maxCalls: 0, maxTokens: 1_000 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runtime: inner, calls } = fakeRuntime({ usage: { inputTokens: 200, outputTokens: 100, cacheWriteTokens: 0 }, gate });
    const runtime = new RunBudgetLedgerRuntime({ runtime: inner, limits: { maxModelCallsPerRun: 0, maxRunTokensPerRun: 0 }, resolveLedgerDir: () => root, global: { ledger, outputReserveTokens: 590 } });
    const first = runtime.runAgent({ agentId: "reviewer", task: "short" });
    // 在途预留 ≈ 590+估算 > 1000 的一半：第二个并发请求预留后会越线 → 启动前拒绝
    await expect(runtime.runAgent({ agentId: "reviewer", task: "short" })).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    release();
    await first;
    expect(calls.length).toBe(1);
    const snapshot = ledger.snapshot();
    expect(snapshot.tokens).toBe(300);
    expect(snapshot.reservedTokens).toBe(0);
    // 被拒请求让账本进入 BUDGET_EXHAUSTED：之后一律拒绝（「达到即停」，不因结算后有余量而自动恢复）
    expect(snapshot.status).toBe("BUDGET_EXHAUSTED");
    await expect(runtime.runAgent({ agentId: "reviewer", task: "short" })).rejects.toBeInstanceOf(BusinessError);
  });

  it("账本跨进程 / 重启不重置；上限只能收紧不能放宽", async () => {
    const root = await tempDir();
    const path = join(root, "l.json");
    const first = new GlobalBudgetLedger({ path, limits: { maxCalls: 3, maxTokens: 0 } });
    const id = first.reserve({ label: "a", estimatedTokens: 0 });
    first.settle(id, { inputTokens: 1 });
    const reopened = new GlobalBudgetLedger({ path, limits: { maxCalls: 100, maxTokens: 0 } });
    expect(reopened.read().limits.maxCalls).toBe(3);
    expect(reopened.read().totals.calls).toBe(1);
    reopened.reserve({ label: "b", estimatedTokens: 0 });
    reopened.reserve({ label: "c", estimatedTokens: 0 });
    expect(() => reopened.reserve({ label: "d", estimatedTokens: 0 })).toThrow(BusinessError);
    expect(reopened.read().status).toBe("BUDGET_EXHAUSTED");
  });

  it("prompt 预估偏保守（CJK 每字 ≥1 token）", () => {
    expect(estimatePromptTokens("多目标跟踪".repeat(100))).toBeGreaterThanOrEqual(500);
    expect(estimatePromptTokens("a".repeat(1000))).toBeGreaterThanOrEqual(400);
  });
});
