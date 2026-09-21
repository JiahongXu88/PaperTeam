/**
 * Research Artifact 审计测试（M8.5 §6 Artifact Audit + §8 Evidence Boundary）。
 *
 * §6 Artifact Audit——research.json 全链路可追溯与不丢数据：
 * 1. Backward Compatibility：M8.1（单一 plan）/ M8.2（+executionHistory）/
 *    M8.3（+gaps / loopPolicy）/ M8.4（+loop）四种历史形态全部可读；
 * 2. Write-path No-loss：计划链写盘（writeResearchPlanChain）不冲掉 gaps /
 *    loopPolicy / loop；循环状态写盘（writeResearchLoopState）不冲掉计划链
 *    与执行历史——rerun / 迭代 / 循环互不覆盖；
 * 3. Full Pipeline Traceability：真实 loop 轮次（start → approve → execute →
 *    coverage → accept gap → derive-next）后 research.json 内 Plan → Execution
 *    → Coverage（派生视图按需重算）→ Gap → Loop 五层数据完整可追。
 *
 * §8 Evidence Boundary——Retrieved ≠ Candidate ≠ Literature ≠ Verified Evidence：
 * - Loop 全程（含真实检索执行）不创建 Candidate、不 promote Literature、
 *   不生成 Verified Evidence（文件系统层面验证三处 Store 均未落盘）；
 * - executionHistory 的 resultIdentifiers 只是审计痕迹，不是候选。
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { readPlanChain } from "../../src/agents/researchPlan.js";
import { readLoopStateFrom } from "../../src/agents/researchLoop.js";
import {
  readResearchArtifact,
  writeResearchLoopState,
  writeResearchPlanChain,
} from "../../src/agents/ResearcherService.js";
import { readResearchLoopPolicyFrom } from "../../src/agents/researchLoopPolicy.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import type { PlanExecutionEntry } from "../../src/agents/researchPlanExecution.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function seedArtifactFile(
  store: ProjectStore,
  projectId: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  const researchDir = store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function newSeededProject(
  artifact: Record<string, unknown>,
): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-audit-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("审计测试", { researchIdea: "deep research" });
  await seedArtifactFile(store, project.id, artifact);
  return { store, projectId: project.id };
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

/** M8.1 旧形态：单一 plan（无 iteration 字段）、无 executionHistory */
function m81Artifact(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-10T08:00:00.000Z",
    taskId: "run-m81",
    plan: {
      planId: "rp-m81000000001",
      status: "done",
      questions: ["Q1"],
      queries: [{ queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "executed", resultCount: 3 }],
      createdAt: "2026-09-10T08:00:00.000Z",
      updatedAt: "2026-09-10T08:00:00.000Z",
    },
    report: reportFixture(),
    evidence: [],
    bibliography: [],
  };
}

