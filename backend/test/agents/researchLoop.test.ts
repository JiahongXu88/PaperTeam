/**
 * Controlled Research Loop 测试（M8.4）：
 * - 纯函数：consumedQueryCount / checkPlanWithinPolicy / evaluateLoopStop /
 *   reconstructExecution / readLoopStateFrom（策略判定规则骨架）；
 * - Service 状态机（fake 协作服务 + 真实 ProjectStore 磁盘）：
 *   start（空态 / 非法态 / 幂等边界）→ approvePlan（HITL 检查点 + 策略硬校验
 *   + 轮次执行 + 错误分类落盘）→ resume（崩溃恢复 reconcile：executing 残留 /
 *   done 回填 / approved 重试 / 手动派生采纳）→ cancel → deriveNextPlan
 *   （缺口决策门槛 + 委托透传 + 决策快照）；
 * - 并发守卫（进行中轮次 409）与取消竞态（cancel 后轮任务不再写盘）；
 * - 向后兼容（旧 artifact 无 loop 字段；loop 写盘不冲掉 gaps / loopPolicy /
 *   计划链）。
 *
 * 检索 / 覆盖 / 缺口 / 派生的真实逻辑在各自套件覆盖（M8.2 / M8.3.2 / M8.3.3）；
 * 本文件只验证编排层：委托调用序列、状态流转、策略消费与持久化。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { BusinessError } from "../../src/errors.js";
import {
  ResearchLoopService,
  checkPlanWithinPolicy,
  consumedQueryCount,
  evaluateLoopStop,
  readLoopStateFrom,
  reconstructExecution,
  type ResearchLoopRound,
  type ResearchLoopState,
} from "../../src/agents/researchLoop.js";
import { DEFAULT_RESEARCH_LOOP_POLICY } from "../../src/agents/researchLoopPolicy.js";
import type {
  PlanExecutionResult,
  ResearchPlanExecutionService,
} from "../../src/agents/researchPlanExecution.js";
import type { ResearchCoverage, ResearchCoverageService } from "../../src/agents/researchCoverage.js";
import type { ResearchGap, ResearchGapService } from "../../src/agents/researchGap.js";
import type { ResearchPlan } from "../../src/agents/researchPlan.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(title: string): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-loop-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create(title, { researchIdea: "Deep Research Agent" });
  return { store, projectId: project.id };
}

async function seedArtifact(store: ProjectStore, projectId: string, artifact: Record<string, unknown>) {
  const researchDir = store.researchDir(projectId);
  const fs = await import("node:fs/promises");
  await fs.mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function readArtifact(store: ProjectStore, projectId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(store.researchDir(projectId), "research.json"), "utf8"),
  ) as Record<string, unknown>;
}

function reportFixture(): Record<string, unknown> {
  return {
    domainOverview: "调研概述",
    relatedWorkDirections: [],
    researchGaps: ["gap"],
    potentialContributions: ["贡献"],
    researchQuestions: [],
    literaturePlan: [],
  };
}

function seededArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-09-21T08:00:00.000Z",
    taskId: "run-seed",
    report: reportFixture(),
    evidence: [],
    bibliography: [],
    ...overrides,
  };
}

function planFixture(overrides: Record<string, unknown> = {}): ResearchPlan {
  return {
    planId: "rp-active000001",
    iterationId: "it-active000001",
    iterationNumber: 1,
    status: "draft",
    questions: ["Deep Research Agent 架构范式"],
    queries: [
      { queryId: "q-1", query: "deep research agent survey", kind: "academic", status: "planned" },
      { queryId: "q-2", query: "scientific agent architecture", kind: "academic", status: "planned" },
    ],
    createdAt: "2026-09-21T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
    ...overrides,
  } as ResearchPlan;
}

function gapFixture(gapId: string, status: ResearchGap["status"]): ResearchGap {
  return {
    gapId,
    planId: "rp-active000001",
    description: "缺口描述",
    severity: "low",
    suggestedQueries: ["补检词"],
    status,
    createdAt: "2026-09-21T08:00:00.000Z",
  };
}

function coverageFixture(overrides: { covered?: number; gaps?: ResearchGap[] } = {}): ResearchCoverage {
  return {
    planId: "rp-active000001",
    planStatus: "done",
    analyzedAt: "2026-09-21T09:00:00.000Z",
    questions: [],
    requirementCoverage: [],
    overall: {
      questionCount: 2,
      covered: overrides.covered ?? 0,
      partial: 1,
      missing: 1,
      summary: "研究问题 2 个：covered 0 · partial 1 · missing 1；缺口 2 项",
    },
    gaps: overrides.gaps ?? [gapFixture("gap-aaaaaaaaaaaa", "proposed"), gapFixture("gap-bbbbbbbbbbbb", "proposed")],
  };
}

function executionResultFixture(overrides: Partial<PlanExecutionResult> = {}): PlanExecutionResult {
  return {
    executionId: "exec-fake000001",
    totalQueries: 2,
    executedQueries: 2,
    failedQueries: 0,
    plan: planFixture({ status: "done" }),
    ...overrides,
  };
}

function loopStateFixture(overrides: Partial<ResearchLoopState> = {}): ResearchLoopState {
  return {
    loopId: "loop-fixture0001",
    status: "awaiting_plan_approval",
    rounds: [],
    createdAt: "2026-09-21T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
    ...overrides,
  };
}

function roundFixture(overrides: Partial<ResearchLoopRound> = {}): ResearchLoopRound {
  return {
    roundNumber: 1,
    planId: "rp-active000001",
    iterationNumber: 1,
    approvedAt: "2026-09-21T08:30:00.000Z",
    ...overrides,
  };
}

/** fake 协作服务 + 可变行为（只验证编排层：调用序列 / 状态流转 / 持久化） */
function buildService(store: ProjectStore) {
  const logs = {
    approve: [] as string[],
    execute: [] as string[],
    derive: [] as Array<{ projectId: string; gapId: string; body: Record<string, unknown> }>,
  };
  const behavior = {
    execute: async (): Promise<PlanExecutionResult> => executionResultFixture(),
    coverage: async (): Promise<ResearchCoverage> => coverageFixture(),
    gapList: async (): Promise<{ planId: string | null; gaps: ResearchGap[] }> => ({
      planId: "rp-active000001",
      gaps: [],
    }),
    derive: async (): Promise<ResearchPlan> => planFixture({ planId: "rp-derived00001", iterationNumber: 2, parentPlanId: "rp-active000001" }),
  };
  const planExecution = {
    approve: async (projectId: string) => {
      logs.approve.push(projectId);
      return planFixture({ status: "approved" });
    },
    execute: async (projectId: string) => {
      logs.execute.push(projectId);
      return behavior.execute();
    },
  } as unknown as ResearchPlanExecutionService;
  const coverage = {
    analyze: async () => behavior.coverage(),
    get: async () => behavior.coverage(),
  } as unknown as ResearchCoverageService;
  const gaps = {
    list: async () => behavior.gapList(),
    derive: async (projectId: string, gapId: string, body: Record<string, unknown>) => {
      logs.derive.push({ projectId, gapId, body });
      return behavior.derive();
    },
  } as unknown as ResearchGapService;
  const service = new ResearchLoopService({ projects: store, planExecution, coverage, gaps });
  return { service, logs, behavior };
}

