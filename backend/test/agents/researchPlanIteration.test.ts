/**
 * ResearchPlan Iteration 测试（M8.3.1 任务七-1/2/3/4/5）：
 * - Iteration schema：iterationId / parentPlanId / iterationNumber 的生成与归一化；
 * - Derive：从 done 计划派生（旧计划不动、新计划 draft、链写回、激活）；
 * - Merge strategy：research() 重跑不覆盖用户计划与执行历史（用户修改优先）；
 * - Backward compatibility：M8.1 / M8.2 旧 artifact（单一 plan、无 iteration
 *   字段）读取与派生迁移；
 * - Active plan：activate 切换 / list 列出。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { ResearcherService } from "../../src/agents/ResearcherService.js";
import { ResearchPlanIterationService } from "../../src/agents/researchPlanIteration.js";
import { RESEARCH_JSON } from "../helpers/testStack.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { BusinessError } from "../../src/errors.js";
import {
  buildDerivedPlan,
  createResearchPlan,
  maxIterationNumber,
  parseResearchPlan,
  parseResearchPlanDeriveInput,
  planChainFields,
  readPlanChain,
  resolvePlanChainOnRerun,
  type ResearchPlan,
} from "../../src/agents/researchPlan.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(title = "迭代测试项目"): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-iter-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create(title, { researchIdea: "Transformer MOT" });
  return { store, projectId: project.id };
}

async function seedArtifact(store: ProjectStore, projectId: string, artifact: Record<string, unknown>) {
  const researchDir = store.researchDir(projectId);
  await import("node:fs/promises").then((fs) => fs.mkdir(researchDir, { recursive: true }));
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact), "utf8");
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
    researchQuestions: ["问题"],
    literaturePlan: [],
  };
}

/** M8.1 / M8.2 旧形态的 plan（无 iteration 字段） */
function legacyPlan(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: "rp-legacy000001",
    status,
    questions: ["Transformer MOT 的发展脉络？"],
    queries: [
      { queryId: "q-1", query: "transformer mot survey", kind: "academic", status: "executed", resultCount: 5 },
      { queryId: "q-2", query: "mot occlusion", kind: "web", status: "planned" },
    ],
    createdAt: "2026-09-19T08:00:00.000Z",
    updatedAt: "2026-09-19T08:00:00.000Z",
    ...overrides,
  };
}

// ---- 任务七-1：Iteration schema ----

