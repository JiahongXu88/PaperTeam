/**
 * WorkflowOrchestrator 引擎单元测试（M3.0）。
 *
 * 使用注入的玩具 WorkflowDefinition 测试引擎纪律本身：
 * 状态转换、StageContract（DoD / requiredInputs）、retry、timeout、
 * checkpoint/resume（含进程重启恢复）、HITL awaiting_input、取消、Domain Event 日志。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { AgentRunFailedError, BusinessError, WorkflowInvalidStateError, type StageFailureCategory } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { appendEventLine, readEventLog } from "../../src/workflow/eventLog.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import type {
  PlanDecision,
  ResumeInput,
  StageSpec,
  WorkflowDefinition,
  WorkflowState,
} from "../../src/workflow/types.js";

const tempRoots: string[] = [];
const orchestrators: WorkflowOrchestrator[] = [];

afterAll(async () => {
  await Promise.all([
    ...orchestrators.map((orchestrator) => orchestrator.close()),
    ...tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

// ---- 测试工具 ----

interface Harness {
  store: ProjectStore;
  projectId: string;
  runStore: WorkflowRunStore;
  orchestrator: WorkflowOrchestrator;
}

async function createHarness(
  definitionFactory: (kind: "idea_to_paper") => WorkflowDefinition,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-wf-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("引擎测试项目");
  const runStore = new WorkflowRunStore(store);
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore,
    definitionFactory: (kind) => definitionFactory(kind as "idea_to_paper"),
    retryDelayMs: 0,
    log: () => {},
  });
  orchestrators.push(orchestrator);
  return { store, projectId: project.id, runStore, orchestrator };
}

async function waitForStatus(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  statuses: string[],
  timeoutMs = 5_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await orchestrator.getRun(runId);
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件满足（或超时抛错）；条件支持异步 */
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时`);
    }
    await delay(10);
  }
}

/** 玩具执行 stage 工厂 */
function stepStage(
  id: string,
  options: {
    result?: Record<string, unknown>;
    execute?: (attempt: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
    maxAttempts?: number;
    timeoutMs?: number;
    retryable?: string[];
    verifyDod?: () => string[] | Promise<string[]>;
    onSignal?: (signal: AbortSignal) => void;
  } = {},
): StageSpec {
  return {
    id,
    description: `玩具 stage ${id}`,
    requiredInputs: [],
    producedOutputs: [id],
    maxAttempts: options.maxAttempts ?? 2,
    timeoutMs: options.timeoutMs ?? 10_000,
    retryable: (options.retryable ?? [
      "transient",
      "timeout",
      "runtime_unavailable",
      "contract_violation",
    ]) as readonly StageFailureCategory[],
    async execute(ctx) {
      options.onSignal?.(ctx.signal);
      if (options.execute) {
        return options.execute(ctx.attempt);
      }
      return options.result ?? { ok: true };
    },
    ...(options.verifyDod ? { verifyDod: async () => options.verifyDod!() } : {}),
  };
}

/** 单一线性 stage 列表的玩具定义 */
function linearDefinition(stageIds: string[], onInput?: (state: WorkflowState, input: ResumeInput) => void): WorkflowDefinition {
  return {
    kind: "idea_to_paper",
    description: "玩具线性 workflow",
    stages: stageIds.map((id) => stepStage(id)),
    plan(state: WorkflowState): PlanDecision {
      const next = stageIds.find((id) => !(id in state.stageResults));
      if (next === undefined) {
        return { kind: "complete", label: "draft", summary: { done: true } };
      }
      return { kind: "stage", stageId: next };
    },
    async onInput(state, stageId, input) {
      onInput?.(state, input);
      if (input.decision !== "approve" && stageId !== "hitl.gate") {
        throw new WorkflowInvalidStateError(state.runId, state.status, `decision=${input.decision}`);
      }
      state.stageResults[stageId] = { decision: input.decision };
    },
  };
}

// ---- 测试 ----

describe("WorkflowOrchestrator：run 创建与状态转换", () => {
  it("createRun 返回 pending 并异步推进到 completed；completedStages 有序", async () => {
    const harness = await createHarness(() => linearDefinition(["alpha", "beta"]));
    const created = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");

    expect(created.runId).toMatch(/^w-[a-z0-9-]+$/);
    expect(["pending", "running"]).toContain(created.status);

    const finished = await waitForStatus(harness.orchestrator, created.runId, ["completed"]);
    expect(finished.completedStages).toEqual(["alpha", "beta"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.stageHistory).toHaveLength(2);
    expect(finished.stageHistory.every((record) => record.status === "completed")).toBe(true);
  });

  it("getRun 读取持久化 run；未知 runId 抛 WORKFLOW_NOT_FOUND", async () => {
    const harness = await createHarness(() => linearDefinition(["only"]));
    await expect(harness.orchestrator.getRun("w-nosuchrun")).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);
    await expect(harness.orchestrator.getRun(run.runId)).resolves.toMatchObject({
      runId: run.runId,
      status: "completed",
    });
  });

  it("同一项目存在进行中 run 时创建新 run 抛 WORKFLOW_INVALID_STATE", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("slow", {
          execute: async () => {
            await gate;
            return { ok: true };
          },
        }),
      ],
      plan: (state) =>
        "slow" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "slow" },
    };
    const harness = await createHarness(() => definition);
    const first = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, first.runId, ["running"]);

    await expect(
      harness.orchestrator.createRun(harness.projectId, "idea_to_paper"),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID_STATE" });

    release?.();
    await waitForStatus(harness.orchestrator, first.runId, ["completed"]);
  });

  it("plan 返回未知 stage：run 失败（INTERNAL_ERROR）", async () => {
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      plan: () => ({ kind: "stage", stageId: "ghost" }),
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["failed"]);
    expect(finished.error?.code).toBe("INTERNAL_ERROR");
  });

  it("requiredInputs 缺失：run 以 STAGE_CONTRACT_VIOLATION 失败", async () => {
    const definition: WorkflowDefinition = {
      kind: "idea_to_paper",
      description: "缺前置输入",
      stages: [{ ...stepStage("second"), requiredInputs: ["first-missing"] }],
      plan: () => ({ kind: "stage", stageId: "second" }),
      async onInput() {
        throw new BusinessError("WORKFLOW_INVALID_STATE", "no hitl");
      },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["failed"]);
    expect(finished.error?.code).toBe("STAGE_CONTRACT_VIOLATION");
    expect(finished.error?.message).toContain("first-missing");
  });
});

describe("WorkflowOrchestrator：StageContract 与重试", () => {
  it("DoD 违规：contract_violation 失败并按 maxAttempts 重试后 run 失败", async () => {
    let attempts = 0;
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("dod", {
          maxAttempts: 3,
          execute: () => {
            attempts += 1;
            return { wrote: true };
          },
          verifyDod: () => ["产出文件不存在"],
        }),
      ],
      plan: (state) =>
        "dod" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "dod" },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["failed"]);

    expect(attempts).toBe(3); // maxAttempts 次尝试后放弃
    expect(finished.error?.message).toContain("DoD");
    expect(finished.stageHistory.filter((r) => r.status === "failed")).toHaveLength(3);
    expect(finished.stageHistory.every((r) => r.error?.category === "contract_violation")).toBe(true);
  });

  it("瞬时失败后重试成功：stageHistory 记录 1 次失败 + 1 次完成", async () => {
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("flaky", {
          execute: (attempt) => {
            if (attempt === 1) {
              throw new AgentRunFailedError("第一次输出无效（模拟）");
            }
            return { recovered: true };
          },
        }),
      ],
      plan: (state) =>
        "flaky" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "flaky" },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["completed"]);

    expect(finished.stageResults["flaky"]).toEqual({ recovered: true });
    expect(finished.stageHistory).toHaveLength(2);
    expect(finished.stageHistory[0]?.status).toBe("failed");
    expect(finished.stageHistory[0]?.error?.category).toBe("transient");
    expect(finished.stageHistory[1]?.status).toBe("completed");
  });

  it("不可重试分类（permanent）：首次失败即终止，不重试", async () => {
    let attempts = 0;
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("permanent", {
          retryable: [],
          execute: () => {
            attempts += 1;
            throw new BusinessError("IMPORT_VALIDATION", "输入非法");
          },
        }),
      ],
      plan: (state) =>
        "permanent" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "permanent" },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["failed"]);
    expect(attempts).toBe(1);
    expect(finished.error?.code).toBe("IMPORT_VALIDATION");
  });

  it("stage 超时：timeout 分类并按重试策略处理", async () => {
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("hangs", {
          maxAttempts: 2,
          timeoutMs: 40,
          execute: async () => {
            await delay(500);
            return { late: true };
          },
        }),
      ],
      plan: (state) =>
        "hangs" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "hangs" },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["failed"], 10_000);

    expect(finished.stageHistory).toHaveLength(2);
    expect(finished.stageHistory.every((r) => r.error?.category === "timeout")).toBe(true);
  }, 15_000);
});

describe("WorkflowOrchestrator：HITL awaiting_input 与 resume", () => {
  function hitlDefinition(): WorkflowDefinition {
    const stages: StageSpec[] = [
      {
        id: "hitl.gate",
        description: "确认后继续",
        requiredInputs: [],
        producedOutputs: ["decision"],
        hitl: {
          prompt: "请确认研究目标",
          options: ["approve", "adjust"],
          payload: async () => ({ feasibility: "MEDIUM" }),
        },
      },
      stepStage("after"),
    ];
    return {
      kind: "idea_to_paper",
      description: "带 HITL 的玩具 workflow",
      stages,
      plan(state) {
        if ("after" in state.stageResults) {
          return { kind: "complete", label: "draft", summary: { done: true } };
        }
        if ("hitl.gate" in state.stageResults) {
          return { kind: "stage", stageId: "after" };
        }
        return { kind: "stage", stageId: "hitl.gate" };
      },
      async onInput(state, stageId, input) {
        if (stageId !== "hitl.gate") {
          throw new WorkflowInvalidStateError(state.runId, state.status, "无待办");
        }
        if (input.decision !== "approve") {
          throw new WorkflowInvalidStateError(state.runId, state.status, `decision=${input.decision}`);
        }
        state.stageResults[stageId] = { decision: input.decision };
      },
    };
  }

  it("进入 awaiting_input（含 payload）；approve 后 resume 并完成", async () => {
    const harness = await createHarness(hitlDefinition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    const awaiting = await waitForStatus(harness.orchestrator, run.runId, ["awaiting_input"]);

    expect(awaiting.awaiting?.stageId).toBe("hitl.gate");
    expect(awaiting.awaiting?.options).toEqual(["approve", "adjust"]);
    expect(awaiting.awaiting?.payload).toEqual({ feasibility: "MEDIUM" });

    const resumed = await harness.orchestrator.resume(run.runId, { decision: "approve" });
    expect(resumed.status).toBe("running");
    const finished = await waitForStatus(harness.orchestrator, run.runId, ["completed"]);
    expect(finished.completedStages).toEqual(["hitl.gate", "after"]);
    expect(finished.inputs["hitl.gate"]?.decision).toBe("approve");

    // 事件异步落盘：轮询等待 workflow.completed 事件出现（内存态先行可见）
    await waitUntil(
      async () =>
        (await harness.orchestrator.readEvents(run.runId)).events.some(
          (event) => event.type === "workflow.completed",
        ),
      5_000,
      "workflow.completed 事件落盘",
    );
    const { events } = await harness.orchestrator.readEvents(run.runId);
    const types = events.map((event) => event.type);
    expect(types).toContain("workflow.awaiting_input");
    expect(types).toContain("workflow.resumed");
    expect(types).toContain("workflow.completed");
  });

  it("非法 decision：resume 抛 WORKFLOW_INVALID_STATE，状态保持 awaiting_input", async () => {
    const harness = await createHarness(hitlDefinition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["awaiting_input"]);

    await expect(
      harness.orchestrator.resume(run.runId, { decision: "nonsense" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID_STATE" });

    const still = await harness.orchestrator.getRun(run.runId);
    expect(still.status).toBe("awaiting_input");

    // 正确输入后仍可完成
    await harness.orchestrator.resume(run.runId, { decision: "approve" });
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);
  });

  it("对非 awaiting_input 状态 resume 抛非法状态转换", async () => {
    const harness = await createHarness(() => linearDefinition(["solo"]));
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);
    await expect(harness.orchestrator.resume(run.runId, { decision: "approve" })).rejects.toMatchObject(
      { code: "WORKFLOW_INVALID_STATE" },
    );
  });
});

describe("WorkflowOrchestrator：取消", () => {
  it("awaiting_input 时取消：立即 cancelled", async () => {
    const harness = await createHarness(() => {
      const def: WorkflowDefinition = {
        kind: "idea_to_paper",
        description: "hitl only",
        stages: [
          {
            id: "gate",
            description: "等待",
            requiredInputs: [],
            producedOutputs: [],
            hitl: { prompt: "确认", options: ["approve"] },
          },
        ],
        plan: (state) =>
          "gate" in state.stageResults
            ? { kind: "complete", label: "draft", summary: {} }
            : { kind: "stage", stageId: "gate" },
        async onInput(state, stageId) {
          state.stageResults[stageId] = { decision: "approve" };
        },
      };
      return def;
    });
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["awaiting_input"]);

    const cancelled = await harness.orchestrator.cancel(run.runId);
    expect(cancelled.status).toBe("cancelled");

    await expect(harness.orchestrator.cancel(run.runId)).rejects.toMatchObject({
      code: "WORKFLOW_INVALID_STATE",
    });
  });

  it("stage 执行中取消：协作式在边界生效（signal 传播给 stage）", async () => {
    let signalObserved = false;
    let release: (() => void) | undefined;
    const definition: WorkflowDefinition = {
      ...linearDefinition([]),
      stages: [
        stepStage("longrun", {
          execute: async () => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return { done: true };
          },
          onSignal: (signal) => {
            signalObserved = true;
            signal.addEventListener("abort", () => release?.());
          },
        }),
      ],
      plan: (state) =>
        "longrun" in state.stageResults
          ? { kind: "complete", label: "draft", summary: {} }
          : { kind: "stage", stageId: "longrun" },
    };
    const harness = await createHarness(() => definition);
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitUntil(() => signalObserved, 5_000, "stage 开始执行（signal 传入）");

    const afterCancelRequest = await harness.orchestrator.cancel(run.runId);
    expect(afterCancelRequest.status).toBe("running"); // 请求已登记，等待边界生效
    expect(signalObserved).toBe(true);

    const finished = await waitForStatus(harness.orchestrator, run.runId, ["cancelled"]);
    expect(finished.status).toBe("cancelled");
  });
});

describe("WorkflowOrchestrator：checkpoint 持久化与重启恢复", () => {
  it("checkpoint.json 原子落盘并可读回（runStore roundtrip）", async () => {
    const harness = await createHarness(() => linearDefinition(["one"]));
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);

    const checkpointPath = harness.runStore.checkpointPath(harness.projectId, run.runId);
    const raw = await readFile(checkpointPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const loaded = await harness.runStore.loadCheckpoint(harness.projectId, run.runId);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.completedStages).toEqual(["one"]);
  });

  it("中断（running）的 run：新进程 recoverInterruptedRuns 恢复且已成功 stage 不重执行", async () => {
    // 手工构造「进程在 stage1 完成后、stage2 执行中崩溃」的 checkpoint
    const root = await mkdtemp(join(tmpdir(), "paperteam-wf-rec-"));
    tempRoots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("恢复测试");
    const runStore = new WorkflowRunStore(store);
    const now = new Date().toISOString();
    const state: WorkflowState = {
      schemaVersion: 1,
      runId: "w-recover0001",
      projectId: project.id,
      workflowKind: "idea_to_paper",
      status: "running",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      currentStage: "stage.two",
      completedStages: ["stage.one"],
      stageResults: { "stage.one": { value: 1 } },
      stageHistory: [
        {
          stageId: "stage.one",
          attempt: 1,
          status: "completed",
          startedAt: now,
          finishedAt: now,
          summary: { value: 1 },
        },
      ],
      inputs: {},
      eventsSeq: 3,
    };
    await runStore.saveCheckpoint(state);
    await appendEventLine(runStore.eventsPath(project.id, state.runId), {
      seq: 1,
      type: "workflow.started",
      runId: state.runId,
      projectId: project.id,
      ts: now,
    });
    await appendEventLine(runStore.eventsPath(project.id, state.runId), {
      seq: 2,
      type: "stage.started",
      runId: state.runId,
      projectId: project.id,
      stageId: "stage.one",
      ts: now,
    });
    await appendEventLine(runStore.eventsPath(project.id, state.runId), {
      seq: 3,
      type: "stage.completed",
      runId: state.runId,
      projectId: project.id,
      stageId: "stage.one",
      ts: now,
    });

    const executed: string[] = [];
    const definition: WorkflowDefinition = {
      kind: "idea_to_paper",
      description: "恢复用定义",
      stages: [
        stepStage("stage.one", { execute: () => ((executed.push("stage.one"), { value: 1 })) }),
        stepStage("stage.two", { execute: () => ((executed.push("stage.two"), { value: 2 })) }),
      ],
      plan: (current) => {
        if ("stage.two" in current.stageResults) {
          return { kind: "complete", label: "draft", summary: {} };
        }
        if ("stage.one" in current.stageResults) {
          return { kind: "stage", stageId: "stage.two" };
        }
        return { kind: "stage", stageId: "stage.one" };
      },
      async onInput() {
        throw new BusinessError("WORKFLOW_INVALID_STATE", "no hitl");
      },
    };
    const orchestrator = new WorkflowOrchestrator({
      projects: store,
      runStore,
      definitionFactory: () => definition,
      retryDelayMs: 0,
      log: () => {},
    });
    orchestrators.push(orchestrator);

    const recovered = await orchestrator.recoverInterruptedRuns();
    expect(recovered).toEqual([{ runId: "w-recover0001", outcome: "restarted" }]);

    const finished = await waitForStatus(orchestrator, "w-recover0001", ["completed"]);
    expect(executed).toEqual(["stage.two"]); // stage.one 不重复执行
    expect(finished.completedStages).toEqual(["stage.one", "stage.two"]);

    // 恢复后事件 seq 接续磁盘日志（不回退、不重复）
    const { events } = await orchestrator.readEvents("w-recover0001");
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBeGreaterThan(3);
    expect(events.some((event) => event.type === "workflow.recovered")).toBe(true);
  });

  it("awaiting_input 的 run：重启后保持等待，可 resume 完成", async () => {
    const executed: string[] = [];
    const buildDefinition = (): WorkflowDefinition => {
      const stages: StageSpec[] = [
        stepStage("prepare", { execute: () => ((executed.push("prepare"), {})) }),
        {
          id: "confirm",
          description: "等待确认",
          requiredInputs: ["prepare"],
          producedOutputs: [],
          hitl: { prompt: "请确认", options: ["approve"] },
        },
        stepStage("finish", { execute: () => ((executed.push("finish"), {})) }),
      ];
      return {
        kind: "idea_to_paper",
        description: "hitl 恢复",
        stages,
        plan: (state) => {
          if ("finish" in state.stageResults) {
            return { kind: "complete", label: "draft", summary: {} };
          }
          if ("confirm" in state.stageResults) {
            return { kind: "stage", stageId: "finish" };
          }
          if ("prepare" in state.stageResults) {
            return { kind: "stage", stageId: "confirm" };
          }
          return { kind: "stage", stageId: "prepare" };
        },
        async onInput(state, stageId, input) {
          if (input.decision !== "approve") {
            throw new WorkflowInvalidStateError(state.runId, state.status, "bad decision");
          }
          state.stageResults[stageId] = { decision: "approve" };
        },
      };
    };

    // 第一个编排器驱动到 awaiting_input 后“退出”（不再持有内存状态）
    const first = await createHarness(buildDefinition);
    const run = await first.orchestrator.createRun(first.projectId, "idea_to_paper");
    await waitForStatus(first.orchestrator, run.runId, ["awaiting_input"]);
    // 恢复语义读取的是磁盘 checkpoint：等待落盘完成（避免内存态先行可见的竞态）
    await waitUntil(
      async () =>
        (await first.runStore.loadCheckpoint(first.projectId, run.runId))?.status ===
        "awaiting_input",
      5_000,
      "checkpoint 落盘 awaiting_input",
    );

    // 第二个编排器（模拟重启）恢复
    const secondStore = first.store;
    const secondRunStore = first.runStore;
    const second = new WorkflowOrchestrator({
      projects: secondStore,
      runStore: secondRunStore,
      definitionFactory: buildDefinition,
      retryDelayMs: 0,
      log: () => {},
    });
    orchestrators.push(second);
    const recovered = await second.recoverInterruptedRuns();
    expect(recovered).toEqual([{ runId: run.runId, outcome: "awaiting_input" }]);
    expect((await second.getRun(run.runId)).status).toBe("awaiting_input");

    await second.resume(run.runId, { decision: "approve" });
    const finished = await waitForStatus(second, run.runId, ["completed"]);
    expect(finished.status).toBe("completed");
    expect(executed).toEqual(["prepare", "finish"]); // prepare 未重执行
  });
});

describe("Domain Event 日志（events.jsonl）", () => {
  it("完整事件流按序持久化；workflow.completed 为最后一个业务事件", async () => {
    const harness = await createHarness(() => linearDefinition(["a", "b"]));
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);

    // 内存状态先于事件落盘可见（persistThenCommit：saveCheckpoint → 改内存
    // → await 事件追加）。waitForStatus 看到内存 completed 时，最后一条
    // workflow.completed 可能尚未写完 events.jsonl（全量并发下偶发）。
    // 这里轮询事件文件直至 workflow.completed 出现（有界等待）。
    const deadline = Date.now() + 5_000;
    let events: Awaited<ReturnType<typeof harness.orchestrator.readEvents>>["events"];
    for (;;) {
      events = (await harness.orchestrator.readEvents(run.runId)).events;
      const last = events[events.length - 1];
      if (last !== undefined && last.type === "workflow.completed") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 workflow.completed 事件落盘超时（当前 ${events.length} 条）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("workflow.started");
    expect(types).toEqual(
      expect.arrayContaining(["stage.started", "stage.completed", "workflow.completed"]),
    );
    expect(types[types.length - 1]).toBe("workflow.completed");
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // 不泄露 Runtime 内部细节：事件负载不含 sessionKey / token 字段
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sessionKey");
    expect(serialized).not.toContain("apiKey");
  });

  it("损坏行被跳过，不影响其余事件读取", async () => {
    const harness = await createHarness(() => linearDefinition(["a"]));
    const run = await harness.orchestrator.createRun(harness.projectId, "idea_to_paper");
    await waitForStatus(harness.orchestrator, run.runId, ["completed"]);
    const eventsPath = harness.runStore.eventsPath(harness.projectId, run.runId);

    await writeFile(eventsPath, "{\"broken-json\n", { flag: "a" });
    const result = await readEventLog(eventsPath);
    expect(result.skippedLines).toBe(1);
    expect(result.events.length).toBeGreaterThanOrEqual(4);
    expect(result.events[0]?.type).toBe("workflow.started");
  });
});