const errorOf = (error: unknown): { code?: string; message?: string } =>
  error instanceof BusinessError ? { code: error.code, message: error.message } : {};

// ---- 纯函数：策略判定规则骨架 ----

describe("consumedQueryCount（真实执行计数）", () => {
  it("Σ 各轮 executed + failed；无执行快照的轮不计", () => {
    expect(consumedQueryCount([])).toBe(0);
    expect(
      consumedQueryCount([
        roundFixture({ execution: { executionId: "e1", totalQueries: 3, executedQueries: 2, failedQueries: 1, completedAt: "t" } }),
        roundFixture({ roundNumber: 2 }),
        roundFixture({ roundNumber: 3, execution: { executionId: "e2", totalQueries: 1, executedQueries: 0, failedQueries: 1, completedAt: "t" } }),
      ]),
    ).toBe(4);
  });
});

describe("checkPlanWithinPolicy（批准检查点硬校验）", () => {
  it("planned 超过单轮上限 → LOOP_POLICY_VIOLATION", () => {
    const queries = Array.from({ length: 21 }, (_, index) => ({
      queryId: `q-${index + 1}`,
      query: `query ${index + 1}`,
      kind: "academic" as const,
      status: "planned" as const,
    }));
    expect(() =>
      checkPlanWithinPolicy({ policy: DEFAULT_RESEARCH_LOOP_POLICY, plan: planFixture({ queries }), consumedQueries: 0 }),
    ).toThrowError(expect.objectContaining({ code: "LOOP_POLICY_VIOLATION" }));
  });

  it("已消耗 + planned 超过循环预算 → LOOP_POLICY_VIOLATION；恰好等于预算 → 通过", () => {
    const policy = { ...DEFAULT_RESEARCH_LOOP_POLICY, maxTotalQueries: 4 };
    expect(() =>
      checkPlanWithinPolicy({ policy, plan: planFixture(), consumedQueries: 3 }),
    ).toThrowError(expect.objectContaining({ code: "LOOP_POLICY_VIOLATION" }));
    expect(() =>
      checkPlanWithinPolicy({ policy, plan: planFixture(), consumedQueries: 2 }),
    ).not.toThrow();
  });

  it("planned=0（全部已执行 / 跳过）→ 通过（零检索轮不违反策略）", () => {
    const plan = planFixture({
      queries: [{ queryId: "q-1", query: "x", kind: "academic", status: "executed", resultCount: 1 }],
    });
    expect(() =>
      checkPlanWithinPolicy({ policy: DEFAULT_RESEARCH_LOOP_POLICY, plan, consumedQueries: 99 }),
    ).not.toThrow();
  });
});

