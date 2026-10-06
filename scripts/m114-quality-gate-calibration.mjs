#!/usr/bin/env node
/**
 * M11.4 Quality Gate Calibration（2026-10-06/07）— 一次性校准实验。
 *
 * 目的：对三个锚点（pre-revision baseline / Attempt 7 candidate rev-3 /
 * human final）在**完全相同**的 Reviewer prompt / model / rubric / pipeline
 * 下做 blinded 独立采样，回答：
 *   1. academicScore 的组内方差（reviewer noise）
 *   2. 三锚点是否可区分（尤其 candidate vs human final）
 *   3. 80 阈值在任何真实锚点上是否可达
 *
 * 臂：
 *   CAL — 现行管线口径（buildManuscriptDigest 原样，含其全部缺陷），
 *         3 锚点 × 3 样本（每样本独立项目副本 = 独立会话，零历史泄漏）
 *   VIS — 全文可见口径（digest = 完整正文，无 18 块 / 2600 字符截断），
 *         baseline × 1 + human_final × 1（量化截断 artifact 对评分的贡献）
 *   PAIRWISE — candidate vs human final 盲评（甲/乙），仅校准研究用
 *
 * 隔离与纪律：
 *   - 源项目 D:\Projects\PaperTeam\backend\projects\p-d12dc28ad850 只读；
 *     副本写到 D:\PaperTeamData\M11_4_QualityGateCalibration\projects
 *   - human final（manuscript/source/paper.tex）只在 Attempt 2 candidate
 *     freeze（2026-10-04T23:13:35Z）已解除 hold 的评估语境读取；不回灌
 *     任何生成链；Attempt 7 run 已终态，无污染对象
 *   - 不跑 Writer / Planner / workflow；不进入正式 Acceptance
 *
 * 用法：node scripts/m114-quality-gate-calibration.mjs [--cal] [--vis] [--pairwise]
 * （默认全跑；已完成的样本按 report 断点跳过）
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const WORK_DIR = "D:\\PaperTeamData\\M11_4_QualityGateCalibration";
const SOURCE_PROJECT_ROOT = join(repoRoot, "backend", "projects");
const SOURCE_PROJECT = "p-d12dc28ad850"; // Attempt 7 clean run（rev-3 candidate 为其 manuscript/main.tex）
const CASE_ROOT = "D:\\PaperTeamData\\M10.3-real-paper-case";

const ANCHORS = {
  baseline: join(CASE_ROOT, "manuscript", "historical", "paper_before_revision.tex"),
  candidate: null, // 源项目 manuscript/main.tex 原样（rev-3）
  "human-final": join(CASE_ROOT, "manuscript", "source", "paper.tex"),
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry");
const runCal = !dryRun && (args.size === 0 || args.has("--cal"));
const runVis = !dryRun && (args.size === 0 || args.has("--vis"));
const runPairwise = !dryRun && (args.size === 0 || args.has("--pairwise"));
const dryPrep = dryRun;

process.env["PROJECTS_ROOT"] = join(WORK_DIR, "projects");
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";

const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logLines.push(line);
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
const { extractJsonObject } = await import(distUrl("agents", "outputParsing.js"));

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
log(`model = ${JSON.stringify({ provider: modelSpec.provider, model: modelSpec.model, baseUrl: modelSpec.baseUrl !== undefined })}（apiChannel 仅 general_api 落盘；缺省 = Coding Plan）`);

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
const reportPath = join(WORK_DIR, "calibration-report.json");
let report = { schemaVersion: 1, startedAt: new Date().toISOString(), samples: [], pairwise: null, notes: [] };
try {
  report = { ...report, ...JSON.parse(await readFile(reportPath, "utf8")) };
  log(`resume：已有 ${report.samples.length} 个样本记录`);
} catch { /* fresh */ }
const doneKeys = new Set(report.samples.map((s) => s.key));

