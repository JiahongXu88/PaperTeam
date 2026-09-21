/**
 * Controlled Research Loop HTTP API 集成测试（M8.4）：
 *   GET  /api/projects/:id/research/loop               → { loop | null }
 *   POST /api/projects/:id/research/loop/start         → { loop }（draft 计划 → 批准检查点）
 *   POST /api/projects/:id/research/loop/plan/approve  → { loop }（HITL 批准 → 执行一轮）
 *   POST /api/projects/:id/research/loop/derive-next   → { loop, plan }（缺口决策 → 下一轮草案）
 *   POST /api/projects/:id/research/loop/resume        → { loop }（崩溃恢复 / 重试）
 *   POST /api/projects/:id/research/loop/cancel        → { loop }
 *
 * 覆盖：空态 / start 门槛 / 重复 start 409 → 批准检查点（轮次真实执行：fake
 * openalex 检索 + 真实 Coverage 分析 → awaiting_gap_decision）→ 缺口检查点
 * （未 accept 派生 409 / accept 后派生新草案 / 停等下一轮批准）→ Loop Policy
 * 真实停止（iteration_limit / budget_exceeded / budget 守卫 409 /
 * no_new_coverage 两轮真实流 / no_open_gaps）→ cancel → resume（409 与崩溃
 * 恢复）→ 并发 resume 409（延时的 fetch 门）→ 405 / 404 / 向后兼容。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "./helpers/testStack.js";

const openalexFake = {
  results: [
    {
      id: "https://openalex.org/W222",
      title: "Deep Research Agent Survey",
      doi: "https://doi.org/10.1234/dra-survey",
      publication_year: 2026,
      authorships: [{ author: { display_name: "Bob Li" } }],
      cited_by_count: 7,
    },
  ],
};

/** 可挂起的 fake fetch（并发 resume 测试用 gate；其余测试直通） */
let gate: Promise<void> | null = null;
let releaseGate: (() => void) | null = null;
let fetchCalls = 0;

const fakeSearchFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    fetchCalls += 1;
    if (gate !== null) {
      await gate;
    }
    return new Response(JSON.stringify(openalexFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

function holdNextFetches(): void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
}

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 1_000,
      fetchImpl: fakeSearchFetch as unknown as typeof fetch,
    },
  });
});

afterAll(async () => {
  await stack.cleanup();
});

async function createProject(title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

async function seedArtifact(projectId: string, artifact: Record<string, unknown>): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function readArtifact(projectId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(stack.store.researchDir(projectId), "research.json"), "utf8"),
  ) as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
}

type LoopBody = {
  loopId: string;
  status: string;
  rounds: Array<Record<string, unknown>>;
  stopReason?: string;
  error?: string;
};

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

function planFixture(status: string, queries: Array<Record<string, unknown>>, questions: string[] = ["Deep Research Agent 架构范式", "Scientific Agent 代表工作"]) {
  return {
    planId: "rp-seed00000001",
    iterationId: "it-seed00000001",
    iterationNumber: 1,
    status,
    questions,
    queries,
    createdAt: "2026-09-21T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
  };
}

function plannedQueries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    queryId: `q-${index + 1}`,
    query: `deep research agent survey ${index + 1}`,
    kind: "academic",
    status: "planned",
  }));
}

async function getLoop(projectId: string): Promise<LoopBody | null> {
  const response = await stack.request("GET", `/api/projects/${projectId}/research/loop`);
  expect(response.status).toBe(200);
  return (response.body["loop"] as LoopBody | null) ?? null;
}

async function putLoopPolicy(projectId: string, body: Record<string, unknown>): Promise<void> {
  const response = await stack.request("PUT", `/api/projects/${projectId}/research/loop-policy`, body);
  expect(response.status).toBe(200);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor: 条件超时");
}

// ---- 空态与 start 门槛 ----

describe("GET/POST /research/loop · /loop/start", () => {
  it("无循环 → {loop:null}；无 artifact → start 404；非 draft → 409；draft → 批准检查点；重复 start → 409", async () => {
    const projectId = await createProject("loop-http-start");
    expect(await getLoop(projectId)).toBeNull();

    const noArtifact = await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    expect(noArtifact.status).toBe(404);

    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("done", plannedQueries(1)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const notDraft = await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    expect(notDraft.status).toBe(409);
    expect(errorOf(notDraft.body)).toBe("LOOP_INVALID_STATE");

    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const started = await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    expect(started.status).toBe(200);
    expect(started.body["loop"]).toMatchObject({ status: "awaiting_plan_approval", rounds: [] });

    const duplicate = await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate.body)).toBe("LOOP_INVALID_STATE");
  });
});

// ---- 批准检查点：一轮真实执行 → 缺口检查点 ----

