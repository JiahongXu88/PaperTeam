/**
 * scholarlyTools 工具面测试（M7.1a）：
 * - 工具 schema：researcher 形态（discovery + projectId）注册
 *   search_papers / search_web / lookup_paper / save_candidates 四工具；
 *   无 projectId（citation 形态）不注册 save_candidates；
 * - search_papers / search_web 把 projectId 透传给 discovery（写入项目检索缓存）；
 * - save_candidates：参数原样到达 saveCandidatesFromCache（projectId 闭包不可指定），
 *   成功结构化返回 saved/merged 计数，SEARCH_CACHE_MISS 等失败不抛错。
 */

import { describe, expect, it, vi } from "vitest";

import { BusinessError } from "../../src/errors.js";
import type { ScholarlyResolver } from "../../src/citation/scholarly.js";
import type { ResearchDiscoveryService } from "../../src/search/researchDiscoveryService.js";
import { createScholarlyTools } from "../../src/skills/scholarlyTools.js";
import { buildIdentity } from "../../src/sources/identity.js";

/** 最小可执行面（绕开库泛型，直接驱动 execute） */
interface ExecutableTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
}

function toolByName(tools: ReturnType<typeof createScholarlyTools>, name: string): ExecutableTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`工具 ${name} 未注册`);
  }
  return tool as unknown as ExecutableTool;
}

const stubResolver = { resolve: vi.fn() } as unknown as ScholarlyResolver;

/** 假 discovery：记录调用并按脚本返回（覆盖检索与缓存回放两条路径） */
function fakeDiscovery(script: {
  academicSearch?: () => Promise<unknown>;
  webSearch?: () => Promise<unknown>;
  saveCandidatesFromCache?: (projectId: string, kind: string, query: string, indexes: number[]) => Promise<unknown>;
}): { fake: ResearchDiscoveryService; calls: { academicSearch: unknown[][]; webSearch: unknown[][]; save: unknown[][] } } {
  const calls = { academicSearch: [] as unknown[][], webSearch: [] as unknown[][], save: [] as unknown[][] };
  const fake = {
    academicSearch: vi.fn(async (...args: unknown[]) => {
      calls.academicSearch.push(args);
      return script.academicSearch?.() ?? { status: "success", results: [], diagnostics: { providers: [] } };
    }),
    webSearch: vi.fn(async (...args: unknown[]) => {
      calls.webSearch.push(args);
      return script.webSearch?.() ?? { status: "success", results: [], diagnostics: { providers: [] } };
    }),
    saveCandidatesFromCache: vi.fn(async (...args: unknown[]) => {
      calls.save.push(args);
      return script.saveCandidatesFromCache?.(
        args[0] as string,
        args[1] as string,
        args[2] as string,
        args[3] as number[],
      );
    }),
  } as unknown as ResearchDiscoveryService;
  return { fake, calls };
}

describe("createScholarlyTools 工具面（M7.1a）", () => {
  it("researcher 形态（projectId 绑定）：注册 search_papers / search_web / lookup_paper / save_candidates", () => {
    const { fake } = fakeDiscovery({});
    const tools = createScholarlyTools(stubResolver, fake, "p-researcher");
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_papers", "search_web", "lookup_paper", "save_candidates"]),
    );
  });

  it("citation 形态（无 projectId）：不注册 save_candidates", () => {
    const { fake } = fakeDiscovery({});
    const tools = createScholarlyTools(stubResolver, fake);
    expect(tools.map((tool) => tool.name)).toEqual(["search_papers", "search_web", "lookup_paper"]);
  });

  it("search_papers / search_web 把闭包 projectId 透传给 discovery（第三参）", async () => {
    const identity = buildIdentity({ doi: "10.1234/tool-0", title: "Tool Paper" })!;
    const { fake, calls } = fakeDiscovery({
      academicSearch: async () => ({
        status: "success",
        results: [
          {
            identity,
            record: { provider: "openalex", recordId: "W1", title: "Tool Paper", year: 2024 },
            score: 0.9,
            sources: [{ provider: "openalex", rank: 1 }],
          },
        ],
        diagnostics: { providers: [{ provider: "openalex", outcome: "ok", resultCount: 1, latencyMs: 5 }] },
      }),
      webSearch: async () => ({
        status: "success",
        results: [{ url: "https://example.com/x", title: "X", snippet: "s", engines: [], score: 1, provider: "searxng" }],
        diagnostics: { providers: [] },
      }),
    });
    const tools = createScholarlyTools(stubResolver, fake, "p-pass-through");
    await toolByName(tools, "search_papers").execute("call-1", { query: "agents" });
    await toolByName(tools, "search_web").execute("call-2", { query: "agents" });
    expect(calls.academicSearch[0]![2]).toBe("p-pass-through");
    expect(calls.webSearch[0]![2]).toBe("p-pass-through");
  });

  it("save_candidates：参数原样到达后端（projectId 来自闭包，Agent 无法指定其他项目）", async () => {
    const { fake, calls } = fakeDiscovery({
      saveCandidatesFromCache: async () => ({
        saved: [
          {
            candidateId: "C001",
            title: "Saved Paper",
            year: 2024,
            status: "pending_review",
          },
        ],
        mergedExisting: [1],
      }),
    });
    const tools = createScholarlyTools(stubResolver, fake, "p-bound");
    const result = await toolByName(tools, "save_candidates").execute("call-3", {
      kind: "academic",
      query: "agents",
      resultIndexes: [0, 1],
    });
    expect(calls.save[0]).toEqual(["p-bound", "academic", "agents", [0, 1]]);
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "save_candidates", ok: true, savedCount: 1, mergedCount: 1 });
    expect(payload["saved"]).toEqual([
      { candidateId: "C001", title: "Saved Paper", year: 2024, status: "pending_review" },
    ]);
  });

  it("save_candidates：SEARCH_CACHE_MISS 结构化返回，不抛错打断 Agent", async () => {
    const { fake } = fakeDiscovery({
      saveCandidatesFromCache: async () => {
        throw new BusinessError("SEARCH_CACHE_MISS", "没有可用的检索缓存");
      },
    });
    const tools = createScholarlyTools(stubResolver, fake, "p-miss");
    const result = await toolByName(tools, "save_candidates").execute("call-4", {
      kind: "web",
      query: "stale query",
      resultIndexes: [0],
    });
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "save_candidates", ok: false, reason: "SEARCH_CACHE_MISS" });
    expect(result.details).toMatchObject({ ok: false, reason: "SEARCH_CACHE_MISS" });
  });
});