describe("evaluateLoopStop（轮后停止判定）", () => {
  const base = {
    policy: DEFAULT_RESEARCH_LOOP_POLICY,
    chainMaxIteration: 1,
    consumedQueries: 2,
    round: roundFixture({ coverage: { covered: 0, partial: 1, missing: 1, gaps: 2, analyzedAt: "t" } }),
    openGapCount: 2,
  };

  it("无缺口 → no_open_gaps（结构完成，优先于一切策略条件）", () => {
    expect(evaluateLoopStop({ ...base, openGapCount: 0, chainMaxIteration: 99, consumedQueries: 999 })).toBe("no_open_gaps");
  });

  it("链内迭代号达到 maxIterations → iteration_limit", () => {
    expect(evaluateLoopStop({ ...base, chainMaxIteration: 5 })).toBe("iteration_limit");
  });

  it("消耗达到 maxTotalQueries → budget_exceeded", () => {
    expect(evaluateLoopStop({ ...base, consumedQueries: 100 })).toBe("budget_exceeded");
  });

  it("本轮 covered 不多于上一轮 → no_new_coverage；首轮豁免", () => {
    const previousRound = roundFixture({ roundNumber: 1, coverage: { covered: 2, partial: 0, missing: 0, gaps: 1, analyzedAt: "t1" } });
    const currentRound = roundFixture({ roundNumber: 2, coverage: { covered: 2, partial: 0, missing: 0, gaps: 1, analyzedAt: "t2" } });
    expect(evaluateLoopStop({ ...base, round: currentRound, previousRound })).toBe("no_new_coverage");
    // 首轮（无上一轮）不触发
    expect(evaluateLoopStop(base)).toBeNull();
    // 覆盖增长 → 继续
    expect(
      evaluateLoopStop({
        ...base,
        round: roundFixture({ coverage: { covered: 3, partial: 0, missing: 0, gaps: 1, analyzedAt: "t2" } }),
        previousRound,
      }),
    ).toBeNull();
  });

  it("stopConditions 未声明的条件不参与判定（声明式开关）", () => {
    const policy = { ...DEFAULT_RESEARCH_LOOP_POLICY, stopConditions: ["no_new_coverage" as const] };
    expect(evaluateLoopStop({ ...base, policy, chainMaxIteration: 20, consumedQueries: 500 })).toBeNull();
  });
});

describe("reconstructExecution（崩溃窗口回填）", () => {
  it("按 planId 从执行历史重建真实计数", () => {
    const plan = planFixture({ status: "done", planId: "rp-x0000000001" });
    const history = [
      { executionId: "exec-1", queryId: "q-1", query: "a", kind: "academic" as const, timestamp: "t1", status: "executed" as const, planId: "rp-x0000000001", resultCount: 10 },
      { executionId: "exec-1", queryId: "q-2", query: "b", kind: "academic" as const, timestamp: "t2", status: "failed" as const, planId: "rp-x0000000001", error: "provider down" },
      { executionId: "exec-0", queryId: "q-1", query: "旧轮", kind: "academic" as const, timestamp: "t0", status: "executed" as const, resultCount: 5 },
    ];
    expect(reconstructExecution(plan, history)).toEqual({
      executionId: "exec-1",
      totalQueries: 2,
      executedQueries: 1,
      failedQueries: 1,
      completedAt: "t2",
    });
  });

  it("历史无该计划条目（旧记录无 planId）→ undefined（如实缺快照）", () => {
    expect(reconstructExecution(planFixture({ planId: "rp-y0000000001" }), [])).toBeUndefined();
  });
});

