/**
 * M9.1 E2E Activation Foundation：执行结果快照（resultSnapshot）与
 * Search Result → Candidate 的显式 HITL 衔接测试。
 *
 * 经真实 serviceStack（search 注入 fake fetch，只启用 openalex）覆盖：
 * 1. 快照落盘：成功条目回填有界 resultSnapshot（Top-N 最小 projection——
 *    identity 完整保留、abstract 只留 300 字符预览）；
 * 2. 快照有界：12 条结果只留 Top 10；
 * 3. 证据边界：快照存在也不写 Candidate / Evidence / Source（保存前
 *    CandidateStore 恒空——Search Result ≠ Candidate 不变量）；
 * 4. 显式保存：POST /research/execution-results/save-candidates 勾选快照
 *    → 经 CandidateStore 单一写入口径创建 pending 候选（identity /
 *    query provenance / origin / provider 正确）；
 * 5. 幂等：重复保存同快照 → 同身份 pending 判重合并（mergedExisting），
 *    不产生重复候选；
 * 6. 错误形态：无快照的旧条目 → 409 EXECUTION_RESULTS_UNAVAILABLE；
 *    executionId / queryId 不存在 → 404；下标越界 / 缺字段 → 400；
 * 7. partial failure：web provider 未配置（failed 无快照）不影响学术条目
 *    快照保留；GET /execution-history 直出新字段（旧条目无快照正常读）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import type {
  PlanExecutionAcademicResultSnapshot,
  PlanExecutionEntry,
} from "../../src/agents/researchPlanExecution.js";

/** 长 abstract（inverted index 形态，重建后 > 300 字符 → 快照只留预览） */
const longAbstractIndex: Record<string, number[]> = {};
for (let i = 0; i < 100; i += 1) {
  longAbstractIndex[`topic${i}`] = [i];
}

/** 12 条可判等结果（DOI 形态各异；第一条带长 abstract / venue / citation） */
const openalexManyFake = {
  results: [
    {
      id: "https://openalex.org/W111",
      title: "Multi-Agent Systems Survey",
      doi: "https://doi.org/10.1234/mas-survey",
      publication_year: 2023,
      authorships: [{ author: { display_name: "Alice Chen" } }],
      cited_by_count: 42,
      open_access: { is_oa: true },
      primary_location: { source: { display_name: "ACM Computing Surveys" } },
      abstract_inverted_index: longAbstractIndex,
    },
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `https://openalex.org/W${200 + i}`,
      title: `LLM Research Paper ${i + 1}`,
      doi: `https://doi.org/10.1234/paper-${i + 1}`,
      publication_year: 2024,
      authorships: [{ author: { display_name: `Author ${i + 1}` } }],
    })),
  ],
};

const manyFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexManyFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 1_000,
      fetchImpl: manyFetch as unknown as typeof fetch,
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

/** 直接落盘 research.json（与 researchPlanExecution.test.ts 同款 seed 方式） */
async function seedApprovedPlan(projectId: string, queries: Array<{ queryId: string; query: string; kind: "academic" | "web" }>): Promise<void> {
  const researchDir = stack.store.researchDir(projectId);
  await mkdir(researchDir, { recursive: true });
  await writeFile(
    join(researchDir, "research.json"),
    JSON.stringify({
      generatedAt: "2026-09-22T08:00:00.000Z",
      taskId: "run-seed",
      report: {
        domainOverview: "调研概述",
        relatedWorkDirections: [],
        researchGaps: ["缺口"],
        potentialContributions: ["贡献"],
        researchQuestions: ["研究问题"],
        literaturePlan: [],
      },
      evidence: [],
      bibliography: [],
      plan: {
        planId: "rp-seed00000001",
        status: "approved",
        questions: ["研究问题"],
        queries: queries.map((entry) => ({
          queryId: entry.queryId,
          query: entry.query,
          kind: entry.kind,
          rationale: "理解方法演进",
          status: "planned",
        })),
        createdAt: "2026-09-22T08:00:00.000Z",
        updatedAt: "2026-09-22T08:00:00.000Z",
      },
    }),
    "utf8",
  );
}

async function readHistory(projectId: string): Promise<PlanExecutionEntry[]> {
  const raw = await readFile(join(stack.store.researchDir(projectId), "research.json"), "utf8");
  return (JSON.parse(raw) as { executionHistory?: PlanExecutionEntry[] }).executionHistory ?? [];
}

async function listCandidates(projectId: string): Promise<unknown[]> {
  const response = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
  expect(response.status).toBe(200);
  return (response.body["candidates"] as unknown[]) ?? [];
}

