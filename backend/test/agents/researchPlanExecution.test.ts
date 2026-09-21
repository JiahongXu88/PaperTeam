/**
 * ResearchPlan Execution Service 测试（M8.2 第七部分 1-4）。
 *
 * 经真实 serviceStack（search 注入 fake fetch，只启用 openalex）直接调用
 * stack.planExecution，覆盖：
 * 1. Execution Service：planned query 执行 → executed + resultCount 回填 +
 *    executionHistory 落盘（executionId / queryId / timestamp / status）；
 *    skipped / executed 条目不动；
 * 2. Status Transition：draft 不能执行、approve → approved → execute → done、
 *    done 不能重复执行、approve 非 draft 拒绝、artifact/plan 缺失 404；
 * 3. Failure：web provider 未配置 / 学术 provider 全失败 → 逐条 failed 记录
 *    （error 入 history、条目保持 planned、不中断整轮）；
 * 4. Backward Compatibility：M8.1 旧 research.json（无 executionHistory）可读可执行；
 *    执行不写 Candidate / Evidence（Evidence 链路不变量）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import { BusinessError } from "../../src/errors.js";
import type { PlanExecutionEntry } from "../../src/agents/researchPlanExecution.js";
import type { ResearchArtifact } from "../../src/agents/ResearcherService.js";

/** OpenAlex 假响应：两条可判等结果（合法 DOI 形态） */
const openalexFake = {
  results: [
    {
      id: "https://openalex.org/W111",
      title: "Multi-Agent Systems Survey",
      doi: "https://doi.org/10.1234/mas-survey",
      publication_year: 2023,
      authorships: [{ author: { display_name: "Alice Chen" } }],
      cited_by_count: 42,
      open_access: { is_oa: true },
    },
    {
      id: "https://openalex.org/W222",
      title: "LLM Agents Retrospective",
      doi: "https://doi.org/10.1234/llm-retro",
      publication_year: 2024,
      authorships: [{ author: { display_name: "Bob Wu" } }],
    },
  ],
};

/** 成功栈：openalex 正常应答；失败栈：fetch 一律 500 → SEARCH_ALL_PROVIDERS_FAILED */
const okFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

const failFetch = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: "boom" }), { status: 500 });

let okStack: TestStack;
let failStack: TestStack;

beforeAll(async () => {
  okStack = await startTestStack(scriptedIdeaRuntime().runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 1_000,
      fetchImpl: okFetch as unknown as typeof fetch,
    },
  });
  failStack = await startTestStack(scriptedIdeaRuntime().runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 1_000,
      fetchImpl: failFetch as unknown as typeof fetch,
    },
  });
});

afterAll(async () => {
  await okStack.cleanup();
  await failStack.cleanup();
});

async function createProject(stack: TestStack, title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

/** 直接落盘 research.json（绕过 Runtime：执行服务只消费 artifact） */
async function seedArtifact(
  stack: TestStack,
  projectId: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact), "utf8");
}

async function readArtifact(stack: TestStack, projectId: string): Promise<ResearchArtifact> {
  const raw = await readFile(join(stack.store.researchDir(projectId), "research.json"), "utf8");
  return JSON.parse(raw) as ResearchArtifact;
}

