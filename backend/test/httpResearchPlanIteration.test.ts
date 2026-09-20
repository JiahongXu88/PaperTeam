/**
 * Research Plan Iteration HTTP API 集成测试（M8.3.1 任务七-2/4/5 的 HTTP 面）：
 *   GET  /api/projects/:id/research/plans                  → { plans, activePlanId }
 *   POST /api/projects/:id/research/plan/:planId/derive    → { plan }（done → 新 draft）
 *   POST /api/projects/:id/research/plan/:planId/activate  → { plan }（切换活动计划）
 *
 * 覆盖：空态 / 旧 artifact 归一化 / 多轮列表；derive 成功（旧计划不动、新计划
 * 激活）与 409/404/400/405；activate 切换与幂等；M8.1/M8.2 旧 artifact 兼容
 * （读取 + 派生迁移）；项目不存在 404。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "./helpers/testStack.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime);
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
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact), "utf8");
}

async function readArtifact(projectId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(stack.store.researchDir(projectId), "research.json"), "utf8"),
  ) as Record<string, unknown>;
}

function reportFixture(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-20T08:00:00.000Z",
    taskId: "run-seed",
    report: {
      domainOverview: "调研概述",
      relatedWorkDirections: [],
      researchGaps: ["gap"],
      potentialContributions: ["贡献"],
      researchQuestions: ["问题"],
      literaturePlan: [],
    },
    evidence: [],
    bibliography: [],
  };
}

/** M8.1 / M8.2 旧形态：单一 plan 字段、无 iteration 字段 */
function legacyPlan(status: string, planId = "rp-seed00000001"): Record<string, unknown> {
  return {
    planId,
    status,
    questions: ["Transformer MOT survey?"],
    queries: [
      { queryId: "q-1", query: "transformer mot survey", kind: "academic", status: "executed", resultCount: 3 },
    ],
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-20T08:00:00.000Z",
  };
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
}