/** 执行计划并返回成功条目（单 academic query 场景的便捷封装） */
async function executeSingle(
  projectId: string,
  query: { queryId: string; query: string; kind: "academic" | "web" },
): Promise<PlanExecutionEntry> {
  await seedApprovedPlan(projectId, [query]);
  const result = await stack.stack.planExecution.execute(projectId);
  expect(result.failedQueries).toBe(0);
  const history = await readHistory(projectId);
  expect(history).toHaveLength(1);
  return history[0]!;
}

describe("M9.1 执行结果快照落盘（有界 projection）", () => {
  it("成功条目回填 resultSnapshot：identity 完整、abstract 只留 300 字符预览、provider / score / citationCount 保留", async () => {
    const projectId = await createProject("m91-snapshot-basic");
    const entry = await executeSingle(projectId, {
      queryId: "q-1",
      query: "multi-agent scientific research",
      kind: "academic",
    });

    expect(entry.status).toBe("executed");
    // discovery 默认 limit=10（与 HTTP 检索同口径）：12 条 fake 在检索层已截 10
    expect(entry.resultCount).toBe(10);
    expect(entry.resultSnapshot).toBeDefined();
    const [first] = entry.resultSnapshot!;
    expect(first).toMatchObject({
      kind: "academic",
      provider: "openalex",
      title: "Multi-Agent Systems Survey",
      authors: ["Alice Chen"],
      year: 2023,
      venue: "ACM Computing Surveys",
      doi: "10.1234/mas-survey",
      citationCount: 42,
    });
    // identity 完整保留（判等与显式保存候选的依据）
    expect(first!.kind).toBe("academic");
    const academicFirst = first as PlanExecutionAcademicResultSnapshot;
    expect(academicFirst.identity).toMatchObject({ doi: "10.1234/mas-survey", year: 2023 });
    expect(academicFirst.identity.normalizedTitleFingerprint).not.toBe("");
    // abstract 只留截断预览（重建后 100 词 > 300 字符）
    expect(academicFirst.snippetPreview).toBeDefined();
    expect(academicFirst.snippetPreview!.length).toBe(300);
    expect(typeof academicFirst.score).toBe("number");
  });

  it("快照有界：12 条结果只留 Top 10（检索默认 limit 与 snapshot 帽双重保证 ≤ MAX_RESULT_SNAPSHOT_PER_ENTRY）", async () => {
    const projectId = await createProject("m91-snapshot-bounded");
    const entry = await executeSingle(projectId, {
      queryId: "q-1",
      query: "bounded snapshot",
      kind: "academic",
    });
    expect(entry.resultSnapshot!.length).toBeLessThanOrEqual(10);
    expect(entry.resultSnapshot).toHaveLength(10);
    expect(entry.resultIdentifiers).toHaveLength(10); // 与结果同长（M8.5 口径不变）
  });

  it("快照是审计痕迹：落盘后 Candidate / Evidence / Source 全部为空（保存前 CandidateStore 恒空）", async () => {
    const projectId = await createProject("m91-snapshot-no-persist");
    await executeSingle(projectId, { queryId: "q-1", query: "no persist", kind: "academic" });

    expect(await listCandidates(projectId)).toEqual([]);
    const evidence = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    expect((evidence.body["evidence"] as unknown[] | undefined) ?? []).toEqual([]);
    const sources = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect(((sources.body["sources"] as unknown[]) ?? []).length).toBe(0);
  });
});