function reportFixture(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-20T08:00:00.000Z",
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

interface SeedQuery {
  queryId: string;
  query: string;
  kind: "academic" | "web";
  status: "planned" | "executed" | "skipped";
  resultCount?: number;
}

/** 生成指定状态的 plan（模拟 M8.1 产物 + 用户编辑的自然组合） */
function seedPlan(status: string, queries: SeedQuery[]) {
  return {
    planId: "rp-seed00000001",
    status,
    questions: ["Transformer MOT 的发展脉络？"],
    queries: queries.map((entry) => ({
      queryId: entry.queryId,
      query: entry.query,
      kind: entry.kind,
      rationale: "理解方法演进",
      status: entry.status,
      ...(entry.resultCount !== undefined ? { resultCount: entry.resultCount } : {}),
    })),
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-20T08:00:00.000Z",
  };
}

describe("Execution Service：planned query 执行与回填", () => {
  it("执行 approved 计划：planned → executed + resultCount，skipped / executed 不动，history 落盘", async () => {
    const projectId = await createProject(okStack, "exec-basic");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "transformer multi-object tracking survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "已跳过的检索", kind: "web", status: "skipped" },
        { queryId: "q-3", query: "已执行的检索", kind: "academic", status: "executed", resultCount: 5 },
      ]),
    });

    const result = await okStack.stack.planExecution.execute(projectId);
    expect(result.totalQueries).toBe(3);
    expect(result.executedQueries).toBe(1);
    expect(result.failedQueries).toBe(0);
    expect(result.executionId).toMatch(/^exec-[0-9a-f]{12}$/);
    expect(result.plan.status).toBe("done");

    const artifact = await readArtifact(okStack, projectId);
    expect(artifact.plan?.status).toBe("done");
    const [q1, q2, q3] = artifact.plan?.queries ?? [];
    expect(q1).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 2 });
    expect(q2).toMatchObject({ queryId: "q-2", status: "skipped" });
    expect(q2!.resultCount).toBeUndefined();
    expect(q3).toMatchObject({ queryId: "q-3", status: "executed", resultCount: 5 });

    const history = artifact.executionHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      executionId: result.executionId,
      queryId: "q-1",
      query: "transformer multi-object tracking survey",
      kind: "academic",
      status: "executed",
      resultCount: 2,
    });
    expect(typeof history[0]!.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(history[0]!.timestamp))).toBe(false);
  });

  it("M8.5 search audit：成功条目回填 providers 参与摘要与 resultIdentifiers（可追溯「搜到了什么」）", async () => {
    const projectId = await createProject(okStack, "exec-audit");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "transformer multi-object tracking survey", kind: "academic", status: "planned" },
      ]),
    });

    await okStack.stack.planExecution.execute(projectId);

    const entry = ((await readArtifact(okStack, projectId)).executionHistory ?? [])[0]!;
    expect(entry.status).toBe("executed");
    // provider 参与摘要：谁参与了、各自带回多少（openalex fake 两条）
    expect(entry.providers).toEqual([
      expect.objectContaining({ provider: "openalex", outcome: "ok", resultCount: 2 }),
    ]);
    // 结果标识符投影：两条 DOI（前缀形态，非候选、非文献——只是审计痕迹）
    expect(entry.resultIdentifiers).toEqual([
      "doi:10.1234/mas-survey",
      "doi:10.1234/llm-retro",
    ]);

    // HTTP 只读视图：GET /research/execution-history 同口径暴露（M8.5 UI 审计出口）
    const response = await okStack.request("GET", `/api/projects/${projectId}/research/execution-history`);
    expect(response.status).toBe(200);
    const entries = response.body["executionHistory"] as PlanExecutionEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 2 });
    expect(entries[0]!.resultIdentifiers).toContain("doi:10.1234/mas-survey");
  });

  it("执行不写候选与 Evidence（Search Result ≠ Candidate ≠ Evidence 不变量）", async () => {
    const projectId = await createProject(okStack, "exec-no-persist");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
      ]),
    });

    await okStack.stack.planExecution.execute(projectId);

    const candidates = await okStack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((candidates.body["candidates"] as unknown[]).length).toBe(0);
    const evidence = await okStack.request("GET", `/api/projects/${projectId}/evidence`);
    expect((evidence.body["evidence"] as unknown[] | undefined) ?? []).toEqual([]);
    const sources = await okStack.request("GET", `/api/projects/${projectId}/sources`);
    expect(((sources.body["sources"] as unknown[]) ?? []).length).toBe(0);
  });

  it("零 planned query（全部 executed / skipped）：直接流转 done，计数为 0", async () => {
    const projectId = await createProject(okStack, "exec-nothing-planned");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "已执行", kind: "academic", status: "executed", resultCount: 1 },
      ]),
    });

    const result = await okStack.stack.planExecution.execute(projectId);
    expect(result).toMatchObject({ totalQueries: 1, executedQueries: 0, failedQueries: 0 });
    expect(result.plan.status).toBe("done");
    expect((await readArtifact(okStack, projectId)).executionHistory ?? []).toHaveLength(0);
  });
});

