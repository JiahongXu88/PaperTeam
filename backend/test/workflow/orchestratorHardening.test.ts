/**
 * WorkflowOrchestrator 加固回归：
 * - stage 收到 abort 后以异常收尾（生产 stage 的真实行为：抛 WORKFLOW_CANCELLED）→ 终态必须是 cancelled，不是 failed
 * - stage 超时 → 在途 stage 的 signal 被 abort（否则重试会与它并发）
 * - 同项目并发 createRun → 只允许一个成功
 * - 事件日志追加失败不会让后续 emit 永久失败（链不被"污染"）
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BusinessError, type StageFailureCategory } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import type { StageSpec, WorkflowDefinition, WorkflowState } from "../../src/workflow/types.js";

const tempRoots: string[] = [];
const orchestrators: WorkflowOrchestrator[] = [];

afterAll(async () => {
  await Promise.all([
    ...orchestrators.map((orchestrator) => orchestrator.close()),
    ...tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function createHarness(definition: WorkflowDefinition, runStore?: (store: ProjectStore) => WorkflowRunStore) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-wf-hardening-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("加固测试项目");
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: runStore !== undefined ? runStore(store) : new WorkflowRunStore(store),
    definitionFactory: () => definition,
    retryDelayMs: 0,
    log: () => {},
  });
  orchestrators.push(orchestrator);
  return { store, projectId: project.id, orchestrator };
}

async function waitForStatus(orchestrator: WorkflowOrchestrator, runId: string, statuses: string[]) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await orchestrator.getRun(runId);
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function singleStageDefinition(stage: StageSpec): WorkflowDefinition {
  return {
    kind: "idea_to_paper",
    description: "单 stage 玩具 workflow",
    stages: [stage],
    plan(state: WorkflowState) {
      return stage.id in state.stageResults
        ? { kind: "complete", label: "draft", summary: {} }
        : { kind: "stage", stageId: stage.id };
    },
    async onInput() {},
  };
}

const RETRYABLE: readonly StageFailureCategory[] = ["transient", "timeout", "runtime_unavailable", "contract_violation"];

describe("WorkflowOrchestrator 加固", () => {
  it("stage 在 abort 后抛 WORKFLOW_CANCELLED → run 终态 cancelled（不是 failed）", async () => {
    let signal: AbortSignal | undefined;
    const definition = singleStageDefinition({
      id: "slow",
      description: "abort 后抛异常的 stage",
      requiredInputs: [],
      producedOutputs: [],
      maxAttempts: 2,
      timeoutMs: 10_000,
      retryable: RETRYABLE,
      async execute(ctx) {
        signal = ctx.signal;
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new BusinessError("WORKFLOW_CANCELLED", "分章节审阅已被取消");
      },
    });
    const harness = await createHarness(definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const deadline = Date.now() + 5_000;
    while (signal === undefined) {
      if (Date.now() > deadline) {
        throw new Error("stage 未开始");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await harness.orchestrator.cancel(run.runId);
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["cancelled", "failed"]);
    expect(finished.status).toBe("cancelled");
    expect(finished.stageHistory.at(-1)?.error?.code).toBe("WORKFLOW_CANCELLED");
  });

  it("stage 超时：在途 stage 的 signal 被 abort，且不与重试并发", async () => {
    const signals: AbortSignal[] = [];
    const definition = singleStageDefinition({
      id: "hang",
      description: "首次挂起、第二次成功",
      requiredInputs: [],
      producedOutputs: [],
      maxAttempts: 2,
      timeoutMs: 60,
      retryable: RETRYABLE,
      async execute(ctx) {
        signals.push(ctx.signal);
        if (ctx.attempt === 1) {
          await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("aborted");
        }
        return { ok: true };
      },
    });
    const harness = await createHarness(definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(finished.stageHistory[0]?.error?.category).toBe("timeout");
  });

  it("同项目并发 createRun：只有一个成功，其余 409", async () => {
    const definition = singleStageDefinition({
      id: "slow",
      description: "慢 stage",
      requiredInputs: [],
      producedOutputs: [],
      maxAttempts: 1,
      timeoutMs: 10_000,
      retryable: [],
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      },
    });
    const harness = await createHarness(definition);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => harness.orchestrator.createRun(harness.projectId, "idea_to_paper")),
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const outcome of rejected) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "WORKFLOW_INVALID_STATE" });
    }
    const runs = await harness.orchestrator.listRuns(harness.projectId);
    expect(runs).toHaveLength(1);
  });

  it("事件日志追加一次失败后，后续 emit 仍正常（链不被污染）且 run 可完成", async () => {
    let failNext = true;
    class FlakyRunStore extends WorkflowRunStore {
      override eventsPath(projectId: string, runId: string): string {
        if (failNext) {
          failNext = false;
          // 父路径是一个普通文件：mkdir/appendFile 必然失败一次（ENOTDIR / EEXIST）
          const blocker = join(this.runDir(projectId, runId), "blocker");
          mkdirSync(this.runDir(projectId, runId), { recursive: true });
          writeFileSync(blocker, "x");
          return join(blocker, "events.jsonl");
        }
        return super.eventsPath(projectId, runId);
      }
    }
    const definition = singleStageDefinition({
      id: "one",
      description: "普通 stage",
      requiredInputs: [],
      producedOutputs: [],
      maxAttempts: 1,
      timeoutMs: 10_000,
      retryable: [],
      async execute() {
        return { ok: true };
      },
    });
    const harness = await createHarness(definition, (store) => new FlakyRunStore(store));
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    // 首个 emit（workflow.started）失败 → run 进入 failed，但 finalize 自身的 emit 必须成功落盘
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["completed", "failed"]);
    expect(["completed", "failed"]).toContain(finished.status);
    // 终态先提交内存、再追加事件：这里等到终态事件真正落盘
    const deadline = Date.now() + 5_000;
    let events = (await harness.orchestrator.readEvents(run.runId)).events;
    while (!events.some((event) => /^workflow\.(completed|failed)$/.test(event.type))) {
      if (Date.now() > deadline) {
        throw new Error(`终态事件未落盘（events=${events.length}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      events = (await harness.orchestrator.readEvents(run.runId)).events;
    }
    expect(events.at(-1)?.type).toMatch(/^workflow\.(completed|failed)$/);
  });
});