describe("GET /api/projects/:id/research/plans", () => {
  it("无 artifact / 旧 artifact 无 plan → 200 空链（空态而非错误）", async () => {
    const emptyProject = await createProject("plans-empty");
    const empty = await stack.request("GET", `/api/projects/${emptyProject}/research/plans`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ plans: [], activePlanId: null });

    const noPlanProject = await createProject("plans-no-plan");
    await seedArtifact(noPlanProject, reportFixture());
    const noPlan = await stack.request("GET", `/api/projects/${noPlanProject}/research/plans`);
    expect(noPlan.status).toBe(200);
    expect(noPlan.body).toEqual({ plans: [], activePlanId: null });
  });

  it("旧 artifact（单一 plan）：归一化为单轮链（iterationNumber=1、iterationId=planId）", async () => {
    const projectId = await createProject("plans-legacy");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });

    const response = await stack.request("GET", `/api/projects/${projectId}/research/plans`);
    expect(response.status).toBe(200);
    const plans = response.body["plans"] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      planId: "rp-seed00000001",
      iterationNumber: 1,
      iterationId: "rp-seed00000001",
      status: "done",
    });
    expect(response.body["activePlanId"]).toBe("rp-seed00000001");
  });

  it("项目不存在 → 404 PROJECT_NOT_FOUND；非 GET → 405", async () => {
    const missing = await stack.request("GET", "/api/projects/p-none000000001/research/plans");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("PROJECT_NOT_FOUND");

    const projectId = await createProject("plans-405");
    const wrongMethod = await stack.request("POST", `/api/projects/${projectId}/research/plans`, {});
    expect(wrongMethod.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/plan/:planId/derive", () => {
  it("done 计划派生成功：新 draft 自动激活，旧计划保持 done，GET /plans 反映两轮", async () => {
    const projectId = await createProject("derive-ok");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    expect(response.status).toBe(200);
    const plan = response.body["plan"] as Record<string, unknown>;
    expect(plan).toMatchObject({
      status: "draft",
      parentPlanId: "rp-seed00000001",
      iterationNumber: 2,
      iterationId: "rp-seed00000001",
    });
    expect(plan["planId"]).toMatch(/^rp-[a-z0-9]{12}$/);
    // 检索重置 planned、执行回填不继承
    expect((plan["queries"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      query: "transformer mot survey",
      status: "planned",
    });

    const artifact = await readArtifact(projectId);
    const plans = artifact["plans"] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ planId: "rp-seed00000001", status: "done" }); // 旧计划不动
    expect(artifact["activePlanId"]).toBe(plan["planId"]);
    expect((artifact["plan"] as Record<string, unknown>)["planId"]).toBe(plan["planId"]); // 兼容视图同步

    const listed = await stack.request("GET", `/api/projects/${projectId}/research/plans`);
    expect((listed.body["plans"] as unknown[]).length).toBe(2);
    expect(listed.body["activePlanId"]).toBe(plan["planId"]);
  });

  it("携带新的 questions / queries：覆盖整拷（知识缺口 → 调整研究方向）", async () => {
    const projectId = await createProject("derive-new-direction");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      {
        questions: ["遮挡场景下的身份保持如何解决？"],
        queries: [
          { query: "mot identity preservation occlusion", kind: "academic", rationale: "缺口驱动" },
        ],
      },
    );
    expect(response.status).toBe(200);
    const plan = response.body["plan"] as Record<string, unknown>;
    expect(plan["questions"]).toEqual(["遮挡场景下的身份保持如何解决？"]);
    expect(plan["queries"]).toEqual([
      {
        queryId: "q-1",
        query: "mot identity preservation occlusion",
        kind: "academic",
        rationale: "缺口驱动",
        status: "planned",
      },
    ]);
  });

  it("状态与存在性：非 done → 409；planId 不存在 / 无计划 / 无 artifact → 404", async () => {
    const draftId = await createProject("derive-draft");
    await seedArtifact(draftId, { ...reportFixture(), plan: legacyPlan("draft") });
    const draft = await stack.request(
      "POST",
      `/api/projects/${draftId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    expect(draft.status).toBe(409);
    expect(errorOf(draft.body)).toBe("PLAN_INVALID_STATE");

    const missingPlan = await stack.request(
      "POST",
      `/api/projects/${draftId}/research/plan/rp-missing00000/derive`,
      {},
    );
    expect(missingPlan.status).toBe(404);
    expect(errorOf(missingPlan.body)).toBe("NOT_FOUND");

    const noPlanId = await createProject("derive-no-plan");
    await seedArtifact(noPlanId, reportFixture());
    const noPlan = await stack.request(
      "POST",
      `/api/projects/${noPlanId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    expect(noPlan.status).toBe(404);

    const noArtifactId = await createProject("derive-no-artifact");
    const noArtifact = await stack.request(
      "POST",
      `/api/projects/${noArtifactId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    expect(noArtifact.status).toBe(404);
    expect(errorOf(noArtifact.body)).toBe("NOT_FOUND");

    const noProject = await stack.request(
      "POST",
      "/api/projects/p-none000000001/research/plan/rp-seed00000001/derive",
      {},
    );
    expect(noProject.status).toBe(404);
    expect(errorOf(noProject.body)).toBe("PROJECT_NOT_FOUND");
  });

  it("请求体非法（携带 queryId / status、空 query）→ 400；校验失败不写盘", async () => {
    const projectId = await createProject("derive-invalid");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });

    const withStatus = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      { queries: [{ query: "x", kind: "web", status: "planned" }] },
    );
    expect(withStatus.status).toBe(400);
    expect(errorOf(withStatus.body)).toBe("INVALID_REQUEST");

    const emptyQuery = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      { queries: [{ query: " ", kind: "web" }] },
    );
    expect(emptyQuery.status).toBe(400);

    // 失败不落盘：artifact 仍是单计划旧形态
    const artifact = await readArtifact(projectId);
    expect(artifact["plans"]).toBeUndefined();
    expect((artifact["plan"] as Record<string, unknown>)["status"]).toBe("done");
  });

  it("非 POST → 405", async () => {
    const projectId = await createProject("derive-405");
    const response = await stack.request(
      "GET",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
    );
    expect(response.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/plan/:planId/activate", () => {
  it("切换活动计划：GET /research/plan 与 /research/plans 同步反映", async () => {
    const projectId = await createProject("activate-ok");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });
    const derived = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    const derivedId = ((derived.body["plan"] as Record<string, unknown>)["planId"]) as string;

    // 切回历史计划 v1
    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/activate`,
    );
    expect(response.status).toBe(200);
    expect((response.body["plan"] as Record<string, unknown>)["planId"]).toBe("rp-seed00000001");

    const active = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect(((active.body["plan"] as Record<string, unknown>)["planId"])).toBe("rp-seed00000001");

    const listed = await stack.request("GET", `/api/projects/${projectId}/research/plans`);
    expect(listed.body["activePlanId"]).toBe("rp-seed00000001");
    expect((listed.body["plans"] as unknown[]).length).toBe(2); // 派生计划仍在链中
    expect(derivedId).toMatch(/^rp-/);

    // 再切回 v2（幂等语义：目标已是活动 → 原样 200）
    const back = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/${derivedId}/activate`,
    );
    expect(back.status).toBe(200);
    const listedAgain = await stack.request("GET", `/api/projects/${projectId}/research/plans`);
    expect(listedAgain.body["activePlanId"]).toBe(derivedId);
  });

  it("planId 不存在 → 404；无 artifact → 404；非 POST → 405", async () => {
    const projectId = await createProject("activate-missing");
    await seedArtifact(projectId, { ...reportFixture(), plan: legacyPlan("done") });
    const missing = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-missing00000/activate`,
    );
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("NOT_FOUND");

    const noArtifactId = await createProject("activate-no-artifact");
    const noArtifact = await stack.request(
      "POST",
      `/api/projects/${noArtifactId}/research/plan/rp-seed00000001/activate`,
    );
    expect(noArtifact.status).toBe(404);

    const wrongMethod = await stack.request(
      "PUT",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/activate`,
      {},
    );
    expect(wrongMethod.status).toBe(405);
  });
});

describe("backward compatibility（M8.1 / M8.2 artifact 兼容读取与迁移）", () => {
  it("M8.2 artifact（plan + executionHistory）：派生与激活后执行历史保留、M8.1 GET /plan 继续可读", async () => {
    const projectId = await createProject("compat-m82");
    await seedArtifact(projectId, {
      ...reportFixture(),
      plan: legacyPlan("done"),
      executionHistory: [
        {
          executionId: "exec-seed0000001",
          queryId: "q-1",
          query: "transformer mot survey",
          kind: "academic",
          timestamp: "2026-09-20T09:00:00.000Z",
          status: "executed",
          resultCount: 3,
        },
      ],
    });

    // M8.1 端点继续可读（旧消费者零改动）
    const before = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect((before.body["plan"] as Record<string, unknown>)["planId"]).toBe("rp-seed00000001");

    const derived = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-seed00000001/derive`,
      {},
    );
    expect(derived.status).toBe(200);

    const artifact = await readArtifact(projectId);
    expect((artifact["executionHistory"] as unknown[]) ?? []).toHaveLength(1); // 历史不被覆盖
    expect(artifact["plan"]).toBeDefined(); // 兼容视图仍在
    expect(artifact["weaknesses"]).toBeUndefined(); // 无关字段不被伪造
  });

  it("M8.3.1 形态 artifact（plans + activePlanId，activePlanId 指向中间轮）：读取自愈为指向值", async () => {
    const v1 = { ...legacyPlan("done", "rp-a00000000001"), iterationNumber: 1, iterationId: "it-aaa000000001" };
    const v2 = {
      ...legacyPlan("done", "rp-b00000000002"),
      iterationNumber: 2,
      iterationId: "it-aaa000000001",
      parentPlanId: "rp-a00000000001",
    };
    const v3 = {
      ...legacyPlan("draft", "rp-c00000000003"),
      iterationNumber: 3,
      iterationId: "it-aaa000000001",
      parentPlanId: "rp-b00000000002",
    };
    const projectId = await createProject("compat-m831");
    await seedArtifact(projectId, {
      ...reportFixture(),
      plan: v3,
      plans: [v1, v2, v3],
      activePlanId: "rp-b00000000002", // 活动指向中间轮（用户已 activate 过）
    });

    const plans = await stack.request("GET", `/api/projects/${projectId}/research/plans`);
    expect(plans.status).toBe(200);
    expect((plans.body["plans"] as Array<Record<string, unknown>>).map((p) => p.iterationNumber)).toEqual([1, 2, 3]);
    expect(plans.body["activePlanId"]).toBe("rp-b00000000002");

    // 从中间轮（done）派生：iterationNumber 取链内最大 + 1 = 4
    const derived = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/plan/rp-b00000000002/derive`,
      {},
    );
    expect(derived.status).toBe(200);
    expect((derived.body["plan"] as Record<string, unknown>)["iterationNumber"]).toBe(4);
    expect((derived.body["plan"] as Record<string, unknown>)["parentPlanId"]).toBe("rp-b00000000002");
  });
});
