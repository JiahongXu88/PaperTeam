/**
 * serviceStack：M13.8 researchFetch 接线与优先级。
 *
 * - researchFetch 注入 → 学术检索（ProviderHttpClient）与元数据核验（ScholarlyResolver）
 *   的请求都经它发出；
 * - 显式测试 seam（search.fetchImpl / citation.scholarly.fetchImpl）优先于 researchFetch
 *   （mock fetch 不被真实代理劫持）；
 * - 不注入 researchFetch 时不触碰任何路由（旧版行为）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LatexCompiler } from "../src/latex/LatexCompiler.js";
import { ProjectStore } from "../src/project/ProjectStore.js";
import { buildServiceStack } from "../src/serviceStack.js";
import { AGENT_IDS, createScriptedRuntime } from "./helpers/testStack.js";

function recordingFetch(label: string, log: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    log.push(`${label} ${url}`);
    if (url.includes("api.openalex.org")) {
      return new Response(JSON.stringify({ results: [], meta: { count: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("semanticscholar")) {
      return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("export.arxiv.org")) {
      return new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200, headers: { "content-type": "application/atom+xml" } });
    }
    if (url.includes("api.crossref.org")) {
      return new Response(JSON.stringify({ status: "ok", message: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("serviceStack：researchFetch 接线", () => {
  let root: string;
  let store: ProjectStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-stack-researchfetch-"));
    store = new ProjectStore({ root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function buildStack(extra: Partial<Parameters<typeof buildServiceStack>[0]>) {
    return buildServiceStack({
      runtime: createScriptedRuntime().runtime,
      projects: store,
      latex: new LatexCompiler({ timeoutMs: 1_000 }),
      agentIds: { ...AGENT_IDS },
      log: () => {},
      ...extra,
    });
  }

  it("researchFetch 注入：学术检索与引用元数据核验都经它发出", async () => {
    const log: string[] = [];
    const stack = buildStack({ researchFetch: recordingFetch("research", log) });
    await stack.discovery.academicSearch("transformer tracking", { limit: 3 });
    expect(log.some((line) => line.startsWith("research ") && line.includes("api.openalex.org"))).toBe(true);
    expect(log.some((line) => line.startsWith("research ") && line.includes("export.arxiv.org"))).toBe(true);
    const before = log.length;
    await stack.citationIntegrity.scholarlyResolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(log.length).toBeGreaterThan(before);
    expect(log.slice(before).every((line) => line.startsWith("research "))).toBe(true);
  });

  it("显式 search.fetchImpl / citation.scholarly.fetchImpl 优先于 researchFetch", async () => {
    const log: string[] = [];
    const stack = buildStack({
      researchFetch: recordingFetch("research", log),
      search: { disabledProviders: [], providerTimeoutMs: 5_000, fetchImpl: recordingFetch("search-seam", log) },
      citation: { scholarly: { fetchImpl: recordingFetch("scholarly-seam", log) } },
    });
    await stack.discovery.academicSearch("transformer tracking", { limit: 3 });
    await stack.citationIntegrity.scholarlyResolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((line) => !line.startsWith("research "))).toBe(true);
    expect(log.some((line) => line.startsWith("search-seam "))).toBe(true);
    expect(log.some((line) => line.startsWith("scholarly-seam "))).toBe(true);
  });
});
