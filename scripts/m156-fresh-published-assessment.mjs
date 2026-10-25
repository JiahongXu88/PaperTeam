#!/usr/bin/env node
/**
 * M15.6 阶段 D（fresh，有界模型预算）：生产只读评估路径（idea_to_paper + published_paper_assessment
 * → review.run → quality.gate）在干净副本上的真实运行——prospective production simulation（④）。
 *
 * 与 m155 基准的区别：
 *  - 干净副本（不继承骨架 evidence store——D1 清洁隔离；污染差异见 m156-replay-report 的 polluted 变体）
 *  - 走生产 workflow stage（review.run 持久化 review summary / claimGrounding / claim-audit；
 *    quality.gate 走唯一入口 evaluateProjectQualityGate），不是直接 reviewAll
 *  - 记录 v1 对照：以存储的 review summary + 输入重放旧口径（无 pairing / crossSection 字段）
 *
 * 预算纪律：PAPERTEAM_GLOBAL_MAX_MODEL_CALLS 强制上限；recheck 调用置 0（本轮目标是 Gate 语义
 * 验证，跨单元复核是独立有界特性，M15.1 已验）。调用计数 = 物理 runAgent 次数。
 *
 * 用法：node scripts/m156-fresh-published-assessment.mjs [--only f2-bytetrack] [--ce2] [--survey-digest]
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const WORK_DIR = "D:\\PaperTeamData\\M15\\M15_6";
const M114_STAGING = "D:\\PaperTeamData\\M11_4_QualityGateBenchmark\\staging";
const M155_BENCH = "D:\\PaperTeamData\\M15\\M15_5\\benchmark";
const HOLDOUT = join(WORK_DIR, "holdout");
const FRESH_ROOT = join(WORK_DIR, "fresh-projects");

const args = process.argv.slice(2);
const onlyAnchor = args.find((a) => a.startsWith("--only="))?.slice(7);
const doFresh = args.includes("--fresh") || onlyAnchor !== undefined;
const doCe2 = args.includes("--ce2");
const doSurveyDigest = args.includes("--survey-digest");
const digestList = args.filter((a) => a.startsWith("--digest=")).map((a) => a.slice(9));

process.env["PROJECTS_ROOT"] = FRESH_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] ??= "40";
// M15.6 预算纪律：跨单元/finding 复核调用置 0（独立有界特性，非本轮目标）
process.env["PAPERTEAM_REVIEW_CLAIM_RECHECK_CALLS"] = "0";
process.env["PAPERTEAM_REVIEW_FINDING_RECHECK_CALLS"] = "0";

const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logLines.push(line);
}

// ---- 锚点（干净副本文件；不含任何 evidence） ----
async function buildAnchors() {
  const anchors = {};
  const put = (id, files, meta) => {
    anchors[id] = { files, ...meta };
  };
  put("f2-bytetrack", {
    "main.tex": await readFile(join(M114_STAGING, "bytetrack", "egpaper_final.tex"), "utf8"),
    "egbib.bib": await readFile(join(M114_STAGING, "bytetrack", "egbib.bib"), "utf8"),
  }, { family: "F2-published", qualityClass: "known-good-published", provenance: "M11.4 staging bytetrack" });
  const f5files = {};
  for (const entry of await readdir(join(M155_BENCH, "f5-staging"), { withFileTypes: true })) {
    if (entry.name.endsWith(".tex")) {
      const content = await readFile(join(M155_BENCH, "f5-staging", entry.name), "utf8");
      f5files[entry.name === "ms.tex" ? "main.tex" : entry.name] = content;
    }
  }
  put("f5-attention", f5files, { family: "F5-published-new", qualityClass: "known-good-published", provenance: "arXiv 1706.03762 (M15.5 holdout)" });
  put("convnext-holdout", {
    "main.tex": await readFile(join(HOLDOUT, "convnext", "main.tex"), "utf8"),
  }, { family: "F8-CONVNEXT-HOLDOUT", qualityClass: "known-good-published", provenance: "arXiv 2201.03545 e-print（本轮新增独立 family，未参与任何 M11.4/M15.5 调参）" });
  if (doCe2) {
    put("ce2b-bytetrack-citekeys", {
      "main.tex": await readFile(join(M155_BENCH, "ce2-bytetrack", "egpaper_final.tex"), "utf8"),
      "egbib.bib": await readFile(join(M114_STAGING, "bytetrack", "egbib.bib"), "utf8"),
    }, { family: "F2-published", qualityClass: "known-bad-controlled-citation", provenance: "M15.5 ce2-bytetrack + egbib.bib" });
  }
  return anchors;
}

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createIdeaToPaperDefinition } = await import(distUrl("workflow", "definitions.js"));
const { evaluateQualityGate } = await import(distUrl("quality", "gates.js"));

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

/** 物理 runAgent 计数（预算的真实口径：含重试/修复/失败） */
let physicalCalls = 0;
const taskUsage = [];
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
    if (stackRef !== undefined && pid !== undefined && role === "reviewer") {
      // 干净副本：不挂 evidence 检索工具（库本来为空；保持与生产一致的挂载面由 evidenceToolsForRole 决定——
      // 空库下工具返回空，挂载与否不影响结果；此处保持最小面以杜绝骨架污染路径）
      return tools;
    }
    return tools;
  },
  log: () => {},
});
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const startedAt = Date.now();
  const result = await originalRunAgent(...callArgs);
  taskUsage.push({
    call: physicalCalls,
    scope: callArgs[0]?.contextScope ?? null,
    status: result.status,
    durationMs: Date.now() - startedAt,
    ...(result.usage ?? {}),
  });
  if (result.status !== "completed") {
    log(`runAgent #${physicalCalls} → ${result.status}: ${String(result.error ?? "").slice(0, 160)}`);
  }
  return result;
};