describe("readLoopStateFrom（宽容读取）", () => {
  it("无字段 / 形状非法 → null；合法 → 原样返回", () => {
    expect(readLoopStateFrom({})).toBeNull();
    expect(readLoopStateFrom({ loop: "nonsense" })).toBeNull();
    expect(readLoopStateFrom({ loop: { loopId: "loop-x", status: "running" } })).toBeNull(); // 缺 rounds
    expect(readLoopStateFrom({ loop: { loopId: "loop-x", status: "sprinting", rounds: [] } })).toBeNull();
    const state = loopStateFixture();
    expect(readLoopStateFrom({ loop: state })).toBe(state);
  });
});

// ---- Service：start ----

describe("ResearchLoopService.start", () => {
  it("无 artifact / 无计划 → 404；非 draft 计划 → 409；draft → awaiting_plan_approval 并落盘", async () => {
    const { store, projectId } = await newProject("loop-start");
    const { service } = buildService(store);

    expect(errorOf(await service.start(projectId).catch((error) => error))).toMatchObject({ code: "NOT_FOUND" });

    await seedArtifact(store, projectId, seededArtifact());
    expect(errorOf(await service.start(projectId).catch((error) => error))).toMatchObject({ code: "NOT_FOUND" });

    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture({ status: "done" }) }));
    expect(errorOf(await service.start(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });

    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    const state = await service.start(projectId);
    expect(state.status).toBe("awaiting_plan_approval");
    expect(state.rounds).toHaveLength(0);
    expect(state.loopId).toMatch(/^loop-[a-z0-9]{12}$/);
    const artifact = await readArtifact(store, projectId);
    expect((artifact["loop"] as ResearchLoopState).status).toBe("awaiting_plan_approval");
  });

  it("重复 start（非终态）→ 409；终态后重启 → 新 loopId、全新轮次", async () => {
    const { store, projectId } = await newProject("loop-start-dup");
    const { service } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));

    const first = await service.start(projectId);
    expect(errorOf(await service.start(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });

    await service.cancel(projectId);
    const second = await service.start(projectId);
    expect(second.loopId).not.toBe(first.loopId);
    expect(second.rounds).toHaveLength(0);
  });
});

// ---- Service：approvePlan（HITL 检查点 + 策略消费 + 轮次执行） ----

