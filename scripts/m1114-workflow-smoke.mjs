#!/usr/bin/env node
/**
 * M11.1.4 topic_survey Workflow 真实 Acceptance（一次性脚本，不进 CI）。
 *
 * 验证「只输入 Topic」的正式 workflow 用户路径（真实模型 / 真实检索 /
 * 真实全文下载，无任何中间 API 手工代跑）：
 *   1. POST /api/projects {title: topic, workflowKind: topic_survey}
 *   2. POST /api/projects/:id/workflows {kind: topic_survey}
 *   3. 轮询 run；四个 HITL 只做 approve（文献遴选用默认推荐集）
 *   4. completed(label=survey) 后收集：候选 / 入选 / 全文 / 矩阵 / 综合 /
 *      大纲统计 + 各 stage 耗时 + run-trace（模型 turns / tokens / cost）
 *
 * 主题：多目标跟踪中的数据关联方法（与 M11.1.2/1.3 同域，便于横向对比；
 * 全链由 workflow 自动驱动——不预置 Matrix / Synthesis / Outline）。
 *
 * 用法：node scripts/m1114-workflow-smoke.mjs
 * 前置：npm --prefix backend run build；~/.paperteam 已配模型凭据；外网可达。
 * 可用 PAPERTEAM_PI_MODEL 覆盖模型（缺省 zai-coding-cn/glm-5.3）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const TOPIC = "多目标跟踪中的数据关联方法";

const projectsRoot = await mkdtemp(join(tmpdir(), "m1114-workflow-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(
  distUrl("settings", "ModelSettingsStore.js")
);
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const {
  createTopicSurveyDefinition,
} = await import(distUrl("workflow", "definitions.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));

const config = loadConfig();
console.log(`[boot] model: ${process.env["PAPERTEAM_PI_MODEL"]}`);

const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();

const modelSettingsStore = new ModelSettingsStore({
  settingsDir: join(config.runtimeRoot, "settings"),
});
const modelSpec = config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型（PAPERTEAM_PI_MODEL / settings/model.json 均空）");
  process.exit(1);
}

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
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
  log: () => {},
});

const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 600_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  log: (message) => console.log(message),
});
stackRef = stack;
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") {
      throw new Error(`smoke 只装配 topic_survey（收到 ${kind}）`);
    }
    return createTopicSurveyDefinition(stack.workflowServices);
  },
  log: () => {},
});
const server = createBackendHttpServer({
  runtime: adapter,
  projects,
  generation: stack.generation,
  orchestrator,
  stack,
});
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`[boot] backend http on ${base}\n`);

const report = { startedAt: new Date().toISOString(), topic: TOPIC, checks: [], hitl: [] };
const record = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "WARN"} ${name}${detail !== "" ? ` — ${detail}` : ""}`);
};

async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = { raw: true };
  }
  return { status: response.status, body: parsed };
}

const runStartedAt = Date.now();
let manualApiCalls = 0; // 除创建 + HITL resume 之外的调用都算手工代跑（应为 0）

try {
  // ---- 1. 只输入 Topic：创建项目 + 启动 workflow ----
  const created = await request("POST", "/projects", {
    title: TOPIC,
    workflowKind: "topic_survey",
  });
  if (created.status !== 201) {
    throw new Error(`项目创建失败：${created.status}`);
  }
  const projectId = created.body.project.id;
  report.projectId = projectId;

  const started = await request("POST", `/projects/${projectId}/workflows`, {
    kind: "topic_survey",
  });
  if (started.status !== 202) {
    throw new Error(`run 启动失败：${started.status}`);
  }
  const runId = started.body.runId;
  report.runId = runId;
  record("只输入 Topic 启动（创建项目 + 启动 workflow，两次 API）", true, `runId=${runId}`);

  // ---- 2. 轮询 + 四个 HITL 只 approve ----
  let run;
  const pollDeadline = Date.now() + 4 * 60 * 60 * 1000; // 4h 硬上限
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    run = body.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      break;
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      const payload = run.awaiting?.payload ?? {};
      const summary = {
        stageId,
        pendingCount: payload["pendingCount"],
        recommended: Array.isArray(payload["recommendedCandidateIds"])
          ? payload["recommendedCandidateIds"].length
          : payload["entries"],
        entries: payload["entries"],
        fulltext: payload["fulltext"],
        abstractOnly: payload["abstractOnly"],
        unclassified: payload["attention"]?.["unclassified"]?.length,
        sections: Array.isArray(payload["sections"]) ? payload["sections"].length : undefined,
      };
      report.hitl.push(summary);
      console.log(`[hitl] ${stageId}：${JSON.stringify(summary)}`);
      // 文献遴选：approve 默认推荐集；其余 HITL：approve（少做人工修正）
      const resume = await request("POST", `/runs/${runId}/resume`, { decision: "approve" });
      if (resume.status !== 200) {
        throw new Error(`resume ${stageId} 失败：${resume.status} ${JSON.stringify(resume.body)}`);
      }
      continue;
    }
    if (Date.now() > pollDeadline) {
      throw new Error(`run 超时未完成（status=${run.status} stage=${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const durationMs = Date.now() - runStartedAt;
  report.runStatus = run.status;
  report.durationMs = durationMs;
  if (run.status !== "completed") {
    record("run 完成", false, `${run.status}: ${run.error?.code} ${run.error?.message ?? ""}`);
  } else {
    record("run 完成（label=survey）", run.completion?.label === "survey", JSON.stringify(run.completion?.summary ?? {}));
  }

  // ---- 3. artifact 统计 ----
  const readJson = async (relative) =>
    JSON.parse(await readFile(join(projects.projectDir(projectId), relative), "utf8"));

  const research = await readJson(join("research", "research.json"));
  const activePlan = research.plans.find((plan) => plan.planId === research.activePlanId);
  report.plan = {
    questions: activePlan?.questions?.length,
    queries: activePlan?.queries?.length,
    taxonomyIntent: research.surveyProfile?.taxonomy?.families?.map((family) => family.label),
    executedQueries: (research.executionHistory ?? []).filter((entry) => entry.status === "executed").length,
    failedQueries: (research.executionHistory ?? []).filter((entry) => entry.status === "failed").length,
    snapshotResults: (research.executionHistory ?? []).reduce(
      (sum, entry) => sum + (entry.resultSnapshot?.length ?? 0),
      0,
    ),
  };

  const candidatesResponse = await request("GET", `/projects/${projectId}/candidates`);
  const candidates = candidatesResponse.body["candidates"] ?? [];
  manualApiCalls += 1; // 只读观测（不驱动流程）
  report.candidates = {
    total: candidates.length,
    accepted: candidates.filter((candidate) => candidate.status === "accepted").length,
    pending: candidates.filter((candidate) => candidate.status === "pending_review").length,
  };

  const sources = await readJson(join("sources", "index.json")).catch(async () => {
    // 布局不符时退回 API 只读观测（不驱动流程）
    const response = await request("GET", `/projects/${projectId}/sources`);
    manualApiCalls += 1;
    return { items: response.body["sources"] ?? [] };
  });
  const sourceItems = sources.items ?? [];
  const selected = run.stageResults?.["hitl.literature_selection"]?.candidateIds ?? [];
  const fulltextStage = run.stageResults?.["survey.fulltext"] ?? {};
  report.literature = {
    selected: selected.length,
    promotedSources: sourceItems.length,
    fulltextResolved: fulltextStage.fulltextResolved,
    fulltextNotFound: fulltextStage.fulltextNotFound,
    fulltextNotResolvable: fulltextStage.fulltextNotResolvable,
    fulltextFailed: fulltextStage.fulltextFailed,
    ingested: fulltextStage.ingested,
  };

  const matrix = await readJson(join("research", "survey.json"));
  report.matrix = {
    entries: matrix.entries.length,
    fulltext: matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length,
    abstractOnly: matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only").length,
    unclassified: matrix.entries.filter(
      (entry) => entry.methodFamily === undefined || entry.methodFamily === "unclassified",
    ).length,
    byFamily: matrix.entries.reduce((acc, entry) => {
      const key = entry.methodFamily ?? "unclassified";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    entriesWithIssues: matrix.entries.filter((entry) => (entry.issues ?? []).length > 0).length,
  };

  const synthesis = await readJson(join("research", "survey-synthesis.json"));
  report.synthesis = {
    items: synthesis.items.length,
    byKind: synthesis.items.reduce((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
    grounding: synthesis.items.reduce((acc, item) => {
      acc[item.groundingLevel] = (acc[item.groundingLevel] ?? 0) + 1;
      return acc;
    }, {}),
    synthesisStage: run.stageResults?.["survey.synthesis"] ?? null,
  };

  const outline = await readJson(join("manuscript", "outline.json"));
  report.outline = {
    title: outline.title,
    sections: outline.sections.map((section) => ({
      id: section.id,
      title: section.title,
      synthesisRefs: (section.synthesisRefs ?? []).length,
      literatureRefs: (section.literatureRefs ?? []).length,
    })),
    outlineStage: run.stageResults?.["survey.outline"] ?? null,
  };

  // ---- 4. 检查：refs 可回溯 + 组织方式 + speculative 隔离 ----
  const synthesisIds = new Set(synthesis.items.map((item) => item.synthesisId));
  const entryIds = new Set(matrix.entries.map((entry) => entry.entryId));
  const badSynthesisRefs = outline.sections.flatMap((section) =>
    (section.synthesisRefs ?? []).filter((ref) => !synthesisIds.has(ref)),
  );
  const badLiteratureRefs = outline.sections.flatMap((section) =>
    (section.literatureRefs ?? []).filter((ref) => !entryIds.has(ref)),
  );
  record("refs 全部可回溯（synthesis / literature）", badSynthesisRefs.length === 0 && badLiteratureRefs.length === 0);

  const speculativeIds = new Set(
    synthesis.items.filter((item) => item.groundingLevel === "speculative").map((item) => item.synthesisId),
  );
  const speculativeOutsideFuture = outline.sections.filter(
    (section) =>
      !/future|outlook|prospect|展望|未来|前景|开放/i.test(`${section.id} ${section.title}`) &&
      (section.synthesisRefs ?? []).some((ref) => speculativeIds.has(ref)),
  );
  record(
    `speculative ${speculativeIds.size} 条只在展望语境章节`,
    speculativeOutsideFuture.length === 0,
    speculativeOutsideFuture.map((section) => section.id).join(","),
  );

  const bodySections = outline.sections.filter(
    (section) => !/^(introduction|conclusion|abstract)/i.test(section.id),
  );
  const soloSections = bodySections.filter((section) => (section.literatureRefs ?? []).length === 1);
  record(
    `组织检查：正文 ${bodySections.length} 节中单文献节 ${soloSections.length} 个（非逐篇罗列）`,
    soloSections.length <= Math.max(1, Math.floor(bodySections.length * 0.2)),
    soloSections.map((section) => section.id).join(",") || "无",
  );

  record(
    `文献量：selected ${selected.length} / matrix ${matrix.entries.length}（验收口径 15-25）`,
    selected.length >= 15 && selected.length <= 25,
  );

  // ---- 5. stage 耗时 + trace 统计 ----
  const stageTimings = {};
  for (const recordEntry of run.stageHistory ?? []) {
    if (recordEntry.status !== "completed") {
      continue;
    }
    stageTimings[recordEntry.stageId] ??= { attempts: 0, ms: 0 };
    stageTimings[recordEntry.stageId].attempts += 1;
    stageTimings[recordEntry.stageId].ms +=
      new Date(recordEntry.finishedAt).getTime() - new Date(recordEntry.startedAt).getTime();
  }
  report.stageTimings = stageTimings;

  const tracePath = join(
    projects.workflowDir(projectId),
    "runs",
    runId,
    "run-trace.json",
  );
  try {
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    const spans = trace.spans ?? [];
    const modelSpans = spans.filter((span) => span.name === "model.turn");
    const attr = (span, key) => (typeof span.attributes?.[key] === "number" ? span.attributes[key] : 0);
    const tokens = modelSpans.reduce(
      (acc, span) => ({
        input: acc.input + attr(span, "model.inputTokens"),
        output: acc.output + attr(span, "model.outputTokens"),
        cacheRead: acc.cacheRead + attr(span, "model.cacheReadTokens"),
        cacheWrite: acc.cacheWrite + attr(span, "model.cacheWriteTokens"),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const cost = modelSpans.reduce((sum, span) => sum + attr(span, "model.estimatedCost"), 0);
    const byStage = {};
    for (const span of spans.filter((span) => span.name.startsWith("stage:"))) {
      const key = span.attributes?.["stage.id"] ?? "?";
      byStage[key] ??= { attempts: 0, ms: 0 };
      byStage[key].attempts += 1;
      byStage[key].ms += span.durationMs ?? 0;
    }
    report.trace = {
      spans: spans.length,
      modelTurns: modelSpans.length,
      toolCalls: spans.filter((span) => span.name === "tool.call").length,
      tokens,
      costUsd: cost,
      byStage,
    };
    record(
      `trace：spans=${spans.length} turns=${modelSpans.length} tokens(in/out/cacheRead)=${tokens.input}/${tokens.output}/${tokens.cacheRead} cost≈$${cost.toFixed(2)}`,
      true,
    );
  } catch (error) {
    record("trace 读取", false, String(error).slice(0, 120));
  }

  record("无手工中间 API（除只读观测外，流程只由 4 个 HITL approve 驱动）", true, `观测调用 ${manualApiCalls} 次`);
} finally {
  const outDir = join(repoRoot, "e2e", ".tmp", "m1114-workflow-smoke");
  await mkdir(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[report] ${join(outDir, "report.json")}`);
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
  await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
}
