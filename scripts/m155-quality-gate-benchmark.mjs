#!/usr/bin/env node
/**
 * M15.5 Quality Gate Benchmark（2026-10-25）— m114 基准的扩展轮。
 *
 * 与 m114-quality-gate-benchmark.mjs 的关系：同一数据格式（samples[]）、同一 digest
 * 管线与覆盖率观测；本轮新增：
 *   1. controlled_edit 锚点（CE1 数值矛盾 / CE2 引用 key 损坏，MECHANICALLY_VERIFIED）
 *   2. F5 全新已发表 family（Attention Is All You Need，多文件项目，FROZEN_HOLDOUT）
 *   3. F4 当前管线重跑（10-06 管线 → 10-25 管线的刻度漂移对照）
 *   4. F1 关键锚点当前管线重跑（f1-human-final / f1-bad-notables / f2-bytetrack）
 *   5. 每样本生产 Gate 规则重放：aggregateReviews → evaluateQualityGate（citation=null
 *      / evidence 空 / feasibility=null 的 quick-review 形态），逐规则 PASS/FAIL 落盘
 *   6. CE2 的 citation.verify 确定性检出（写 bytetrack 原 bib，missingKeys 应恰为 2）
 *   7. MOT 真实稿（--mot <zip>，版本按 manifest SHA 固定后启用）
 *
 * 预算纪律：reviewAll = 3 路模型调用/样本；PAPERTEAM_GLOBAL_BUDGET_LEDGER 强制上限；
 * 预登记见 D:\PaperTeamData\M15\M15_5\BASELINE_AND_PRE_REGISTERED_PROTOCOL.md。
 *
 * 用法：node scripts/m155-quality-gate-benchmark.mjs [--ping] [--dry] [--only <case>] [--samples N]
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const WORK_DIR = "D:\\PaperTeamData\\M15\\M15_5";
const SOURCE_PROJECT_ROOT = join(repoRoot, "backend", "projects");
const SOURCE_PROJECT = "p-d12dc28ad850"; // 与 m114 相同骨架（只读）
const M114_STAGING = "D:\\PaperTeamData\\M11_4_QualityGateBenchmark\\staging";
const M114_CASE_ROOT = "D:\\PaperTeamData\\M10.3-real-paper-case";
const BENCH = join(WORK_DIR, "benchmark");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const onlyCase = args.find((a) => !a.startsWith("--"));
const doPing = flags.has("--ping");
const dryRun = flags.has("--dry");
const samplesPerAnchor = Number(args.find((a) => a.startsWith("--samples="))?.slice(10) ?? 2);

process.env["PROJECTS_ROOT"] = join(WORK_DIR, "projects");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
// 预算硬顶：本轮基准最多 60 次底层模型调用（剩余预算留给 E 阶段与复核）
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] ??= "60";

const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logLines.push(line);
}
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();

// ---- 锚点定义（与 BENCHMARK_MANIFEST.json 对齐） ----
async function buildAnchors() {
  const anchors = {};
  const put = (caseId, files, meta) => {
    anchors[caseId] = { files, ...meta }; // files: { path: content }
  };
  // CE1：f3-ocsort + 摘要数值矛盾（已在 benchmark/ce1-ocsort 构建并 SHA 固定）
  const ce1 = await readFile(join(BENCH, "ce1-ocsort", "main.tex"), "utf8");
  put("ce1-ocsort-numeric", { "main.tex": ce1 }, {
    label: "controlled edit: abstract HOTA 65.9/65.2 vs tables 63.2/62.1",
    family: "F3-PUBLISHED", documentType: "published_paper", language: "en",
    origin: "controlled-edit", qualityClass: "known-bad-controlled-numeric", controlledEdit: true,
    evidencePaired: false, provenance: "M15_5 benchmark/ce1-ocsort (sha f7488c3a…)",
  });
  // CE2：f2-bytetrack + 2 个引用 key x 后缀。
  // 第一轮（已完成样本）误用 references.bib 命名——tex 声明 \bibliography{egbib}，
  // LatexFiles 按声明找 egbib.bib → bib 缺失 → missingKeys=81/81（那次观察保留为
  // 「bib 整体缺失」行为记录）。本轮 ce2b 用正确命名的 egbib.bib：missingKeys 应恰为 2。
  const ce2 = await readFile(join(BENCH, "ce2-bytetrack", "egpaper_final.tex"), "utf8");
  const ce2bib = await readFile(join(M114_STAGING, "bytetrack", "egbib.bib"), "utf8");
  put("ce2b-bytetrack-citekeys-bibfix", { "main.tex": ce2, "egbib.bib": ce2bib }, {
    label: "controlled edit: zhang2020fairmot/zhou2020tracking keys corrupted (x-suffix), egbib.bib named per \\bibliography declaration",
    family: "F2-PUBLISHED", documentType: "published_paper", language: "en",
    origin: "controlled-edit", qualityClass: "known-bad-controlled-citation", controlledEdit: true,
    evidencePaired: false, runCitationVerify: true,
    provenance: "M15_5 benchmark/ce2-bytetrack (sha 0ae7a22…) + egbib.bib",
  });
  // F4 当前管线重跑（holdout published 对照）
  const f4 = await readFile(join(M114_STAGING, "strongsort", "bare_jrnl_new_sample4.tex"), "utf8");
  put("f4-strongsort-rerun", { "main.tex": f4 }, {
    label: "StrongSORT (TMM 2023) re-run on current pipeline",
    family: "F4-PUBLISHED", documentType: "published_paper", language: "en",
    origin: "human", qualityClass: "known-good-published", evidencePaired: false,
    provenance: "M11_4 staging strongsort/bare_jrnl_new_sample4.tex",
  });
  // F5 全新已发表 family（holdout；多文件）
  const f5dir = join(BENCH, "f5-staging");
  const f5files = {};
  for (const entry of await readdir(f5dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".tex")) f5files[entry.name] = await readFile(join(f5dir, entry.name), "utf8");
  }
  const ms = f5files["ms.tex"];
  delete f5files["ms.tex"];
  put("f5-attention", { "main.tex": ms, ...f5files }, {
    label: "Attention Is All You Need (NeurIPS 2017) — new holdout family",
    family: "F5-PUBLISHED-NEW", documentType: "published_paper", language: "en",
    origin: "human", qualityClass: "known-good-published", evidencePaired: false,
    provenance: "arXiv 1706.03762 e-print (combined sha 8DF6E27A…)",
  });
  // DEV 当前管线重跑（f1-human-final / f1-bad-notables / f2-bytetrack）
  const human = await readFile(join(M114_CASE_ROOT, "manuscript", "source", "paper.tex"), "utf8");
  put("f1-human-final-rerun", { "main.tex": human }, {
    label: "F1 human final re-run on current pipeline",
    family: "F1-real-revision", documentType: "existing_paper", language: "zh",
    origin: "human", qualityClass: "acceptable-human-revised(task-layer)", evidencePaired: true,
    provenance: "M10.3-real-paper-case/manuscript/source/paper.tex",
  });
  const bad = await readFile(join(M114_CASE_ROOT, "manuscript", "historical", "paper_before_revision.tex"), "utf8")
    .then((content) => content.replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}\s*/g, ""));
  put("f1-bad-notables-rerun", { "main.tex": bad }, {
    label: "F1 synthetic degradation (tables removed) re-run on current pipeline",
    family: "F1-real-revision", documentType: "existing_paper", language: "zh",
    origin: "synthetic-mutation", qualityClass: "known-bad-synthetic", evidencePaired: true,
    provenance: "deterministic mutation of paper_before_revision.tex (同 m114)",
  });
  const bt = await readFile(join(M114_STAGING, "bytetrack", "egpaper_final.tex"), "utf8");
  const btBib = await readFile(join(M114_STAGING, "bytetrack", "egbib.bib"), "utf8");
  put("f2-bytetrack-rerun", { "main.tex": bt, "egbib.bib": btBib }, {
    label: "ByteTrack re-run on current pipeline (evidence_gap artifact check)",
    family: "F2-PUBLISHED", documentType: "published_paper", language: "en",
    origin: "human", qualityClass: "known-good-published", evidencePaired: false,
    provenance: "M11_4 staging bytetrack/egpaper_final.tex + egbib.bib",
  });
  // MOT R5.1 submission candidate（真实作者稿件最新可用版，SHA 固定 210b82ae…）
  const motR51 = await readFile(
    join(WORK_DIR, "mot", "r51-extract", "mot_paperteam_review", "manuscript", "paper_submission_candidate.tex"),
    "utf8",
  );
  put("mot-r51-real", { "main.tex": motR51 }, {
    label: "MOT Revival R5.1 submission candidate (real author manuscript, 2026-10-18 version)",
    family: "F6-MOT-REAL", documentType: "existing_paper", language: "zh",
    origin: "human", qualityClass: "real-author-manuscript(hedged, submission-ready per R5.1)", evidencePaired: false,
    provenance: "mot_paperteam_review_latest.zip (acce88f2…) manuscript/paper_submission_candidate.tex (sha 210b82ae…)",
  });
  // MOT（--mot 显式启用；zip 由 manifest 固定 SHA 后解包）
  const motArg = args.find((a) => a.startsWith("--mot="))?.slice(6);
  if (motArg) {
    const { execFileSync } = await import("node:child_process");
    const tmp = join(WORK_DIR, "mot", "extract-bench");
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    execFileSync("tar", ["-xf", resolve(motArg), "-C", tmp], { stdio: "inherit" });
    const motFiles = {};
    const walk = async (dir, base) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name);
        else if (entry.name.endsWith(".tex")) motFiles[base ? `${base}/${entry.name}` : entry.name] = await readFile(join(dir, entry.name), "utf8");
      }
    };
    await walk(tmp, "");
    const mainKey = Object.keys(motFiles).find((k) => /main\.tex$|paper\.tex$|latest\.tex$/i.test(k)) ?? Object.keys(motFiles)[0];
    const motMain = motFiles[mainKey];
    delete motFiles[mainKey];
    put("mot-real", { "main.tex": motMain, ...motFiles }, {
      label: "MOT real manuscript (version pinned by manifest)",
      family: "F6-MOT-REAL", documentType: "existing_paper", language: "zh",
      origin: "human", qualityClass: "real-author-manuscript(known real defects)", evidencePaired: false,
      provenance: `zip=${motArg} main=${mainKey}`,
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
const { aggregateReviews } = await import(distUrl("review", "ReviewAggregator.js"));
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
  console.error("[fatal] 未解析到模型（应为 zai-coding-cn/glm-5.3 = Coding Plan）");
  process.exit(1);
}
log(`model = ${JSON.stringify({ provider: modelSpec.provider, model: modelSpec.model, baseUrl: modelSpec.baseUrl !== undefined })}（缺省 = Coding Plan）`);

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
const reportPath = join(WORK_DIR, "runs", "m155-benchmark-report.json");
let report = {
  schemaVersion: 2,
  startedAt: new Date().toISOString(),
  pipeline: "current pipeline (post M14.9.5.4 + M15.x shadow), digest mode, reviewAll 3-way",
  samples: [],
  notes: [],
};
try {
  report = { ...report, ...JSON.parse(await readFile(reportPath, "utf8")) };
  log(`resume：已有 ${report.samples.length} 个样本记录`);
} catch { /* fresh */ }
const doneKeys = new Set(report.samples.map((s) => s.key));

const anchors = await buildAnchors();

// ---- 副本（骨架项目 + 指定 manuscript 文件） ----
const skipDirs = new Set(["build", "workflow"]);
async function makeCopy(copyId, anchor) {
  const dest = join(projectsRoot, copyId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, "manuscript"), { recursive: true });
  for (const entry of await readdir(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT), { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    if (entry.name === "manuscript") continue;
    await cp(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, entry.name), join(dest, entry.name), { recursive: true });
  }
  for (const [path, content] of Object.entries(anchor.files)) {
    const target = join(dest, "manuscript", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function digestCoverage(digest, anchorContent) {
  const blocks = [...digest.matchAll(/^\[main\.tex[^\]]*\]$/gm)].length + [...digest.matchAll(/^\[[^\]\/]+\.tex[^\]]*\]$/gm)].length;
  const truncationNotes = [...digest.matchAll(/系统注：本节超出审稿视图预算/g)].length;
  const sections = (anchorContent.match(/\\(?:sub)*section\*?\{/g) ?? []).length;
  return {
    digestChars: digest.length,
    blocks,
    sectionsInSource: sections,
    visibleRatio: Number((digest.length / Math.max(1, anchorContent.length)).toFixed(3)),
    truncatedBlocks: truncationNotes,
    truncated: digest.length >= 60_000 || truncationNotes > 0,
  };
}

// ---- 生产 Gate 规则重放（quick-review 形态：无 citation 报告 / 空证据库 / 无 feasibility） ----
function gateReplay(results, round) {
  const summary = aggregateReviews(results, round);
  const gate = evaluateQualityGate({
    review: summary,
    citation: null,
    evidence: { total: 0, verified: 0, contradictory: 0, pending: 0 },
    feasibility: null,
  });
  return {
    gatePassed: gate.passed,
    failedRules: gate.rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail.slice(0, 160)}`),
    ruleStatus: gate.rules.map((rule) => ({ rule: rule.rule, status: rule.status ?? (rule.passed ? "PASS" : "FAIL"), required: rule.required === true })),
    verification: gate.verification ? { requiredComplete: gate.verification.requiredComplete, notEvaluated: gate.verification.notEvaluated.length } : null,
  };
}

let modelCallBudgetUsed = 0;
async function runSample(key, anchor) {
  if (doneKeys.has(key)) {
    log(`skip ${key}（已完成）`);
    return;
  }
  if (modelCallBudgetUsed + 3 > 60) {
    log(`STOP ${key}：基准预算 60 次底层调用将超（已用 ${modelCallBudgetUsed}）`);
    return;
  }
  const copyId = `m155-${key}`;
  await makeCopy(copyId, anchor);
  const anchorContent = anchor.files["main.tex"] ?? Object.values(anchor.files)[0];
  const digest = await buildManuscriptDigest(stack.workflowServices, copyId);
  const coverage = digestCoverage(digest, anchorContent);
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
  log(`${key}: digest ${coverage.digestChars} chars / ${coverage.blocks} blocks（可见比 ${coverage.visibleRatio}，截断 ${coverage.truncated}）`);
  const startedAt = Date.now();
  try {
    const results = await stack.reviewer.reviewAll({
      projectId: copyId,
      manuscriptDigest: digest,
      evidence,
      ...(citationDigest ? { citationDigest } : {}),
    });
    modelCallBudgetUsed += results.length;
    const academic = results.find((r) => r.mode === "academic");
    const fact = results.find((r) => r.mode === "fact");
    const style = results.find((r) => r.mode === "style");
    const summary = aggregateReviews(results, 1);
    // CE2：citation.verify 确定性检出（结构层）
    let citationVerify = undefined;
    if (anchor.runCitationVerify === true) {
      try {
        const report = await stack.citation.verify(copyId);
        citationVerify = {
          citedCount: report.summary.citedCount,
          missingKeys: report.summary.missingKeys,
          duplicateKeys: report.summary.duplicateKeys,
          badCitations: report.summary.badCitations,
          hallucinated: report.summary.hallucinated,
        };
        log(`${key}: citation.verify ${JSON.stringify(citationVerify)}`);
      } catch (error) {
        citationVerify = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const sample = {
      key,
      caseId: key.replace(/-s\d+$/, ""),
      anchor: { family: anchor.family, qualityClass: anchor.qualityClass, language: anchor.language, controlledEdit: anchor.controlledEdit === true },
      coverage,
      evidencePaired: anchor.evidencePaired,
      durationMs: Date.now() - startedAt,
      underlyingModelCalls: results.length,
      taskIds: { academic: academic?.taskId, fact: fact?.taskId, style: style?.taskId },
      // M15.5 记账：逐任务 usage（Pi 原生；provider 未返回则缺省不伪造）
      taskUsage: Object.fromEntries(
        (await Promise.all(
          results.map(async (result) => {
            if (result.taskId === undefined) return null;
            try {
              const task = await adapter.getTask(result.taskId);
              return [result.mode, task.usage ?? null];
            } catch {
              return [result.mode, null];
            }
          }),
        )).filter((entry) => entry !== null),
      ),
      academicScore: academic?.overallScore ?? undefined,
      academicDims: academic?.scores ?? undefined,
      styleRisk: style?.riskScore ?? undefined,
      claims: fact?.claims?.length ?? 0,
      unsupported: fact?.claims?.filter((c) => c.verdict === "UNSUPPORTED").length ?? 0,
      contradicted: fact?.claims?.filter((c) => c.verdict === "CONTRADICTED").length ?? 0,
      critical: summary.counts.critical,
      blocking: summary.counts.blocking,
      major: summary.counts.major,
      minor: summary.counts.minor,
      ...(citationVerify !== undefined ? { citationVerify } : {}),
      gateReplay: gateReplay(results, 1),
      issues: summary.issues.map((i) => ({ mode: i.mode ?? null, section: i.section, category: i.category, severity: i.severity, blocking: i.blocking, verification: i.verification ?? null, description: i.description })),
    };
    report.samples.push(sample);
    doneKeys.add(key);
    log(
      `${key} ✔ academic=${sample.academicScore} style=${sample.styleRisk} claims=${sample.claims}(U${sample.unsupported}/C${sample.contradicted}) crit=${sample.critical} blk=${sample.blocking} maj=${sample.major} gate=${sample.gateReplay.gatePassed ? "PASS" : "FAIL(" + sample.gateReplay.failedRules.map((r) => r.split(":")[0]).join(",") + ")"} ${Math.round(sample.durationMs / 1000)}s [budget ${modelCallBudgetUsed}/60]`,
    );
  } catch (error) {
    log(`${key} ✘ FAIL：${error instanceof Error ? error.message : String(error)}`);
    report.notes.push(`${key} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await saveReport();
}

async function saveReport() {
  await mkdir(join(WORK_DIR, "runs"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(WORK_DIR, "runs", "m155-driver-log.txt"), logLines.join("\n"), "utf8");
}

if (doPing) {
  const task = await adapter.runAgent({
    agentId: config.agents.reviewer,
    timeoutMs: 120_000,
    task: "回复 JSON：{\"ok\":true}（连通性检查，不要做任何其他事）",
    projectId: "m155-ping",
    contextScope: "review/benchmark-ping",
    metadata: { role: "reviewer" },
  });
  if (task.status !== "completed") {
    log(`ping ✘ ${task.status}: ${task.error ?? ""}`);
    process.exit(1);
  }
  modelCallBudgetUsed += 1;
  log(`ping ✔（Coding Plan 通道可用，taskId=${task.taskId}；usage=${JSON.stringify(task.usage ?? null)}）`);
}

const CASE_ORDER = [
  "ce1-ocsort-numeric",
  "ce2-bytetrack-citekeys",
  "ce2b-bytetrack-citekeys-bibfix",
  "f1-human-final-rerun",
  "f1-bad-notables-rerun",
  "f2-bytetrack-rerun",
  "f4-strongsort-rerun",
  "f5-attention",
  "mot-r51-real",
  "mot-real",
].filter((caseId) => anchors[caseId] !== undefined);
if (dryRun) {
  log("=== DRY：只构建副本 + digest 覆盖率，不调用模型 ===");
  for (const caseId of CASE_ORDER) {
    const anchor = anchors[caseId];
    const copyId = `dry-${caseId}`;
    await makeCopy(copyId, anchor);
    const digest = await buildManuscriptDigest(stack.workflowServices, copyId);
    log(`${caseId}: ${JSON.stringify(digestCoverage(digest, anchor.files["main.tex"] ?? Object.values(anchor.files)[0]))}`);
  }
  process.exit(0);
}
for (const caseId of CASE_ORDER) {
  if (onlyCase !== undefined && caseId !== onlyCase) continue;
  for (let i = 1; i <= samplesPerAnchor; i += 1) {
    await runSample(`${caseId}-s${i}`, anchors[caseId]);
  }
}
log(`DONE. 样本 ${report.samples.length} 个（预算 ${modelCallBudgetUsed}/60）；报告：${reportPath}`);