describe("POST /research/loop/plan/approve（轮次真实执行）", () => {
  it("批准 → 真实检索（fake openalex）→ 真实覆盖分析 → awaiting_gap_decision + 轮次历史", async () => {
    const projectId = await createProject("loop-http-approve");
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);

    const approved = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect(approved.status).toBe(200);
    const loop = approved.body["loop"] as LoopBody;
    expect(loop.status).toBe("awaiting_gap_decision");
    expect(loop.rounds).toHaveLength(1);
    expect(loop.rounds[0]).toMatchObject({
      planId: "rp-seed00000001",
      iterationNumber: 1,
      execution: { executedQueries: 2, failedQueries: 0 },
      coverage: { covered: 0, gaps: 2 }, // 无 evidence / promoted → 问题 partial/missing，缺口 2
    });

    // 计划链与执行历史由既有服务如实写盘；loop 与其共存
    const artifact = await readArtifact(projectId);
    expect(artifact["plan"]).toMatchObject({ status: "done" });
    expect(artifact["executionHistory"]).toHaveLength(2);
    expect(artifact["loop"]).toMatchObject({ status: "awaiting_gap_decision" });

    // 批准检查点已过：再次 approve → 409（不重复执行）
    const again = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect(again.status).toBe(409);
    expect(errorOf(again.body)).toBe("LOOP_INVALID_STATE");
  });
});

// ---- 缺口检查点：accept → derive-next → 停等下一轮批准 ----

describe("POST /research/loop/derive-next（缺口决策 → 下一轮）", () => {
  async function seedAwaitingGapDecision(projectId: string): Promise<void> {
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    const approved = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect((approved.body["loop"] as LoopBody).status).toBe("awaiting_gap_decision");
  }

  it("未 accept 任何缺口 → 409；accept 后派生 → awaiting_plan_approval + 新 draft（不自动执行）", async () => {
    const projectId = await createProject("loop-http-derive");
    await seedAwaitingGapDecision(projectId);

    const noDecision = await stack.request("POST", `/api/projects/${projectId}/research/loop/derive-next`, {});
    expect(noDecision.status).toBe(409);
    expect(errorOf(noDecision.body)).toBe("LOOP_INVALID_STATE");

    const gapsResponse = await stack.request("GET", `/api/projects/${projectId}/research/gaps`);
    const gaps = gapsResponse.body["gaps"] as Array<{ gapId: string; status: string }>;
    expect(gaps.length).toBeGreaterThan(0);
    const accepted = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gaps[0]!.gapId}/accept`);
    expect(accepted.status).toBe(200);

    const derived = await stack.request("POST", `/api/projects/${projectId}/research/loop/derive-next`, {});
    expect(derived.status).toBe(200);
    const loop = derived.body["loop"] as LoopBody;
    const plan = derived.body["plan"] as Record<string, unknown>;
    expect(plan).toMatchObject({ status: "draft", iterationNumber: 2, parentPlanId: "rp-seed00000001" });
    expect(loop.status).toBe("awaiting_plan_approval"); // HITL：派生后停等批准
    expect(loop.rounds[0]).toMatchObject({
      decided: { accepted: 1, rejected: 0 },
      derivedPlanId: plan["planId"],
    });

    // 第二轮批准 → 真实执行 → 覆盖无增长（无 evidence）→ no_new_coverage 停止
    const round2 = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect(round2.status).toBe(200);
    const afterRound2 = round2.body["loop"] as LoopBody;
    expect(afterRound2.status).toBe("completed");
    expect(afterRound2.stopReason).toBe("no_new_coverage");
    expect(afterRound2.rounds).toHaveLength(2);
    expect(afterRound2.rounds[1]).toMatchObject({ roundNumber: 2, execution: { executedQueries: 1 } });
  });
});

// ---- Loop Policy 真实停止 ----

describe("Loop Policy 停止（真实消费）", () => {
  async function seedDraft(projectId: string, queryCount: number, questions?: string[]): Promise<void> {
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(queryCount), questions),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const started = await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);
    expect(started.status).toBe(200);
  }

  it("iteration_limit：maxIterations=1 → 首轮后 completed", async () => {
    const projectId = await createProject("loop-policy-iteration");
    await seedDraft(projectId, 2);
    await putLoopPolicy(projectId, { maxIterations: 1 });

    const approved = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body["loop"]).toMatchObject({ status: "completed", stopReason: "iteration_limit" });
  });

  it("budget_exceeded：maxTotalQueries=1 → 执行 1 条后 completed；预算守卫：2 条计划 → 批准 409", async () => {
    const budgetProject = await createProject("loop-policy-budget");
    await seedDraft(budgetProject, 1);
    await putLoopPolicy(budgetProject, { maxTotalQueries: 1 });
    const approved = await stack.request("POST", `/api/projects/${budgetProject}/research/loop/plan/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body["loop"]).toMatchObject({ status: "completed", stopReason: "budget_exceeded" });

    const guardProject = await createProject("loop-policy-budget-guard");
    await seedDraft(guardProject, 2);
    await putLoopPolicy(guardProject, { maxTotalQueries: 1 });
    const rejected = await stack.request("POST", `/api/projects/${guardProject}/research/loop/plan/approve`);
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected.body)).toBe("LOOP_POLICY_VIOLATION");
    expect(await getLoop(guardProject)).toMatchObject({ status: "awaiting_plan_approval" }); // 停在检查点等编辑
  });

  it("no_open_gaps：计划无问题、报告无残差 → 结构完成", async () => {
    const projectId = await createProject("loop-policy-no-gaps");
    await seedDraft(projectId, 1, []);
    const approved = await stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body["loop"]).toMatchObject({ status: "completed", stopReason: "no_open_gaps" });
  });
});

