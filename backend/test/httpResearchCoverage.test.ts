/**
 * Research Coverage HTTP API 集成测试（M8.3.2 第五部分）：
 *   GET  /api/projects/:id/research/coverage          → { coverage | null }
 *   POST /api/projects/:id/research/coverage/analyze  → { coverage }（无计划 → 404）
 *
 * 覆盖：空态 / 旧 artifact 归一化分析 / Evidence 与已入库候选驱动 covered /
 * 多轮计划链分析活动计划 / 只读不落盘（No mutation）/ 404 / 405 / 项目不存在。
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
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function readArtifactRaw(projectId: string): Promise<string> {
  return readFile(join(stack.store.researchDir(projectId), "research.json"), "utf8");
}

function errorOf(body: Record<string, unknown>): string | undefined {
  return (body["error"] as { code?: string } | undefined)?.code;
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

/** M8.1 / M8.2 旧形态：单一 plan（无 iteration 字段）+ 执行历史 */
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
        { queryId: "q-2", query: "edge device deployment", kind: "web", status: "executed", resultCount: 3 },
      ],
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
    },
    report: reportFixture(),
    evidence: [],
    bibliography: [],
  };
}

type CoverageBody = {
  planId: string;
  planStatus: string;
  questions: Array<{
    question: string;
    origin: string;
    coverage: string;
    relatedQueryCount: number;
    executedQueryCount: number;
    resultCount: number;
    evidenceCount: number;
    promotedCount: number;
    gap?: string;
  }>;
  overall: { questionCount: number; covered: number; partial: number; missing: number; summary: string };
  /** M8.3.3 起 gaps 为 ResearchGap[]（gapId / severity / status=proposed 等增量字段） */
  gaps: Array<{
    gapId: string;
    planId: string;
    question?: string;
    description: string;
    severity: string;
    suggestedQueries: string[];
    status: string;
  }>;
};

describe("GET /api/projects/:id/research/coverage", () => {
  it("无 artifact / 无计划 → 200 空态（coverage:null，不报错）", async () => {
    const emptyProject = await createProject("cov-empty");
    const empty = await stack.request("GET", `/api/projects/${emptyProject}/research/coverage`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ coverage: null });

    const noPlanProject = await createProject("cov-no-plan");
    await seedArtifact(noPlanProject, { generatedAt: "2026-09-20T08:00:00.000Z", taskId: "run-seed", report: reportFixture(), evidence: [], bibliography: [] });
    const noPlan = await stack.request("GET", `/api/projects/${noPlanProject}/research/coverage`);
    expect(noPlan.status).toBe(200);
    expect(noPlan.body).toEqual({ coverage: null });
  });

  it("旧 artifact（单一 plan）：即时重算返回覆盖报告（missing / partial 缺口如实）", async () => {
    const projectId = await createProject("cov-legacy");
    await seedArtifact(projectId, seededArtifact());

    const response = await stack.request("GET", `/api/projects/${projectId}/research/coverage`);
    expect(response.status).toBe(200);
    const coverage = response.body["coverage"] as CoverageBody;
    expect(coverage.planId).toBe("rp-seed00000001");
    expect(coverage.planStatus).toBe("done");
    expect(coverage.questions).toHaveLength(2);
    expect(coverage.questions[0]).toMatchObject({ origin: "plan", coverage: "partial", resultCount: 5 });
    expect(coverage.questions[1]).toMatchObject({ origin: "plan", coverage: "partial", resultCount: 3 });
    expect(coverage.overall).toMatchObject({ questionCount: 2, covered: 0, partial: 2, missing: 0 });
    expect(coverage.gaps).toHaveLength(2);
    expect(coverage.gaps[0]).toMatchObject({
      question: "Transformer tracking 的发展脉络",
      suggestedQueries: ["Transformer tracking 的发展脉络"],
      status: "proposed",
      severity: "low", // partial：有结果无证据支撑
    });
  });

  it("项目不存在 → 404 PROJECT_NOT_FOUND；非 GET → 405", async () => {
    const missing = await stack.request("GET", "/api/projects/p-none000000001/research/coverage");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("PROJECT_NOT_FOUND");

    const projectId = await createProject("cov-405");
    const wrongMethod = await stack.request("POST", `/api/projects/${projectId}/research/coverage`, {});
    expect(wrongMethod.status).toBe(405);
  });
});

