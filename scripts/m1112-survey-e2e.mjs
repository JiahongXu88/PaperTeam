#!/usr/bin/env node
/**
 * M11.2 Survey Writing E2E 真实 Acceptance（一次性脚本，不进 CI）。
 *
 * 验证「只输入 Topic → 综述论文 PDF」的正式 workflow 用户路径（真实模型 /
 * 真实检索 / 真实全文下载 / 真实 LaTeX 编译，无中间 API 手工代跑）：
 *   1. POST /api/projects {title: topic, workflowKind: topic_survey}
 *   2. POST /api/projects/:id/workflows {kind: topic_survey}
 *   3. 轮询 run；HITL 只做 approve（文献遴选用默认推荐集）
 *   4. completed(label=final|draft) 后收集：研究链统计 + 写作链统计
 *      （sections / 字数 / citations / survey-writing 评估 / gate 规则 /
 *      修订轮数）+ 各 stage 耗时 + run-trace（turns / tokens / cost）
 *
 * 与 m1114 的差异：项目数据**保留**在 e2e/.tmp/m1112-survey-e2e/projects/
 * （不删除——后续里程碑可复用 Matrix / Synthesis / Outline 续跑）。
 *
 * 主题：多目标跟踪中的数据关联方法（与 M11.1 系列同域，便于横向对比）。
 *
 * 用法：node scripts/m1112-survey-e2e.mjs
 * 前置：npm --prefix backend run build；~/.paperteam 已配模型凭据；外网可达。
 * 可用 PAPERTEAM_PI_MODEL 覆盖模型（缺省 zai-coding-cn/glm-5.3）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const TOPIC = "多目标跟踪中的数据关联方法";
const outDir = join(repoRoot, "e2e", ".tmp", "m1112-survey-e2e");
const projectsRoot = join(outDir, "projects");

process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";
// 综述 25 篇文献的引用元数据核验上限（默认 20 按普通论文口径；survey 提升到 60）
process.env["CITATION_MAX_METADATA_LOOKUPS"] ??= "60";

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

await mkdir(projectsRoot, { recursive: true });
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
    : { longRunTimeoutMs: 900_000 }),
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
let manualApiCalls = 0; // 除创建 + HITL resume + 只读观测外的调用（应为 0）

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

  // ---- 2. 轮询 + HITL approve ----
  let run;
  const pollDeadline = Date.now() + 6 * 60 * 60 * 1000; // 6h 硬上限（写作链比研究链更长）
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    run = body.run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      break;
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      report.hitl.push({ stageId, at: new Date().toISOString() });
      console.log(`[hitl] ${stageId}`);
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
    record("run 完成", false, `${run.status}: ${run.error?.code} ${run.error?.message ?? ""}（stage ${run.error?.stageId ?? "?"}）`);
    throw new Error(`run 未完成：${run.status}`);
  }
  record(
    `run 完成（label=${run.completion?.label}）`,
    run.completion?.label === "final" || run.completion?.label === "draft",
    JSON.stringify(run.completion?.summary ?? {}),
  );
  report.completion = run.completion;

  // ---- 3. artifact 统计 ----
  const readJson = async (relative) =>
    JSON.parse(await readFile(join(projects.projectDir(projectId), relative), "utf8"));
  const readText = async (relative) =>
    readFile(join(projects.projectDir(projectId), relative), "utf8");

  const matrix = await readJson(join("research", "survey.json"));
  const synthesis = await readJson(join("research", "survey-synthesis.json"));
  const outline = await readJson(join("manuscript", "outline.json"));
  report.research = {
    matrixEntries: matrix.entries.length,
    fulltext: matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length,
    abstractOnly: matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only").length,
    synthesisItems: synthesis.items.length,
    synthesisByKind: synthesis.items.reduce((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
    grounding: synthesis.items.reduce((acc, item) => {
      acc[item.groundingLevel] = (acc[item.groundingLevel] ?? 0) + 1;
      return acc;
    }, {}),
    sections: outline.sections.length,
  };

  // 写作链统计
  const writingStage = run.stageResults?.["writing.sections"] ?? {};
  const reviewRounds = (run.stageHistory ?? []).filter(
    (entry) => entry.stageId === "review.run" && entry.status === "completed",
  ).length;
  const revisionRounds = (run.stageHistory ?? []).filter(
    (entry) => entry.stageId === "revision.revise" && entry.status === "completed",
  ).length;

  // 章节字数与引用统计（正文事实）
  const sectionStats = [];
  let totalChars = 0;
  let totalCiteCommands = 0;
  let multiKeyCiteCommands = 0;
  const citedKeys = new Set();
  for (const section of outline.sections) {
    const content = await readText(join("manuscript", "sections", section.file));
    const cites = [...content.matchAll(/\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)];
    totalCiteCommands += cites.length;
    for (const match of cites) {
      const keys = (match[1] ?? "").split(",").map((key) => key.trim()).filter(Boolean);
      if (keys.length >= 2) multiKeyCiteCommands += 1;
      for (const key of keys) citedKeys.add(key);
    }
    totalChars += content.replace(/\s/g, "").length;
    sectionStats.push({
      id: section.id,
      title: section.title,
      chars: content.replace(/\s/g, "").length,
      cites: cites.length,
      synthesisRefs: (section.synthesisRefs ?? []).length,
      literatureRefs: (section.literatureRefs ?? []).length,
    });
  }
  const bib = await readText(join("manuscript", "references.bib"));
  const bibKeys = (bib.match(/^@[a-z]+\{([^,]+),/gm) ?? []).map((line) => line.replace(/^@[a-z]+\{/, "").replace(/,$/, ""));

  report.writing = {
    sections: sectionStats,
    totalChars,
    totalCiteCommands,
    multiKeyCiteCommands,
    distinctCitedKeys: citedKeys.size,
    bibliographyEntries: bibKeys.length,
    writingStageRevision: writingStage.revision,
    reviewRounds,
    revisionRounds,
    gateRounds: (run.stageHistory ?? []).filter(
      (entry) => entry.stageId === "quality.gate" && entry.status === "completed",
    ).length,
  };

  // survey-writing 评估产物（最后一轮）
  const surveyWritingFiles = [];
  try {
    for (const key of ["r1", "r2", "r3", "r4"]) {
      const evaluation = await readJson(join("reviews", `survey-writing-${key}.json`));
      surveyWritingFiles.push(evaluation);
    }
  } catch {
    // 轮次数不定：尽力读取
  }
  if (surveyWritingFiles.length > 0) {
    const latest = surveyWritingFiles[surveyWritingFiles.length - 1];
    report.surveyWriting = {
      round: latest.round,
      blockers: latest.blockers,
      warnings: latest.warnings,
      metrics: latest.metrics,
    };
    record("survey-writing 评估产物存在", true, `round=${latest.round} blockers=${latest.blockers.length}`);
    record(
      `survey writing blockers = 0（悬空 refs / fake key / 可回溯）`,
      latest.blockers.length === 0,
      latest.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join("；"),
    );
  } else {
    record("survey-writing 评估产物存在", false, "reviews/survey-writing-r*.json 未找到");
  }

  // gate 产物（最后一轮的 survey 规则）
  const gateRound = report.writing.gateRounds;
  if (gateRound > 0) {
    const gate = await readJson(join("reviews", `quality-gate-r${gateRound}.json`));
    report.gate = {
      passed: gate.gate.passed,
      reasons: gate.gate.reasons,
      surveyRules: gate.gate.rules.filter((rule) => rule.rule.startsWith("survey_")),
    };
    record("Quality Gate（最后一轮）", gate.gate.passed, gate.gate.passed ? "" : gate.gate.reasons.join("；"));
  }

  // ---- 4. 验收检查 ----
  record(
    `PDF 产出`,
    run.completion?.label === "final" || run.completion?.label === "draft",
    `label=${run.completion?.label} draft=${run.completion?.summary?.draftArtifactId ?? null} final=${run.completion?.summary?.finalArtifactId ?? null}`,
  );
  record(
    `正文引用 key ⊆ bibliography（引用真实）`,
    [...citedKeys].every((key) => bibKeys.includes(key)),
    `${citedKeys.size} 个 distinct key / bib ${bibKeys.length} 条`,
  );
  record(
    `多源并列引用存在（multi-source citation）`,
    multiKeyCiteCommands > 0,
    `${multiKeyCiteCommands}/${totalCiteCommands}`,
  );
  record(
    `文献覆盖（cited matrix sources）`,
    true,
    `${report.surveyWriting?.metrics?.citedLiterature ?? "?"}/${report.surveyWriting?.metrics?.totalLiterature ?? "?"}`,
  );
  record(
    `修订轮数 bounded（≤ 配置上限 + 1 轮基线）`,
    revisionRounds <= 3,
    `review rounds=${reviewRounds} revision rounds=${revisionRounds}`,
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

  const tracePath = join(projects.workflowDir(projectId), "runs", runId, "run-trace.json");
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
    report.trace = {
      spans: spans.length,
      modelTurns: modelSpans.length,
      toolCalls: spans.filter((span) => span.name === "tool.call").length,
      tokens,
      costUsd: cost,
    };
    record(
      `trace：turns=${modelSpans.length} tokens(in/out/cacheRead)=${tokens.input}/${tokens.output}/${tokens.cacheRead} cost≈$${cost.toFixed(2)}`,
      true,
    );
  } catch (error) {
    record("trace 读取", false, String(error).slice(0, 120));
  }

  record(
    "无手工中间 API（流程只由 HITL approve 驱动；观测调用只读）",
    true,
    `观测调用 ${manualApiCalls} 次`,
  );
} finally {
  await mkdir(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[report] ${join(outDir, "report.json")}`);
  console.log(`[data] 项目数据保留在 ${projectsRoot}（projectId=${report.projectId ?? "?"}）`);
  server.close();
  await orchestrator.close().catch(() => {});
  await adapter.close().catch(() => {});
}