// ---- cancel · resume ----

describe("POST /research/loop/cancel · /loop/resume", () => {
  it("缺口检查点 cancel → cancelled 落盘；终态再 cancel → 409；resume 在检查点 → 409", async () => {
    const projectId = await createProject("loop-http-cancel");
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("done", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
      loop: {
        loopId: "loop-seed00000001",
        status: "awaiting_gap_decision",
        rounds: [
          {
            roundNumber: 1,
            planId: "rp-seed00000001",
            iterationNumber: 1,
            approvedAt: "2026-09-21T08:30:00.000Z",
            execution: { executionId: "exec-seed000001", totalQueries: 2, executedQueries: 2, failedQueries: 0, completedAt: "2026-09-21T08:40:00.000Z" },
            coverage: { covered: 0, partial: 2, missing: 0, gaps: 2, analyzedAt: "2026-09-21T08:41:00.000Z" },
          },
        ],
        createdAt: "2026-09-21T08:20:00.000Z",
        updatedAt: "2026-09-21T08:41:00.000Z",
      },
    });

    const cancelled = await stack.request("POST", `/api/projects/${projectId}/research/loop/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body["loop"]).toMatchObject({ status: "cancelled" });
    expect((await readArtifact(projectId))["loop"]).toMatchObject({ status: "cancelled" });

    const again = await stack.request("POST", `/api/projects/${projectId}/research/loop/cancel`);
    expect(again.status).toBe(409);
    expect(errorOf(again.body)).toBe("LOOP_INVALID_STATE");

    const resume = await stack.request("POST", `/api/projects/${projectId}/research/loop/resume`);
    expect(resume.status).toBe(409);
  });

  it("持久化恢复：进程重启残留 running + 计划 executing → resume → awaiting_retry + 修复提示", async () => {
    const projectId = await createProject("loop-http-recovery");
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("executing", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
      loop: {
        loopId: "loop-seed00000002",
        status: "running",
        currentStep: "execute",
        rounds: [{ roundNumber: 1, planId: "rp-seed00000001", iterationNumber: 1, approvedAt: "2026-09-21T08:30:00.000Z" }],
        createdAt: "2026-09-21T08:20:00.000Z",
        updatedAt: "2026-09-21T08:31:00.000Z",
      },
    });

    const resumed = await stack.request("POST", `/api/projects/${projectId}/research/loop/resume`);
    expect(resumed.status).toBe(200);
    const loop = resumed.body["loop"] as LoopBody;
    expect(loop.status).toBe("awaiting_retry");
    expect(loop.error).toContain("改回 approved");
  });

  it("并发 resume：轮次执行中 → 409；放行后正常完成", async () => {
    const projectId = await createProject("loop-http-concurrent");
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(2)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await stack.request("POST", `/api/projects/${projectId}/research/loop/start`);

    const callsBefore = fetchCalls;
    holdNextFetches();
    const pending = stack.request("POST", `/api/projects/${projectId}/research/loop/plan/approve`);
    await waitFor(async () => fetchCalls > callsBefore); // 首条检索已被 gate 挂起

    const concurrent = await stack.request("POST", `/api/projects/${projectId}/research/loop/resume`);
    expect(concurrent.status).toBe(409);
    expect(errorOf(concurrent.body)).toBe("LOOP_INVALID_STATE");

    releaseGate?.();
    const approved = await pending;
    expect(approved.status).toBe(200);
    expect(approved.body["loop"]).toMatchObject({ status: "awaiting_gap_decision" });
  });
});

// ---- 协议边界与向后兼容 ----

describe("协议边界与向后兼容", () => {
  it("方法限制 405；项目不存在 404；旧 artifact（无 loop 字段）既有 API 不受影响", async () => {
    const projectId = await createProject("loop-http-misc");
    await seedArtifact(projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-seed",
      plan: planFixture("draft", plannedQueries(1)),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });

    const wrongMethodLoop = await stack.request("POST", `/api/projects/${projectId}/research/loop`);
    expect(wrongMethodLoop.status).toBe(405);
    const wrongMethodStart = await stack.request("GET", `/api/projects/${projectId}/research/loop/start`);
    expect(wrongMethodStart.status).toBe(405);

    const missingProject = await stack.request("POST", "/api/projects/p-missing0000001/research/loop/start");
    expect(missingProject.status).toBe(404);

    // 既有 API 照常：计划读取 / 策略默认值（含 M8.4 扩展的 maxTotalQueries）
    const plan = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body["plan"]).toMatchObject({ planId: "rp-seed00000001" });
    const policy = await stack.request("GET", `/api/projects/${projectId}/research/loop-policy`);
    expect(policy.body["loopPolicy"]).toMatchObject({ maxIterations: 5, maxQueriesPerIteration: 20, maxTotalQueries: 100 });
  });
});
