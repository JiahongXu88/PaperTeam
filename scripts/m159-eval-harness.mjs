#!/usr/bin/env node
/**
 * M15.9 评估 harness：Target-Journal-Calibrated 层的 A0/A1/A2/A3 消融 + Layer A oracle 对照。
 *
 * 样本（phase-c/mutation-register.json，盲态：本脚本不读登记的预期结论——预期只在聚合时比对）：
 *   b1c（合规对照）/ b1c-f1..f5（指南变异族）/ b1c-f7（引用破坏，零模型确定性腿）/
 *   bnet（范围差分合成稿）× venue {cjig, cea}。
 *
 * 臂：
 *   A0 = 内部 Quality Gate（负例安全性由 F7 确定性腿 + M15.8.6 N1/N2/H fresh 锚承担，不重复烧模型）；
 *   A1 = M12 Target Readiness（确定性；语料 profile 复制自 corpus 项目——同指纹同参照系）；
 *   A2 = G1 官方要求确定性符合度 + G2 rubric（模型，含 benchmark 带）；
 *   A3 = G2 rubric 不含 benchmark 带（omitBenchmarkBands 消融）。
 *
 * 纪律：
 *   - GlobalBudgetLedger（任务上限 600）+ completeSimple 物理计数全记（taskUse）；
 *   - --list/--dry-run 零网络零模型；--resume 按 report 键跳过；--only 单样本；
 *   - 评估项目与 mutation 登记物理隔离（登记只在 phase-c/，项目在 eval-projects/）。
 *
 * 产物（仓库外 D:\PaperTeamData\M15\M15_9\）：
 *   phase-d/m159-eval-report.json（逐 sample×venue×arm 增量落盘）
 *   phase-d/m159-driver-log.txt
 *   budget/budget-ledger.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORK_DIR = "D:/PaperTeamData/M15/M15_9";
const EVAL_DIR = join(WORK_DIR, "phase-d");
const PROJECTS_ROOT = join(WORK_DIR, "eval-projects");
const LEDGER_PATH = join(WORK_DIR, "budget", "budget-ledger.json");
const REPORT_PATH = join(EVAL_DIR, "m159-eval-report.json");
const DRIVER_LOG_PATH = join(EVAL_DIR, "m159-driver-log.txt");
const MATERIALZED_DIR = join(WORK_DIR, "phase-c", "materialized");
const GUIDELINE_DIR = join(WORK_DIR, "phase-c", "guideline-artifacts");
const CJIG_PARSED_DIR = join(WORK_DIR, "phase-b", "corpus", "cjig", "parsed");
const CJIG_PDF_DIR = join(WORK_DIR, "phase-b", "corpus", "cjig", "pdf");

const SESSION_MAX_CALLS = 600; // 任务书 §8 保护性上限
const VENUES = ["cjig", "cea"];

const SAMPLES = [
  { id: "b1c", docType: "survey", venues: ["cjig", "cea"], arms: ["readiness", "rubricA2", "rubricA3"] },
  { id: "b1c-f1-title22", docType: "survey", venues: ["cjig", "cea"], arms: ["rubricA2"] },
  { id: "b1c-f2-kw3", docType: "survey", venues: ["cjig"], arms: ["rubricA2"] },
  { id: "b1c-f3-stale-refs", docType: "survey", venues: ["cjig"], arms: [] },
  { id: "b1c-f4-unstructured-abs", docType: "survey", venues: ["cjig"], arms: [] },
  { id: "b1c-f5-refs12", docType: "survey", venues: ["cjig"], arms: [] },
  { id: "b1c-f7-citation-key-break", docType: "survey", venues: [], arms: [], special: "citation-check" },
  { id: "bnet-scope-mismatch", docType: "research", venues: ["cjig", "cea"], arms: ["rubricA2", "rubricA3"] },
];

// ---- CLI ----
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
const listOnly = has("--list");
const dryRun = has("--dry-run");
const fresh = has("--fresh");
const resume = has("--resume");
const onlySample = valueOf("only");
const maxModelCalls = Number(valueOf("max-model-calls") ?? 0);

if (!listOnly && !dryRun && !fresh && !resume) {
  console.error("[refuse] 缺省拒绝执行：--list / --dry-run 只读，--fresh / --resume 显式运行");
  process.exit(2);
}
if (fresh && resume) {
  console.error("[refuse] --fresh 与 --resume 互斥");
  process.exit(2);
}
if ((fresh || resume) && maxModelCalls <= 0) {
  console.error("[refuse] 运行模式必须显式 --max-model-calls N（1..600）");
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const nowIso = () => new Date().toISOString();

if (listOnly) {
  console.log("样本矩阵：");
  for (const s of SAMPLES) {
    console.log(`  ${s.id} [${s.docType}] venues=${s.venues.join("|") || "-"} arms=${s.arms.join("|") || "-"}${s.special ? ` special=${s.special}` : ""}`);
  }
  console.log(`账本：${LEDGER_PATH}（上限 ${SESSION_MAX_CALLS}）`);
  console.log(`报告：${REPORT_PATH}${existsSync(REPORT_PATH) ? "（已存在）" : ""}`);
  process.exit(0);
}

// ---- 环境与装配（运行模式） ----
process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER_PATH;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(SESSION_MAX_CALLS);

const appendLog = async (line) => {
  const stamped = `[${nowIso()}] ${line}`;
  console.log(stamped);
  try {
    await mkdir(EVAL_DIR, { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(DRIVER_LOG_PATH, stamped + "\n", "utf8");
  } catch (error) {
    console.error(`[driver-log-degraded] ${String(error?.message ?? error)}`);
  }
};

const atomicWriteJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  renameSync(tmp, path);
};

// dist 动态 import（env 已设）
const dist = (...p) => join(REPO_ROOT, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { checkCitations } = await import(distUrl("citation", "StaticCitationChecker.js"));

const config = loadConfig();
if (config.workflow.globalBudget === undefined) {
  console.error("[fatal] globalBudget 未读到（PAPERTEAM_GLOBAL_BUDGET_LEDGER 未生效）");
  process.exit(1);
}
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.9 eval harness",
});

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

// completeSimple 计数包装（task 全计口径；rubric/profile 摘要都走这里）
let simpleCallCount = 0;
const taskUse = [];
const { createRequire } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// 纯 ESM 包（exports 仅 import 通道）：绝对路径动态 import（createRequire 走不通）
const piPkgUrl = pathToFileURL(
  join(REPO_ROOT, "backend", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
).href;
const { ModelRuntime } = await import(piPkgUrl);
const modelRuntime = await ModelRuntime.create({
  authPath: join(config.pi.agentDir, "auth.json"),
  modelsPath: join(config.pi.agentDir, "models.json"),
});
const runtimeForTarget = {
  getModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
  hasConfiguredAuth: (provider) => modelRuntime.hasConfiguredAuth(provider),
  completeSimple: async (...callArgs) => {
    if (simpleCallCount >= maxModelCalls) {
      throw new Error(`[budget] completeSimple 驱动级上限 ${maxModelCalls} 已到`);
    }
    simpleCallCount += 1;
    const startedAt = Date.now();
    const result = await modelRuntime.completeSimple(...callArgs);
    taskUse.push({ call: simpleCallCount, kind: "completeSimple", durationMs: Date.now() - startedAt });
    await appendLog(`completeSimple #${simpleCallCount}（${Date.now() - startedAt}ms）`);
    return result;
  },
};
const specParsed = (() => {
  const [provider, ...rest] = String(modelSpec).split("/");
  return rest.length > 0 ? { provider, modelId: rest.join("/") } : undefined;
})();
const catalogEntry = specParsed ? runtimeForTarget.getModel(specParsed.provider, specParsed.modelId) : undefined;
const targetSummaryModel =
  catalogEntry !== undefined && catalogEntry !== null && runtimeForTarget.hasConfiguredAuth(specParsed.provider)
    ? { caller: runtimeForTarget, catalogEntry, spec: String(modelSpec) }
    : undefined;
if (targetSummaryModel === undefined) {
  console.error("[fatal] targetSummaryModel 装配失败（模型目录未命中或未配置凭据）");
  process.exit(1);
}

const projects = new ProjectStore({ root: PROJECTS_ROOT });
// stack 装配用 adapter（本 harness 不经 runAgent 走任何 workflow；模型调用只走 completeSimple）
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: () => [],
  roleCustomTools: () => [],
  log: () => {},
});
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
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  ...(targetSummaryModel !== undefined ? { targetSummaryModel } : {}),
  log: () => {},
});
const targets = stack.targets;

// ---- 报告 ----
let report = {
  schema: "m159-eval/v1",
  createdAt: nowIso(),
  updatedAt: null,
  maxModelCalls,
  sessionMaxCalls: SESSION_MAX_CALLS,
  samples: [],
  usage: taskUse,
  budgetStart: budgetLedger.snapshot(),
};
if (existsSync(REPORT_PATH) && resume) {
  report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  if (report.schema !== "m159-eval/v1") {
    console.error("[refuse] 既有报告 schema 不识别");
    process.exit(2);
  }
  report.usage = Array.isArray(report.usage) ? report.usage : [];
  report.usage.push({ invocationStart: nowIso(), note: "resume invocation usage below" });
}
const completedKeys = new Set(report.samples.map((s) => s.key));
const persistReport = async () => {
  report.updatedAt = nowIso();
  atomicWriteJson(REPORT_PATH, report);
};

if (dryRun) {
  console.log("[dry-run] 样本与材料存在性校验（零网络零模型）：");
  let ok = true;
  for (const s of SAMPLES) {
    const dir = join(MATERIALZED_DIR, s.id, "manuscript");
    const present = existsSync(join(dir, "main.tex"));
    console.log(`  ${s.id}: manuscript=${present ? "OK" : "MISSING"}`);
    ok = ok && present;
  }
  for (const v of VENUES) {
    console.log(`  guideline ${v}: ${existsSync(join(GUIDELINE_DIR, `${v}.json`)) ? "OK" : "MISSING"}`);
  }
  const parsedCount = existsSync(CJIG_PARSED_DIR)
    ? (await readdir(CJIG_PARSED_DIR)).filter((f) => f.endsWith(".json")).length
    : 0;
  console.log(`  cjig parsed docs: ${parsedCount}（harness 需要 ≥10 才能建 fulltext profile）`);
  console.log(`  已完成样本键：${completedKeys.size}`);
  process.exit(ok ? 0 : 2);
}

// ---- corpus 项目（每 venue 一次；benchmark+profile 文件复制到各样本项目） ----

async function buildCorpusProject(venue) {
  const projectId = `p-m159-corpus-${venue}`;
  const researchDir = join(PROJECTS_ROOT, projectId, "research");
  const benchmarkPath = join(researchDir, "target-benchmark.json");
  if (!existsSync(benchmarkPath)) {
    if (!existsSync(join(PROJECTS_ROOT, projectId))) {
      await projects.create(`M15.9 ${venue} 语料项目`, { documentType: "survey", researchField: "计算机视觉与多目标跟踪", targetVenue: venue === "cjig" ? "中国图象图形学报" : "计算机工程与应用" });
    }
    const manifest = JSON.parse(await readFile(join(WORK_DIR, "phase-b", "corpus", venue, `${venue}-manifest-v2.json`), "utf8"));
    const papers = [];
    let parsedSaved = 0;
    for (const paper of manifest.papers) {
      const added = await stack.sources.addRecord(projectId, {
        sourceType: "paper",
        origin: "manual_upload",
        sourceRole: "reference",
        metadata: {
          title: paper.titleZh ?? paper.title,
          ...(paper.year !== undefined ? { year: paper.year } : {}),
          venue: venue === "cjig" ? "中国图象图形学报" : "计算机工程与应用",
          ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
        },
      });
      const sourceId = added.source.sourceId;
      // CJIG：附 PDF + 解析产物（缓存直灌，避免重复 docling）
      if (venue === "cjig" && paper.pdfFile !== undefined) {
        const pdfPath = join(CJIG_PDF_DIR, paper.pdfFile);
        if (existsSync(pdfPath)) {
          const content = await readFile(pdfPath);
          const attached = await stack.sources.attachFile(projectId, sourceId, { fileName: paper.pdfFile, content, originalName: paper.pdfFile });
          const parsedPath = join(CJIG_PARSED_DIR, paper.pdfFile.replace(/\.pdf$/, ".json"));
          if (existsSync(parsedPath)) {
            const extraction = JSON.parse(await readFile(parsedPath, "utf8"));
            const counts = { text: 0, table: 0, figure: 0, formula: 0, code: 0, output: 0 };
            for (const block of extraction.blocks ?? []) {
              counts[block.type] = (counts[block.type] ?? 0) + 1;
            }
            const document = {
              schemaVersion: 1,
              sourceId,
              fileName: paper.pdfFile,
              storedFileName: attached.source.fileName ?? paper.pdfFile,
              kind: "paper",
              mimeType: "application/pdf",
              parser: extraction.parser ?? { id: "docling" },
              parseMode: extraction.mode ?? "structured",
              status: extraction.quality === "partial" ? "partial" : "ok",
              ...(extraction.pageCount !== undefined ? { pageCount: extraction.pageCount } : {}),
              blocks: extraction.blocks ?? [],
              counts,
              notes: extraction.notes ?? [],
              contentHash: sha256(content),
            };
            await stack.parsedDocuments.save(projectId, document);
            parsedSaved += 1;
          }
        }
      }
      papers.push({
        sourceId,
        identityKey: added.source.identity ? JSON.stringify(added.source.identity).slice(0, 64) : paper.doi ?? paper.title,
        provenance: { provider: "m159_official_site_corpus", retrievedAt: nowIso(), queryUsed: "-" },
        inclusionReason: `stratified benchmark sample (${venue})`,
        ...(paper.citationCountCrossref !== undefined ? { citationCount: paper.citationCountCrossref } : {}),
        venueRaw: venue === "cjig" ? "中国图象图形学报" : "计算机工程与应用",
        hasFullText: venue === "cjig" && paper.pdfFile !== undefined && existsSync(join(CJIG_PDF_DIR, paper.pdfFile)),
      });
    }
    await targets.benchmark.freeze(projectId, {
      target: {
        documentType: "survey",
        targetProfile: "journal",
        targetVenue: venue === "cjig" ? "中国图象图形学报" : "计算机工程与应用",
        researchField: "计算机视觉与多目标跟踪",
      },
      papers,
    });
    await appendLog(`corpus ${venue} 冻结：papers=${papers.length} parsedSaved=${parsedSaved}`);
  }
  // profile：缺失或陈旧 → 生成（CJIG 一次 bounded 摘要调用；CEA 结构 unavailable → 0 调用）
  const { profile, regenerated } = await targets.profile.ensureCurrent(projectId);
  if (regenerated) {
    await appendLog(`corpus ${venue} profile 生成：n=${profile.n} structure=${profile.dimensions.structure.availability}（method=${profile.dimensions.method.availability}）`);
  }
  return { projectId, researchDir };
}

// ---- 样本项目 ----

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await copyTree(join(src, entry.name), join(dest, entry.name));
    } else {
      await copyFile(join(src, entry.name), join(dest, entry.name));
    }
  }
}

async function setupSampleProject(sample, venue, corpus) {
  const projectId = `p-m159-${sample.id}-${venue}`.replace(/[^a-z0-9-]/g, "-").slice(0, 60);
  if (!existsSync(join(PROJECTS_ROOT, projectId, "project.json"))) {
    await projects.create(`M15.9 ${sample.id} × ${venue}`, {
      documentType: sample.docType,
      researchField: "计算机视觉与多目标跟踪",
      targetVenue: venue === "cjig" ? "中国图象图形学报" : "计算机工程与应用",
    });
  }
  // manuscript
  await copyTree(join(MATERIALZED_DIR, sample.id, "manuscript"), join(PROJECTS_ROOT, projectId, "manuscript"));
  // benchmark + profile（同语料同指纹 → freshness 成立）
  const researchDir = join(PROJECTS_ROOT, projectId, "research");
  await mkdir(researchDir, { recursive: true });
  await copyFile(join(corpus.researchDir, "target-benchmark.json"), join(researchDir, "target-benchmark.json"));
  if (existsSync(join(corpus.researchDir, "target-profile.json"))) {
    await copyFile(join(corpus.researchDir, "target-profile.json"), join(researchDir, "target-profile.json"));
  }
  // guideline
  const guideline = JSON.parse(await readFile(join(GUIDELINE_DIR, `${venue}.json`), "utf8"));
  await targets.guideline.import_(projectId, guideline);
  return projectId;
}

// ---- 主循环 ----

const corpora = {};
for (const venue of VENUES) {
  corpora[venue] = await buildCorpusProject(venue);
}

for (const sample of SAMPLES) {
  if (onlySample !== undefined && sample.id !== onlySample) continue;

  // 特殊腿：F7 零模型 citation 检查
  if (sample.special === "citation-check") {
    const key = `${sample.id}#static-citation`;
    if (!completedKeys.has(key)) {
      const dir = join(MATERIALZED_DIR, sample.id, "manuscript");
      const bibText = await readFile(join(dir, "references.bib"), "utf8");
      const texFiles = [{ file: "main.tex", content: await readFile(join(dir, "main.tex"), "utf8") }];
      for (const f of await readdir(join(dir, "sections"))) {
        texFiles.push({ file: `sections/${f}`, content: await readFile(join(dir, "sections", f), "utf8") });
      }
      const result = checkCitations(texFiles, bibText);
      report.samples.push({
        key,
        sampleId: sample.id,
        arm: "A0-citation-static",
        status: "COMPLETED",
        missingKeys: result.missingKeys,
        expectation: "missing >= 1（F7 oracle）",
        detected: result.missingKeys.length >= 1,
        at: nowIso(),
      });
      completedKeys.add(key);
      await persistReport();
      await appendLog(`F7 静态引用检查：missing=${result.missingKeys.length} → ${result.missingKeys.slice(0, 3).join(",")}`);
    }
    continue;
  }

  for (const venue of sample.venues) {
    // 指南确定性符合度（每 sample×venue）
    const gkey = `${sample.id}#${venue}#guideline`;
    if (!completedKeys.has(gkey)) {
      const projectId = await setupSampleProject(sample, venue, corpora[venue]);
      const compliance = await targets.guideline.evaluate(projectId, { manuscriptRevision: 1 });
      report.samples.push({
        key: gkey,
        sampleId: sample.id,
        venue,
        arm: "A2-guideline",
        status: "COMPLETED",
        topStatus: compliance.summary.topStatus,
        hardViolations: compliance.summary.hardViolations,
        violations: compliance.checks.filter((c) => c.status === "VIOLATION").map((c) => ({ id: c.requirementId, observed: c.observed })),
        notEvaluated: compliance.summary.notEvaluatedCount,
        projectId,
        at: nowIso(),
      });
      completedKeys.add(gkey);
      await persistReport();
      await appendLog(`${sample.id} × ${venue} guideline：${compliance.summary.topStatus}（hardViolations=${compliance.summary.hardViolations}）`);
    }

    // A1 readiness（确定性）
    if (sample.arms.includes("readiness")) {
      const rkey = `${sample.id}#${venue}#readiness`;
      if (!completedKeys.has(rkey)) {
        const projectId = report.samples.find((s) => s.key === gkey)?.projectId;
        const readiness = await targets.gap.evaluate(projectId, { manuscriptRevision: 1 });
        report.samples.push({
          key: rkey,
          sampleId: sample.id,
          venue,
          arm: "A1-readiness",
          status: "COMPLETED",
          overall: readiness.overall.verdict,
          summary: readiness.overall.summary,
          dimensions: readiness.dimensions.map((d) => ({ dimension: d.dimension, verdict: d.verdict })),
          at: nowIso(),
        });
        completedKeys.add(rkey);
        await persistReport();
        await appendLog(`${sample.id} × ${venue} readiness：${readiness.overall.verdict}`);
      }
    }

    // A2/A3 rubric（模型）
    for (const arm of sample.arms.filter((a) => a.startsWith("rubric"))) {
      const rkey = `${sample.id}#${venue}#${arm}`;
      if (completedKeys.has(rkey)) continue;
      if (simpleCallCount >= maxModelCalls) {
        await appendLog(`[budget-stop] ${rkey} 跳过（completeSimple ${simpleCallCount}/${maxModelCalls}）`);
        continue;
      }
      const projectId = report.samples.find((s) => s.key === gkey)?.projectId;
      const guideline = await targets.guideline.getRequired(projectId);
      const rubric = await targets.rubric.evaluate(projectId, guideline, {
        manuscriptRevision: 1,
        ...(arm === "rubricA3" ? { omitBenchmarkBands: true } : {}),
      });
      report.samples.push({
        key: rkey,
        sampleId: sample.id,
        venue,
        arm: arm === "rubricA3" ? "A3-rubric-no-bands" : "A2-rubric",
        status: "COMPLETED",
        overall: rubric.overall.verdict,
        rationale: rubric.overall.rationale,
        scope: { inScope: rubric.scopeRelevance.inScope, columnMatch: rubric.scopeRelevance.columnMatch ?? null },
        dimensions: rubric.dimensions.map((d) => ({ dimension: d.dimension, verdict: d.verdict, needsExpertReview: d.needsExpertReview })),
        summaryFailure: rubric.summaryFailure ?? null,
        model: rubric.model ?? null,
        at: nowIso(),
      });
      completedKeys.add(rkey);
      await persistReport();
      await appendLog(`${sample.id} × ${venue} ${arm}：${rubric.overall.verdict} scope=${String(rubric.scopeRelevance.inScope)}`);
    }
  }
}

report.budgetEnd = budgetLedger.snapshot();
report.simpleCallCount = simpleCallCount;
await persistReport();
await appendLog(`完成：samples=${report.samples.length} completeSimple=${simpleCallCount} ledger=${JSON.stringify(budgetLedger.snapshot())}`);
console.log(`[done] ${REPORT_PATH}`);