describe("Iteration schema（iterationId / parentPlanId / iterationNumber）", () => {
  it("新建 / 解析的首轮计划：iterationNumber=1、iterationId 后端生成、无 parentPlanId", () => {
    const created = createResearchPlan(["q1"], [{ query: "mot", kind: "academic" }]);
    expect(created.iterationNumber).toBe(1);
    expect(created.iterationId).toMatch(/^it-[a-z0-9]{12}$/);
    expect(created.parentPlanId).toBeUndefined();

    const parsed = parseResearchPlan({
      plan: { questions: ["q1"], queries: [{ query: "mot", kind: "web" }] },
    })!;
    expect(parsed.iterationNumber).toBe(1);
    expect(parsed.iterationId).toMatch(/^it-[a-z0-9]{12}$/);
    expect(parsed.parentPlanId).toBeUndefined();
  });

  it("旧 artifact（M8.1 / M8.2 单一 plan、无 iteration 字段）：readPlanChain 归一化为单轮链", () => {
    const chain = readPlanChain({ plan: legacyPlan("done") as unknown as ResearchPlan });
    expect(chain.plans).toHaveLength(1);
    expect(chain.activePlanId).toBe("rp-legacy000001");
    expect(chain.plans[0]).toMatchObject({
      planId: "rp-legacy000001",
      iterationNumber: 1,
      iterationId: "rp-legacy000001", // 旧计划以 planId 充当线索 id（稳定）
    });
    expect(chain.plans[0]!.parentPlanId).toBeUndefined();
  });

  it("M8.3.1 形态（plans + activePlanId）：按 iterationNumber 升序；activePlanId 失效回落最新一轮", () => {
    const v1 = { ...createResearchPlan(["q1"], []), iterationNumber: 1, status: "done" as const };
    const v2 = { ...createResearchPlan(["q2"], []), iterationNumber: 2, status: "draft" as const };
    const ordered = readPlanChain({ plans: [v2, v1], activePlanId: v2.planId });
    expect(ordered.plans.map((plan) => plan.iterationNumber)).toEqual([1, 2]);
    expect(ordered.activePlanId).toBe(v2.planId);

    const healed = readPlanChain({ plans: [v2, v1], activePlanId: "rp-missing00000" });
    expect(healed.activePlanId).toBe(v2.planId); // 最新一轮自愈
  });

  it("planChainFields：空链不产字段；有链时 plan（active 视图）/ plans / activePlanId 三者同产", () => {
    expect(planChainFields({ plans: [], activePlanId: undefined })).toEqual({});
    const v1 = createResearchPlan(["q1"], []);
    const v2 = createResearchPlan(["q2"], []);
    const chain = { plans: [v1, v2], activePlanId: v2.planId };
    expect(planChainFields(chain)).toEqual({ plan: v2, plans: [v1, v2], activePlanId: v2.planId });
  });

  it("maxIterationNumber：空链 0，多轮取最大", () => {
    expect(maxIterationNumber([])).toBe(0);
    const v1 = createResearchPlan(["q1"], []);
    const v3 = { ...createResearchPlan(["q3"], []), iterationNumber: 3 };
    expect(maxIterationNumber([v1, v3])).toBe(3);
  });
});

describe("buildDerivedPlan / parseResearchPlanDeriveInput（派生领域逻辑）", () => {
  const source: ResearchPlan = {
    ...createResearchPlan(
      ["问题一"],
      [
        { query: "mot survey", kind: "academic", rationale: "理由", expectedCoverage: "综述" },
        { query: "mot occlusion", kind: "web" },
      ],
    ),
    status: "done",
  };
  // 模拟执行回填
  source.queries[0]!.status = "executed";
  source.queries[0]!.resultCount = 7;

  it("缺省整拷来源：questions / queries 复制，检索重置 planned、丢 resultCount、重分配 queryId", () => {
    const derived = buildDerivedPlan(source, 2, {});
    expect(derived.status).toBe("draft");
    expect(derived.parentPlanId).toBe(source.planId);
    expect(derived.iterationNumber).toBe(2);
    expect(derived.iterationId).toBe(source.iterationId); // 线索继承
    expect(derived.questions).toEqual(source.questions);
    expect(derived.queries).toHaveLength(2);
    expect(derived.queries[0]).toMatchObject({
      queryId: "q-1",
      query: "mot survey",
      kind: "academic",
      rationale: "理由",
      status: "planned",
    });
    expect(derived.queries[0]!.resultCount).toBeUndefined(); // 执行状态不跨轮继承
    expect(derived.planId).not.toBe(source.planId);
  });

  it("提供 questions / queries 时覆盖来源", () => {
    const derived = buildDerivedPlan(source, 3, {
      questions: ["新方向"],
      queries: [{ query: "新检索", kind: "web", rationale: "缺口驱动" }],
    });
    expect(derived.iterationNumber).toBe(3);
    expect(derived.questions).toEqual(["新方向"]);
    expect(derived.queries).toEqual([
      { queryId: "q-1", query: "新检索", kind: "web", rationale: "缺口驱动", status: "planned" },
    ]);
  });

  it("derive 输入校验：空体合法；queryId / status 不被接受；非法条目 → INVALID_REQUEST", () => {
    expect(parseResearchPlanDeriveInput({})).toEqual({});
    expect(parseResearchPlanDeriveInput({ questions: ["a"] })).toEqual({ questions: ["a"] });

    const rejects: Array<[string, Record<string, unknown>]> = [
      ["携带 queryId", { queries: [{ queryId: "q-1", query: "x", kind: "web" }] }],
      ["携带 status", { queries: [{ query: "x", kind: "web", status: "planned" }] }],
      ["空 query", { queries: [{ query: " ", kind: "web" }] }],
      ["非法 kind", { queries: [{ query: "x", kind: "library" }] }],
      ["questions 非数组", { questions: "x" }],
    ];
    for (const [name, body] of rejects) {
      expect(() => parseResearchPlanDeriveInput(body), name).toThrow(BusinessError);
    }
  });
});