// ---- 副本准备（选择性复制：跳过 build/ 与 workflow/，保留 manuscript/evidence/
//      sources/reviews 等 review 输入；源项目只读） ----
const skipDirs = new Set(["build", "workflow"]);
async function makeCopy(copyId, anchorFile) {
  const dest = join(projectsRoot, copyId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, "manuscript"), { recursive: true });
  for (const entry of await readFileEntries(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT))) {
    if (skipDirs.has(entry)) continue;
    await cp(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, entry), join(dest, entry), { recursive: true });
  }
  const anchorPath = anchorFile ?? join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, "manuscript", "main.tex");
  const anchorContent = await readFile(anchorPath, "utf8");
  await writeFile(join(dest, "manuscript", "main.tex"), anchorContent, "utf8");
  return anchorContent;
}
async function readFileEntries(dir) {
  return (await readdir(dir, { withFileTypes: true })).map((e) => e.name);
}

// ---- 共享输入构建（每锚点从其副本 1 构建，同锚点内全部样本共用） ----
async function sharedInputs(pid) {
  const digest = await buildManuscriptDigest(stack.workflowServices, pid);
  const evidenceSelection = await stack.evidenceSelection.selectForWriting(pid);
  const citationReport = await stack.citation.latestReport(pid);
  const citationDigest = citationReport
    ? `cited=${citationReport.summary.citedCount} missing=${citationReport.summary.missingKeys} hallucinated=${citationReport.summary.hallucinated} mismatched=${citationReport.summary.mismatched}`
    : undefined;
  return { digest, evidence: evidenceSelection.formal, citationDigest };
}

function projectSample(key, pid, digest, inputs) {
  return async () => {
    const startedAt = Date.now();
    const results = await stack.reviewer.reviewAll({
      projectId: pid,
      manuscriptDigest: digest,
      evidence: inputs.evidence,
      ...(inputs.citationDigest ? { citationDigest: inputs.citationDigest } : {}),
    });
    const academic = results.find((r) => r.mode === "academic");
    const fact = results.find((r) => r.mode === "fact");
    const style = results.find((r) => r.mode === "style");
    const countBy = (sev) => results.reduce((s, r) => s + r.issues.filter((i) => i.severity === sev).length, 0);
    return {
      key,
      projectId: pid,
      digestChars: digest.length,
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
  };
}

async function saveReport() {
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(WORK_DIR, "driver-log.txt"), logLines.join("\n"), "utf8");
}

