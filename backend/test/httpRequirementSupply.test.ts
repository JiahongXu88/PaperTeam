/**
 * M9.9 Evidence Supply Decision Integration HTTP 集成测试：
 *   POST /api/projects/:id/research/requirements/supply-query
 *   （缺口驱动供给检索：covered 拒绝 / waived 拒绝 / 重复拒绝 / done 拒绝 /
 *    追加 planned 查询带 requirementId + rationale 可审计）
 *   POST /api/projects/:id/research/execution-results/save-candidates
 *   （M9.9 Phase 4：从需求供给检索的执行快照保存候选 → requirementId provenance）
 *
 * 离线：research.json / EvidenceStore 直接落盘（不走 Runtime）。
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

async function seedArtifact(
  projectId: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
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

interface RequirementFixture {
  requirementId: string;
  topic: string;
  claimType: string;
  expectedEvidenceType: string;
  priority: string;
  status: string;
}

/** draft 计划（可含需求 + 检索；supply-query 只接受 draft / approved 计划） */
function planFixture(options?: {
  requirements?: RequirementFixture[];
  queries?: Array<Record<string, unknown>>;
  status?: string;
}): Record<string, unknown> {
  return {
    planId: "rp-seed00000001",
    iterationId: "it-seed00000001",
    iterationNumber: 1,
    status: options?.status ?? "draft",
    questions: ["Agent memory 机制综述"],
    queries: options?.queries ?? [
      { queryId: "q-1", query: "agent memory survey", kind: "academic", status: "executed", resultCount: 4 },
    ],
    ...(options?.requirements !== undefined ? { requirements: options.requirements } : {}),
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
  };
}

const REQ_MECHANISM: RequirementFixture = {
  requirementId: "er-1",
  topic: "MemGPT memory management",
  claimType: "mechanism",
  expectedEvidenceType: "original_paper",
  priority: "high",
  status: "open",
};

const REQ_BENCHMARK: RequirementFixture = {
  requirementId: "er-2",
  topic: "agent benchmark evaluation",
  claimType: "benchmark",
  expectedEvidenceType: "benchmark_paper",
  priority: "medium",
  status: "open",
};

function artifactOf(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    generatedAt: "2026-09-24T08:00:00.000Z",
    taskId: "run-seed",
    plan,
    plans: [plan],
    activePlanId: "rp-seed00000001",
    report: reportFixture(),
    evidence: [],
    bibliography: [],
  };
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
}

describe("POST /api/projects/:id/research/requirements/supply-query（M9.9 Phase 3）", () => {
  it("missing 需求 → 200：追加 planned 查询（requirementId + rationale 可审计）并持久化", async () => {
    const projectId = await createProject("supply-missing");
    await seedArtifact(projectId, artifactOf(planFixture({ requirements: [REQ_MECHANISM, REQ_BENCHMARK] })));

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(response.status).toBe(200);
    const query = response.body["query"] as Record<string, unknown>;
    expect(query["query"]).toBe("MemGPT memory management");
    expect(query["kind"]).toBe("academic");
    expect(query["status"]).toBe("planned");
    expect(query["requirementId"]).toBe("er-1");
    expect(String(query["rationale"])).toContain("需求 er-1");
    expect(String(query["rationale"])).toContain("当前覆盖 partial");

    // 持久化：GET /research/plan 可见追加的检索
    const planView = await stack.request("GET", `/api/projects/${projectId}/research/plan`);
    const queries = (planView.body["plan"] as { queries: Array<Record<string, unknown>> }).queries;
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({ requirementId: "er-1", status: "planned" });
    // 既有检索不受影响
    expect(queries[0]).toMatchObject({ queryId: "q-1", resultCount: 4 });
  });

  it("benchmark_paper 形态提示词派生；自定义 query 覆盖确定性派生", async () => {
    const projectId = await createProject("supply-benchmark");
    await seedArtifact(projectId, artifactOf(planFixture({ requirements: [REQ_BENCHMARK] })));

    const derived = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/requirements/supply-query`,
      { requirementId: "er-2" },
    );
    expect(derived.status).toBe(200);
    expect((derived.body["query"] as { query: string }).query).toBe("agent benchmark evaluation benchmark");

    const projectId2 = await createProject("supply-override");
    await seedArtifact(projectId2, artifactOf(planFixture({ requirements: [REQ_BENCHMARK] })));
    const overridden = await stack.request(
      "POST",
      `/api/projects/${projectId2}/research/requirements/supply-query`,
      { requirementId: "er-2", query: "LLM agent benchmarks 2025", kind: "web" },
    );
    expect(overridden.status).toBe(200);
    expect(overridden.body["query"]).toMatchObject({
      query: "LLM agent benchmarks 2025",
      kind: "web",
      requirementId: "er-2",
    });
  });

  it("重复追加（同需求已有 planned 供给检索）→ 400；waived 需求 → 400", async () => {
    const projectId = await createProject("supply-duplicate");
    await seedArtifact(projectId, artifactOf(planFixture({ requirements: [REQ_MECHANISM] })));

    const first = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(first.status).toBe(200);
    const second = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(second.status).toBe(400);
    expect(errorOf(second.body)).toBe("INVALID_REQUEST");
    expect(String((second.body["error"] as { message?: string }).message)).toContain("已有待执行的供给检索");

    const waivedProject = await createProject("supply-waived");
    await seedArtifact(
      waivedProject,
      artifactOf(planFixture({ requirements: [{ ...REQ_MECHANISM, status: "waived" }] })),
    );
    const waived = await stack.request(
      "POST",
      `/api/projects/${waivedProject}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(waived.status).toBe(400);
    expect(String((waived.body["error"] as { message?: string }).message)).toContain("弃权");
  });

  it("covered 需求 → 400（缺口驱动纪律：已覆盖不触发补充检索）", async () => {
    const projectId = await createProject("supply-covered");
    // 关联检索 + verified 证据（≥2 内容词命中）→ covered
    await seedArtifact(
      projectId,
      artifactOf(
        planFixture({
          requirements: [REQ_MECHANISM],
          queries: [
            { queryId: "q-1", query: "MemGPT memory management architecture", kind: "academic", status: "executed", resultCount: 3 },
          ],
        }),
      ),
    );
    await stack.stack.evidence.append(
      projectId,
      {
        claim: "MemGPT memory management 分层机制刻画",
        source: { title: "MemGPT: Towards LLMs as Operating Systems" },
        verificationStatus: "verified",
      },
      "researcher",
    );

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(response.status).toBe(400);
    expect(errorOf(response.body)).toBe("INVALID_REQUEST");
    expect(String((response.body["error"] as { message?: string }).message)).toContain("已覆盖");
  });

  it("done / executing 计划 → 400；需求不存在 → 404；缺 requirementId → 400；GET → 405", async () => {
    const doneProject = await createProject("supply-done");
    await seedArtifact(
      doneProject,
      artifactOf(planFixture({ requirements: [REQ_MECHANISM], status: "done" })),
    );
    const done = await stack.request(
      "POST",
      `/api/projects/${doneProject}/research/requirements/supply-query`,
      { requirementId: "er-1" },
    );
    expect(done.status).toBe(400);
    expect(String((done.body["error"] as { message?: string }).message)).toContain("派生下一轮");

    const missingProject = await createProject("supply-notfound");
    await seedArtifact(missingProject, artifactOf(planFixture({ requirements: [REQ_MECHANISM] })));
    const notFound = await stack.request(
      "POST",
      `/api/projects/${missingProject}/research/requirements/supply-query`,
      { requirementId: "er-99" },
    );
    expect(notFound.status).toBe(404);
    expect(errorOf(notFound.body)).toBe("NOT_FOUND");

    const noBody = await stack.request(
      "POST",
      `/api/projects/${missingProject}/research/requirements/supply-query`,
      {},
    );
    expect(noBody.status).toBe(400);
    expect(errorOf(noBody.body)).toBe("INVALID_REQUEST");

    const wrongMethod = await stack.request(
      "GET",
      `/api/projects/${missingProject}/research/requirements/supply-query`,
    );
    expect(wrongMethod.status).toBe(405);
  });
});