// ---- 任务七-3：Merge strategy（research() 重跑不覆盖用户修改）----

/** 与 AgentServices.test.ts 同风格的 fake Runtime：按调用返回固定 JSON */
function runtimeReturning(output: () => string): AgentRuntime {
  const makeTask = (agentId: string): AgentTask => ({
    taskId: "run-iter-test",
    agentId,
    status: "completed",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    output: output(),
  });
  return {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    startAgent: async () => {
      throw new Error("unused");
    },
    runAgent: async (input) => makeTask(input.agentId),
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}

function researcherOutputWithPlan(): string {
  const output = JSON.parse(RESEARCH_JSON) as Record<string, unknown>;
  output["plan"] = {
    questions: ["Agent 重跑产出的新问题"],
    queries: [{ query: "agent rerun query", kind: "academic", rationale: "重跑理由" }],
  };
  return JSON.stringify(output);
}

describe("Merge strategy：research() 重跑（用户修改优先）", () => {
  it("已有计划链：用户编辑的计划（done）与 executionHistory 不被覆盖，报告侧刷新", async () => {
    const { store, projectId } = await newProject("merge-rerun");
    await seedArtifact(store, projectId, {
      generatedAt: "2026-09-18T08:00:00.000Z",
      taskId: "run-old",
      plan: legacyPlan("done", { questions: ["用户改过的问题"] }),
      executionHistory: [
        {
          executionId: "exec-seed0000001",
          queryId: "q-1",
          query: "transformer mot survey",
          kind: "academic",
          timestamp: "2026-09-18T09:00:00.000Z",
          status: "executed",
          resultCount: 5,
        },
      ],
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });

    const researcher = new ResearcherService({
      runtime: runtimeReturning(researcherOutputWithPlan),
      agentId: "researcher",
      projects: store,
      evidence: new EvidenceStore(store),
      sources: new SourceStore(store),
      log: () => {},
    });
    const result = await researcher.research({ projectId: projectId });

    const artifact = await readArtifact(store, projectId);
    // 计划链原样保留（用户修改优先）：status / questions / queries 不变
    const plan = artifact["plan"] as ResearchPlan;
    expect(plan.status).toBe("done");
    expect(plan.questions).toEqual(["用户改过的问题"]);
    expect(plan.queries[0]).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 5 });
    // Agent 重跑产出的新 plan 不落盘（防止隐式改写用户计划）
    expect((artifact["plans"] as ResearchPlan[])).toHaveLength(1);
    expect(result.plan!.questions).toEqual(["Agent 重跑产出的新问题"]); // 响应仍如实返回本轮产出
    // 执行历史保留
    expect((artifact["executionHistory"] as unknown[]) ?? []).toHaveLength(1);
    // 报告侧刷新为新一次运行的结果
    expect((artifact["report"] as { domainOverview: string }).domainOverview).toContain("检索增强生成");
    expect(artifact["taskId"]).toBe("run-iter-test");
  });

  it("首跑（无 artifact）：Agent plan 初始化 iteration 1（M8.1 语义保持）", async () => {
    const { store, projectId } = await newProject("merge-first-run");
    const researcher = new ResearcherService({
      runtime: runtimeReturning(researcherOutputWithPlan),
      agentId: "researcher",
      projects: store,
      evidence: new EvidenceStore(store),
      sources: new SourceStore(store),
      log: () => {},
    });
    await researcher.research({ projectId: projectId });

    const artifact = await readArtifact(store, projectId);
    const plan = artifact["plan"] as ResearchPlan;
    expect(plan.iterationNumber).toBe(1);
    expect(plan.questions).toEqual(["Agent 重跑产出的新问题"]);
    expect(artifact["activePlanId"]).toBe(plan.planId);
    expect((artifact["plans"] as ResearchPlan[])).toHaveLength(1);
  });

  it("resolvePlanChainOnRerun 纯函数三分支", () => {
    const existing = readPlanChain({ plan: legacyPlan("done") as unknown as ResearchPlan });
    const generated = createResearchPlan(["g"], []);
    expect(resolvePlanChainOnRerun(existing, generated)).toBe(existing); // 已有链 → 原样
    expect(resolvePlanChainOnRerun({ plans: [], activePlanId: undefined }, generated)).toEqual({
      plans: [generated],
      activePlanId: generated.planId,
    });
    expect(
      resolvePlanChainOnRerun({ plans: [], activePlanId: undefined }, undefined),
    ).toEqual({ plans: [], activePlanId: undefined });
  });
});

