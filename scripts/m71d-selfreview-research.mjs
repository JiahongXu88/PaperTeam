#!/usr/bin/env node
/**
 * M7.1d Self Review —— 用 PaperTeam 自身 Research Discovery 能力调研外部
 * AI Research Agent / Deep Research 系统（一次性脚本，不进 CI）。
 *
 * 调用面 = Agent 会话同款工具对象：createScholarlyTools 产出的
 * search_papers / search_web / save_candidates（与 backend/src/index.ts
 * roleCustomTools 注入 researcher 会话的完全同源），服务栈与 index.ts
 * 同源装配（loadConfig / buildServiceStack）。
 *
 * 与 M7.1b smoke 的区别：不做 Agent run，只做工具级受控调用——query 覆盖
 * 度可控、结果可复现（Agent 全链路已由 M7.1b 真实验证，此处复用其能力
 * 面做研究）。Runtime 以最小 stub 满足装配类型（不会被调用）。
 *
 * 用法：node scripts/m71d-selfreview-research.mjs
 * 前置：npm run build（backend/dist 最新）。
 * 输出：docs/research/m71d-selfreview-search-results.json（原始调用记录，
 *       供 PAPERTEAM_SELF_REVIEW_M7.md 引用）。
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

// 临时项目根（必须在 loadConfig 前设置；绝对路径）
const projectsRoot = await mkdtemp(join(tmpdir(), "m71d-selfreview-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));

const config = loadConfig();
const log = (message) => console.log(message);

// ---------------- 装配（与 index.ts 同源；runtime 为 stub——工具级调用不触发） ----------------

const stack = buildServiceStack({
  runtime: {
    // AgentRuntime 形状占位：本脚本零 Agent run，任何方法被调到即说明偏离预期
    async runAgent() {
      throw new Error("m71d: unexpected runAgent (tool-level script)");
    },
    async startAgent() {
      throw new Error("m71d: unexpected startAgent (tool-level script)");
    },
    async close() {},
  },
  projects: new ProjectStore({ root: projectsRoot }),
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 600_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  log,
});

const projects = stack.projects;
const project = await projects.create("AI Research Agent 系统对比调研（M7.1d Self Review）", {
  researchIdea:
    "对比分析 2024-2026 年 AI scientific research agent / deep research 系统的架构（OpenAI Deep Research / Claude Research / Gemini Deep Research / AI Scientist / PaperQA / STORM / Elicit 等），评估 PaperTeam 自身架构的优势与不足",
  researchField: "AI · Research Agents",
});
log(`[boot] project: ${project.id} (root: ${projectsRoot})`);
log(
  `[boot] search config: disabledProviders=${JSON.stringify(config.search?.disabledProviders ?? [])} searxngConfigured=${Boolean(config.search?.searxngUrl)}`,
);

// ---------------- 工具面（Agent 会话同款对象，直接 execute） ----------------

const tools = createScholarlyTools(stack.citationIntegrity.scholarlyResolver, stack.discovery, project.id);
const byName = new Map(tools.map((t) => [t.name, t]));

async function callTool(name, params) {
  const tool = byName.get(name);
  if (tool === undefined) {
    throw new Error(`tool not found: ${name}`);
  }
  const startedAt = Date.now();
  const result = await tool.execute("m71d-selfreview", params);
  let payload;
  try {
    payload = JSON.parse(result.content[0].text);
  } catch {
    payload = { unparseable: result.content[0].text.slice(0, 500) };
  }
  return { payload, details: result.details, latencyMs: Date.now() - startedAt };
}

// ---------------- 检索计划（12 学术 query + 2 web query；2024-2026 优先） ----------------

const academicQueries = [
  // 覆盖目标系统本体
  { tag: "deep-research-systems", query: "deep research agents large language models", yearFrom: 2025 },
  { tag: "ai-scientist", query: "AI Scientist autonomous research paper generation", yearFrom: 2024 },
  { tag: "paperqa", query: "PaperQA retrieval augmented literature question answering", yearFrom: 2023 },
  { tag: "storm", query: "STORM writing Wikipedia-like articles from scratch with foundation models", yearFrom: 2024 },
  { tag: "literature-review-automation", query: "automated literature review large language models scientific", yearFrom: 2024 },
  // 覆盖架构能力维度
  { tag: "agentic-rag", query: "agentic retrieval augmented generation search agents", yearFrom: 2024 },
  { tag: "iterative-retrieval", query: "iterative retrieval query decomposition language models", yearFrom: 2024 },
  { tag: "multi-agent-science", query: "multi-agent system scientific research collaboration", yearFrom: 2024 },
  { tag: "citation-verification", query: "citation verification hallucination scientific writing", yearFrom: 2024 },
  { tag: "evidence-grounding", query: "evidence grounding attribution long-form generation", yearFrom: 2024 },
  { tag: "research-benchmarks", query: "benchmark evaluation deep research agents report generation", yearFrom: 2025 },
  { tag: "human-ai-research", query: "human-AI collaborative research assistant literature", yearFrom: 2024 },
  // 第二轮定向补充（首轮未直接命中的目标系统）
  { tag: "ai-scientist-paper", query: "fully automated open-ended scientific discovery", yearFrom: 2024 },
  { tag: "agent-laboratory", query: "Agent Laboratory LLM agents research automation", yearFrom: 2025 },
  { tag: "deep-research-survey", query: "deep research agents survey", yearFrom: 2025 },
  { tag: "co-storm", query: "Co-STORM collaborative knowledge curation discourse", yearFrom: 2024 },
  { tag: "elicit-review", query: "Elicit systematic review automation evidence extraction", yearFrom: 2024 },
];
// lookup_paper 核验（查证 ≠ 检索：三篇目标系统原始论文的 canonical 记录）
const lookupTargets = [
  { title: "The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery", year: 2024 },
  { title: "PaperQA: Retrieval-Augmented Generative Agent for Scientific Research", year: 2023 },
  { title: "Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models", year: 2024 },
];
const webQueries = [
  { tag: "openai-deep-research", query: "OpenAI Deep Research architecture agent" },
  { tag: "gemini-deep-research", query: "Gemini Deep Research how it works" },
];
// 选中 query 立即保存 top 候选（演示 save_candidates 并落盘对照）
const savePlan = new Set(["deep-research-systems", "ai-scientist", "paperqa", "storm"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trimResults(payload) {
  if (!Array.isArray(payload.results)) {
    return [];
  }
  return payload.results.slice(0, 8).map((r) => ({
    index: r.index,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : r.score,
    title: r.title,
    year: r.year,
    venue: r.venue,
    doi: r.doi ?? null,
    arxivId: r.arxivId ?? null,
    citationCount: r.citationCount ?? null,
    openAccess: r.openAccess ?? null,
    authors: Array.isArray(r.authors) ? r.authors.slice(0, 3) : r.authors,
    abstract: typeof r.abstract === "string" ? r.abstract.slice(0, 400) : r.abstract,
    url: r.url ?? null,
    sources: r.sources ?? null,
  }));
}

// ---------------- 执行 ----------------

const academicCalls = [];
const saveCalls = [];

for (const q of academicQueries) {
  try {
    const { payload, details, latencyMs } = await callTool("search_papers", {
      query: q.query,
      limit: 10,
      ...(q.yearFrom !== undefined ? { yearFrom: q.yearFrom } : {}),
    });
    const entry = {
      tool: "search_papers",
      tag: q.tag,
      params: { query: q.query, limit: 10, ...(q.yearFrom !== undefined ? { yearFrom: q.yearFrom } : {}) },
      status: payload.status ?? null,
      resultCount: Array.isArray(payload.results) ? payload.results.length : 0,
      diagnostics: payload.diagnostics ?? null,
      latencyMs,
      details,
      results: trimResults(payload),
    };
    academicCalls.push(entry);
    log(
      `[search_papers] ${q.tag}: status=${entry.status} results=${entry.resultCount} ${latencyMs}ms providers=${JSON.stringify((payload.diagnostics ?? []).map((d) => `${d.provider}:${d.outcome}(${d.resultCount})`).join(","))}`,
    );
    if (savePlan.has(q.tag) && entry.resultCount > 0) {
      const indexes = entry.results.slice(0, 3).map((r) => r.index);
      const save = await callTool("save_candidates", {
        kind: "academic",
        query: q.query,
        resultIndexes: indexes,
      });
      saveCalls.push({ tool: "save_candidates", tag: q.tag, params: { kind: "academic", query: q.query, resultIndexes: indexes }, payload: save.payload, latencyMs: save.latencyMs });
      log(`[save_candidates] ${q.tag}: ok=${save.payload.ok} saved=${save.payload.savedCount ?? 0} merged=${save.payload.mergedCount ?? 0}`);
    }
  } catch (error) {
    academicCalls.push({ tool: "search_papers", tag: q.tag, params: q, error: String(error?.stack ?? error) });
    log(`[search_papers] ${q.tag}: ERROR ${error?.message ?? error}`);
  }
  await sleep(600);
}

const webCalls = [];
for (const q of webQueries) {
  try {
    const { payload, details, latencyMs } = await callTool("search_web", { query: q.query, limit: 10 });
    webCalls.push({
      tool: "search_web",
      tag: q.tag,
      params: { query: q.query, limit: 10 },
      payload,
      details,
      latencyMs,
    });
    log(`[search_web] ${q.tag}: ok=${payload.ok ?? true} reason=${payload.reason ?? "-"} status=${payload.status ?? "-"} results=${Array.isArray(payload.results) ? payload.results.length : 0}`);
  } catch (error) {
    webCalls.push({ tool: "search_web", tag: q.tag, params: q, error: String(error?.stack ?? error) });
    log(`[search_web] ${q.tag}: ERROR ${error?.message ?? error}`);
  }
  await sleep(300);
}

const lookupCalls = [];
for (const target of lookupTargets) {
  try {
    const { payload, details, latencyMs } = await callTool("lookup_paper", target);
    lookupCalls.push({ tool: "lookup_paper", tag: target.title.slice(0, 60), params: target, payload, details, latencyMs });
    const canonicalTitle = payload.canonical?.title ?? "?";
    log(`[lookup_paper] outcome=${payload.outcome} | ${canonicalTitle.slice(0, 80)}`);
  } catch (error) {
    lookupCalls.push({ tool: "lookup_paper", tag: target.title.slice(0, 60), params: target, error: String(error?.stack ?? error) });
    log(`[lookup_paper] ERROR ${error?.message ?? error}`);
  }
  await sleep(400);
}

// ---------------- 磁盘证据 ----------------

let candidatesOnDisk = null;
try {
  const raw = JSON.parse(await readFile(join(projectsRoot, project.id, "sources", "candidates.json"), "utf8"));
  candidatesOnDisk = {
    count: Array.isArray(raw.items) ? raw.items.length : 0,
    items: (raw.items ?? []).map((c) => ({
      candidateId: c.candidateId,
      title: c.title?.slice(0, 100),
      year: c.year,
      status: c.status,
      origin: c.origin,
      provider: c.provider,
    })),
  };
} catch {
  candidatesOnDisk = { count: 0, items: [] };
}
log(`[disk] candidates on disk: ${candidatesOnDisk.count}`);

// ---------------- 输出 ----------------

const summary = {
  generatedAt: new Date().toISOString(),
  purpose: "M7.1d PaperTeam Self Review — 外部 AI Research Agent / Deep Research 系统调研的 Research Discovery 调用记录",
  toolSurface: "createScholarlyTools(...) 产出的 Agent 会话同款工具对象（search_papers / search_web / save_candidates），服务栈与 backend/src/index.ts 同源装配",
  projectsRoot,
  projectId: project.id,
  searchConfig: {
    disabledProviders: config.search?.disabledProviders ?? [],
    searxngConfigured: Boolean(config.search?.searxngUrl),
  },
  academicCalls,
  webCalls,
  lookupCalls,
  saveCalls,
  candidatesOnDisk,
};
const outPath = join(repoRoot, "docs", "research", "m71d-selfreview-search-results.json");
await writeFile(outPath, JSON.stringify(summary, null, 2), "utf8");

const totalResults = academicCalls.reduce((acc, c) => acc + (c.resultCount ?? 0), 0);
console.log("\n===== SUMMARY =====");
console.log(`search_papers calls: ${academicCalls.length} (results total: ${totalResults})`);
console.log(`search_web calls: ${webCalls.length}`);
console.log(`save_candidates calls: ${saveCalls.length} (candidates on disk: ${candidatesOnDisk.count})`);
console.log(`results json: ${outPath}`);
console.log(`projects root: ${projectsRoot}`);
