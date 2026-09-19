#!/usr/bin/env node
/**
 * M7.1b 真实 Researcher Discovery 验证（一次性脚本，不进入 CI）。
 *
 * 与单元测试的区别：跑真实 Researcher Agent 主链路（真实模型 + 真实外部
 * 学术检索 + 真实 CandidateStore 落盘），装配路径与 backend/src/index.ts
 * 完全同源（loadConfig / SkillRegistry / roleCustomTools / buildServiceStack），
 * 仅两处偏离：
 *   1. PROJECTS_ROOT 重定向到临时目录（不污染真实项目）；
 *   2. Runtime 外包一层 TracingRuntime（透明转发 + 订阅 AgentEvent 流记录
 *      tool_execution_start/end）——只为采集 tool call trace，不改任何行为。
 *
 * 场景（docs/research/M7.1_DISCOVERY_VALIDATION.md 的输入）：
 *   A 新领域文献调研：Transformer 多目标跟踪 2024-2026（期望 search_papers
 *     + save_candidates + candidates.json 落盘）
 *   B 事实验证：ByteTrack 发表年份（期望检索核验优先于模型记忆）
 *   C 已有论文分析：改进方向（期望允许直接分析，不强制检索）
 *
 * 用法：node scripts/m71-discovery-smoke.mjs [--only a|b|c]
 * 前置：npm run build（backend/dist 最新）；本机 ~/.paperteam 已配模型凭据。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]?.toLowerCase()
  : undefined;

// 临时项目根（必须在 loadConfig 前设置；绝对路径）
const projectsRoot = await mkdtemp(join(tmpdir(), "m71-discovery-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(
  distUrl("settings", "ModelSettingsStore.js")
);
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));

const config = loadConfig();
const logLines = [];
const boot = (message) => {
  logLines.push(message);
  console.log(message);
};

// ---------------- TracingRuntime：透明转发 + tool call trace 采集 ----------------

class TracingRuntime {
  constructor(adapter) {
    this.adapter = adapter;
    /** @type {Map<string, Array<{seq?:number, phase:string, tool:string, isError?:boolean}>>} */
    this.traces = new Map();
    /** @type {Map<string, {status:string, usage?:unknown, model?:unknown, error?:string}>} */
    this.tasks = new Map();
  }
  get provider() {
    return this.adapter.provider;
  }
  get resolvedModel() {
    return this.adapter.resolvedModel;
  }
  async startAgent(input) {
    const handle = await this.adapter.startAgent(input);
    const trace = this.traces.get(handle.taskId) ?? [];
    this.traces.set(handle.taskId, trace);
    void (async () => {
      try {
        for await (const event of handle.events()) {
          if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
            trace.push({
              ...(event.seq !== undefined ? { seq: event.seq } : {}),
              phase: event.type === "tool_execution_start" ? "start" : "end",
              tool: String(event.data?.toolName ?? "?"),
              ...(event.type === "tool_execution_end" ? { isError: Boolean(event.data?.isError) } : {}),
            });
          }
        }
      } catch (error) {
        trace.push({ phase: "trace_error", tool: String(error?.message ?? error) });
      }
    })();
    return handle;
  }
  async runAgent(input) {
    const handle = await this.startAgent(input);
    const task = await handle.result();
    this.tasks.set(task.taskId, {
      status: task.status,
      usage: task.usage,
      model: task.metadata?.model,
      ...(task.error !== undefined ? { error: task.error } : {}),
    });
    return task;
  }
  async getTask(taskId) {
    return this.adapter.getTask(taskId);
  }
  async healthCheck() {
    return this.adapter.healthCheck();
  }
  async modelStatusSnapshot() {
    return this.adapter.modelStatusSnapshot();
  }
  runtimeStats() {
    return this.adapter.runtimeStats();
  }
  async close() {
    return this.adapter.close();
  }
}

// ---------------- 装配（与 index.ts 同源） ----------------

const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
const installed = await skillRegistry.ensureInstalled();
boot(`[boot] skills installed: ${installed.map((s) => s.id).join(", ") || "(none)"}`);

