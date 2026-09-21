/**
 * Research Gap HITL + Loop Policy HTTP API 集成测试（M8.3.3 第七部分）：
 *   GET  /api/projects/:id/research/gaps                  → { planId, gaps }
 *   POST /api/projects/:id/research/gaps/:gapId/accept    → { gap }（proposed → accepted）
 *   POST /api/projects/:id/research/gaps/:gapId/reject    → { gap }（proposed → rejected）
 *   POST /api/projects/:id/research/gaps/:gapId/derive    → { plan }（accepted → 新 draft）
 *   GET/PUT /api/projects/:id/research/loop-policy        → { loopPolicy }
 *
 * 覆盖：空态 / 旧 artifact 派生缺口（gapId / severity / proposed）→ 决策
 * （幂等 / 409 / 404）→ 派生（旧计划不变、新计划正确生成）→ 循环策略
 * 校验与持久化；405 / 404 / 项目不存在。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

/** 与后端 deterministicGapId 相同的键构造（问题缺口） */
function gapIdOf(planId: string, question: string): string {
  return `gap-${createHash("sha256").update(`${planId}\nquestion\n${question}`).digest("hex").slice(0, 12)}`;
}

/** 活动计划 done：问题 1 partial（low）/ 问题 2 missing（high）/ 残差方向（medium） */
function seededArtifact(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-20T08:00:00.000Z",
    taskId: "run-seed",
    plan: {
      planId: "rp-seed00000001",
      status: "done",
      questions: ["Transformer tracking 的发展脉络", "edge device 部署优化"],
      queries: [
        { queryId: "q-1", query: "transformer tracking survey", kind: "academic", status: "executed", resultCount: 5 },
      ],
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
    },
    report: {
      domainOverview: "调研概述",
      relatedWorkDirections: [],
      researchGaps: ["gap"],
      potentialContributions: ["贡献"],
      researchQuestions: [],
      literaturePlan: ["低照度场景数据集"],
    },
    evidence: [],
    bibliography: [],
  };
}

type GapBody = {
  gapId: string;
  planId: string;
  question?: string;
  description: string;
  severity: string;
  suggestedQueries: string[];
  status: string;
  createdAt: string;
  decidedAt?: string;
};

async function listGaps(projectId: string): Promise<{ planId: string | null; gaps: GapBody[] }> {
  const response = await stack.request("GET", `/api/projects/${projectId}/research/gaps`);
  expect(response.status).toBe(200);
  return response.body as { planId: string | null; gaps: GapBody[] };
}

