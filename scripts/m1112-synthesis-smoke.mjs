#!/usr/bin/env node
/**
 * M11.1.2 Structured Synthesis 真实 smoke（一次性脚本，不进 CI）。
 *
 * 与 fixture 测试的区别：真实 Researcher / Citation 模型（survey-matrix /
 * survey-synthesis / evidence judge 三条链）+ 真实 arXiv 全文（下载 → 解析
 * → chunk → 检索）+ 真实 Evidence Grounding（quote 逐字 → OpenAlex
 * metadata → 语义 judge）。装配与 index.ts 同源（HTTP 模式，与
 * m93-fulltext-smoke 相同）；PROJECTS_ROOT 重定向临时目录。
 *
 * 主题：多目标跟踪中的数据关联方法（任务书指定）。
 * 文献集：11 篇 arXiv 全文（SORT / DeepSORT / Tracktor / FairMOT /
 * CenterTrack / MOTR / OC-SORT / ByteTrack / StrongSORT / BoT-SORT / MOT20），
 * 时间跨度 2016-2022、覆盖 motion / appearance / joint 三条 subFamily 线。
 *
 * 检查项（非验收硬门槛，产出供人审）：
 *   1. taxonomy 聚合是否合理（family / subFamily 分布）
 *   2. 是否产生明显胡编的 consensus（全量 claim 打印）
 *   3. comparison 是否真正跨论文（双侧 entryIds 指向不同来源）
 *   4. future_direction 是否按 cited / inferred 分离且 inferred 一律 speculative
 *   5. 每条 evidence_backed 是否真的可回溯（evidenceId → verified 记录 → chunk）
 *   6. 引用不变量：全部 entryIds / sourceIds 指向真实 Matrix 条目
 *
 * 用法：node scripts/m1112-synthesis-smoke.mjs
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

const projectsRoot = await mkdtemp(join(tmpdir(), "m1112-synthesis-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

/** 11 篇 arXiv 全文（多目标跟踪数据关联；2016-2022；motion/appearance/joint 三线） */
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