const modelSettingsStore = new ModelSettingsStore({
  settingsDir: join(config.runtimeRoot, "settings"),
});
const modelSpec =
  config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型（PAPERTEAM_PI_MODEL / settings/model.json 均空）");
  process.exit(1);
}
boot(`[boot] model: ${modelSpec}`);

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  // 与 index.ts 完全同源的 roleCustomTools 接线
  roleCustomTools: (role, projectId) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(
        ...createScholarlyTools(
          stackRef.citationIntegrity.scholarlyResolver,
          stackRef.discovery,
          role === "researcher" ? projectId : undefined,
        ),
      );
    }
    if (
      (role === "researcher" || role === "writer" || role === "reviewer") &&
      stackRef !== undefined &&
      projectId !== undefined
    ) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, projectId));
    }
    if (stackRef !== undefined && projectId !== undefined) {
      tools.push(
        ...evidenceToolsForRole(
          role,
          {
            chunkAccess: stackRef.chunkAccess,
            grounding: stackRef.evidenceGrounding,
            evidence: stackRef.evidence,
          },
          projectId,
        ),
      );
    }
    return tools;
  },
  log: (message) => logLines.push(message),
});

const runtime = new TracingRuntime(adapter);
const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 600_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  log: (message) => logLines.push(message),
});
stackRef = stack;

// ---------------- 磁盘证据采集 ----------------

async function readJsonIfExist(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function projectDiskEvidence(projectId) {
  const dir = join(projectsRoot, projectId);
  const candidates = await readJsonIfExist(join(dir, "sources", "candidates.json"));
  const research = await readJsonIfExist(join(dir, "research", "research.json"));
  let evidenceCount = 0;
  try {
    const raw = await readFile(join(dir, "evidence", "evidence.jsonl"), "utf8");
    evidenceCount = raw.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    evidenceCount = 0;
  }
  return {
    researchJsonExists: research !== null,
    researchKind: research?.kind ?? "idea_research",
    bibliographyCount: Array.isArray(research?.bibliography) ? research.bibliography.length : 0,
    evidenceEntries: research?.evidence?.length ?? 0,
    evidenceJsonlLines: evidenceCount,
    candidates: Array.isArray(candidates?.items)
      ? candidates.items.map((c) => ({
          candidateId: c.candidateId,
          title: c.title?.slice(0, 90),
          year: c.year,
          status: c.status,
          origin: c.origin,
          provider: c.provider,
          query: c.query,
          doi: c.doi,
          arxivId: c.arxivId,
        }))
      : [],
  };
}

// ---------------- 场景 ----------------

const results = [];

async function scenario(tag, fn) {
  if (only !== undefined && only !== tag.toLowerCase()) {
    return;
  }
  const startedAt = Date.now();
  boot(`\n===== Scenario ${tag.toUpperCase()} start =====`);
  try {
    const detail = await fn();
    results.push({ scenario: tag, ok: true, elapsedMs: Date.now() - startedAt, ...detail });
    boot(`===== Scenario ${tag.toUpperCase()} done (${((Date.now() - startedAt) / 1000).toFixed(1)}s) =====`);
  } catch (error) {
    results.push({
      scenario: tag,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.stack ?? error),
    });
    boot(`===== Scenario ${tag.toUpperCase()} FAILED: ${error?.message ?? error} =====`);
  }
}

// —— A 新领域文献调研 ——
await scenario("A", async () => {
  const project = await projects.create("Transformer 多目标跟踪方法调研（M7.1 验证 A）", {
    researchIdea: "调研2024-2026年基于Transformer的多目标跟踪方法，总结主要研究方向和代表论文",
    researchField: "计算机视觉 · 多目标跟踪",
  });
  const result = await stack.researcher.research({ projectId: project.id });
  const trace = runtime.traces.get(result.taskId) ?? [];
  const toolsCalled = [...new Set(trace.filter((t) => t.phase === "start").map((t) => t.tool))];
  const disk = await projectDiskEvidence(project.id);
  return {
    projectId: project.id,
    taskId: result.taskId,
    model: runtime.tasks.get(result.taskId)?.model,
    usage: runtime.tasks.get(result.taskId)?.usage,
    toolCallsTotal: trace.filter((t) => t.phase === "start").length,
    toolsCalled,
    toolTrace: trace,
    researcherResult: {
      gaps: result.report.researchGaps.length,
      directions: result.report.relatedWorkDirections.length,
      literaturePlan: result.report.literaturePlan.length,
      evidenceAppended: result.evidenceAppended,
      evidenceProposed: result.evidenceProposed,
      bibliography: result.bibliographyCount,
    },
    domainOverviewHead: result.report.domainOverview.slice(0, 300),
    disk,
    checks: {
      calledSearchPapers: toolsCalled.includes("search_papers"),
      calledSaveCandidates: toolsCalled.includes("save_candidates"),
      candidatesPersisted: disk.candidates.length > 0,
      candidatesPendingReview: disk.candidates.every((c) => c.status === "pending_review"),
      candidatesFromAcademicSearch: disk.candidates.some((c) => c.origin === "academic_search"),
    },
  };
});

