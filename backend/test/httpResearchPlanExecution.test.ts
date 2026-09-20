/**
 * Research Plan Execution HTTP API 集成测试（M8.2 第四部分 / 第七部分 2-4）：
 *   POST /api/projects/:id/research/plan/approve → { plan }（draft → approved）
 *   POST /api/projects/:id/research/plan/execute → { executionId, totalQueries,
 *        executedQueries, failedQueries, plan }
 *
 * 覆盖：plan 不存在 404（无 artifact / 旧 artifact 无 plan）；状态不允许 409
 * （draft / executing / done 执行、非 draft 批准）；approve → execute 成功链路
 * （fake fetch 只启用 openalex）；执行后 GET /plan 反映回填（兼容读取）；
 * 执行不写候选；方法限制 405；项目不存在 404。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "./helpers/testStack.js";

const openalexFake = {
  results: [
    {
      id: "https://openalex.org/W111",
      title: "Multi-Agent Systems Survey",
      doi: "https://doi.org/10.1234/mas-survey",
      publication_year: 2023,
      authorships: [{ author: { display_name: "Alice Chen" } }],
      cited_by_count: 42,
    },
  ],
};

const fakeSearchFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

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

async function seedArtifact(
  projectId: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact), "utf8");
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

function planFixture(status: string, queries: Array<Record<string, unknown>>) {
  return {
    planId: "rp-seed00000001",
    status,
    questions: ["Transformer MOT survey?"],
    queries,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-20T08:00:00.000Z",
  };
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
}

describe("POST /api/projects/:id/research/plan/approve", () => {
  it("draft → 200 approved；updated plan 持久化", async () => {
    const projectId = await createProject("approve-ok");
    await seedArtifact(projectId, {
      ...reportFixture(),
      plan: planFixture("draft", [{ queryId: "q-1", query: "survey", kind: "academic", status: "planned" }]),
    });

    const response = await stack.request("POST", `/api/projects/${projectId}/research/plan/approve`);
    expect(response.status).toBe(200);
    expect((response.body["plan"] as { status: string }).status).toBe("approved");

    const readBack = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect((readBack.body["plan"] as { status: string }).status).toBe("approved");
  });

  it("非 draft（done）→ 409 PLAN_INVALID_STATE；plan 无 / artifact 无 → 404", async () => {
    const doneId = await createProject("approve-done");
    await seedArtifact(doneId, {
      ...reportFixture(),
      plan: planFixture("done", [{ queryId: "q-1", query: "x", kind: "academic", status: "executed" }]),
    });
    const response = await stack.request("POST", `/api/projects/${doneId}/research/plan/approve`);
    expect(response.status).toBe(409);
    expect(errorOf(response.body)).toBe("PLAN_INVALID_STATE");

    const noPlanId = await createProject("approve-no-plan");
    await seedArtifact(noPlanId, reportFixture());
    const noPlan = await stack.request("POST", `/api/projects/${noPlanId}/research/plan/approve`);
    expect(noPlan.status).toBe(404);
    expect(errorOf(noPlan.body)).toBe("NOT_FOUND");

    const noArtifactId = await createProject("approve-no-artifact");
    const noArtifact = await stack.request("POST", `/api/projects/${noArtifactId}/research/plan/approve`);
    expect(noArtifact.status).toBe(404);
  });

  it("非 POST → 405", async () => {
    const projectId = await createProject("approve-405");
    const response = await stack.request("GET", `/api/projects/${projectId}/research/plan/approve`);
    expect(response.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/plan/execute", () => {
  it("approved 计划执行成功：返回 executionId 与计数，plan 流转 done，GET 反映回填", async () => {
    const projectId = await createProject("execute-ok");
    await seedArtifact(projectId, {
      ...reportFixture(),
      plan: planFixture("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "already done", kind: "academic", status: "executed", resultCount: 9 },
      ]),
    });

    const response = await stack.request("POST", `/api/projects/${projectId}/research/plan/execute`);
    expect(response.status).toBe(200);
    const body = response.body as {
      executionId: string;
      totalQueries: number;
      executedQueries: number;
      failedQueries: number;
      plan: { status: string; queries: Array<{ queryId: string; status: string; resultCount?: number }> };
    };
    expect(body.executionId).toMatch(/^exec-[0-9a-f]{12}$/);
    expect(body.totalQueries).toBe(2);
    expect(body.executedQueries).toBe(1);
    expect(body.failedQueries).toBe(0);
    expect(body.plan.status).toBe("done");
    expect(body.plan.queries[0]).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 1 });
    expect(body.plan.queries[1]).toMatchObject({ queryId: "q-2", resultCount: 9 });

    // GET /plan 兼容读取：回填持久化
    const readBack = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    const plan = readBack.body["plan"] as { status: string };
    expect(plan.status).toBe("done");

    // Evidence 链路不变量：执行不产生候选 / 文献
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((candidates.body["candidates"] as unknown[]).length).toBe(0);
  });

  it("状态不允许执行：draft / executing / done → 409 PLAN_INVALID_STATE", async () => {
    for (const status of ["draft", "executing", "done"]) {
      const projectId = await createProject(`execute-${status}`);
      await seedArtifact(projectId, {
        ...reportFixture(),
        plan: planFixture(status, [{ queryId: "q-1", query: "x", kind: "academic", status: "planned" }]),
      });
      const response = await stack.request("POST", `/api/projects/${projectId}/research/plan/execute`);
      expect(response.status).toBe(409);
      expect(errorOf(response.body)).toBe("PLAN_INVALID_STATE");
    }
  });

  it("plan 不存在 → 404（无 artifact / 旧 artifact 无 plan）；项目不存在 → 404", async () => {
    const noArtifactId = await createProject("execute-no-artifact");
    const noArtifact = await stack.request("POST", `/api/projects/${noArtifactId}/research/plan/execute`);
    expect(noArtifact.status).toBe(404);
    expect(errorOf(noArtifact.body)).toBe("NOT_FOUND");

    const noPlanId = await createProject("execute-no-plan");
    await seedArtifact(noPlanId, reportFixture());
    const noPlan = await stack.request("POST", `/api/projects/${noPlanId}/research/plan/execute`);
    expect(noPlan.status).toBe(404);
    expect(errorOf(noPlan.body)).toBe("NOT_FOUND");

    const noProject = await stack.request("POST", "/api/projects/p-none000000001/research/plan/execute");
    expect(noProject.status).toBe(404);
    expect(errorOf(noProject.body)).toBe("PROJECT_NOT_FOUND");
  });

  it("失败如实呈现：web query（provider 未配置）failed 计数与 plan 回填", async () => {
    const projectId = await createProject("execute-partial-failure");
    await seedArtifact(projectId, {
      ...reportFixture(),
      plan: planFixture("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "web clue", kind: "web", status: "planned" },
      ]),
    });

    const response = await stack.request("POST", `/api/projects/${projectId}/research/plan/execute`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ executedQueries: 1, failedQueries: 1 });
    const plan = response.body["plan"] as {
      queries: Array<{ queryId: string; status: string; resultCount?: number }>;
    };
    expect(plan.queries[1]).toMatchObject({ queryId: "q-2", status: "planned" });
  });

  it("非 POST → 405", async () => {
    const projectId = await createProject("execute-405");
    const response = await stack.request("PUT", `/api/projects/${projectId}/research/plan/execute`, {});
    expect(response.status).toBe(405);
  });
});