describe("POST /api/projects/:id/research/coverage/analyze", () => {
  it("执行分析：报告形状完整（questions / overall / gaps），covered 由证据驱动", async () => {
    const projectId = await createProject("cov-analyze");
    await seedArtifact(projectId, seededArtifact());
    // 项目证据：claim 与问题 1 关联（transformer/tracking 命中）；
    // M9.4：covered 只认 verified 证据（未核验最多 partial）
    await stack.stack.evidence.append(
      projectId,
      {
        claim: "Transformer tracking 综述梳理了发展脉络",
        source: { title: "A Survey of Transformer Tracking" },
        verificationStatus: "verified",
      },
      "researcher",
    );

    const response = await stack.request("POST", `/api/projects/${projectId}/research/coverage/analyze`, {});
    expect(response.status).toBe(200);
    const coverage = response.body["coverage"] as CoverageBody;
    expect(coverage.questions[0]).toMatchObject({ coverage: "covered", evidenceCount: 1 });
    expect(coverage.questions[1]).toMatchObject({ coverage: "partial", promotedCount: 0 });
    expect(coverage.overall).toMatchObject({ covered: 1, partial: 1, missing: 0 });
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]).toMatchObject({ question: "edge device 部署优化", planId: "rp-seed00000001" });
    expect(coverage.overall.summary).toContain("covered 1 · partial 1");
  });

  it("只读不落盘：analyze 后 research.json 字节级不变（No mutation）", async () => {
    const projectId = await createProject("cov-no-mutation");
    await seedArtifact(projectId, seededArtifact());
    const before = await readArtifactRaw(projectId);

    const response = await stack.request("POST", `/api/projects/${projectId}/research/coverage/analyze`, {});
    expect(response.status).toBe(200);
    expect(await readArtifactRaw(projectId)).toBe(before);
  });

  it("report.researchQuestions 与 literaturePlan 参与分析（去重补充 + 残差缺口）", async () => {
    const projectId = await createProject("cov-report-questions");
    const artifact = seededArtifact();
    (artifact["report"] as Record<string, unknown>)["researchQuestions"] = ["遮挡场景身份保持"];
    (artifact["report"] as Record<string, unknown>)["literaturePlan"] = ["低照度场景数据集"];
    await seedArtifact(projectId, artifact);

    const response = await stack.request("POST", `/api/projects/${projectId}/research/coverage/analyze`, {});
    const coverage = response.body["coverage"] as CoverageBody;
    expect(coverage.questions.map((entry) => entry.origin)).toEqual(["plan", "plan", "report"]);
    expect(coverage.questions[2]).toMatchObject({ question: "遮挡场景身份保持", coverage: "missing" });
    expect(coverage.gaps.at(-1)).toMatchObject({
      description: "调研报告登记的残差文献方向：低照度场景数据集",
      suggestedQueries: ["低照度场景数据集"],
    });
  });

  it("M8.3.1 多轮计划链：分析活动计划（activePlanId 指向 v1 历史轮）", async () => {
    const v1 = {
      planId: "rp-a00000000001",
      iterationId: "it-aaa000000001",
      iterationNumber: 1,
      status: "done",
      questions: ["第一轮问题 transformer mot"],
      queries: [
        { queryId: "q-1", query: "transformer mot survey", kind: "academic", status: "executed", resultCount: 5 },
      ],
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
    };
    const v2 = {
      ...v1,
      planId: "rp-b00000000002",
      iterationNumber: 2,
      parentPlanId: v1.planId,
      status: "draft",
      questions: ["第二轮问题 edge deployment"],
      queries: [{ queryId: "q-1", query: "edge mot deployment", kind: "web", status: "planned" }],
    };
    const projectId = await createProject("cov-chain");
    await seedArtifact(projectId, {
      ...seededArtifact(),
      plan: v1,
      plans: [v1, v2],
      activePlanId: v1.planId,
    });

    const response = await stack.request("POST", `/api/projects/${projectId}/research/coverage/analyze`, {});
    const coverage = response.body["coverage"] as CoverageBody;
    expect(coverage.planId).toBe("rp-a00000000001");
    expect(coverage.questions.map((entry) => entry.question)).toEqual(["第一轮问题 transformer mot"]);
  });

  it("无 artifact / 无计划 → 404 NOT_FOUND；非 POST → 405；项目不存在 → 404", async () => {
    const noArtifact = await createProject("cov-404-artifact");
    const missing = await stack.request("POST", `/api/projects/${noArtifact}/research/coverage/analyze`, {});
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body)).toBe("NOT_FOUND");

    const noPlan = await createProject("cov-404-plan");
    await seedArtifact(noPlan, { generatedAt: "2026-09-20T08:00:00.000Z", taskId: "run-seed", report: reportFixture(), evidence: [], bibliography: [] });
    const noPlanResponse = await stack.request("POST", `/api/projects/${noPlan}/research/coverage/analyze`, {});
    expect(noPlanResponse.status).toBe(404);
    expect(errorOf(noPlanResponse.body)).toBe("NOT_FOUND");

    const wrongMethod = await stack.request("GET", `/api/projects/${noPlan}/research/coverage/analyze`);
    expect(wrongMethod.status).toBe(405);

    const noProject = await stack.request("POST", "/api/projects/p-none000000001/research/coverage/analyze", {});
    expect(noProject.status).toBe(404);
    expect(errorOf(noProject.body)).toBe("PROJECT_NOT_FOUND");
  });
});