describe("ResearchLoopService.approvePlan", () => {
  it("非 awaiting_plan_approval → 409；策略违规 → 409 且不委托 approve", async () => {
    const { store, projectId } = await newProject("loop-approve-guard");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId);

    // 非 awaiting_plan_approval（运行后停在缺口决策检查点）→ 409
    const wrongStatus = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "done" }),
      loop: loopStateFixture({ status: "awaiting_gap_decision", rounds: [roundFixture()] }),
    }));
    expect(errorOf(await wrongStatus.service.approvePlan(projectId).catch((error) => error))).toMatchObject({
      code: "LOOP_INVALID_STATE",
    });
    expect(wrongStatus.logs.approve).toHaveLength(0);

    // 策略违规：21 条 planned > maxQueriesPerIteration=20（重新 seed 时保留 loop 字段）
    const queries = Array.from({ length: 21 }, (_, index) => ({
      queryId: `q-${index + 1}`,
      query: `query ${index + 1}`,
      kind: "academic" as const,
      status: "planned" as const,
    }));
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ queries }),
      loop: loopStateFixture({ status: "awaiting_plan_approval" }),
    }));
    expect(errorOf(await service.approvePlan(projectId).catch((error) => error))).toMatchObject({
      code: "LOOP_POLICY_VIOLATION",
    });
    expect(logs.approve).toHaveLength(0); // 委托从未发生——计划保持 draft
    expect((await service.get(projectId))!.status).toBe("awaiting_plan_approval");
  });

  it("预算守卫：已消耗 + planned 超过 maxTotalQueries → 409", async () => {
    const { store, projectId } = await newProject("loop-approve-budget");
    const { service } = buildService(store);
    const plan = planFixture();
    await seedArtifact(store, projectId, seededArtifact({
      plan,
      loopPolicy: { ...DEFAULT_RESEARCH_LOOP_POLICY, maxTotalQueries: 3 },
      loop: loopStateFixture({
        status: "awaiting_plan_approval",
        rounds: [roundFixture({
          derivedPlanId: "rp-active000001",
          execution: { executionId: "e0", totalQueries: 2, executedQueries: 2, failedQueries: 0, completedAt: "t" },
        })],
      }),
    }));
    expect(errorOf(await service.approvePlan(projectId).catch((error) => error))).toMatchObject({
      code: "LOOP_POLICY_VIOLATION",
    });
  });

  it("批准 → 执行 → 覆盖 → awaiting_gap_decision；轮次历史如实回填", async () => {
    const { store, projectId } = await newProject("loop-approve-happy");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId);

    const state = await service.approvePlan(projectId);
    expect(logs.approve).toEqual([projectId]);
    expect(logs.execute).toEqual([projectId]);
    expect(state.status).toBe("awaiting_gap_decision");
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]).toMatchObject({
      planId: "rp-active000001",
      iterationNumber: 1,
      execution: { executionId: "exec-fake000001", executedQueries: 2, failedQueries: 0 },
      coverage: { covered: 0, gaps: 2 },
    });
    expect((await readArtifact(store, projectId))["loop"]).toMatchObject({ status: "awaiting_gap_decision" });
  });

  it("执行抛 BusinessError → awaiting_retry + error 摘要；非业务异常 → failed", async () => {
    const retryProject = await newProject("loop-execute-retry");
    const retry = buildService(retryProject.store);
    await seedArtifact(retryProject.store, retryProject.projectId, seededArtifact({ plan: planFixture() }));
    await retry.service.start(retryProject.projectId);
    retry.behavior.execute = async () => {
      throw new BusinessError("PLAN_INVALID_STATE", "计划状态残留 executing");
    };
    const retryState = await retry.service.approvePlan(retryProject.projectId);
    expect(retryState.status).toBe("awaiting_retry");
    expect(retryState.error).toContain("残留 executing");

    const failProject = await newProject("loop-execute-fail");
    const fail = buildService(failProject.store);
    await seedArtifact(failProject.store, failProject.projectId, seededArtifact({ plan: planFixture() }));
    await fail.service.start(failProject.projectId);
    fail.behavior.execute = async () => {
      throw new Error("boom: disk full");
    };
    const failState = await fail.service.approvePlan(failProject.projectId);
    expect(failState.status).toBe("failed");
    expect(failState.error).toContain("boom");
  });
});

// ---- Service：resume（崩溃恢复 / 重试） ----