const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  log: (message) => console.log(message),
});
stackRef = stack;
const services = stack.workflowServices;
const definition = createIdeaToPaperDefinition(services);

const results = [];
async function runFreshAnchor(anchorId, anchor) {
  const startedAt = Date.now();
  // 干净副本：新项目（store 生成 id；不复制任何骨架——evidence 库为空）
  const created = await projects.create(`M15.6 fresh ${anchorId}`, { language: "en" });
  const projectId = created.id;
  const manuscriptDir = projects.manuscriptDir(projectId);
  await mkdir(manuscriptDir, { recursive: true });
  const artifactsDir = join(projects.projectDir(projectId), "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  for (const [path, content] of Object.entries(anchor.files)) {
    const target = join(manuscriptDir, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  // 只读评估输入来源声明（author_latex + sha 绑定；与 claimAuditReviewRun.test 同构）
  const mainTex = anchor.files["main.tex"] ?? Object.values(anchor.files)[0];
  await writeFile(
    join(artifactsDir, "input-provenance.json"),
    JSON.stringify({ sourceKind: "author_latex", manuscriptSha256: createHash("sha256").update(mainTex).digest("hex"), note: "M15.6 fresh published-assessment run (clean copy, no inherited evidence store)" }),
    "utf8",
  );
  const state = {
    workflowKind: "idea_to_paper",
    stageResults: {},
    stageHistory: [],
    completedStages: [],
    inputs: {},
    request: { reviewPurpose: "published_paper_assessment" },
  };
  const runStage = async (stageId) => {
    const stage = definition.stages.find((s) => s.id === stageId);
    if (stage === undefined) throw new Error(`stage ${stageId} 不存在`);
    const ctx = {
      projectId,
      runId: `m156-${anchorId}`,
      attempt: 1,
      signal: new AbortController().signal,
      state,
      emitProgress: async () => {},
      emitDomain: async () => {},
      log: (message) => log(`  [${stageId}] ${String(message).slice(0, 200)}`),
    };
    const out = await stage.execute(ctx);
    state.stageResults[stageId] = out;
    return out;
  };
  const callsBefore = physicalCalls;
  const reviewStage = await runStage("review.run");
  const gateStage = await runStage("quality.gate");
  const callsUsed = physicalCalls - callsBefore;
  const round = reviewStage["round"];

  // 完整 summary / gate 从产物文件读取（stage result 是摘要投影）
  const summary = JSON.parse(await readFile(join(projects.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8"));
  const gateArtifact = JSON.parse(await readFile(join(projects.reviewsDir(projectId), `quality-gate-r${round}.json`), "utf8"));
  const gateResult = gateArtifact.gate;
  const v1 = evaluateQualityGate({
    review: summary,
    citation: null,
    evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0 }, contradictory: 0, skippedLines: 0 },
    feasibility: null,
  });
  const record = {
    anchorId,
    projectId,
    family: anchor.family,
    qualityClass: anchor.qualityClass,
    provenance: anchor.provenance,
    durationMs: Date.now() - startedAt,
    physicalModelCalls: callsUsed,
    review: {
      round,
      coverage: summary.coverage ? { mode: summary.coverage.mode, complete: summary.coverage.complete, ratio: summary.coverage.ratio, units: `${summary.coverage.completedUnits}/${summary.coverage.targetUnits}` } : null,
      counts: summary.counts,
      factVerdicts: summary.scores.factVerdicts,
      academicScore: summary.scores.academicScore,
      styleRisk: summary.scores.styleRisk,
    },
    gate: {
      passed: gateResult.passed,
      rules: gateResult.rules.map((r) => ({ rule: r.rule, status: r.status ?? (r.passed ? "PASS" : "FAIL"), required: r.required === true, detail: r.detail.slice(0, 240) })),
      verification: gateResult.verification ? { requiredComplete: gateResult.verification.requiredComplete, notEvaluatedCount: gateResult.verification.notEvaluated.length } : null,
      evaluation: gateResult.evaluation ?? null,
    },
    publishedAssessment: gateStage["publishedAssessment"] ?? null,
    qualityDecisionV2Shadow: gateStage["qualityDecisionV2Shadow"] ?? null,
    v1Comparison: {
      passed: v1.passed,
      failedRules: v1.rules.filter((r) => !r.passed).map((r) => r.rule),
    },
    gateRuleDiff: (() => {
      const v1Rules = Object.fromEntries(v1.rules.map((r) => [r.rule, r.status ?? (r.passed ? "PASS" : "FAIL")]));
      return gateResult.rules
        .filter((r) => (v1Rules[r.rule] ?? "ABSENT") !== (r.status ?? (r.passed ? "PASS" : "FAIL")))
        .map((r) => `${r.rule}: v1=${v1Rules[r.rule] ?? "ABSENT"} → m156=${r.status ?? (r.passed ? "PASS" : "FAIL")}`);
    })(),
  };
  results.push(record);
  log(
    `${anchorId} ✔ calls=${callsUsed} coverage=${record.review.coverage ? `${record.review.coverage.mode}@${(record.review.coverage.ratio * 100).toFixed(0)}%(${record.review.coverage.units})` : "?"} claims=${JSON.stringify(record.review.factVerdicts)} gate=${record.gate.passed ? "PASS" : `FAIL(${record.gate.rules.filter((r) => r.status === "FAIL").map((r) => r.rule).join(",")})`} [${Math.round(record.durationMs / 1000)}s]`,
  );
  return record;
}

const anchors = await buildAnchors();
const ORDER = doFresh ? Object.keys(anchors).filter((id) => onlyAnchor === undefined || id === onlyAnchor) : [];

// 连通性 ping（1 次调用）
const ping = await adapter.runAgent({
  agentId: config.agents.reviewer,
  timeoutMs: 120_000,
  task: "回复 JSON：{\"ok\":true}（连通性检查，不要做任何其他事）",
  projectId: "m156-ping",
  contextScope: "review/benchmark-ping",
  metadata: { role: "reviewer" },
});
physicalCalls -= 1; // ping 不计入基准预算
if (ping.status !== "completed") {
  log(`ping ✘ ${ping.status}`);
  process.exit(1);
}
log(`ping ✔（Coding Plan 通道可用；usage=${JSON.stringify(ping.usage ?? null)}）`);

for (const anchorId of ORDER) {
  try {
    await runFreshAnchor(anchorId, anchors[anchorId]);
  } catch (error) {
    log(`${anchorId} ✘ FAIL：${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
    results.push({ anchorId, error: String(error instanceof Error ? error.message : error) });
  }
  await writeFile(join(WORK_DIR, "evaluation", "m156-fresh-report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), physicalModelCalls: physicalCalls, results }, null, 2), "utf8");
  await writeFile(join(WORK_DIR, "evaluation", "m156-fresh-driver-log.txt"), logLines.join("\n"), "utf8");
}

// ---- digest 模式锚点（干净副本 + reviewAll 三路 + 重放口径 gate；生产 units 路径的成本见各锚点记录） ----
const digestAnchors = {};
if (digestList.includes("llm-survey") || doSurveyDigest) {
  // F7 综述：arXiv 2303.18223（1M 字符——生产 units 模式成本超预算，digest 口径 + 如实声明）
  const surveyFiles = [];
  const walk = async (dir, base) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name);
      else if (entry.name.endsWith(".tex")) {
        const content = await readFile(join(dir, entry.name), "utf8");
        surveyFiles.push({ path: base ? `${base}/${entry.name}` : entry.name, content });
      }
    }
  };
  await walk(join(HOLDOUT, "llm-survey"), "");
  digestAnchors["llm-survey"] = {
    files: Object.fromEntries(surveyFiles.map((f) => [f.path.replace(/^sections\//, "").replace(/\//g, "_"), f.content])),
    fileEntries: surveyFiles,
    family: "F7-LLM-SURVEY-HOLDOUT",
    qualityClass: "known-good-published-survey",
    provenance: "arXiv 2303.18223 e-print（本轮新增独立 family）",
  };
}
for (const id of digestList) {
  if (id === "llm-survey") continue;
  if (anchors[id] === undefined) continue;
  digestAnchors[id] = { ...anchors[id], fileEntries: Object.entries(anchors[id].files).map(([file, content]) => ({ file, content })) };
}

if (Object.keys(digestAnchors).length > 0) {
  const { aggregateReviews } = await import(distUrl("review", "ReviewAggregator.js"));
  const { computeCrossSectionConsistency } = await import(distUrl("review", "crossSectionConsistency.js"));
  const { deriveEvidencePairing } = await import(distUrl("quality", "evidencePairing.js"));
  const { buildManuscriptDigest } = await import(distUrl("workflow", "definitions.js"));
  for (const [anchorId, anchor] of Object.entries(digestAnchors)) {
    const created = await projects.create(`M15.6 digest ${anchorId}`, { language: "en" });
    const projectId = created.id;
    const manuscriptDir = projects.manuscriptDir(projectId);
    await mkdir(manuscriptDir, { recursive: true });
    for (const file of anchor.fileEntries) {
      const target = join(manuscriptDir, ...file.file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const digest = await buildManuscriptDigest(services, projectId);
    const startedAt = Date.now();
    const callsBefore = physicalCalls;
    const reviewResults = await stack.reviewer.reviewAll({ projectId, manuscriptDigest: digest, evidence: [] });
    const summary = aggregateReviews(reviewResults, 1);
    const crossSection = computeCrossSectionConsistency({ files: anchor.fileEntries });
    const pairing = deriveEvidencePairing({
      reviewPurpose: "published_paper_assessment",
      evidence: { total: 0, verified: 0, contradictory: 0 },
      claimGrounding: null,
      claimChecks: undefined,
      factVerdicts: summary.scores.factVerdicts,
      unsupportedCriticalClaims: summary.unsupportedCriticalClaims,
      issues: summary.issues,
      evidenceRecords: [],
    });
    const gate = evaluateQualityGate({
      review: summary,
      citation: null,
      evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0 }, contradictory: 0, skippedLines: 0 },
      feasibility: null,
      evidencePairing: pairing,
      crossSectionConsistency: crossSection,
      reviewPurpose: "published_paper_assessment",
    });
    const v1 = evaluateQualityGate({
      review: summary,
      citation: null,
      evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0 }, contradictory: 0, skippedLines: 0 },
      feasibility: null,
    });
    const ruleStatus = (g) => Object.fromEntries(g.rules.map((r) => [r.rule, r.status ?? (r.passed ? "PASS" : "FAIL")]));
    const record = {
      anchorId: `${anchorId}-digest`,
      family: anchor.family,
      qualityClass: anchor.qualityClass,
      provenance: anchor.provenance,
      mode: "digest-reviewAll + gate replay（干净副本；作者契约 digest 口径——published rubric 的完整对照见生产 fresh 运行）",
      durationMs: Date.now() - startedAt,
      physicalModelCalls: physicalCalls - callsBefore,
      review: {
        counts: summary.counts,
        factVerdicts: summary.scores.factVerdicts,
        academicScore: summary.scores.academicScore,
        styleRisk: summary.scores.styleRisk,
      },
      gate: {
        passed: gate.passed,
        rules: gate.rules.map((r) => ({ rule: r.rule, status: r.status ?? (r.passed ? "PASS" : "FAIL"), required: r.required === true })),
      },
      crossSection: { status: crossSection.status, counts: crossSection.counts, notEvaluatedReasons: crossSection.notEvaluatedReasons },
      v1Rules: ruleStatus(v1),
      m156Rules: ruleStatus(gate),
    };
    results.push(record);
    log(`${anchorId}-digest ✔ calls=${record.physicalModelCalls} claims=${JSON.stringify(summary.scores.factVerdicts)} gate=${gate.passed ? "PASS" : "FAIL"} crossSection=${JSON.stringify(crossSection.counts)}`);
    await writeFile(join(WORK_DIR, "evaluation", "m156-fresh-report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), physicalModelCalls: physicalCalls, results }, null, 2), "utf8");
  }
}

log(`DONE. 物理（非 ping）模型调用 = ${physicalCalls}；报告：${join(WORK_DIR, "evaluation", "m156-fresh-report.json")}`);