describe("Status Transition：draft → approved → executing → done", () => {
  it("draft 不能执行（409 PLAN_INVALID_STATE）", async () => {
    const projectId = await createProject(okStack, "transition-draft");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("draft", [
        { queryId: "q-1", query: "draft 检索", kind: "academic", status: "planned" },
      ]),
    });
    await expect(okStack.stack.planExecution.execute(projectId)).rejects.toMatchObject({
      code: "PLAN_INVALID_STATE",
      httpStatus: 409,
    });
    // 状态不被失败尝试改变
    expect((await readArtifact(okStack, projectId)).plan?.status).toBe("draft");
  });

  it("approve：draft → approved；execute → done；done 再执行 → 409", async () => {
    const projectId = await createProject(okStack, "transition-full");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("draft", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
      ]),
    });

    const approved = await okStack.stack.planExecution.approve(projectId);
    expect(approved.status).toBe("approved");
    expect((await readArtifact(okStack, projectId)).plan?.status).toBe("approved");

    const executed = await okStack.stack.planExecution.execute(projectId);
    expect(executed.plan.status).toBe("done");

    await expect(okStack.stack.planExecution.execute(projectId)).rejects.toMatchObject({
      code: "PLAN_INVALID_STATE",
      httpStatus: 409,
    });
    expect((await readArtifact(okStack, projectId)).plan?.status).toBe("done");
  });

  it("executing 状态禁止重复执行（409，提示重启残留的恢复方式）", async () => {
    const projectId = await createProject(okStack, "transition-executing");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("executing", [
        { queryId: "q-1", query: "stuck", kind: "academic", status: "planned" },
      ]),
    });
    const error = await okStack.stack.planExecution.execute(projectId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BusinessError);
    expect((error as BusinessError).code).toBe("PLAN_INVALID_STATE");
    expect((error as BusinessError).httpStatus).toBe(409);
    expect((error as BusinessError).message).toContain("禁止重复执行");
  });

  it("approve 非 draft（approved / done）→ 409", async () => {
    const approvedId = await createProject(okStack, "transition-approve-approved");
    await seedArtifact(okStack, approvedId, {
      ...reportFixture(),
      plan: seedPlan("approved", [{ queryId: "q-1", query: "x", kind: "academic", status: "planned" }]),
    });
    await expect(okStack.stack.planExecution.approve(approvedId)).rejects.toMatchObject({
      code: "PLAN_INVALID_STATE",
    });

    const doneId = await createProject(okStack, "transition-approve-done");
    await seedArtifact(okStack, doneId, {
      ...reportFixture(),
      plan: seedPlan("done", [{ queryId: "q-1", query: "x", kind: "academic", status: "executed" }]),
    });
    await expect(okStack.stack.planExecution.approve(doneId)).rejects.toMatchObject({
      code: "PLAN_INVALID_STATE",
    });
  });

  it("artifact 不存在 / 旧 artifact 无 plan → NOT_FOUND 404", async () => {
    const noArtifactId = await createProject(okStack, "transition-no-artifact");
    await expect(okStack.stack.planExecution.execute(noArtifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(okStack.stack.planExecution.approve(noArtifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const noPlanId = await createProject(okStack, "transition-no-plan");
    await seedArtifact(okStack, noPlanId, reportFixture());
    await expect(okStack.stack.planExecution.execute(noPlanId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });
});

describe("Failure：检索失败的错误记录", () => {
  it("web provider 未配置：单条 failed 不中断整轮，error 入 history、条目保持 planned", async () => {
    const projectId = await createProject(okStack, "failure-web");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "real-time tracking", kind: "web", status: "planned" },
      ]),
    });

    const result = await okStack.stack.planExecution.execute(projectId);
    expect(result.executedQueries).toBe(1);
    expect(result.failedQueries).toBe(1);
    expect(result.plan.status).toBe("done");

    const artifact = await readArtifact(okStack, projectId);
    const queries = artifact.plan?.queries ?? [];
    expect(queries[0]).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 2 });
    expect(queries[1]).toMatchObject({ queryId: "q-2", status: "planned" });
    expect(queries[1]!.resultCount).toBeUndefined();

    const history = artifact.executionHistory ?? [];
    expect(history).toHaveLength(2);
    const failedEntry = history.find((entry) => entry.queryId === "q-2")!;
    expect(failedEntry.status).toBe("failed");
    expect(failedEntry.error).toContain("Web Search 未配置");
    expect(failedEntry.resultCount).toBeUndefined();
  });

  it("学术 provider 全失败（SEARCH_ALL_PROVIDERS_FAILED）：逐条 failed 记录、plan 仍 done", async () => {
    const projectId = await createProject(failStack, "failure-academic-all");
    await seedArtifact(failStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "query one", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "query two", kind: "academic", status: "planned" },
      ]),
    });

    const result = await failStack.stack.planExecution.execute(projectId);
    expect(result).toMatchObject({ executedQueries: 0, failedQueries: 2 });
    expect(result.plan.status).toBe("done");

    const history = (await readArtifact(failStack, projectId)).executionHistory ?? [];
    expect(history).toHaveLength(2);
    for (const entry of history as PlanExecutionEntry[]) {
      expect(entry.status).toBe("failed");
      expect(typeof entry.error).toBe("string");
    }
    // 失败条目保持 planned：修复 provider 后重走批准流可重试
    const queries = (await readArtifact(failStack, projectId)).plan?.queries ?? [];
    expect(queries.map((query) => query.status)).toEqual(["planned", "planned"]);
  });
});