/** M8.4 形态：完整计划链 + 执行历史 + gaps + loopPolicy + loop */
function m84Artifact(): Record<string, unknown> {
  return {
    ...m81Artifact(),
    plans: [
      {
        planId: "rp-m81000000001",
        iterationId: "it-m84000000001",
        iterationNumber: 1,
        status: "done",
        questions: ["Q1"],
        queries: [{ queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "executed", resultCount: 3 }],
        createdAt: "2026-09-10T08:00:00.000Z",
        updatedAt: "2026-09-10T08:00:00.000Z",
      },
      {
        planId: "rp-m84000000002",
        iterationId: "it-m84000000001",
        parentPlanId: "rp-m81000000001",
        iterationNumber: 2,
        status: "draft",
        questions: ["Q1"],
        queries: [{ queryId: "q-1", query: "knowledge graph", kind: "academic", status: "planned" }],
        createdAt: "2026-09-11T08:00:00.000Z",
        updatedAt: "2026-09-11T08:00:00.000Z",
      },
    ],
    activePlanId: "rp-m84000000002",
    executionHistory: [
      {
        executionId: "exec-m8400000001",
        queryId: "q-1",
        query: "multi-agent survey",
        kind: "academic",
        timestamp: "2026-09-10T08:01:00.000Z",
        status: "executed",
        resultCount: 3,
        planId: "rp-m81000000001",
      },
    ] satisfies PlanExecutionEntry[],
    gaps: [
      {
        gapId: "gap-m84000000001",
        question: "Q1",
        description: "有检索但无证据支撑",
        severity: "low",
        status: "accepted",
        suggestedQueries: ["knowledge graph reasoning"],
        decidedAt: "2026-09-11T08:00:00.000Z",
      },
    ],
    loopPolicy: {
      maxQueriesPerIteration: 10,
      maxTotalQueries: 50,
      maxIterations: 5,
      stopConditions: ["iteration_limit", "budget_exceeded"],
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
    loop: {
      loopId: "loop-m8400000001",
      status: "awaiting_gap_decision",
      rounds: [
        {
          roundNumber: 1,
          planId: "rp-m81000000001",
          iterationNumber: 1,
          approvedAt: "2026-09-11T07:00:00.000Z",
          execution: {
            executionId: "exec-m8400000001",
            totalQueries: 1,
            executedQueries: 1,
            failedQueries: 0,
            completedAt: "2026-09-11T07:01:00.000Z",
          },
          coverage: { covered: 0, partial: 1, missing: 0, gaps: 1, analyzedAt: "2026-09-11T07:02:00.000Z" },
        },
      ],
      createdAt: "2026-09-11T07:00:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
  };
}

// ---- §6.1 Backward Compatibility：四种历史形态全部可读 ----

describe("Artifact Audit：旧 artifact 兼容读取", () => {
  it("M8.1 形态（单一 plan、无 iteration 字段）：readPlanChain 归一化为单轮链 iteration=1", async () => {
    const { store, projectId } = await newSeededProject(m81Artifact());
    const artifact = await readResearchArtifact(store, projectId);
    expect(artifact).not.toBeNull();
    const chain = readPlanChain(artifact!);
    expect(chain.plans).toHaveLength(1);
    expect(chain.activePlanId).toBe("rp-m81000000001");
    expect(chain.plans[0]).toMatchObject({ iterationNumber: 1, iterationId: "rp-m81000000001" });
    // 无 executionHistory / gaps / loopPolicy / loop 字段 = 各自的空态，不报错
    expect(artifact!.executionHistory).toBeUndefined();
    expect(readLoopStateFrom(artifact!)).toBeNull();
  });

  it("M8.2 形态（+ executionHistory）：历史可读且 queryId / resultCount 完整", async () => {
    const { store, projectId } = await newSeededProject({
      ...m81Artifact(),
      executionHistory: (m84Artifact().executionHistory as PlanExecutionEntry[]),
    });
    const artifact = await readResearchArtifact(store, projectId);
    expect(artifact!.executionHistory).toHaveLength(1);
    expect(artifact!.executionHistory![0]).toMatchObject({
      executionId: "exec-m8400000001",
      status: "executed",
      resultCount: 3,
    });
  });

  it("M8.3 形态（+ gaps / loopPolicy）：缺口决策与策略可读", async () => {
    const { store, projectId } = await newSeededProject({
      ...m81Artifact(),
      gaps: m84Artifact().gaps,
      loopPolicy: m84Artifact().loopPolicy,
    });
    const artifact = await readResearchArtifact(store, projectId);
    expect(artifact!.gaps?.[0]).toMatchObject({ gapId: "gap-m84000000001", status: "accepted" });
    expect(readResearchLoopPolicyFrom(artifact!).maxTotalQueries).toBe(50);
  });

  it("M8.4 形态（+ loop + 计划链）：循环状态与多轮链可读", async () => {
    const { store, projectId } = await newSeededProject(m84Artifact());
    const artifact = await readResearchArtifact(store, projectId);
    const chain = readPlanChain(artifact!);
    expect(chain.plans.map((plan) => plan.iterationNumber)).toEqual([1, 2]);
    expect(chain.activePlanId).toBe("rp-m84000000002");
    const loop = readLoopStateFrom(artifact!);
    expect(loop).toMatchObject({ loopId: "loop-m8400000001", status: "awaiting_gap_decision" });
    expect(loop!.rounds[0]).toMatchObject({
      planId: "rp-m81000000001",
      execution: { executedQueries: 1, failedQueries: 0 },
      coverage: { partial: 1, gaps: 1 },
    });
  });
});

// ---- §6.2 Write-path No-loss：写盘互不覆盖 ----

describe("Artifact Audit：写盘路径不丢数据", () => {
  it("writeResearchPlanChain（计划演化写盘）保留 gaps / loopPolicy / loop / executionHistory", async () => {
    const { store, projectId } = await newSeededProject(m84Artifact());
    const artifact = (await readResearchArtifact(store, projectId))!;
    const chain = readPlanChain(artifact);
    // 模拟一次计划编辑写盘（只动链）
    const edited = chain.plans.map((plan) =>
      plan.planId === chain.activePlanId ? { ...plan, updatedAt: "2026-09-12T08:00:00.000Z" } : plan,
    );
    await writeResearchPlanChain(store, projectId, artifact, { plans: edited, activePlanId: chain.activePlanId }, artifact.executionHistory);

    const next = (await readResearchArtifact(store, projectId))!;
    expect(next.gaps).toHaveLength(1); // 缺口决策不被冲掉
    expect(readResearchLoopPolicyFrom(next).maxIterations).toBe(5); // 策略不被冲掉
    expect(readLoopStateFrom(next)?.rounds).toHaveLength(1); // 循环状态不被冲掉
    expect(next.executionHistory).toHaveLength(1); // 执行历史不被冲掉
  });

  it("writeResearchLoopState（循环状态写盘）保留计划链 / executionHistory / gaps", async () => {
    const { store, projectId } = await newSeededProject(m84Artifact());
    const artifact = (await readResearchArtifact(store, projectId))!;
    const loop = readLoopStateFrom(artifact)!;
    await writeResearchLoopState(store, projectId, artifact, {
      loop: { ...loop, status: "cancelled", cancelledAt: "2026-09-12T08:00:00.000Z" },
    });

    const next = (await readResearchArtifact(store, projectId))!;
    const chain = readPlanChain(next);
    expect(chain.plans).toHaveLength(2); // 计划链不被循环写盘冲掉
    expect(next.executionHistory).toHaveLength(1); // 执行历史保留
    expect(next.gaps).toHaveLength(1); // 缺口决策保留
    expect(readLoopStateFrom(next)?.status).toBe("cancelled"); // 本次写入生效
  });
});

// ---- §6.3 Full Pipeline Traceability + §8 Evidence Boundary（真实栈） ----

const openalexFake = {
  results: [
    {
      id: "https://openalex.org/W111",
      title: "Multi-Agent Systems Survey",
      doi: "https://doi.org/10.1234/mas-survey",
      publication_year: 2023,
    },
    {
      id: "https://openalex.org/W222",
      title: "LLM Agents Retrospective",
      doi: "https://doi.org/10.1234/llm-retro",
      publication_year: 2024,
    },
  ],
};

const okFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

describe("Full Pipeline Traceability（真实 loop 轮次：Plan → Execution → Coverage → Gap → Loop）", () => {
  let stack: TestStack;
  let projectId: string;

  beforeAll(async () => {
    stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      search: {
        disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
        providerTimeoutMs: 1_000,
        fetchImpl: okFetch as unknown as typeof fetch,
      },
    });
    const response = await stack.request("POST", "/api/projects", { title: "全链路审计" });
    projectId = (response.body["project"] as { id: string }).id;
    // Q1 有相关检索（partial 缺口）；Q2 无任何相关检索（missing 缺口）
    await seedArtifactFile(stack.store, projectId, {
      generatedAt: "2026-09-21T08:00:00.000Z",
      taskId: "run-audit",
      plan: {
        planId: "rp-audit00000001",
        status: "draft",
        questions: ["multi-agent systems survey", "knowledge graph reasoning"],
        queries: [
          { queryId: "q-1", query: "multi-agent systems survey", kind: "academic", status: "planned", rationale: "Q1" },
        ],
        createdAt: "2026-09-21T08:00:00.000Z",
        updatedAt: "2026-09-21T08:00:00.000Z",
      },
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await stack.stack.loop.start(projectId);
    await stack.stack.loop.approvePlan(projectId); // 批准 → 真实检索执行 → 覆盖分析
  });
  afterAll(async () => {
    await stack.cleanup();
  });

  it("轮次执行后：executionHistory 带 M8.5 审计字段（providers / resultIdentifiers）", async () => {
    const artifact = await readResearchArtifact(stack.store, projectId);
    const entry = artifact!.executionHistory?.[0];
    expect(entry).toMatchObject({
      queryId: "q-1",
      status: "executed",
      resultCount: 2,
      planId: "rp-audit00000001",
    });
    expect(entry!.providers).toEqual([
      expect.objectContaining({ provider: "openalex", outcome: "ok", resultCount: 2 }),
    ]);
    expect(entry!.resultIdentifiers).toEqual(["doi:10.1234/mas-survey", "doi:10.1234/llm-retro"]);
  });

  it("循环停在缺口决策检查点：loop 轮次快照（execution + coverage）完整落盘", async () => {
    const artifact = await readResearchArtifact(stack.store, projectId);
    const loop = readLoopStateFrom(artifact!)!;
    expect(loop.status).toBe("awaiting_gap_decision");
    expect(loop.rounds).toHaveLength(1);
    expect(loop.rounds[0]).toMatchObject({
      planId: "rp-audit00000001",
      execution: { executedQueries: 1, failedQueries: 0 },
      coverage: { partial: 1, missing: 1, gaps: 2 },
    });
  });

  it("缺口确认 + 派生下一轮：五层数据（链 / 历史 / 缺口 / 策略 / 循环）一次可追、互不覆盖", async () => {
    const gaps = await stack.stack.gaps.list(projectId);
    expect(gaps.gaps.length).toBe(2);
    const accepted = gaps.gaps[0]!;
    await stack.stack.gaps.accept(projectId, accepted.gapId);

    const { loop } = await stack.stack.loop.deriveNextPlan(projectId, {});
    expect(loop.status).toBe("awaiting_plan_approval");

    const artifact = await readResearchArtifact(stack.store, projectId);
    const chain = readPlanChain(artifact!);
    // 计划链：两轮（done 首轮 + draft 次轮），活动计划切到新轮
    expect(chain.plans.map((plan) => plan.status)).toEqual(["done", "draft"]);
    expect(chain.activePlanId).toBe(chain.plans[1]!.planId);
    expect(chain.plans[1]!.parentPlanId).toBe("rp-audit00000001");
    // 执行历史仍在（首轮审计可追）
    expect(artifact!.executionHistory).toHaveLength(1);
    // 缺口决策已落盘（accepted）
    expect(artifact!.gaps?.find((gap) => gap.gapId === accepted.gapId)?.status).toBe("accepted");
    // 循环轮次的决策与派生指向完整
    const loopState = readLoopStateFrom(artifact!)!;
    expect(loopState.rounds[0]).toMatchObject({
      decided: { accepted: 1, rejected: 0 },
      derivedPlanId: chain.plans[1]!.planId,
    });
  });

  it("§8 Evidence Boundary：Loop 全程不创建 Candidate / Literature / Verified Evidence", async () => {
    const projectRoot = join(stack.root, projectId);
    // Discovery 候选未落盘（save_candidates 未发生 → 文件不存在，而非空文件）
    expect(existsSync(join(projectRoot, "sources", "candidates.json"))).toBe(false);
    // 文献库（promote 未发生）
    expect(existsSync(join(projectRoot, "sources", "index.json"))).toBe(false);
    // EvidenceStore（含 verified evidence）未落盘
    expect(existsSync(join(projectRoot, "evidence", "evidence.jsonl"))).toBe(false);
    // HTTP 口径复核：候选 / 文献 / 证据三个 Store 均为空
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect(candidates.body["candidates"]).toEqual([]);
    const sources = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect((sources.body["sources"] as unknown[]) ?? []).toEqual([]);
    const evidence = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    expect((evidence.body["evidence"] as unknown[]) ?? []).toEqual([]);
  });
});