const report = { startedAt: new Date().toISOString(), papers: [], matrix: null, synthesis: null, checks: [] };
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
  // ---- 项目 + 导入 ----
  const created = await request("POST", "/projects", { title: "M11.1.2 Synthesis Live Smoke：MOT 数据关联" });
  const projectId = created.body.project?.id;
  if (created.status !== 201 || projectId === undefined) {
    throw new Error(`项目创建失败：${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }
  report.projectId = projectId;

  const imported = [];
  for (const paper of PAPERS) {
    const r = await request("POST", `/projects/${projectId}/sources/import/arxiv`, {
      arxivId: paper.arxivId,
      enrich: false,
    });
    if (r.status !== 201) {
      record(`导入 ${paper.label}`, false, `HTTP ${r.status}`);
      continue;
    }
    imported.push({ ...paper, sourceId: r.body.source.sourceId });
    report.papers.push({ ...paper, sourceId: r.body.source.sourceId });
  }
  record(`导入 ${imported.length}/${PAPERS.length} 篇 arXiv 元数据`, imported.length === PAPERS.length);

  // ---- 全文补全（arXiv resolver 下载 PDF → builtin 文本层 chunk 立即可检索） ----
  const resolved = await request("POST", `/projects/${projectId}/sources/resolve-fulltext`, {
    sourceIds: imported.map((paper) => paper.sourceId),
  });
  const resolvedCount = (resolved.body.results ?? []).filter((entry) => entry.outcome === "resolved").length;
  record(`全文补全 ${resolvedCount}/${imported.length} 篇`, resolvedCount >= 8, JSON.stringify(resolved.body.summary ?? {}));

  // 检索自检：至少一篇可检索到 chunk（matrix fulltext 路径的前提）
  const probe = await request("POST", `/projects/${projectId}/retrieval/search`, {
    query: "multi-object tracking data association",
    topK: 3,
  });
  const probeChunks = (probe.body.results ?? []).length;
  record("chunk 可检索（matrix fulltext 前提）", probeChunks > 0, `top3=${probeChunks}`);

  // ---- Matrix 构建（真实模型逐篇抽取；service 直调规避 HTTP 长请求超时） ----
  console.log("\n[matrix] 真实构建开始（11 篇逐篇抽取）…");
  const matrixStarted = Date.now();
  const matrixBuild = await stack.survey.buildMatrix(projectId, {});
  const matrixSummary = matrixBuild.summary;
  const matrix = matrixBuild.matrix;
  report.matrix = {
    summary: matrixSummary,
    entries: matrix.entries.map((entry) => ({
      entryId: entry.entryId,
      sourceId: entry.sourceId,
      depth: entry.interpretationDepth,
      family: entry.methodFamily,
      sub: entry.subFamily,
      anchors: entry.anchors.length,
      issues: (entry.issues ?? []).map((issue) => issue.code),
    })),
  };
  const fulltextCount = matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length;
  const anchoredCount = matrix.entries.filter((entry) => entry.anchors.length > 0).length;
  record(
    `Matrix：built=${matrixSummary.built} failed=${matrixSummary.failed}（fulltext=${fulltextCount} / 有锚=${anchoredCount}）`,
    matrixSummary.failed === 0 && anchoredCount >= 6,
    `${Math.round((Date.now() - matrixStarted) / 1000)}s`,
  );
  const familyHist = {};
  for (const entry of matrix.entries) {
    const key = `${entry.methodFamily ?? "-"}${entry.subFamily !== undefined ? `/${entry.subFamily}` : ""}`;
    familyHist[key] = (familyHist[key] ?? 0) + 1;
  }
  console.log(`[matrix] family 分布：${JSON.stringify(familyHist)}`);

  // ---- Synthesis 构建（真实模型 batch + 真实 evidence grounding；service 直调） ----
  console.log("\n[synthesis] 真实构建开始（6 类 batch + judge）…");
  const synthesisStarted = Date.now();
  const synthesisBuild = await stack.synthesis.buildSynthesis(projectId, {});
  const synthesis = synthesisBuild.synthesis;
  const summary = synthesisBuild.summary;
  report.synthesisSummary = summary;
  report.rejections = synthesisBuild.rejections;
  report.items = synthesis.items;
  record(
    `Synthesis：batches=${summary.batches} candidates=${summary.candidates} accepted=${summary.accepted} rejected=${summary.rejected}`,
    summary.accepted > 0,
    `${Math.round((Date.now() - synthesisStarted) / 1000)}s；evidence=${summary.evidenceVerified}/${summary.evidenceProposed}`,
  );
  console.log(`[synthesis] byKind：${JSON.stringify(summary.byKind)}`);

  // ---- 检查 1：taxonomy 合理性 ----
  const taxonomyItems = synthesis.items.filter((item) => item.kind === "taxonomy");
  record(
    `taxonomy ${taxonomyItems.length} 条（family/subFamily leaf）`,
    taxonomyItems.length >= 3,
    taxonomyItems.map((item) => `${item.detail.family}${item.detail.subFamily ?? ""}:${item.derivedFrom.entryIds.length}`).join(" "),
  );

  // ---- 检查 2：consensus 全量打印（人审胡编） ----
  console.log("\n[synthesis] consensus 全量（人审是否胡编）：");
  for (const item of synthesis.items.filter((item) => item.kind === "consensus")) {
    console.log(
      `  [${item.groundingLevel}] (${item.sourceIds.length} 源) ${item.claim}\n      entries=${item.derivedFrom.entryIds.join(",")} evidence=${item.evidenceIds.join(",") || "-"}`,
    );
  }

  // ---- 检查 3：comparison 跨论文 ----
  const comparisons = synthesis.items.filter((item) => item.kind === "comparison");
  const crossPaperComparisons = comparisons.filter((item) =>
    (item.detail?.sides ?? []).every((side) => side.entryIds.length > 0),
  );
  record(
    `comparison ${comparisons.length} 条全部双侧有据`,
    comparisons.length > 0 && crossPaperComparisons.length === comparisons.length,
  );
  for (const item of comparisons) {
    console.log(
      `  [${item.groundingLevel}] ${item.detail.dimension}: ${item.detail.sides.map((side) => `${side.label}(${side.entryIds.join(",")})`).join(" vs ")}`,
    );
  }

  // ---- 检查 4：future 分离 + inferred 一律 speculative ----
  const futures = synthesis.items.filter((item) => item.kind === "future_direction");
  const inferred = futures.filter((item) => item.detail?.origin === "inferred");
  const cited = futures.filter((item) => item.detail?.origin === "cited_future_work");
  record(
    `future：cited=${cited.length} / inferred=${inferred.length}；inferred 全部 speculative`,
    futures.length > 0 && inferred.every((item) => item.groundingLevel === "speculative"),
    `cited levels=${cited.map((item) => item.groundingLevel).join(",") || "-"}`,
  );

  // ---- 检查 5：evidence_backed 可回溯 ----
  const records = await stack.evidence.list(projectId);
  const byId = new Map(records.map((record) => [record.id, record]));
  const backed = synthesis.items.filter((item) => item.groundingLevel === "evidence_backed");
  let traceable = 0;
  let untraceable = [];
  for (const item of backed) {
    let ok = item.evidenceIds.length >= 2;
    for (const evidenceId of item.evidenceIds) {
      const record = byId.get(evidenceId);
      if (
        record === undefined ||
        record.verificationStatus !== "verified" ||
        !item.sourceIds.includes(record.source?.sourceId) ||
        record.location?.chunk === undefined
      ) {
        ok = false;
        untraceable.push(`${item.synthesisId}→${evidenceId}`);
      }
    }
    if (ok) {
      traceable += 1;
    }
  }
  record(
    `evidence_backed ${backed.length} 条全部可回溯（≥2 verified / 归属正确 / 有 chunk 锚）`,
    backed.length > 0 && traceable === backed.length,
    untraceable.length > 0 ? `不可回溯：${untraceable.join("、")}` : "",
  );

  // ---- 检查 6：引用不变量 ----
  const entryIds = new Set(matrix.entries.map((entry) => entry.entryId));
  const badRefs = synthesis.items.filter(
    (item) => !item.derivedFrom.entryIds.every((entryId) => entryIds.has(entryId)),
  );
  record(`全部 entryIds 指向真实 Matrix 条目`, badRefs.length === 0, badRefs.map((item) => item.synthesisId).join(","));

  // ---- grounding 分布汇总 ----
  const groundingHist = {};
  for (const item of synthesis.items) {
    groundingHist[item.groundingLevel] = (groundingHist[item.groundingLevel] ?? 0) + 1;
  }
  console.log(`\n[synthesis] grounding 分布：${JSON.stringify(groundingHist)}`);
  if ((report.rejections ?? []).length > 0) {
    console.log("[synthesis] 拒绝账目：");
    for (const rejection of report.rejections) {
      console.log(`  ${rejection.kind}: ${rejection.claim.slice(0, 60)} — ${rejection.reason.slice(0, 120)}`);
    }
  }
} finally {
  // ---- 报告落盘（e2e/.tmp 已 gitignore；不进 git） ----
  const outDir = join(repoRoot, "e2e", ".tmp", "m1112-synthesis-smoke");
  await mkdir(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[report] ${join(outDir, "report.json")}`);
  server.close();
  await adapter.close().catch(() => {});
  await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
}