describe("ResearchLoopService.resume", () => {
  it("无循环 → 404；检查点 / 终态 → 409（无可恢复断点）", async () => {
    const { store, projectId } = await newProject("loop-resume-409");
    const { service } = buildService(store);
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({ code: "NOT_FOUND" });

    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId); // awaiting_plan_approval + draft 计划
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });

    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture(),
      loop: loopStateFixture({ status: "awaiting_gap_decision", rounds: [roundFixture()] }),
    }));
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });

    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture(),
      loop: loopStateFixture({ status: "completed", stopReason: "iteration_limit", rounds: [roundFixture()], completedAt: "t" }),
    }));
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });
  });

  it("崩溃恢复（进程重启残留 running + 计划 executing）→ awaiting_retry + 修复提示", async () => {
    const { store, projectId } = await newProject("loop-resume-stale");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "executing" }),
      loop: loopStateFixture({ status: "running", currentStep: "execute", rounds: [roundFixture()] }),
    }));
    const state = await service.resume(projectId);
    expect(state.status).toBe("awaiting_retry");
    expect(state.error).toContain("改回 approved");
    expect(logs.execute).toHaveLength(0);
  });

  it("崩溃恢复（执行已完成落盘）→ 从 executionHistory 回填真实计数 → 覆盖分析 → awaiting_gap_decision", async () => {
    const { store, projectId } = await newProject("loop-resume-done");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "done", queries: [
        { queryId: "q-1", query: "deep research agent survey", kind: "academic", status: "executed", resultCount: 10 },
        { queryId: "q-2", query: "scientific agent architecture", kind: "academic", status: "planned" },
      ] }),
      executionHistory: [
        { executionId: "exec-hist000001", queryId: "q-1", query: "deep research agent survey", kind: "academic", timestamp: "2026-09-21T08:40:00.000Z", status: "executed", planId: "rp-active000001", resultCount: 10 },
        { executionId: "exec-hist000001", queryId: "q-2", query: "scientific agent architecture", kind: "academic", timestamp: "2026-09-21T08:41:00.000Z", status: "failed", planId: "rp-active000001", error: "provider down" },
      ],
      loop: loopStateFixture({ status: "running", currentStep: "execute", rounds: [roundFixture()] }),
    }));
    const state = await service.resume(projectId);
    expect(logs.execute).toHaveLength(0); // 不重复执行——磁盘事实已 done
    expect(state.status).toBe("awaiting_gap_decision");
    expect(state.rounds[0]!.execution).toEqual({
      executionId: "exec-hist000001",
      totalQueries: 2,
      executedQueries: 1,
      failedQueries: 1,
      completedAt: "2026-09-21T08:41:00.000Z",
    });
    expect(state.rounds[0]!.coverage).toMatchObject({ gaps: 2 });
  });

  it("崩溃恢复（approved 未执行）→ 重试执行", async () => {
    const { store, projectId } = await newProject("loop-resume-approved");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "approved" }),
      loop: loopStateFixture({ status: "awaiting_retry", error: "上次中断", rounds: [roundFixture()] }),
    }));
    const state = await service.resume(projectId);
    expect(logs.execute).toEqual([projectId]);
    expect(state.status).toBe("awaiting_gap_decision");
    expect(state.rounds).toHaveLength(1); // 同一轮续跑，不新增轮次
  });

  it("崩溃窗口（批准已落盘、轮次未登记）→ resume 采纳为第 1 轮并续跑", async () => {
    const { store, projectId } = await newProject("loop-resume-adopt");
    const { service, logs } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "approved" }),
      loop: loopStateFixture({ status: "awaiting_plan_approval", rounds: [] }),
    }));
    const state = await service.resume(projectId);
    expect(logs.execute).toEqual([projectId]);
    expect(state.rounds).toHaveLength(1);
    expect(state.status).toBe("awaiting_gap_decision");
  });

  it("活动计划已被更高迭代号计划替换（用户手动派生）→ 采纳并回到批准检查点", async () => {
    const { store, projectId } = await newProject("loop-resume-derived");
    const { service, logs } = buildService(store);
    const round1 = roundFixture();
    const derived = planFixture({ planId: "rp-derived00001", iterationNumber: 2, parentPlanId: "rp-active000001", status: "draft" });
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "done" }),
      plans: [planFixture({ status: "done" }), derived],
      activePlanId: "rp-derived00001",
      loop: loopStateFixture({ status: "running", currentStep: "coverage", rounds: [round1] }),
    }));
    const state = await service.resume(projectId);
    expect(logs.execute).toHaveLength(0);
    expect(state.status).toBe("awaiting_plan_approval");
    expect(state.rounds[0]!.derivedPlanId).toBe("rp-derived00001");
  });

  it("活动计划被切走（迭代号不高于本轮）→ 409 指引", async () => {
    const { store, projectId } = await newProject("loop-resume-switched");
    const { service } = buildService(store);
    const other = planFixture({ planId: "rp-other00000001", iterationId: "it-other00000001", iterationNumber: 1, status: "done" });
    await seedArtifact(store, projectId, seededArtifact({
      plans: [planFixture({ status: "done" }), other],
      activePlanId: "rp-other00000001",
      loop: loopStateFixture({ status: "running", currentStep: "coverage", rounds: [roundFixture()] }),
    }));
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });
  });
});

// ---- Service：cancel ----

describe("ResearchLoopService.cancel", () => {
  it("检查点取消 → cancelled 落盘；终态再取消 → 409；无循环 → 404", async () => {
    const { store, projectId } = await newProject("loop-cancel");
    const { service } = buildService(store);
    expect(errorOf(await service.cancel(projectId).catch((error) => error))).toMatchObject({ code: "NOT_FOUND" });

    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId);
    const state = await service.cancel(projectId);
    expect(state.status).toBe("cancelled");
    expect(state.cancelledAt).toBeDefined();
    expect((await service.get(projectId))!.status).toBe("cancelled");

    expect(errorOf(await service.cancel(projectId).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });
  });
});

// ---- Service：deriveNextPlan（缺口决策门槛 → 派生 → 停在批准检查点） ----