describe("GET /api/projects/:id/research/gaps", () => {
  it("无 artifact / 无计划 → 200 空态（planId:null + gaps:[]，不报错）", async () => {
    const emptyProject = await createProject("gaps-empty");
    expect(await listGaps(emptyProject)).toEqual({ planId: null, gaps: [] });

    const noPlanProject = await createProject("gaps-no-plan");
    await seedArtifact(noPlanProject, {
      generatedAt: "2026-09-20T08:00:00.000Z",
      taskId: "run-seed",
      report: seededArtifact()["report"],
      evidence: [],
      bibliography: [],
    });
    expect(await listGaps(noPlanProject)).toEqual({ planId: null, gaps: [] });
  });

  it("旧 artifact（无 gaps 字段）：派生缺口全部 proposed（gapId / severity / 建议检索）", async () => {
    const projectId = await createProject("gaps-legacy");
    await seedArtifact(projectId, seededArtifact());

    const { planId, gaps } = await listGaps(projectId);
    expect(planId).toBe("rp-seed00000001");
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toMatchObject({
      gapId: gapIdOf("rp-seed00000001", "Transformer tracking 的发展脉络"),
      planId: "rp-seed00000001",
      question: "Transformer tracking 的发展脉络",
      severity: "low",
      status: "proposed",
      suggestedQueries: ["Transformer tracking 的发展脉络"],
    });
    expect(gaps[1]).toMatchObject({ question: "edge device 部署优化", severity: "high" });
    expect(gaps[2]!.question).toBeUndefined(); // 残差缺口无关联问题（字段省略）
    expect(gaps[2]).toMatchObject({
      severity: "medium",
      description: "调研报告登记的残差文献方向：低照度场景数据集",
    });
  });

  it("项目不存在 → 404 PROJECT_NOT_FOUND；非 GET → 405", async () => {
    const missing = await stack.request("GET", "/api/projects/p-none000000001/research/gaps");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("PROJECT_NOT_FOUND");

    const projectId = await createProject("gaps-405");
    const wrongMethod = await stack.request("POST", `/api/projects/${projectId}/research/gaps`, {});
    expect(wrongMethod.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/gaps/:gapId/{accept|reject}", () => {
  it("accept：proposed → accepted 落盘；重复 accept 幂等；list 反映决策", async () => {
    const projectId = await createProject("gaps-accept");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");

    const first = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});
    expect(first.status).toBe(200);
    expect(first.body["gap"]).toMatchObject({ gapId, status: "accepted" });
    expect((first.body["gap"] as GapBody).decidedAt).toBeDefined();

    const second = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});
    expect(second.status).toBe(200);
    expect(second.body["gap"]).toMatchObject({ gapId, status: "accepted" });

    const { gaps } = await listGaps(projectId);
    expect(gaps.find((gap) => gap.gapId === gapId)).toMatchObject({ status: "accepted" });
    expect(gaps.filter((gap) => gap.status === "proposed")).toHaveLength(2);
    // 落盘：research.json 顶层 gaps 只含决策快照，计划链原样
    const stored = await readArtifact(projectId);
    expect(stored["gaps"]).toHaveLength(1);
    expect(stored["plan"]).toMatchObject({ planId: "rp-seed00000001", status: "done" });
  });

  it("reject：proposed → rejected；反向决策 → 409 GAP_INVALID_STATE", async () => {
    const projectId = await createProject("gaps-reject");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");

    const rejected = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/reject`, {});
    expect(rejected.status).toBe(200);
    expect(rejected.body["gap"]).toMatchObject({ gapId, status: "rejected" });

    const conflict = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});
    expect(conflict.status).toBe(409);
    expect(errorOf(conflict.body)).toBe("GAP_INVALID_STATE");
  });

  it("未知 gapId → 404 NOT_FOUND；无 artifact → 404；非 POST → 405", async () => {
    const projectId = await createProject("gaps-decide-404");
    await seedArtifact(projectId, seededArtifact());
    const missing = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/gaps/gap-000000000000/accept`,
      {},
    );
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("NOT_FOUND");

    const noArtifact = await createProject("gaps-decide-404-empty");
    const noResearch = await stack.request(
      "POST",
      `/api/projects/${noArtifact}/research/gaps/gap-000000000000/reject`,
      {},
    );
    expect(noResearch.status).toBe(404);

    const wrongMethod = await stack.request("GET", `/api/projects/${projectId}/research/gaps/gap-000000000000/accept`);
    expect(wrongMethod.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/gaps/:gapId/derive", () => {
  it("accepted 缺口 + done 计划 → 新 draft 计划：旧计划不变、新计划 iterationNumber+1 并激活", async () => {
    const projectId = await createProject("gaps-derive");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");
    await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});

    const response = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/derive`, {});
    expect(response.status).toBe(200);
    const plan = response.body["plan"] as Record<string, unknown>;
    expect(plan).toMatchObject({
      status: "draft",
      parentPlanId: "rp-seed00000001",
      iterationNumber: 2,
      questions: ["edge device 部署优化"],
    });
    const queries = plan["queries"] as Array<Record<string, unknown>>;
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ query: "edge device 部署优化", kind: "academic", status: "planned" });

    const stored = await readArtifact(projectId);
    const plans = stored["plans"] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ planId: "rp-seed00000001", status: "done", iterationNumber: 1 });
    expect(stored["activePlanId"]).toBe(plan["planId"]);
    expect((stored["gaps"] as unknown[]).some((gap) => (gap as GapBody).gapId === gapId)).toBe(true);
  });

  it("请求体 query modifications：覆盖缺省 suggestedQueries", async () => {
    const projectId = await createProject("gaps-derive-modify");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");
    await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/gaps/${gapId}/derive`,
      { queries: [{ query: "edge mot deployment survey", kind: "web" }] },
    );
    expect(response.status).toBe(200);
    const queries = (response.body["plan"] as Record<string, unknown>)["queries"] as Array<Record<string, unknown>>;
    expect(queries).toEqual([
      { queryId: "q-1", query: "edge mot deployment survey", kind: "web", status: "planned" },
    ]);
  });

  it("proposed 缺口 → 409 GAP_INVALID_STATE（Human Approval 断点）", async () => {
    const projectId = await createProject("gaps-derive-gate");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");

    const response = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/derive`, {});
    expect(response.status).toBe(409);
    expect(errorOf(response.body)).toBe("GAP_INVALID_STATE");
  });

  it("非法请求体（queries 带 queryId）→ 400；非 POST → 405", async () => {
    const projectId = await createProject("gaps-derive-400");
    await seedArtifact(projectId, seededArtifact());
    const gapId = gapIdOf("rp-seed00000001", "edge device 部署优化");
    await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/accept`, {});

    const bad = await stack.request("POST", `/api/projects/${projectId}/research/gaps/${gapId}/derive`, {
      queries: [{ queryId: "q-9", query: "x", kind: "web" }],
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body)).toBe("INVALID_REQUEST");

    const wrongMethod = await stack.request("GET", `/api/projects/${projectId}/research/gaps/${gapId}/derive`);
    expect(wrongMethod.status).toBe(405);
  });
});

