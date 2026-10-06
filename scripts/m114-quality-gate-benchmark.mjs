#!/usr/bin/env node
/**
 * M11.4 Quality Gate Benchmark（2026-10-07）— Product Closure 的实证基准。
 *
 * 目的：在**修复后的生产管线 digest**（splitSingleFileDigest 64 块 + 句界安全
 * 截断）下，对多个 paper family 的锚点做 ≥3 次独立 Reviewer 采样，回答：
 *   1. Reviewer score 的组内方差（measurement noise）
 *   2. known-good / acceptable / pre-revision / known-bad 的分布与可分性
 *   3. 相对 delta（human-revised − pre；candidate − pre）
 *   4. Option C 的 floor / non-regression tolerance 是否有数据支撑
 *
 * 与 M11_4_QualityGateCalibration 的关系：那轮 37 次调用在**旧 digest**（44%
 * 可见）+ VIS 全文 override 口径下测量，已入库不复跑；本轮全部为**现行生产
 * digest** 的新锚点采样（新增 paper families + 缺失 anchors）。
 *
 * Families / anchors（见 benchmark-manifest.json，逐条记录 §18 inclusion 字段）：
 *   F1  真实返修论文（中文，唯一真实 human revision family）
 *       f1-pre           pre-revision baseline（human，冻结 SHA 423CF0…）
 *       f1-human-final   human revised final（已知可接受锚点）
 *       f1-candidate     PaperTeam candidate（Attempt 7 rev-3）
 *       f1-bad-notables  synthetic degradation（剔除全部表格环境；仅敏感性检查）
 *   F2-F4  已发表顶会/期刊论文（英文，known-good；arXiv LaTeX 源）
 *
 * 隔离与纪律：
 *   - 源项目 backend/projects/p-d12dc28ad850 只读；副本写 benchmark 工作区
 *   - human final 仅在评估语境读取（Attempt 2 freeze 后合法解封；不回灌生成链）
 *   - F2-F4 无对应 PaperTeam 项目 → evidence 置空（evidencePaired=false），
 *     fact 口径计数对它们不可比（记录，不解读）
 *   - 不跑 Writer / Planner / workflow；不进入正式 Acceptance
 *
 * 用法：node scripts/m114-quality-gate-benchmark.mjs [--ping] [--dry] [--only <case>]
 * （resume-by-key：已完成的样本自动跳过）
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const WORK_DIR = "D:\\PaperTeamData\\M11_4_QualityGateBenchmark";
const SOURCE_PROJECT_ROOT = join(repoRoot, "backend", "projects");
const SOURCE_PROJECT = "p-d12dc28ad850"; // Attempt 7 clean run（只读）
const CASE_ROOT = "D:\\PaperTeamData\\M10.3-real-paper-case";
const STAGING = join(WORK_DIR, "staging");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const onlyCase = args.find((a) => !a.startsWith("--"));
const doPing = flags.has("--ping");
const dryRun = flags.has("--dry");

process.env["PROJECTS_ROOT"] = join(WORK_DIR, "projects");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";

const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logLines.push(line);
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();

// ---- anchor 准备（f1-bad 是确定性变异：剔除全部 table/table* 环境） ----
async function stripTableEnvironments(content) {
  return content.replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}\s*/g, "");
}

