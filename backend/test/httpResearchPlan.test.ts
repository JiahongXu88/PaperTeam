/**
 * Research Plan HTTP API 集成测试（M8.1 第六部分-2）：
 *   GET  /api/projects/:id/research/plan   → { plan: ResearchPlan | null }
 *   PUT  /api/projects/:id/research/plan   → 编辑 questions / queries（校验 + 合并）
 *
 * 覆盖：无 artifact → plan:null / PUT 404；有 plan → GET 原样返回；PUT 替换与
 * 同 id 保留 resultCount；参数校验 → 400；方法限制 → 405；项目不存在 → 404。
 * 离线：research.json 直接落盘（不走 Runtime），plan 语义与 research 路由解耦。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "./helpers/testStack.js";
import type { ResearchPlan } from "../src/agents/researchPlan.js";

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

/** 直接落盘 research.json（绕过 Runtime：plan API 只消费 artifact，不依赖调研过程） */
async function seedArtifact(
  projectId: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact), "utf8");
}

const BASE_PLAN = {
  planId: "rp-seed00000001",
  status: "draft",
  questions: ["Transformer MOT 的发展脉络？", "当前 SOTA 的效率瓶颈？"],
  queries: [
    {
      queryId: "q-1",
      query: "transformer multi-object tracking survey",
      kind: "academic",
      rationale: "理解方法演进",
      expectedCoverage: "近三年综述",
      status: "planned",
    },
    {
      queryId: "q-2",
      query: "real-time transformer tracking",
      kind: "web",
      rationale: "找效率优化线索",
      status: "executed",
      resultCount: 5,
    },
  ],
  createdAt: "2026-09-19T08:00:00.000Z",
  updatedAt: "2026-09-19T08:00:00.000Z",
};

function reportFixture(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-19T08:00:00.000Z",
    taskId: "run-seed",
    report: {
      domainOverview: "调研概述",
      relatedWorkDirections: [],
      researchGaps: ["遮挡场景身份保持不足"],
      potentialContributions: ["评估协议"],
      researchQuestions: ["研究问题"],
      literaturePlan: [],
    },
    evidence: [],
    bibliography: [],
  };
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
}

describe("GET /api/projects/:id/research/plan", () => {
  it("无 research.json → 200 + plan:null（空态而非错误）", async () => {
    const projectId = await createProject("plan-empty");
    const response = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ plan: null });
  });

  it("有 plan → 原样返回；旧 artifact 无 plan → plan:null 且不报错", async () => {
    const withPlan = await createProject("plan-seeded");
    await seedArtifact(withPlan, { ...reportFixture(), plan: BASE_PLAN });
    const response = await stack.request("GET", `/api/projects/${withPlan}/research/plan`);
    expect(response.status).toBe(200);
    expect(response.body["plan"]).toEqual(BASE_PLAN);

    const legacy = await createProject("plan-legacy");
    await seedArtifact(legacy, reportFixture());
    const legacyResponse = await stack.request("GET", `/api/projects/${legacy}/research/plan`);
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.body).toEqual({ plan: null });
  });

  it("项目不存在 → 404 PROJECT_NOT_FOUND", async () => {
    const response = await stack.request("GET", "/api/projects/p-noplan000001/research/plan");
    expect(response.status).toBe(404);
    expect(errorOf(response.body)).toBe("PROJECT_NOT_FOUND");
  });
});

describe("PUT /api/projects/:id/research/plan", () => {
  it("编辑 research questions 与 query / rationale / query status", async () => {
    const projectId = await createProject("plan-edit");
    await seedArtifact(projectId, { ...reportFixture(), plan: BASE_PLAN });

    const response = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {
      questions: ["换成：MOT 端到端方法的演化？"],
      queries: [
        {
          queryId: "q-1",
          query: "end-to-end multi-object tracking survey",
          kind: "academic",
          rationale: "改后的理由",
          status: "skipped",
        },
      ],
    });
    expect(response.status).toBe(200);
    const plan = response.body["plan"] as ResearchPlan;
    expect(plan.questions).toEqual(["换成：MOT 端到端方法的演化？"]);
    expect(plan.queries[0]).toMatchObject({
      queryId: "q-1",
      query: "end-to-end multi-object tracking survey",
      rationale: "改后的理由",
      status: "skipped",
    });
    // 未提供的 query（q-2）按整体替换语义移除；plan 元数据稳定
    expect(plan.queries).toHaveLength(1);
    expect(plan.planId).toBe("rp-seed00000001");
    expect(plan.status).toBe("draft");
    expect(plan.updatedAt >= BASE_PLAN.updatedAt).toBe(true);

    // GET 回读持久化生效
    const readBack = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect((readBack.body["plan"] as ResearchPlan).questions).toEqual([
      "换成：MOT 端到端方法的演化？",
    ]);
  });

  it("同 queryId 更新不冲掉执行回填：resultCount 保留", async () => {
    const projectId = await createProject("plan-keep-resultcount");
    await seedArtifact(projectId, { ...reportFixture(), plan: BASE_PLAN });

    const response = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {
      queries: [{ queryId: "q-2", query: "real-time transformer tracking", kind: "web" }],
    });
    expect(response.status).toBe(200);
    const query = (response.body["plan"] as ResearchPlan).queries[0]!;
    expect(query).toMatchObject({ queryId: "q-2", status: "executed", resultCount: 5 });
  });

  it("旧 artifact 无 plan：PUT 初始化 draft 计划（编辑即初始化）", async () => {
    const projectId = await createProject("plan-init");
    await seedArtifact(projectId, reportFixture());

    const response = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {
      queries: [{ query: "手动补充的检索", kind: "academic" }],
    });
    expect(response.status).toBe(200);
    const plan = response.body["plan"] as ResearchPlan;
    expect(plan.status).toBe("draft");
    expect(plan.queries[0]).toMatchObject({ query: "手动补充的检索", status: "planned" });
  });

  it("参数校验：空请求体 / 非法 kind → 400 INVALID_REQUEST", async () => {
    const projectId = await createProject("plan-invalid");
    await seedArtifact(projectId, { ...reportFixture(), plan: BASE_PLAN });

    const empty = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {});
    expect(empty.status).toBe(400);
    expect(errorOf(empty.body)).toBe("INVALID_REQUEST");

    const badKind = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {
      queries: [{ query: "x", kind: "library" }],
    });
    expect(badKind.status).toBe(400);
    expect(errorOf(badKind.body)).toBe("INVALID_REQUEST");

    // 校验失败不改写磁盘：GET 仍是原 plan
    const readBack = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    expect(readBack.body["plan"]).toEqual(BASE_PLAN);
  });

  it("无 research.json → 404 NOT_FOUND（先运行调研）", async () => {
    const projectId = await createProject("plan-put-missing");
    const response = await stack.request("PUT", `/api/projects/${projectId}/research/plan`, {
      questions: ["x"],
    });
    expect(response.status).toBe(404);
    expect(errorOf(response.body)).toBe("NOT_FOUND");
  });

  it("非 GET/PUT 方法 → 405（Allow: GET, PUT）", async () => {
    const projectId = await createProject("plan-405");
    const response = await stack.request("POST", `/api/projects/${projectId}/research/plan`, {
      questions: ["x"],
    });
    expect(response.status).toBe(405);
  });
});