describe("GET/PUT /api/projects/:id/research/loop-policy", () => {
  it("GET：无 artifact → 默认策略（空态而非错误）；有落盘值 → 读取", async () => {
    const emptyProject = await createProject("loop-empty");
    const empty = await stack.request("GET", `/api/projects/${emptyProject}/research/loop-policy`);
    expect(empty.status).toBe(200);
    expect(empty.body["loopPolicy"]).toEqual({
      maxIterations: 5,
      maxQueriesPerIteration: 20,
      maxTotalQueries: 100,
      stopConditions: ["no_new_coverage", "budget_exceeded", "iteration_limit"],
    });

    const projectId = await createProject("loop-stored");
    await seedArtifact(projectId, seededArtifact());
    await stack.request("PUT", `/api/projects/${projectId}/research/loop-policy`, { maxIterations: 8 });

    const stored = await stack.request("GET", `/api/projects/${projectId}/research/loop-policy`);
    expect(stored.body["loopPolicy"]).toMatchObject({ maxIterations: 8 });
    // 落盘在 research.json 顶层 loopPolicy；其余字段不受影响
    const artifact = await readArtifact(projectId);
    expect(artifact["loopPolicy"]).toMatchObject({ maxIterations: 8 });
    expect(artifact["plan"]).toBeTruthy();
  });

  it("PUT：非法值 → 400 不落盘；无 artifact → 404；非 GET/PUT → 405", async () => {
    const projectId = await createProject("loop-put");
    await seedArtifact(projectId, seededArtifact());

    const bad = await stack.request("PUT", `/api/projects/${projectId}/research/loop-policy`, {
      maxIterations: 99,
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad.body)).toBe("INVALID_REQUEST");
    expect(await readArtifact(projectId)).not.toHaveProperty("loopPolicy");

    const noArtifact = await createProject("loop-put-404");
    const missing = await stack.request("PUT", `/api/projects/${noArtifact}/research/loop-policy`, {});
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("NOT_FOUND");

    const wrongMethod = await stack.request("POST", `/api/projects/${projectId}/research/loop-policy`, {});
    expect(wrongMethod.status).toBe(405);
  });
});