async function buildAnchorFiles() {
  const anchors = {};
  const put = (caseId, content, meta) => {
    anchors[caseId] = { content, ...meta };
  };
  const pre = await readFile(join(CASE_ROOT, "manuscript", "historical", "paper_before_revision.tex"), "utf8");
  const human = await readFile(join(CASE_ROOT, "manuscript", "source", "paper.tex"), "utf8");
  const candidate = await readFile(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, "manuscript", "main.tex"), "utf8");
  const badMutated = await stripTableEnvironments(pre);
  put("f1-pre", pre, {
    label: "pre-revision baseline",
    family: "F1-real-revision",
    documentType: "existing_paper",
    language: "zh",
    origin: "human",
    qualityClass: "pre-revision",
    hasComments: true,
    hasHumanFinal: true,
    evidencePaired: true,
    provenance: "D:/PaperTeamData/M10.3-real-paper-case/manuscript/historical/paper_before_revision.tex",
  });
  put("f1-human-final", human, {
    label: "human revised final",
    family: "F1-real-revision",
    documentType: "existing_paper",
    language: "zh",
    origin: "human",
    qualityClass: "acceptable-human-revised",
    hasComments: true,
    hasHumanFinal: true,
    evidencePaired: true,
    provenance: "D:/PaperTeamData/M10.3-real-paper-case/manuscript/source/paper.tex",
  });
  put("f1-candidate", candidate, {
    label: "PaperTeam candidate (Attempt 7 rev-3)",
    family: "F1-real-revision",
    documentType: "existing_paper",
    language: "zh",
    origin: "paperteam",
    qualityClass: "paperteam-candidate",
    hasComments: true,
    hasHumanFinal: true,
    evidencePaired: true,
    provenance: "backend/projects/p-d12dc28ad850/manuscript/main.tex",
  });
  put("f1-bad-notables", badMutated, {
    label: "synthetic degradation of f1-pre (all table* environments removed)",
    family: "F1-real-revision",
    documentType: "existing_paper",
    language: "zh",
    origin: "synthetic-mutation",
    qualityClass: "known-bad-synthetic",
    hasComments: false,
    hasHumanFinal: true,
    evidencePaired: true,
    provenance: "deterministic mutation of paper_before_revision.tex",
    mutation: "strip \\\\begin{table*?}...\\\\end{table*?} blocks",
  });
  const published = [
    ["f2-bytetrack", "ByteTrack (ECCV 2022)", "bytetrack/egpaper_final.tex"],
    ["f3-ocsort", "OC-SORT (CVPR 2023)", "ocsort/main.tex"],
    ["f4-strongsort", "StrongSORT (IEEE TMM 2023)", "strongsort/bare_jrnl_new_sample4.tex"],
  ];
  for (const [caseId, label, rel] of published) {
    const content = await readFile(join(STAGING, rel), "utf8");
    put(caseId, content, {
      label,
      family: caseId.replace(/-.*/, "").toUpperCase() + "-published",
      documentType: "published_paper",
      language: "en",
      origin: "human",
      qualityClass: "known-good-published",
      hasComments: false,
      hasHumanFinal: false,
      evidencePaired: false,
      provenance: `arXiv e-print ${rel.split("/")[0]} (staging)`,
    });
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
const { buildManuscriptDigest } = await import(distUrl("workflow", "definitions.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));

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
  console.error("[fatal] 未解析到模型（应为 zai-coding-cn/glm-5.3 = Coding Plan）");
  process.exit(1);
}
log(`model = ${JSON.stringify({ provider: modelSpec.provider, model: modelSpec.model, baseUrl: modelSpec.baseUrl !== undefined })}（apiChannel 仅 general_api 生效；缺省 = Coding Plan）`);

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

// ---- 报告（断点续跑） ----
const reportPath = join(WORK_DIR, "benchmark-report.json");
let report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  pipeline: "production digest (splitSingleFileDigest 64-block + sentence-safe truncation)",
  samples: [],
  notes: [],
};
try {
  report = { ...report, ...JSON.parse(await readFile(reportPath, "utf8")) };
  log(`resume：已有 ${report.samples.length} 个样本记录`);
} catch { /* fresh */ }
const doneKeys = new Set(report.samples.map((s) => s.key));

// ---- manifest（§18 inclusion criteria，机器可读） ----
const anchors = await buildAnchorFiles();
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  uniquePaperFamilies: [...new Set(Object.values(anchors).map((a) => a.family))].length,
  realHumanRevisionPairs: 1,
  cases: Object.entries(anchors).map(([caseId, a]) => ({
    caseId,
    sha256: sha256(a.content),
    chars: a.content.length,
    sectionCount: (a.content.match(/\\(?:sub)*section\*?\{/g) ?? []).length,
    tableCount: (a.content.match(/\\begin\{table\*?\}/g) ?? []).length,
    samplesPerAnchor: 3,
    suitableFor: ["absolute", a.hasHumanFinal ? "relative-delta" : "absolute"],
    sharing: a.family.startsWith("F1") ? "local-private" : "public-arxiv",
    ...a,
    content: undefined,
  })),
};
await mkdir(WORK_DIR, { recursive: true });
await writeFile(join(WORK_DIR, "benchmark-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

// ---- 副本准备（跳过 build/ 与 workflow/；源项目只读） ----
const skipDirs = new Set(["build", "workflow"]);
async function makeCopy(copyId, anchor) {
  const dest = join(projectsRoot, copyId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, "manuscript"), { recursive: true });
  for (const entry of await readdir(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT), { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    await cp(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, entry.name), join(dest, entry.name), { recursive: true });
  }
  await writeFile(join(dest, "manuscript", "main.tex"), anchor.content, "utf8");
}

// ---- digest 覆盖率观测（§25：不能再出现实验章整体不可见） ----
function digestCoverage(digest, anchorContent) {
  const blocks = [...digest.matchAll(/^\[main\.tex[^\]]*\]$/gm)].length;
  const truncationNotes = [...digest.matchAll(/系统注：本节超出审稿视图预算/g)].length;
  const sections = (anchorContent.match(/\\(?:sub)*section\*?\{/g) ?? []).length;
  return {
    digestChars: digest.length,
    blocks,
    sectionsInSource: sections,
    visibleRatio: Number((digest.length / Math.max(1, anchorContent.length)).toFixed(3)),
    truncatedBlocks: truncationNotes,
    truncated: digest.length >= 60_000 || truncationNotes > 0,
    truncationReason:
      digest.length >= 60_000
        ? truncationNotes > 0
          ? "per-block budget + 60k total budget (sentence-safe, annotated)"
          : "60k total budget (sentence-safe, annotated)"
        : truncationNotes > 0
          ? "per-block budget (sentence-safe, annotated)"
          : "none",
  };
}

// ---- 采样（reviewAll 三路 fan-out；evidence 按 anchor 口径） ----
async function runSample(key, anchor) {
  if (doneKeys.has(key)) {
    log(`skip ${key}（已完成）`);
    return;
  }
  const copyId = `bench-${key}`;
  await makeCopy(copyId, anchor);
  const digest = await buildManuscriptDigest(stack.workflowServices, copyId);
  const coverage = digestCoverage(digest, anchor.content);
  let evidence = [];
  let citationDigest;
  if (anchor.evidencePaired) {
    const evidenceSelection = await stack.evidenceSelection.selectForWriting(copyId);
    evidence = evidenceSelection.formal;
    const citationReport = await stack.citation.latestReport(copyId);
    citationDigest = citationReport
      ? `cited=${citationReport.summary.citedCount} missing=${citationReport.summary.missingKeys} hallucinated=${citationReport.summary.hallucinated} mismatched=${citationReport.summary.mismatched}`
      : undefined;
  }
  log(`${key}: digest ${coverage.digestChars} chars / ${coverage.blocks} blocks（源 ${coverage.sectionsInSource} 节，可见比 ${coverage.visibleRatio}，截断 ${coverage.truncationReason}）`);
  const startedAt = Date.now();
  try {
    const results = await stack.reviewer.reviewAll({
      projectId: copyId,
      manuscriptDigest: digest,
      evidence,
      ...(citationDigest ? { citationDigest } : {}),
    });
    const academic = results.find((r) => r.mode === "academic");
    const fact = results.find((r) => r.mode === "fact");
    const style = results.find((r) => r.mode === "style");
    const countBy = (sev) => results.reduce((s, r) => s + r.issues.filter((i) => i.severity === sev).length, 0);
    const sample = {
      key,
      caseId: key.replace(/-s\d+$/, ""),
      anchor: { family: anchor.family, qualityClass: anchor.qualityClass, language: anchor.language },
      coverage,
      evidencePaired: anchor.evidencePaired,
      durationMs: Date.now() - startedAt,
      taskIds: { academic: academic?.taskId, fact: fact?.taskId, style: style?.taskId },
      academicScore: academic?.overallScore ?? undefined,
      academicDims: academic?.scores ?? undefined,
      academicSummary: academic?.summary ?? undefined,
      styleRisk: style?.riskScore ?? undefined,
      claims: fact?.claims?.length ?? 0,
      supported: fact?.claims?.filter((c) => c.verdict === "SUPPORTED").length ?? 0,
      partiallySupported: fact?.claims?.filter((c) => c.verdict === "PARTIALLY_SUPPORTED").length ?? 0,
      unsupported: fact?.claims?.filter((c) => c.verdict === "UNSUPPORTED").length ?? 0,
      contradicted: fact?.claims?.filter((c) => c.verdict === "CONTRADICTED").length ?? 0,
      critical: countBy("critical"),
      blocking: results.reduce((s, r) => s + r.issues.filter((i) => i.blocking).length, 0),
      major: countBy("major"),
      minor: countBy("minor"),
      factFindings: fact?.issues.length ?? 0,
      citationFindings: results.reduce((s, r) => s + r.issues.filter((i) => i.category === "citation").length, 0),
      evidenceFindings: results.reduce((s, r) => s + r.issues.filter((i) => i.category === "evidence_gap").length, 0),
      issues: results.flatMap((r) =>
        r.issues.map((i) => ({ mode: r.mode, section: i.section, category: i.category, severity: i.severity, blocking: i.blocking, description: i.description })),
      ),
    };
    report.samples.push(sample);
    doneKeys.add(key);
    log(
      `${key} ✔ academic=${sample.academicScore} dims=${JSON.stringify(sample.academicDims)} style=${sample.styleRisk} claims=${sample.claims}(U${sample.unsupported}/C${sample.contradicted}) crit=${sample.critical} blk=${sample.blocking} maj=${sample.major} ${Math.round(sample.durationMs / 1000)}s`,
    );
  } catch (error) {
    log(`${key} ✘ FAIL：${error instanceof Error ? error.message : String(error)}`);
    report.notes.push(`${key} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await saveReport();
}

async function saveReport() {
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(WORK_DIR, "driver-log.txt"), logLines.join("\n"), "utf8");
}

// ---- 连通性 preflight（Test Connection 语义：1 次最小调用） ----
if (doPing) {
  const task = await adapter.runAgent({
    agentId: config.agents.reviewer,
    timeoutMs: 120_000,
    task: "回复 JSON：{\"ok\":true}（连通性检查，不要做任何其他事）",
    projectId: "bench-ping",
    contextScope: "review/benchmark-ping",
    metadata: { role: "reviewer" },
  });
  if (task.status !== "completed") {
    log(`ping ✘ ${task.status}: ${task.error ?? ""}`);
    process.exit(1);
  }
  log(`ping ✔（Coding Plan 通道可用，taskId=${task.taskId}）`);
}

// ---- 主流程 ----
const CASE_ORDER = ["f1-pre", "f1-human-final", "f1-candidate", "f1-bad-notables", "f2-bytetrack", "f3-ocsort", "f4-strongsort"];
if (dryRun) {
  log("=== DRY：只构建副本 + digest 覆盖率，不调用模型 ===");
  for (const caseId of CASE_ORDER) {
    const anchor = anchors[caseId];
    const copyId = `dry-${caseId}`;
    await makeCopy(copyId, anchor);
    const digest = await buildManuscriptDigest(stack.workflowServices, copyId);
    log(`${caseId}: ${JSON.stringify(digestCoverage(digest, anchor.content))}`);
  }
  process.exit(0);
}
for (const caseId of CASE_ORDER) {
  if (onlyCase !== undefined && caseId !== onlyCase) continue;
  for (let i = 1; i <= 3; i += 1) {
    await runSample(`${caseId}-s${i}`, anchors[caseId]);
  }
}
log(`DONE. 样本 ${report.samples.length} 个，报告：${reportPath}`);