describe("ResearchLoopService.deriveNextPlan", () => {
  async function seedForGapDecision(store: ProjectStore, projectId: string, gaps: ResearchGap[]) {
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "done" }),
      loop: loopStateFixture({
        status: "awaiting_gap_decision",
        rounds: [roundFixture({
          execution: { executionId: "e1", totalQueries: 2, executedQueries: 2, failedQueries: 0, completedAt: "t" },
          coverage: { covered: 0, partial: 1, missing: 1, gaps: gaps.length, analyzedAt: "t" },
        })],
      }),
    }));
    return gaps;
  }

  it("非 awaiting_gap_decision → 409；无 accepted 缺口 → 409（HITL：没有决策就没有下一轮）", async () => {
    const { store, projectId } = await newProject("loop-derive-guard");
    const { service } = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture(),
      loop: loopStateFixture({ status: "awaiting_plan_approval" }),
    }));
    expect(errorOf(await service.deriveNextPlan(projectId, {}).catch((error) => error))).toMatchObject({ code: "LOOP_INVALID_STATE" });

    const gaps = [gapFixture("gap-aaaaaaaaaaaa", "proposed"), gapFixture("gap-bbbbbbbbbbbb", "rejected")];
    await seedForGapDecision(store, projectId, gaps);
    const none = buildService(store);
    none.behavior.gapList = async () => ({ planId: "rp-active000001", gaps });
    expect(errorOf(await none.service.deriveNextPlan(projectId, {}).catch((error) => error))).toMatchObject({
      code: "LOOP_INVALID_STATE",
    });
  });

  it("多 accepted 缺口未指定 gapId → 400；指定后委托派生（gapId 不透传）→ awaiting_plan_approval + 决策快照", async () => {
    const { store, projectId } = await newProject("loop-derive-ok");
    const { service, logs, behavior } = buildService(store);
    const gaps = [gapFixture("gap-aaaaaaaaaaaa", "accepted"), gapFixture("gap-bbbbbbbbbbbb", "accepted"), gapFixture("gap-cccccccccccc", "rejected")];
    await seedForGapDecision(store, projectId, gaps);
    behavior.gapList = async () => ({ planId: "rp-active000001", gaps });

    expect(errorOf(await service.deriveNextPlan(projectId, {}).catch((error) => error))).toMatchObject({
      code: "INVALID_REQUEST",
    });

    const { loop, plan } = await service.deriveNextPlan(projectId, {
      gapId: "gap-aaaaaaaaaaaa",
      queries: [{ query: "custom query", kind: "academic" }],
    });
    expect(plan.planId).toBe("rp-derived00001");
    expect(logs.derive).toHaveLength(1);
    expect(logs.derive[0]).toMatchObject({ gapId: "gap-aaaaaaaaaaaa" });
    expect(logs.derive[0]!.body).toEqual({ queries: [{ query: "custom query", kind: "academic" }] }); // gapId 已剥离
    expect(loop.status).toBe("awaiting_plan_approval"); // 派生后停等批准——不自动执行
    expect(loop.rounds[0]!.decided).toMatchObject({ accepted: 2, rejected: 1 });
    expect(loop.rounds[0]!.derivedPlanId).toBe("rp-derived00001");
  });

  it("唯一 accepted 缺口可省略 gapId；策略收紧复检（迭代上限）→ 409", async () => {
    const { store, projectId } = await newProject("loop-derive-single");
    const single = buildService(store);
    const gaps = [gapFixture("gap-aaaaaaaaaaaa", "accepted"), gapFixture("gap-bbbbbbbbbbbb", "rejected")];
    await seedForGapDecision(store, projectId, gaps);
    single.behavior.gapList = async () => ({ planId: "rp-active000001", gaps });
    const { loop } = await single.service.deriveNextPlan(projectId, {});
    expect(loop.status).toBe("awaiting_plan_approval");

    const capped = buildService(store);
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture({ status: "done", iterationNumber: 5 }),
      loopPolicy: DEFAULT_RESEARCH_LOOP_POLICY, // maxIterations=5
      loop: loopStateFixture({
        status: "awaiting_gap_decision",
        rounds: [roundFixture({ iterationNumber: 5, coverage: { covered: 0, partial: 0, missing: 2, gaps: 2, analyzedAt: "t" } })],
      }),
    }));
    capped.behavior.gapList = async () => ({ planId: "rp-active000001", gaps });
    expect(errorOf(await capped.service.deriveNextPlan(projectId, {}).catch((error) => error))).toMatchObject({
      code: "LOOP_POLICY_VIOLATION",
    });
  });
});