// ---- 任务七-2 / 5：Derive 服务与 Active plan ----

describe("ResearchPlanIterationService：derive / activate / list", () => {
  function service(store: ProjectStore): ResearchPlanIterationService {
    return new ResearchPlanIterationService({ projects: store, log: () => {} });
  }

  it("derive：旧计划保持 done 原样、新计划 draft 且自动激活，链完整写回", async () => {
    const { store, projectId } = await newProject("derive-ok");
    await seedArtifact(store, projectId, {
      generatedAt: "2026-09-19T08:00:00.000Z",
      taskId: "run-seed",
      plan: legacyPlan("done"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });

    const derived = await service(store).derive(projectId, "rp-legacy000001", {});
    expect(derived.status).toBe("draft");
    expect(derived.parentPlanId).toBe("rp-legacy000001");
    expect(derived.iterationNumber).toBe(2);
    expect(derived.iterationId).toBe("rp-legacy000001"); // 旧计划线索 id（planId 充当）被继承
    expect(derived.queries[0]).toMatchObject({ query: "transformer mot survey", status: "planned" });
    expect(derived.queries[0]!.resultCount).toBeUndefined();

    const artifact = await readArtifact(store, projectId);
    const plans = artifact["plans"] as ResearchPlan[];
    expect(plans).toHaveLength(2);
    // 旧计划不动：status / questions / 执行回填全保持
    expect(plans[0]).toMatchObject({
      planId: "rp-legacy000001",
      status: "done",
      iterationNumber: 1,
      questions: ["Transformer MOT 的发展脉络？"],
    });
    expect(plans[0]!.queries[0]).toMatchObject({ status: "executed", resultCount: 5 });
    // 新计划成为活动计划；plan 兼容视图同步
    expect(artifact["activePlanId"]).toBe(derived.planId);
    expect((artifact["plan"] as ResearchPlan).planId).toBe(derived.planId);
  });

  it("derive 携带新 questions / queries：覆盖整拷", async () => {
    const { store, projectId } = await newProject("derive-override");
    await seedArtifact(store, projectId, {
      plan: legacyPlan("done"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const derived = await service(store).derive(projectId, "rp-legacy000001", {
      questions: ["知识缺口驱动的新问题"],
      queries: [{ query: "mot domain adaptation", kind: "academic" }],
    });
    expect(derived.questions).toEqual(["知识缺口驱动的新问题"]);
    expect(derived.queries).toEqual([
      { queryId: "q-1", query: "mot domain adaptation", kind: "academic", status: "planned" },
    ]);
  });

  it("derive 状态与存在性：非 done → 409；planId 不存在 / 无计划 / 无 artifact → 404", async () => {
    const draftProject = await newProject("derive-draft");
    await seedArtifact(draftProject.store, draftProject.projectId, {
      plan: legacyPlan("draft"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await expect(
      service(draftProject.store).derive(draftProject.projectId, "rp-legacy000001", {}),
    ).rejects.toMatchObject({ code: "PLAN_INVALID_STATE", httpStatus: 409 });

    await expect(
      service(draftProject.store).derive(draftProject.projectId, "rp-missing00000", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });

    const noPlan = await newProject("derive-no-plan");
    await seedArtifact(noPlan.store, noPlan.projectId, {
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await expect(
      service(noPlan.store).derive(noPlan.projectId, "rp-legacy000001", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });

    const noArtifact = await newProject("derive-no-artifact");
    await expect(
      service(noArtifact.store).derive(noArtifact.projectId, "rp-legacy000001", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("activate：切换活动计划；planId 不存在 → 404；已是活动计划幂等返回", async () => {
    const { store, projectId } = await newProject("activate-ok");
    await seedArtifact(store, projectId, {
      plan: legacyPlan("done"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const iteration = service(store);
    const derived = await iteration.derive(projectId, "rp-legacy000001", {});

    // 切回历史计划 v1
    const activated = await iteration.activate(projectId, "rp-legacy000001");
    expect(activated.planId).toBe("rp-legacy000001");
    const artifact = await readArtifact(store, projectId);
    expect(artifact["activePlanId"]).toBe("rp-legacy000001");
    expect((artifact["plan"] as ResearchPlan).planId).toBe("rp-legacy000001");
    // 幂等：再激活当前活动计划，不报错
    expect((await iteration.activate(projectId, "rp-legacy000001")).planId).toBe("rp-legacy000001");
    // 派生计划仍在链中
    expect(((artifact["plans"] as ResearchPlan[]).map((p) => p.planId))).toContain(derived.planId);

    await expect(iteration.activate(projectId, "rp-missing00000")).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("list：无 artifact → 空链；旧 artifact → 归一化单轮；多轮 → 全量升序", async () => {
    const empty = await newProject("list-empty");
    expect(await service(empty.store).list(empty.projectId)).toEqual({
      plans: [],
      activePlanId: undefined,
    });

    const legacy = await newProject("list-legacy");
    await seedArtifact(legacy.store, legacy.projectId, {
      plan: legacyPlan("done"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const legacyChain = await service(legacy.store).list(legacy.projectId);
    expect(legacyChain.plans).toHaveLength(1);
    expect(legacyChain.activePlanId).toBe("rp-legacy000001");

    const multi = await newProject("list-multi");
    await seedArtifact(multi.store, multi.projectId, {
      plan: legacyPlan("done"),
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    const iteration = service(multi.store);
    await iteration.derive(multi.projectId, "rp-legacy000001", {});
    await iteration.derive(multi.projectId, "rp-legacy000001", { questions: ["第三轮"] });
    const chain = await iteration.list(multi.projectId);
    expect(chain.plans.map((plan) => plan.iterationNumber)).toEqual([1, 2, 3]);
    expect(chain.activePlanId).toBe(chain.plans[2]!.planId);
  });

  it("backward compatibility：M8.2 artifact（plan + executionHistory）派生后执行历史保留", async () => {
    const { store, projectId } = await newProject("derive-keep-history");
    await seedArtifact(store, projectId, {
      plan: legacyPlan("done"),
      executionHistory: [
        {
          executionId: "exec-seed0000001",
          queryId: "q-1",
          query: "transformer mot survey",
          kind: "academic",
          timestamp: "2026-09-18T09:00:00.000Z",
          status: "executed",
          resultCount: 5,
        },
      ],
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    await service(store).derive(projectId, "rp-legacy000001", {});
    const artifact = await readArtifact(store, projectId);
    expect((artifact["executionHistory"] as unknown[]) ?? []).toHaveLength(1);
  });
});