describe("M9.1 快照 → 候选显式保存（HITL）", () => {
  it("勾选快照保存 → 创建 pending 候选（identity / query provenance / origin / provider 正确）", async () => {
    const projectId = await createProject("m91-save-candidates");
    const entry = await executeSingle(projectId, {
      queryId: "q-1",
      query: "multi-agent scientific research",
      kind: "academic",
    });

    const response = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, queryId: entry.queryId, saveAsCandidates: [0, 1] },
    );
    expect(response.status).toBe(200);
    const saved = response.body["saved"] as unknown[];
    expect(saved).toHaveLength(2);

    const candidates = (await listCandidates(projectId)) as Array<{
      status: string;
      origin: string;
      provider: string;
      query?: string;
      doi?: string;
      title?: string;
    }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.status === "pending_review")).toBe(true);
    expect(candidates.every((candidate) => candidate.origin === "academic_search")).toBe(true);
    expect(candidates.every((candidate) => candidate.provider === "openalex")).toBe(true);
    expect(candidates.every((candidate) => candidate.query === "multi-agent scientific research")).toBe(true);
    expect(candidates.map((candidate) => candidate.doi)).toContain("10.1234/mas-survey");
  });

  it("重复保存同一快照：同身份 pending 判重合并（mergedExisting），候选数不增长", async () => {
    const projectId = await createProject("m91-save-idempotent");
    const entry = await executeSingle(projectId, {
      queryId: "q-1",
      query: "idempotent save",
      kind: "academic",
    });

    const first = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, queryId: entry.queryId, saveAsCandidates: [0] },
    );
    expect(first.status).toBe(200);
    expect((first.body["saved"] as unknown[]).length).toBe(1);

    const second = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, queryId: entry.queryId, saveAsCandidates: [0] },
    );
    expect(second.status).toBe(200);
    expect((second.body["saved"] as unknown[]).length).toBe(0);
    expect(second.body["mergedExisting"]).toEqual([0]);

    expect((await listCandidates(projectId)).length).toBe(1);
  });

  it("无快照的旧条目（M8.5 形态）→ 409 EXECUTION_RESULTS_UNAVAILABLE；不存在的 executionId / queryId → 404", async () => {
    const projectId = await createProject("m91-save-old-entry");
    // seed 一个 M8.5 形态 artifact：executed 但只有 resultIdentifiers、无 resultSnapshot
    const researchDir = stack.store.researchDir(projectId);
    await mkdir(researchDir, { recursive: true });
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({
        generatedAt: "2026-09-21T08:00:00.000Z",
        taskId: "run-seed",
        report: { domainOverview: "d", relatedWorkDirections: [], researchGaps: [], potentialContributions: [], researchQuestions: [], literaturePlan: [] },
        evidence: [],
        bibliography: [],
        plan: {
          planId: "rp-m85old000001",
          status: "done",
          questions: [],
          queries: [{ queryId: "q-old", query: "old query", kind: "academic", status: "executed", resultCount: 3 }],
          createdAt: "2026-09-21T08:00:00.000Z",
          updatedAt: "2026-09-21T08:00:00.000Z",
        },
        executionHistory: [
          {
            executionId: "exec-m85old00001",
            queryId: "q-old",
            query: "old query",
            kind: "academic",
            timestamp: "2026-09-21T08:05:00.000Z",
            status: "executed",
            resultCount: 3,
            providers: [{ provider: "openalex", outcome: "ok", resultCount: 3 }],
            resultIdentifiers: ["doi:10.1234/a", "doi:10.1234/b", "doi:10.1234/c"],
          },
        ],
      }),
      "utf8",
    );

    // GET execution-history 旧形态正常读取（兼容）
    const view = await stack.request("GET", `/api/projects/${projectId}/research/execution-history`);
    expect(view.status).toBe(200);
    const entries = view.body["executionHistory"] as PlanExecutionEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.resultSnapshot).toBeUndefined();

    const old = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: "exec-m85old00001", queryId: "q-old", saveAsCandidates: [0] },
    );
    expect(old.status).toBe(409);
    expect(old.body["error"]).toMatchObject({ code: "EXECUTION_RESULTS_UNAVAILABLE" });

    const missing = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: "exec-nonexistent", queryId: "q-old", saveAsCandidates: [0] },
    );
    expect(missing.status).toBe(404);
    expect(missing.body["error"]).toMatchObject({ code: "EXECUTION_ENTRY_NOT_FOUND" });
  });

  it("缺字段 / 空数组 / 越界下标 → 400 INVALID_REQUEST", async () => {
    const projectId = await createProject("m91-save-validation");
    const entry = await executeSingle(projectId, { queryId: "q-1", query: "validation", kind: "academic" });

    const missingQueryId = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, saveAsCandidates: [0] },
    );
    expect(missingQueryId.status).toBe(400);

    const emptyIndexes = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, queryId: entry.queryId, saveAsCandidates: [] },
    );
    expect(emptyIndexes.status).toBe(400);

    const outOfRange = await stack.request(
      "POST",
      `/api/projects/${projectId}/research/execution-results/save-candidates`,
      { executionId: entry.executionId, queryId: entry.queryId, saveAsCandidates: [99] },
    );
    expect(outOfRange.status).toBe(400);
  });
});

describe("M9.1 partial failure 与兼容", () => {
  it("web provider 未配置：failed 条目无快照，学术成功条目快照保留（互不影响）", async () => {
    const projectId = await createProject("m91-partial-failure");
    await seedApprovedPlan(projectId, [
      { queryId: "q-1", query: "academic ok", kind: "academic" },
      { queryId: "q-2", query: "web down", kind: "web" },
    ]);

    const result = await stack.stack.planExecution.execute(projectId);
    expect(result.executedQueries).toBe(1);
    expect(result.failedQueries).toBe(1);

    const history = await readHistory(projectId);
    const academicEntry = history.find((item) => item.queryId === "q-1")!;
    const webEntry = history.find((item) => item.queryId === "q-2")!;
    expect(academicEntry.status).toBe("executed");
    expect(academicEntry.resultSnapshot).toHaveLength(10);
    expect(webEntry.status).toBe("failed");
    expect(webEntry.resultSnapshot).toBeUndefined();
    expect(webEntry.error).toContain("Web Search 未配置");
  });
});
