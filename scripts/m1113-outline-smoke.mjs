#!/usr/bin/env node
/**
 * M11.1.3 Survey Outline 真实 smoke（一次性脚本，不进 CI）。
 *
 * 与 m1112-synthesis-smoke 相同的 11 篇 arXiv MOT 文献全链重建（真实 Researcher
 * 模型 matrix / synthesis + 真实全文），随后用真实 Writer 模型规划 Survey
 * Outline（writing/outline survey 模式），产出供人审：
 *   1. 是否按方法体系 / 研究问题组织（而非逐篇罗列）
 *   2. 每个核心章节是否可追溯 synthesis（refs 逐条列出 + 追溯表）
 *   3. speculative（inferred future）是否被隔离在展望章节
 *   4. 8/11 abstract_only / DeepSORT 错分类对结构的实际影响
 *   5. 契约校验 blocking / warnings 如实输出
 *
 * 用法：node scripts/m1113-outline-smoke.mjs
 * 前置：npm --prefix backend run build；~/.paperteam 已配模型凭据；外网可达。
 * 可用 PAPERTEAM_PI_MODEL 覆盖模型（缺省 zai-coding-cn/glm-5.3）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const projectsRoot = await mkdtemp(join(tmpdir(), "m1113-outline-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

const PAPERS = [
  { arxivId: "1602.00763", label: "SORT (2016)" },
  { arxivId: "1703.07402", label: "DeepSORT (2017)" },
  { arxivId: "1903.05625", label: "Tracktor (2019)" },
  { arxivId: "2003.09003", label: "MOT20 benchmark (2020)" },
  { arxivId: "2004.01177", label: "CenterTrack (2020)" },
  { arxivId: "2004.01842", label: "FairMOT (2020)" },
  { arxivId: "2105.03247", label: "MOTR (2021)" },
  { arxivId: "2110.06864", label: "ByteTrack (2022)" },
  { arxivId: "2202.13514", label: "StrongSORT (2022)" },
  { arxivId: "2203.14360", label: "OC-SORT (2022)" },
  { arxivId: "2206.14651", label: "BoT-SORT (2022)" },
];

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
const { createIdeaToPaperDefinition } = await import(distUrl("workflow", "definitions.js"));
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
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 600_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  log: () => {},
});
stackRef = stack;
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects),
  definitionFactory: () => createIdeaToPaperDefinition(stack.workflowServices),
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

const report = { startedAt: new Date().toISOString(), papers: [], matrix: null, checks: [] };
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

try {
  // ---- 项目 + 导入 + 全文（与 m1112 相同） ----
  const created = await request("POST", "/projects", { title: "M11.1.3 Outline Live Smoke：MOT 数据关联综述" });
  const projectId = created.body.project?.id;
  if (created.status !== 201 || projectId === undefined) {
    throw new Error(`项目创建失败：${created.status}`);
  }
  report.projectId = projectId;

  const imported = [];
  for (const paper of PAPERS) {
    const r = await request("POST", `/projects/${projectId}/sources/import/arxiv`, {
      arxivId: paper.arxivId,
      enrich: false,
    });
    if (r.status === 201) {
      imported.push({ ...paper, sourceId: r.body.source.sourceId });
      report.papers.push({ ...paper, sourceId: r.body.source.sourceId });
    }
  }
  record(`导入 ${imported.length}/${PAPERS.length} 篇 arXiv 元数据`, imported.length === PAPERS.length);

  const resolved = await request("POST", `/projects/${projectId}/sources/resolve-fulltext`, {
    sourceIds: imported.map((paper) => paper.sourceId),
  });
  const resolvedCount = (resolved.body.results ?? []).filter((entry) => entry.outcome === "resolved").length;
  record(`全文补全 ${resolvedCount}/${imported.length} 篇`, true, JSON.stringify(resolved.body.summary ?? {}));

  // ---- Matrix（service 直调；HTTP 长请求超时） ----
  console.log("\n[matrix] 真实构建开始…");
  const matrixStarted = Date.now();
  const matrixBuild = await stack.survey.buildMatrix(projectId, {});
  const matrix = matrixBuild.matrix;
  report.matrix = {
    summary: matrixBuild.summary,
    entries: matrix.entries.map((entry) => ({
      entryId: entry.entryId,
      depth: entry.interpretationDepth,
      family: entry.methodFamily,
      sub: entry.subFamily,
      anchors: entry.anchors.length,
    })),
  };
  record(
    `Matrix：built=${matrixBuild.summary.built} failed=${matrixBuild.summary.failed}（${Math.round((Date.now() - matrixStarted) / 1000)}s）`,
    matrixBuild.summary.failed === 0,
  );

  // ---- Synthesis ----
  console.log("\n[synthesis] 真实构建开始…");
  const synthesisStarted = Date.now();
  const synthesisBuild = await stack.synthesis.buildSynthesis(projectId, {});
  const synthesis = synthesisBuild.synthesis;
  report.synthesisSummary = synthesisBuild.summary;
  report.synthesisItems = synthesis.items.map((item) => ({
    synthesisId: item.synthesisId,
    kind: item.kind,
    groundingLevel: item.groundingLevel,
    claim: item.claim.slice(0, 160),
    entries: item.derivedFrom.entryIds,
    detail: item.detail ?? null,
  }));
  record(
    `Synthesis：accepted=${synthesisBuild.summary.accepted} rejected=${synthesisBuild.summary.rejected}（${Math.round((Date.now() - synthesisStarted) / 1000)}s）`,
    synthesisBuild.summary.accepted > 0,
  );

  // ---- Survey Outline（本阶段主角；service 直调） ----
  console.log("\n[outline] 真实规划开始（writing/outline survey 模式）…");
  const outlineStarted = Date.now();
  const outlineBuild = await stack.surveyOutline.buildSurveyOutline(projectId, {});
  const outline = outlineBuild.outline;
  const validation = outlineBuild.validation;
  report.outline = outline;
  report.outlineValidation = validation;
  report.outlineSummary = outlineBuild.summary;
  record(
    `Outline：${outline.sections.length} 节 / planningAttempts=${outlineBuild.summary.planningAttempts}（${Math.round((Date.now() - outlineStarted) / 1000)}s）`,
    validation.blocking.length === 0,
    validation.blocking.length === 0 ? "" : validation.blocking.join("；").slice(0, 200),
  );

  // ---- 检查 1：按方法体系组织（refs 分布），非逐篇 ----
  const byId = new Map(synthesis.items.map((item) => [item.synthesisId, item]));
  const entryLabel = new Map(matrix.entries.map((entry) => [entry.entryId, entry]));
  console.log("\n[outline] 章节结构全量（人审组织方式）：");
  for (const section of outline.sections) {
    const kinds = [...new Set((section.synthesisRefs ?? []).map((ref) => byId.get(ref)?.kind ?? "?"))];
    console.log(
      `  ${section.id}「${section.title}」 synthesis=${(section.synthesisRefs ?? []).length}（${kinds.join("+")}） literature=${(section.literatureRefs ?? []).length}`,
    );
  }
  const bodySections = outline.sections.filter(
    (section) => !/^(introduction|conclusion|abstract)/i.test(section.id),
  );
  const soloSections = bodySections.filter((section) => (section.literatureRefs ?? []).length === 1);
  record(
    `组织检查：正文 ${bodySections.length} 节中单文献节 ${soloSections.length} 个（逐篇罗列 = 0 或个位数）`,
    soloSections.length <= 1,
    soloSections.map((section) => section.id).join(",") || "无",
  );

  // ---- 检查 2：refs 可追溯 ----
  const knownSynthesis = new Set(synthesis.items.map((item) => item.synthesisId));
  const knownEntries = new Set(matrix.entries.map((entry) => entry.entryId));
  const badSynthesisRefs = outline.sections.flatMap((section) =>
    (section.synthesisRefs ?? []).filter((ref) => !knownSynthesis.has(ref)),
  );
  const badEntryRefs = outline.sections.flatMap((section) =>
    (section.literatureRefs ?? []).filter((ref) => !knownEntries.has(ref)),
  );
  record("全部 synthesisRefs 指向真实 synthesis", badSynthesisRefs.length === 0, badSynthesisRefs.join(","));
  record("全部 literatureRefs 指向真实 Matrix 条目", badEntryRefs.length === 0, badEntryRefs.join(","));

  // ---- 检查 3：speculative 隔离 ----
  const speculativeIds = new Set(
    synthesis.items.filter((item) => item.groundingLevel === "speculative").map((item) => item.synthesisId),
  );
  const speculativeInNonFuture = outline.sections.filter(
    (section) =>
      !/future|outlook|prospect|展望|未来|前景/i.test(`${section.id} ${section.title}`) &&
      (section.synthesisRefs ?? []).some((ref) => speculativeIds.has(ref)),
  );
  record(
    `speculative ${speculativeIds.size} 条只出现在展望章节`,
    speculativeInNonFuture.length === 0,
    speculativeInNonFuture.map((section) => section.id).join(",") || "",
  );
  const futureSection = outline.sections.find((section) =>
    /future|outlook|prospect|展望|未来|前景/i.test(`${section.id} ${section.title}`),
  );
  record(
    "存在独立的展望章节（含 speculative 消费）",
    futureSection !== undefined &&
      (futureSection.synthesisRefs ?? []).some((ref) => speculativeIds.has(ref)),
  );

  // ---- 检查 4：上游弱数据影响（abstract_only / unclassified / DeepSORT） ----
  const abstractOnly = matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only");
  const unclassified = matrix.entries.filter(
    (entry) => entry.methodFamily === undefined || entry.methodFamily === "unclassified",
  );
  console.log(
    `\n[上游] abstract_only=${abstractOnly.length}/11；unclassified=${unclassified.length}；warnings=${validation.warnings.length}`,
  );
  for (const warning of validation.warnings) {
    console.log(`  [warning] ${warning}`);
  }
  const coveredEntryIds = new Set(
    outline.sections.flatMap((section) => section.literatureRefs ?? []),
  );
  const uncoveredAbstractOnly = abstractOnly.filter((entry) => !coveredEntryIds.has(entry.entryId));
  record(
    `abstract_only 覆盖：${abstractOnly.length - uncoveredAbstractOnly.length}/${abstractOnly.length} 篇进入 literatureRefs`,
    true,
    uncoveredAbstractOnly.length > 0 ? `未覆盖：${uncoveredAbstractOnly.map((e) => e.entryId).join(",")}` : "全覆盖",
  );

  // ---- 覆盖率汇总 ----
  console.log(
    `\n[outline] synthesis 覆盖 ${(validation.summary.synthesisCoverage * 100).toFixed(0)}% / literature 覆盖 ${(validation.summary.literatureCoverage * 100).toFixed(0)}%`,
  );
} finally {
  const outDir = join(repoRoot, "e2e", ".tmp", "m1113-outline-smoke");
  await mkdir(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[report] ${join(outDir, "report.json")}`);
  server.close();
  await adapter.close().catch(() => {});
  await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
}