// —— B 事实验证 ——
await scenario("B", async () => {
  const project = await projects.create("ByteTrack 发表信息核验（M7.1 验证 B）", {
    researchIdea: "ByteTrack发表于哪一年？它解决了什么问题？",
    researchField: "计算机视觉 · 多目标跟踪",
  });
  const result = await stack.researcher.research({ projectId: project.id });
  const trace = runtime.traces.get(result.taskId) ?? [];
  const toolsCalled = [...new Set(trace.filter((t) => t.phase === "start").map((t) => t.tool))];
  const disk = await projectDiskEvidence(project.id);
  return {
    projectId: project.id,
    taskId: result.taskId,
    model: runtime.tasks.get(result.taskId)?.model,
    usage: runtime.tasks.get(result.taskId)?.usage,
    toolCallsTotal: trace.filter((t) => t.phase === "start").length,
    toolsCalled,
    toolTrace: trace,
    domainOverviewHead: result.report.domainOverview.slice(0, 400),
    disk,
    checks: {
      verifiedViaSearch: toolsCalled.some((t) => t === "search_papers" || t === "lookup_paper"),
    },
  };
});

// —— C 已有论文分析（不强制检索） ——
await scenario("C", async () => {
  const project = await projects.create("论文改进方向分析（M7.1 验证 C）", {
    workflowKind: "existing_paper_improvement",
    researchIdea: "分析我的论文算法还有哪些改进方向",
    researchField: "计算机视觉 · 多目标跟踪",
  });
  const digest = [
    "论文标题：MRG-DTM: Multi-Reference Gated Dynamic Transfer for Multi-Object Tracking",
    "方法概述：在 ByteTrack 式检测+关联两段式框架上引入 MRG-DTM 模块——多参考运动门控与动态传递机制，",
    "  在遮挡场景下用历史轨迹参考修正运动预测，并引入 ReID 外观嵌入辅助低照度场景的身份保持。",
    "实验设置：MOT17/MOT20 半监督协议，检测器 YOLO 系（INT8 量化部署于嵌入式 RDK X3），",
    "  评测指标 HOTA/MOTA/IDF1/IDS/Frag；含遮挡恢复专项与低照度/高密度极端场景专项实验。",
    "主要结果：与纯 IoU 关联基线相比，遮挡场景 IDS 降低约 73%（150→41）、Frag 降低约 49%，",
    "  恢复率提升至 50%；但整体 HOTA 增益有限，极端场景下机制增益接近中性。",
    "已知弱点：运动项尺度失衡导致部分翻转；ReID 嵌入在量化后区分度下降；高速场景关联延迟。",
  ].join("\n");
  const result = await stack.researcher.analyzeExistingPaper({ projectId: project.id, manuscriptDigest: digest });
  const trace = runtime.traces.get(result.taskId) ?? [];
  const toolsCalled = [...new Set(trace.filter((t) => t.phase === "start").map((t) => t.tool))];
  const disk = await projectDiskEvidence(project.id);
  return {
    projectId: project.id,
    taskId: result.taskId,
    model: runtime.tasks.get(result.taskId)?.model,
    usage: runtime.tasks.get(result.taskId)?.usage,
    toolCallsTotal: trace.filter((t) => t.phase === "start").length,
    toolsCalled,
    toolTrace: trace,
    weaknessesCount: result.weaknesses.length,
    weaknessesHead: result.weaknesses.slice(0, 5),
    disk,
    checks: {
      analysisCompleted: true,
      searchForced: toolsCalled.some((t) => t === "search_papers" || t === "search_web"),
    },
  };
});

// ---------------- 收尾 ----------------

const stats = adapter.runtimeStats();
await adapter.close();

const summary = {
  generatedAt: new Date().toISOString(),
  modelSpec,
  agentDir: config.pi.agentDir.replace(homedir(), "~"),
  projectsRoot,
  searchConfig: {
    disabledProviders: config.search?.disabledProviders ?? [],
    searxngConfigured: Boolean(config.search?.searxngUrl),
  },
  runtimeStats: stats?.usageTotals,
  results,
};
const reportPath = join(projectsRoot, "m71-validation-results.json");
const { writeFile } = await import("node:fs/promises");
await writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");

console.log("\n===== SUMMARY =====");
for (const r of results) {
  console.log(
    `${r.ok ? "DONE" : "FAIL"} [${r.scenario}] ${(r.elapsedMs / 1000).toFixed(1)}s checks=${JSON.stringify(r.checks)}`,
  );
}
console.log(`results json: ${reportPath}`);
console.log(`projects root: ${projectsRoot}`);

// 保留临时目录（磁盘证据供报告引用）；下次运行自然创建新目录
