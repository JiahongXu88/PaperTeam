/**
 * Research Discovery HTTP 集成测试（M6.3；指令 §44/§43-9）。
 *
 * 经真实 HTTP server + 真实 serviceStack（search 注入 fake fetch：只放行
 * openalex 的假响应），覆盖：搜索 → 显式保存 → CandidateStore → promotion 幂等、
 * 项目隔离、origin/provider/identity/query provenance、重复不污染、
 * 无 SearXNG 时后端正常且 web-search 结构化 503、provider health 端点、
 * 检索链路不写 EvidenceStore。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

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
      ids: { openalex: "https://openalex.org/W111" },
      abstract_inverted_index: { Survey: [0], of: [1], agents: [2] },
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

const fakeSearchFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexFake), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

let stack: TestStack;
let otherStack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    search: {
      // 只启用 openalex + 注入 fake fetch（离线）；searxng 未配置
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

describe("Research Discovery HTTP API", () => {
  it("academic-search：返回融合结果 + diagnostics，不写 candidates（默认不持久化）", async () => {
    const projectId = await createProject("discovery-no-save");
    const response = await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "multi-agent survey",
      limit: 5,
    });
    expect(response.status).toBe(200);
    expect(response.body["status"]).toBe("success");
    const results = response.body["results"] as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    expect(results[0]!["record"]).toMatchObject({ title: "Multi-Agent Systems Survey", doi: "10.1234/mas-survey" });
    expect(results[0]!["citationCount"]).toBe(42);
    const diagnostics = response.body["diagnostics"] as { providers: Array<Record<string, unknown>> };
    expect(diagnostics.providers).toEqual([
      expect.objectContaining({ provider: "openalex", outcome: "ok", resultCount: 2 }),
    ]);
    // 未传 saveAsCandidates：不写候选
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((candidates.body["candidates"] as unknown[]).length).toBe(0);
    // EvidenceStore 不被检索链路触碰
    const evidence = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    expect((evidence.body["evidence"] as unknown[] | undefined) ?? []).toEqual([]);
  });

  it("saveAsCandidates：显式保存 → origin/provider/identity/query provenance 齐全", async () => {
    const projectId = await createProject("discovery-save");
    const response = await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "multi-agent survey",
      saveAsCandidates: [0],
    });
    expect(response.status).toBe(200);
    const saved = response.body["saved"] as { saved: unknown[]; mergedExisting: number[] };
    expect(saved.saved).toHaveLength(1);
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    const list = candidates.body["candidates"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      origin: "academic_search",
      provider: "openalex",
      title: "Multi-Agent Systems Survey",
      doi: "10.1234/mas-survey",
      query: "multi-agent survey",
      status: "pending_review",
    });
    const identity = list[0]!["identity"] as Record<string, unknown>;
    expect(identity["doi"]).toBe("10.1234/mas-survey");
  });

  it("重复保存同身份：pending 候选不重复污染（合并既有）", async () => {
    const projectId = await createProject("discovery-dedup");
    await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "multi-agent survey",
      saveAsCandidates: [0, 1],
    });
    const again = await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "agents again",
      saveAsCandidates: [0],
    });
    const saved = again.body["saved"] as { saved: unknown[]; mergedExisting: number[] };
    expect(saved.saved).toHaveLength(0);
    expect(saved.mergedExisting).toEqual([0]);
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((candidates.body["candidates"] as unknown[]).length).toBe(2); // 仍是两条
  });

  it("项目隔离：候选只落在各自项目", async () => {
    const projectA = await createProject("discovery-iso-a");
    const projectB = await createProject("discovery-iso-b");
    await stack.request("POST", `/api/projects/${projectA}/research/academic-search`, {
      query: "q-a",
      saveAsCandidates: [0],
    });
    const bCandidates = await stack.request("GET", `/api/projects/${projectB}/sources/candidates`);
    expect((bCandidates.body["candidates"] as unknown[]).length).toBe(0);
    const aCandidates = await stack.request("GET", `/api/projects/${projectA}/sources/candidates`);
    expect((aCandidates.body["candidates"] as unknown[]).length).toBe(1);
  });

  it("promotion 继续幂等：搜索候选 → promote → 重复 promote 同一 Source", async () => {
    const projectId = await createProject("discovery-promote");
    await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "multi-agent survey",
      saveAsCandidates: [0],
    });
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    const candidateId = ((candidates.body["candidates"] as Array<Record<string, unknown>>)[0]!["candidateId"]) as string;
    const first = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/${candidateId}/promote`, {});
    expect(first.status).toBe(200);
    const sourceId = (first.body["source"] as Record<string, unknown>)["sourceId"];
    expect((first.body["source"] as Record<string, unknown>)["origin"]).toBe("AGENT_RETRIEVED");
    const second = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/${candidateId}/promote`, {});
    expect(second.status).toBe(200);
    expect((second.body["source"] as Record<string, unknown>)["sourceId"]).toBe(sourceId);
    expect(second.body["created"]).toBe(false);
  });

  it("web-search：未配置 SearXNG → 结构化 503，后端与学术检索不受影响", async () => {
    const projectId = await createProject("discovery-no-searxng");
    const web = await stack.request("POST", `/api/projects/${projectId}/research/web-search`, { query: "anything" });
    expect(web.status).toBe(503);
    expect(web.body).toMatchObject({
      status: "error",
      error: expect.objectContaining({ code: "SEARCH_PROVIDER_NOT_CONFIGURED" }),
    });
    // 学术链路照常 + 健康端点可用
    const academic = await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "still works",
    });
    expect(academic.status).toBe(200);
    const health = await stack.request("GET", "/api/research/providers");
    expect(health.status).toBe(200);
    const providers = health.body["providers"] as { academic: unknown[]; web: unknown[] };
    expect(providers.academic).toHaveLength(1); // 只有 openalex 注册
    expect(providers.web).toHaveLength(0); // SearXNG 未注册
  });

  it("校验：query 缺失 400 / limit 越界 400 / saveAsCandidates 越界 400", async () => {
    const projectId = await createProject("discovery-validation");
    expect((await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {})).status).toBe(400);
    expect(
      (await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, { query: "x", limit: 51 })).status,
    ).toBe(400);
    expect(
      (
        await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
          query: "x",
          saveAsCandidates: [99],
        })
      ).status,
    ).toBe(400);
    // 年份区间非法
    expect(
      (
        await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
          query: "x",
          yearFrom: 2030,
          yearTo: 2020,
        })
      ).status,
    ).toBe(400);
  });

  it("检索结果不是 Evidence / Source：不传 save 时 sources 列表不变", async () => {
    const projectId = await createProject("discovery-no-leak");
    const before = await stack.request("GET", `/api/projects/${projectId}/sources`);
    await stack.request("POST", `/api/projects/${projectId}/research/academic-search`, { query: "q" });
    const after = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect((after.body["sources"] as unknown[]).length).toBe((before.body["sources"] as unknown[]).length);
  });
});

describe("无 SearXNG / 无任何 provider 的最小栈", () => {
  it("academic-search 结构化 503；backend 其余端点正常（SearXNG optional 纪律）", async () => {
    otherStack = await startTestStack(scriptedIdeaRuntime().runtime); // 默认 search 全关
    const projectId = await createProjectOn(otherStack, "bare-stack");
    const academic = await otherStack.request("POST", `/api/projects/${projectId}/research/academic-search`, {
      query: "x",
    });
    expect(academic.status).toBe(503);
    expect(academic.body).toMatchObject({
      error: expect.objectContaining({ code: "SEARCH_PROVIDER_NOT_CONFIGURED" }),
    });
    // 核心能力不受影响
    const projects = await otherStack.request("GET", "/api/projects");
    expect(projects.status).toBe(200);
    const health = await otherStack.request("GET", "/api/research/providers");
    expect(health.status).toBe(200);
    await otherStack.cleanup();
  });
});

async function createProjectOn(target: TestStack, title: string): Promise<string> {
  const response = await target.request("POST", "/api/projects", { title });
  return (response.body["project"] as { id: string }).id;
}