describe("Backward Compatibility：旧 research.json", () => {
  it("M8.1 旧 artifact（plan 有、executionHistory 无）可读可执行，history 从零追加", async () => {
    const projectId = await createProject(okStack, "compat-m81");
    await seedArtifact(okStack, projectId, {
      // 不含 executionHistory 字段（M8.1 及更早的形态）
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
      ]),
    });

    const result = await okStack.stack.planExecution.execute(projectId);
    expect(result.executedQueries).toBe(1);
    const history = (await readArtifact(okStack, projectId)).executionHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ queryId: "q-1", status: "executed", resultCount: 2 });
  });

  it("多次执行的历史追加（不同 executionId），既有 report / evidence 字段原样保留", async () => {
    const projectId = await createProject(okStack, "compat-append");
    await seedArtifact(okStack, projectId, {
      ...reportFixture(),
      plan: seedPlan("approved", [
        { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "web 检索", kind: "web", status: "planned" },
      ]),
    });
    // 预置一段 M8.2 历史（模拟此前执行留下的记录）
    await writeFile(
      join(okStack.store.researchDir(projectId), "research.json"),
      JSON.stringify({
        ...reportFixture(),
        plan: seedPlan("approved", [
          { queryId: "q-1", query: "multi-agent survey", kind: "academic", status: "planned" },
          { queryId: "q-2", query: "web 检索", kind: "web", status: "planned" },
        ]),
        executionHistory: [
          {
            executionId: "exec-previous0001",
            queryId: "q-0",
            query: "上次执行",
            kind: "academic",
            timestamp: "2026-09-19T08:00:00.000Z",
            status: "executed",
            resultCount: 7,
          },
        ],
      }),
      "utf8",
    );

    const result = await okStack.stack.planExecution.execute(projectId);
    const artifact = await readArtifact(okStack, projectId);
    const history = artifact.executionHistory ?? [];
    expect(history).toHaveLength(3); // 1 条既有 + 本轮 2 条
    expect(history[0]).toMatchObject({ executionId: "exec-previous0001" });
    expect(history.slice(1).every((entry) => entry.executionId === result.executionId)).toBe(true);
    // 既有字段原样
    expect(artifact.report.researchGaps).toEqual(["遮挡场景身份保持不足"]);
    expect(artifact.evidence).toEqual([]);
  });
});