describe("save-candidates 的需求 provenance（M9.9 Phase 4）", () => {
  it("需求供给检索的执行快照 → 候选带 requirementId；普通检索快照 → 无关联", async () => {
    const projectId = await createProject("supply-provenance");
    await seedArtifact(
      projectId,
      artifactOf(
        planFixture({
          requirements: [REQ_MECHANISM],
          queries: [
            { queryId: "q-1", query: "agent memory survey", kind: "academic", status: "executed", resultCount: 4 },
            {
              queryId: "q-2",
              query: "MemGPT memory management",
              kind: "academic",
              status: "executed",
              resultCount: 1,
              requirementId: "er-1",
            },
          ],
        }),
      ),
    );
    // 手工补 executionHistory（两跳执行快照：q-1 普通检索 / q-2 需求供给检索）
    const researchDir = stack.store.researchDir(projectId);
    const artifactPath = join(researchDir, "research.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    artifact["executionHistory"] = [
      {
        executionId: "exec-seed000001",
        queryId: "q-1",
        query: "agent memory survey",
        kind: "academic",
        timestamp: "2026-09-24T08:10:00.000Z",
        status: "executed",
        resultCount: 1,
        resultSnapshot: [
          {
            kind: "academic",
            provider: "openalex",
            identity: { doi: "10.1000/plain" },
            title: "Plain Survey Paper",
            year: 2023,
          },
        ],
      },
      {
        executionId: "exec-seed000002",
        queryId: "q-2",
        query: "MemGPT memory management",
        kind: "academic",
        timestamp: "2026-09-24T08:15:00.000Z",
        status: "executed",
        resultCount: 1,
        resultSnapshot: [
          {
            kind: "academic",
            provider: "openalex",
            identity: { doi: "10.1000/memgpt" },
            title: "MemGPT Paper",
            year: 2023,
          },
        ],
      },
    ];
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

    const linked = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: "exec-seed000002", queryId: "q-2", saveAsCandidates: [0] },
    );
    expect(linked.status).toBe(200);
    const plain = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: "exec-seed000001", queryId: "q-1", saveAsCandidates: [0] },
    );
    expect(plain.status).toBe(200);

    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    const list = candidates.body["candidates"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    const memgpt = list.find((candidate) => candidate["requirementId"] === "er-1");
    const plainEntry = list.find((candidate) => candidate["title"] === "Plain Survey Paper");
    expect(memgpt).toMatchObject({ title: "MemGPT Paper", status: "pending_review" });
    expect(memgpt?.["query"]).toBe("MemGPT memory management");
    expect(plainEntry).toBeDefined();
    expect(plainEntry?.["requirementId"]).toBeUndefined();
  });
});
