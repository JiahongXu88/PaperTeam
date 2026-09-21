/**
 * Web Search → Research Pipeline 接线验证（M8.5 §7 Web Search Real Validation）。
 *
 * 本机约束：无 Docker → 无法启动真实 SearXNG 容器（限制已记录在
 * M8.5 文档）。本测试用**本地 HTTP 假服务**模拟 SearXNG JSON API
 * （GET /search?format=json 的最小形状），验证生产装配路径的完整接线：
 *
 *   PAPERTEAM_SEARXNG_URL（searxngUrl 配置）
 *   → SearXNGProvider 注册 → WebSearchService → ResearchDiscoveryService
 *   → ResearchPlanExecution（kind=web 的 planned query）
 *   → executionHistory 审计（providers / resultIdentifiers）
 *
 * 即：配置了 SearXNG 时，academic + web 两种检索都能进入 Research Pipeline
 * 并留下可审计痕迹；未配置时 web query 如实 failed（不伪造成功——见
 * researchPlanExecution.test.ts 的 failure 用例）。
 */

import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readResearchArtifact } from "../../src/agents/ResearcherService.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

/** SearXNG JSON API 的最小真实形状（/search?format=json） */
function searxngJsonBody(): string {
  return JSON.stringify({
    query: "multi-agent systems survey",
    results: [
      {
        url: "https://example.com/mas-survey?utm_source=x",
        title: "Multi-Agent Systems Survey",
        content: "A survey of multi-agent systems.",
        engines: ["bing", "baidu"],
        score: 4.5,
      },
      {
        url: "https://example.org/llm-agents/",
        title: "LLM Agents Retrospective",
        content: "Retrospective on LLM agents.",
        engines: ["bing"],
        score: 2.0,
      },
    ],
    unresponsive_engines: [],
  });
}

const openalexFake = {
  results: [
    {
      id: "https://openalex.org/W111",
      title: "Multi-Agent Systems Survey",
      doi: "https://doi.org/10.1234/mas-survey",
      publication_year: 2023,
    },
  ],
};

describe("Web Search Pipeline 接线（SearXNG 配置 → 计划执行 → 审计落盘）", () => {
  let searxng: Server;
  let searxngUrl: string;
  let stack: TestStack;

  beforeAll(async () => {
    // 本地 SearXNG 假服务：真实 HTTP（非 fetch 注入）——覆盖 provider 的
    // URL 拼装 / query 参数 / header 全链路
    await new Promise<void>((resolve) => {
      searxng = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/search" && url.searchParams.get("format") === "json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(searxngJsonBody());
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
      searxng.listen(0, "127.0.0.1", () => {
        searxngUrl = `http://127.0.0.1:${(searxng.address() as { port: number }).port}`;
        resolve();
      });
    });

    stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      search: {
        disabledProviders: ["semantic-scholar", "arxiv", "aminer"],
        providerTimeoutMs: 2_000,
        searxngUrl,
        fetchImpl: (async (url: string | URL | Request): Promise<Response> => {
          const target = String(url);
          // SearXNG 走真实本地服务；学术侧只留 openalex 假应答
          if (target.startsWith(searxngUrl)) {
            return fetch(target);
          }
          if (target.startsWith("https://api.openalex.org/works")) {
            return new Response(JSON.stringify(openalexFake), { status: 200 });
          }
          return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
        }) as unknown as typeof fetch,
      },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
    await new Promise<void>((resolve) => searxng.close(() => resolve()));
  });

  it("web query 经 SearXNG 执行成功并进 executionHistory 审计；academic 同轮并行可用", async () => {
    const response = await stack.request("POST", "/api/projects", { title: "Web 检索接线" });
    const projectId = (response.body["project"] as { id: string }).id;
    const researchDir = stack.store.researchDir(projectId);
    await mkdir(researchDir, { recursive: true });
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({
        generatedAt: "2026-09-21T09:00:00.000Z",
        taskId: "run-webpipe",
        plan: {
          planId: "rp-webpipe000001",
          status: "draft",
          questions: ["multi-agent systems survey"],
          queries: [
            { queryId: "q-1", query: "multi-agent systems survey", kind: "academic", status: "planned" },
            { queryId: "q-2", query: "multi-agent systems survey", kind: "web", status: "planned" },
          ],
          createdAt: "2026-09-21T09:00:00.000Z",
          updatedAt: "2026-09-21T09:00:00.000Z",
        },
        report: {
          domainOverview: "概述",
          relatedWorkDirections: [],
          researchGaps: ["gap"],
          potentialContributions: ["c"],
          researchQuestions: [],
          literaturePlan: [],
        },
        evidence: [],
        bibliography: [],
      }),
      "utf8",
    );

    // 直接驱动栈内服务（与 HTTP 等价；计划批准 → 真实执行含 web 检索）
    await stack.stack.planExecution.approve(projectId);
    const result = await stack.stack.planExecution.execute(projectId);
    expect(result.executedQueries).toBe(2);
    expect(result.failedQueries).toBe(0);

    const artifact = (await readResearchArtifact(stack.store, projectId))!;
    const history = artifact.executionHistory ?? [];
    expect(history).toHaveLength(2);

    const academicEntry = history.find((entry) => entry.queryId === "q-1")!;
    expect(academicEntry.status).toBe("executed");
    expect(academicEntry.providers).toEqual([
      expect.objectContaining({ provider: "openalex", outcome: "ok", resultCount: 1 }),
    ]);
    expect(academicEntry.resultIdentifiers).toEqual(["doi:10.1234/mas-survey"]);

    const webEntry = history.find((entry) => entry.queryId === "q-2")!;
    expect(webEntry.status).toBe("executed");
    expect(webEntry.resultCount).toBe(2);
    expect(webEntry.providers).toEqual([
      expect.objectContaining({ provider: "searxng", outcome: "ok", resultCount: 2 }),
    ]);
    // Web 标识符 = canonical URL（utm 清洗 / 尾斜杠折叠后的稳定形态）
    expect(webEntry.resultIdentifiers).toEqual([
      "https://example.com/mas-survey",
      "https://example.org/llm-agents",
    ]);

    // 审计痕迹 ≠ 候选：web 检索结果没有落成 Candidate
    const candidates = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect(candidates.body["candidates"]).toEqual([]);
  });
});