// ---- 并发守卫与取消竞态 ----

describe("并发守卫与取消竞态", () => {
  it("轮次执行中：并发 resume / 重复 approve → 409 LOOP_INVALID_STATE；放行后正常完成", async () => {
    const { store, projectId } = await newProject("loop-concurrent");
    const holder = behaviorHolder();
    const service = new ResearchLoopService({
      projects: store,
      planExecution: holder.planExecution,
      coverage: holder.coverage,
      gaps: holder.gaps,
    });
    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId);

    const pending = service.approvePlan(projectId);
    await holder.waitForExecuteEntered();
    expect(errorOf(await service.resume(projectId).catch((error) => error))).toMatchObject({
      code: "LOOP_INVALID_STATE",
    });
    expect(errorOf(await service.approvePlan(projectId).catch((error) => error))).toMatchObject({
      code: "LOOP_INVALID_STATE",
    });
    holder.releaseExecute();
    const state = await pending;
    expect(state.status).toBe("awaiting_gap_decision");
    expect(holder.logs.execute).toHaveLength(1); // 只执行了一次
  });

  it("执行中 cancel → 状态 cancelled；轮任务后续落盘被抑制（执行快照不回填）", async () => {
    const { store, projectId } = await newProject("loop-cancel-running");
    const holder = behaviorHolder();
    const service = new ResearchLoopService({
      projects: store,
      planExecution: holder.planExecution,
      coverage: holder.coverage,
      gaps: holder.gaps,
    });
    await seedArtifact(store, projectId, seededArtifact({ plan: planFixture() }));
    await service.start(projectId);

    const pending = service.approvePlan(projectId);
    await holder.waitForExecuteEntered();
    await service.cancel(projectId);
    expect((await service.get(projectId))!.status).toBe("cancelled");
    holder.releaseExecute();
    const state = await pending;
    expect(state.status).toBe("cancelled");
    expect(state.rounds[0]!.execution).toBeUndefined(); // 取消后不再回填
  });
});

// holder 辅助：可控延时的 execute fake（并发 / 取消竞态测试用）
function behaviorHolder() {
  let releaseExecute!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseExecute = resolve;
  });
  let executeEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    executeEntered = resolve;
  });
  const logs = { approve: [] as string[], execute: [] as string[] };
  const planExecution = {
    approve: async (projectId: string) => {
      logs.approve.push(projectId);
      return planFixture({ status: "approved" });
    },
    execute: async (projectId: string) => {
      logs.execute.push(projectId);
      executeEntered?.();
      await gate;
      return executionResultFixture();
    },
  } as unknown as ResearchPlanExecutionService;
  const coverage = {
    analyze: async () => coverageFixture(),
    get: async () => coverageFixture(),
  } as unknown as ResearchCoverageService;
  const gaps = {
    list: async () => ({ planId: "rp-active000001", gaps: [] as ResearchGap[] }),
    derive: async () => planFixture({ planId: "rp-derived00001", iterationNumber: 2 }),
  } as unknown as ResearchGapService;
  return {
    planExecution,
    coverage,
    gaps,
    logs,
    releaseExecute: () => releaseExecute(),
    waitForExecuteEntered: () => entered,
  };
}

// ---- 向后兼容 ----

describe("向后兼容（旧 artifact / 字段保留）", () => {
  it("旧 artifact 无 loop 字段 → get null；start 后 gaps / loopPolicy / 计划链原样保留", async () => {
    const { store, projectId } = await newProject("loop-compat");
    const { service } = buildService(store);
    expect(await service.get(projectId)).toBeNull();

    const decisions = [gapFixture("gap-aaaaaaaaaaaa", "accepted")];
    await seedArtifact(store, projectId, seededArtifact({
      plan: planFixture(),
      gaps: decisions,
      loopPolicy: { ...DEFAULT_RESEARCH_LOOP_POLICY, maxIterations: 3 },
    }));
    await service.start(projectId);
    const artifact = await readArtifact(store, projectId);
    expect(artifact["gaps"]).toEqual(decisions);
    expect(artifact["loopPolicy"]).toMatchObject({ maxIterations: 3 });
    expect(artifact["plan"]).toMatchObject({ planId: "rp-active000001" });
    expect(artifact["loop"]).toMatchObject({ status: "awaiting_plan_approval" });
  });
});
