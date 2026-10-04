#!/usr/bin/env node
/**
 * M11.3 Phase A — Reviewer Stability Audit（MOT 冻结稿，一次性）。
 *
 * 同一冻结 artifact（p-6de7674cd29e 的当前 manuscript 修订）在完全相同的
 * digest / evidence / citation / survey digest / review profile / 模型配置下
 * 独立执行 N 次 fact+academic+style review：
 *   - 每次 review 在独立项目副本上运行（sessionKey 按 projectId 派生 →
 *     副本 = 全新会话，采样之间零历史泄漏）；
 *   - 共享输入全部从副本 1（与源逐字节相同）确定性构建：buildManuscriptDigest /
 *     evaluateSurveyWritingForProject / citation latestReport / formal evidence。
 *
 * 产物：e2e/.tmp/m113-stability/stability-report.json（逐次投影 + 指标统计 +
 * finding 稳定性，统计逻辑 = backend/src/review/reviewerStability.ts）。
 *
 * 用法：node scripts/m113-reviewer-stability.mjs [runs=5]
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const runs = Number.parseInt(process.argv[2] ?? "5", 10);
const sourceProject = process.argv[3] ?? "p-6de7674cd29e";
const sourceRoot = join(repoRoot, "e2e", ".tmp", "m1112-survey-e2e", "projects");
const workRoot = join(repoRoot, "e2e", ".tmp", "m113-stability");

process.env["PROJECTS_ROOT"] = join(workRoot, "projects");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { buildManuscriptDigest, evaluateSurveyWritingForProject } = await import(distUrl("workflow", "definitions.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));
const { renderSurveyMetricsLines } = await import(distUrl("survey", "writingInvariants.js"));

const config = loadConfig();
const projectsRoot = process.env["PROJECTS_ROOT"];
const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const modelSpec = config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型");
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
  roleCustomTools: (role, pid) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(
        ...createScholarlyTools(
          stackRef.citationIntegrity.scholarlyResolver,
          stackRef.discovery,
          role === "researcher" ? pid : undefined,
        ),
      );
    }
    if (stackRef !== undefined && pid !== undefined && (role === "researcher" || role === "writer" || role === "reviewer")) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, pid));
    }
    if (stackRef !== undefined && pid !== undefined) {
      tools.push(
        ...evidenceToolsForRole(
          role,
          { chunkAccess: stackRef.chunkAccess, grounding: stackRef.evidenceGrounding, evidence: stackRef.evidence },
          pid,
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
    : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  log: (message) => console.log(message),
});
stackRef = stack;

// ---- 准备副本（源只读不动） ----
await rm(join(workRoot, "projects"), { recursive: true, force: true });
await mkdir(join(workRoot, "projects"), { recursive: true });
const copyIds = [];
for (let index = 1; index <= runs; index += 1) {
  const copyId = `${sourceProject}-s${index}`;
  await cp(join(sourceRoot, sourceProject), join(workRoot, "projects", copyId), { recursive: true });
  copyIds.push(copyId);
}
console.log(`[prep] ${runs} 个独立副本就绪（源：${sourceProject} @ ${sourceRoot}，未改动）`);

// ---- 共享输入：从副本 1 构建（与源逐字节相同） ----
const referencePid = copyIds[0];
const manuscriptDigest = await buildManuscriptDigest(stack.workflowServices, referencePid);
const evidenceSelection = await stack.evidenceSelection.selectForWriting(referencePid);
const evidence = evidenceSelection.formal;
const projectMeta = JSON.parse(await readFile(join(projectsRoot, referencePid, "project.json"), "utf8"));
const language = projectMeta.language === "en" ? "en" : undefined;
const citationReport = await stack.citation.latestReport(referencePid);
const citationDigest = citationReport
  ? `cited=${citationReport.summary.citedCount} missing=${citationReport.summary.missingKeys} hallucinated=${citationReport.summary.hallucinated} mismatched=${citationReport.summary.mismatched}`
  : undefined;
const surveyWriting = await evaluateSurveyWritingForProject(stack.workflowServices, referencePid);
const surveyDigest = renderSurveyMetricsLines(surveyWriting).join("\n");
console.log(
  `[inputs] digest=${manuscriptDigest.length} chars, evidence=${evidence.length}, citationDigest=${citationDigest ?? "-"}, surveyDigest=${surveyDigest.split("\n").length} lines（全部采样共用）`,
);

// ---- 逐采样执行 ----
const samples = [];
for (const [index, copyId] of copyIds.entries()) {
  const startedAt = Date.now();
  console.log(`\n[run ${index + 1}/${runs}] ${copyId} …`);
  const results = await stack.reviewer.reviewAll({
    projectId: copyId,
    manuscriptDigest,
    evidence,
    ...(projectMeta.targetProfile ? { targetProfile: projectMeta.targetProfile } : {}),
    ...(language ? { language } : {}),
    ...(citationDigest ? { citationDigest } : {}),
    reviewProfile: "survey",
    surveyDigest,
  });
  const academic = results.find((result) => result.mode === "academic");
  const fact = results.find((result) => result.mode === "fact");
  const style = results.find((result) => result.mode === "style");
  const countBy = (severity) =>
    results.reduce((sum, result) => sum + result.issues.filter((issue) => issue.severity === severity).length, 0);
  const sample = {
    run: `s${index + 1}`,
    projectId: copyId,
    durationMs: Date.now() - startedAt,
    academicScore: academic?.overallScore ?? undefined,
    styleRisk: style?.riskScore ?? undefined,
    claims: fact?.claims?.length ?? 0,
    supported: fact?.claims?.filter((claim) => claim.verdict === "SUPPORTED").length ?? 0,
    partiallySupported: fact?.claims?.filter((claim) => claim.verdict === "PARTIALLY_SUPPORTED").length ?? 0,
    unsupported: fact?.claims?.filter((claim) => claim.verdict === "UNSUPPORTED").length ?? 0,
    contradicted: fact?.claims?.filter((claim) => claim.verdict === "CONTRADICTED").length ?? 0,
    critical: countBy("critical"),
    blocking: results.reduce((sum, result) => sum + result.issues.filter((issue) => issue.blocking).length, 0),
    major: countBy("major"),
    minor: countBy("minor"),
    issues: results.flatMap((result) =>
      result.issues.map((issue) => ({
        section: issue.section,
        category: issue.category,
        severity: issue.severity,
        ...(issue.rootCauseKey ? { rootCauseKey: issue.rootCauseKey } : {}),
        description: issue.description,
        ...(issue.target ? { target: issue.target } : {}),
      })),
    ),
  };
  samples.push(sample);
  console.log(
    `[run ${index + 1}] academic=${sample.academicScore} style=${sample.styleRisk} claims=${sample.claims}（S${sample.supported}/P${sample.partiallySupported}/U${sample.unsupported}/C${sample.contradicted}） crit=${sample.critical} blk=${sample.blocking} maj=${sample.major} minor=${sample.minor} ${Math.round(sample.durationMs / 1000)}s`,
  );
}

// ---- 统计（与 backend/src/review/reviewerStability.ts 同一实现） ----
const { summarizeMetrics, matchFindings } = await import(distUrl("review", "reviewerStability.js"));
const metrics = summarizeMetrics(samples);
const findingStability = matchFindings(samples);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceProject,
  sourceRoot,
  runs,
  sharedInputs: {
    digestChars: manuscriptDigest.length,
    evidenceCount: evidence.length,
    citationDigest,
    surveyDigestLines: surveyDigest.split("\n").length,
  },
  metrics,
  findingStability,
  samples,
};
await mkdir(workRoot, { recursive: true });
await writeFile(join(workRoot, "stability-report.json"), JSON.stringify(report, null, 2), "utf8");
await writeFile(
  join(workRoot, "survey-digest.txt"),
  surveyDigest + "\n\n==== manuscript digest ====\n" + manuscriptDigest,
  "utf8",
);

console.log("\n==== 指标统计（min / median / mean±σ / max / range）====");
for (const [key, stats] of Object.entries(metrics)) {
  console.log(
    `  ${key.padEnd(20)} ${stats.min} / ${stats.median} / ${stats.mean}±${stats.stddev} / ${stats.max}  (range ${stats.range})`,
  );
}
console.log(
  `\n==== Finding 稳定性：${findingStability.totalFindings} 个独立键，stable(全采样)=${findingStability.stable.length}，unstable=${findingStability.unstable.length} ====`,
);
for (const entry of findingStability.stable.slice(0, 20)) {
  console.log(`  [STABLE ${entry.frequency}/${runs}] ${entry.section}|${entry.category}: ${entry.sample.slice(0, 100)}`);
}
console.log("  unstable 代表（前 10）：");
for (const entry of findingStability.unstable.slice(0, 10)) {
  console.log(`  [${entry.frequency}/${runs}] ${entry.section}|${entry.category}: ${entry.sample.slice(0, 100)}`);
}
console.log(`\n[done] 报告 → ${join(workRoot, "stability-report.json")}`);

await adapter.close().catch(() => {});
process.exit(0);