async function runSample(key, anchorFile, digestOverride) {
  if (doneKeys.has(key)) {
    log(`skip ${key}（已完成）`);
    return;
  }
  const copyId = `cal-${key}`;
  const anchorContent = await makeCopy(copyId, anchorFile);
  const inputs = await sharedInputs(copyId);
  const digest = digestOverride ?? inputs.digest;
  if (digestOverride === undefined) {
    log(`${key}: 现行管线 digest = ${digest.length} chars（anchor ${(anchorContent ?? "").length} chars）`);
  } else {
    log(`${key}: 全文可见 digest = ${digest.length} chars`);
  }
  try {
    const sample = await projectSample(key, copyId, digest, inputs)();
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

// ---- VIS digest：完整正文（无 18 块 cap / 无 2600 截断 / 无 60k 总截断） ----
async function fullTextDigest(anchorFile) {
  const content = anchorFile === null
    ? await readFile(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, "manuscript", "main.tex"), "utf8")
    : await readFile(anchorFile, "utf8");
  return `[main.tex（完整正文——系统全量视图）]\n${content}`;
}

// ---- 主流程 ----
if (dryPrep) {
  log("=== DRY：只构建副本 + digest，不调用模型 ===");
  for (const [anchor, file] of Object.entries(ANCHORS)) {
    const copyId = `dry-${anchor}`;
    const content = await makeCopy(copyId, file);
    const inputs = await sharedInputs(copyId);
    const full = await fullTextDigest(file);
    log(
      `${anchor}: anchor=${(content ?? "").length} chars | 现行 digest=${inputs.digest.length} chars (${(100 * inputs.digest.length / (content ?? "").length).toFixed(0)}%) | 全文 digest=${full.length} chars | evidence=${inputs.evidence.length} | citation=${inputs.citationDigest ?? "-"}`,
    );
    const digestEndsWith = inputs.digest.slice(-260).replace(/\n/g, " ");
    log(`  现行 digest 末尾（可见的最后内容）：…${digestEndsWith}`);
  }
  process.exit(0);
}
if (runCal) {
  log("=== CAL 臂：现行管线 digest，3 锚点 × 3 样本 ===");
  for (const [anchor, file] of Object.entries(ANCHORS)) {
    for (let i = 1; i <= 3; i += 1) {
      await runSample(`${anchor}-s${i}`, file, undefined);
    }
  }
}
if (runVis) {
  log("=== VIS 臂：全文可见 digest（baseline / candidate / human_final 各 1） ===");
  await runSample("vis-baseline-full", ANCHORS.baseline, await fullTextDigest(ANCHORS.baseline));
  await runSample("vis-candidate-full", ANCHORS.candidate, await fullTextDigest(ANCHORS.candidate));
  await runSample("vis-human-final-full", ANCHORS["human-final"], await fullTextDigest(ANCHORS["human-final"]));
}
if (runPairwise) {
  log("=== PAIRWISE：candidate(甲) vs human_final(乙) 盲评 ===");
  const key = "pairwise-cand-vs-human";
  if (report.pairwise !== null && report.pairwise !== undefined) {
    log("skip pairwise（已完成）");
  } else {
    const copyId = "cal-pairwise";
    await makeCopy(copyId, null);
    const candidateText = await readFile(join(SOURCE_PROJECT_ROOT, SOURCE_PROJECT, "manuscript", "main.tex"), "utf8");
    const humanText = await readFile(ANCHORS["human-final"], "utf8");
    const instructions = JSON.parse(
      await readFile(join(projectsRoot, copyId, "reviews", "external-instructions.json"), "utf8"),
    );
    const comments = instructions.instructions.map((i) => `- [${i.reviewerLabel}] ${i.text}`).join("\n");
    const prompt = [
      "你是一名论文返修评审专家。两份由不同执行者完成的论文修订稿全文如下（甲 / 乙），",
      "对应同一份返修前基稿与同一条原始外审意见清单。",
      "请逐条意见判断哪一份更好地回应了 reviewer intent，并给出整体判断。",
      "",
      "===== 原始外审意见（5 条）=====",
      comments,
      "",
      "评判维度（每维给 甲 更好 / 乙 更好 / 相当）：",
      "1. reviewer intent 回应完整性（逐条）",
      "2. 事实可靠性（是否引入无依据/与实验数据冲突的表述）",
      "3. 证据充分性（结论是否有数据支撑）",
      "4. 学术表达质量",
      "5. 可投稿准备度（publication readiness）",
      "",
      "只输出一个 JSON 对象（不要 Markdown 围栏）：",
      "{",
      '  "perComment": [{"reviewer": "Editor|R1|R2|R3|R4", "better": "甲|乙|相当", "reason": "…"}, …5 条],',
      '  "overall": {"better": "甲|乙|相当", "intentResponse": "甲|乙|相当", "factReliability": "甲|乙|相当",',
      '    "evidenceSufficiency": "甲|乙|相当", "academicExpression": "甲|乙|相当", "publicationReadiness": "甲|乙|相当",',
      '    "reason": "…"}',
      "}",
      "",
      "===== 甲（修订稿全文）=====",
      candidateText,
      "",
      "===== 乙（修订稿全文）=====",
      humanText,
    ].join("\n");
    try {
      const task = await adapter.runAgent({
        agentId: config.agents.reviewer,
        timeoutMs: 1_800_000,
        task: prompt,
        projectId: copyId,
        contextScope: "review/pairwise-calibration",
        metadata: { role: "reviewer", skill: "pairwise" },
      });
      if (task.status !== "completed") {
        throw new Error(`pairwise task ${task.status}: ${task.error ?? ""}`);
      }
      const parsed = extractJsonObject(task.output ?? "", "Pairwise 结果");
      report.pairwise = { taskId: task.taskId, result: parsed };
      log(`pairwise ✔ overall=${JSON.stringify(parsed.overall ?? parsed)}`);
    } catch (error) {
      log(`pairwise ✘ FAIL：${error instanceof Error ? error.message : String(error)}`);
      report.notes.push(`pairwise failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await saveReport();
  }
}

log(`DONE. 样本 ${report.samples.length} 个，报告：${reportPath}`);
