#!/usr/bin/env node
/**
 * M11.4 Attempt 8 — Quality-Gate-Layered Clean Revalidation Driver（2026-10-07）
 *
 * 与 Attempt 7 驱动相同的链路，但验收对象换为 Option C 分层 gate：
 *   - Revision Task verdict（PASS / FAIL / AUTHOR_DECISION_REQUIRED）
 *   - Publication Readiness 独立输出
 *   - 任务层成功 → REVISION_TASK_COMPLETE + Draft PDF（不进 overflow 追问）
 *
 * 前提（由执行代理在启动本脚本前完成）：
 *   - Git：main / HEAD == origin/main == 2c7854e… / clean；backend dist 已重建
 *   - Backend 已启动（默认 3000），Model Settings = zai-coding-cn/glm-5.3 + coding_plan
 *   - Test Connection PASS；runtime activeRuns = 0
 *   - 资源 preflight PASS（free commit 稳定，运行期低频监控）
 *
 * 本脚本职责（严格按 M11.4 Attempt 8 验收要求）：
 *   1. 服务/模型配置/空闲 preflight
 *   2. Blind isolation preflight（AcceptanceEvaluationReader；held-out 全部
 *      blocked、reviewer comments 5 blocks）——Candidate Freeze 前不读任何
 *      held-out 内容
 *   3. 正确 baseline（manuscript/historical/paper_before_revision.tex，SHA256
 *      423CF0E0…E46D30）构建导入 ZIP（paper.tex + refs.bib + figs/）
 *   4. POST /api/projects/import-paper → 新 Project
 *   5. 上传 3 份 submission-basis 报告 + board_c0_20260904 + fair_ablation
 *      合法数据文件（不伪造扩展名；.log 不上传）
 *   6. 解析预览 + 批量导入 5 条真实 Editor/Reviewer comments（作者回复不入库）
 *   7. POST /workflows（existing_paper_improvement / suggest_only）→ 新 Run
 *   8. HITL 驱动（research_plan approve / evidence_supply continue /
 *      plan_confirm approve / revision_validation 诚实决策 / overflow+stalled
 *      accept_draft / style_polish skip）
 *   9. 终态后把 run/project 工件快照到 workdir 供验收分析（含 completion
 *      summary 全量 JSON，捕获 revisionTaskVerdict / publicationReadiness）
 *
 * 输出目录（不在仓库内）：D:\PaperTeamData\M11_4_ReliabilityClosure\
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";

import { AcceptanceEvaluationReader, HeldOutAccessError } from "../backend/dist/evaluation/heldOutAccess.js";

const API = process.env.M114_API ?? "http://localhost:3000";
const CASE_ROOT = "D:\\PaperTeamData\\M10.3-real-paper-case";
const RUN_TAG = process.env.M114_RUN_TAG ?? "run1";
const WORK_DIR = process.env.M114_WORK_DIR ?? `D:\\PaperTeamData\\M11_4_ReliabilityClosure\\${RUN_TAG}`;
const EXPECTED_BASELINE_SHA = "423CF0E0C66612AD7C801785D60F183367BCFDA5D46C1E32E1610B2F87E46D30";

const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logLines.push(line);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

function assert(condition, label, detail = "") {
  if (!condition) throw new Error(`CHECK FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  log(`✔ ${label}`);
}

// ---------------------------------------------------------------------------
// 0. Workdir（Attempt 8 全新；不读旧 Attempt 7 状态）
// ---------------------------------------------------------------------------
await mkdir(WORK_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Preflight：health / model settings（coding plan）/ idle
// ---------------------------------------------------------------------------
const health = await api("GET", "/health");
assert(health.status === 200 && health.body?.status === "ok", "backend health ok");

const settings = (await api("GET", "/api/settings/model")).body?.settings ?? {};
assert(settings.model === "zai-coding-cn/glm-5.3", `model = zai-coding-cn/glm-5.3（got ${settings.model}）`);
assert(settings.apiChannel === "coding_plan", `apiChannel = coding_plan（got ${settings.apiChannel}）`);
assert(settings.vision?.model === "zai-coding-cn/glm-5.3-flash", `vision model = zai-coding-cn/glm-5.3-flash（got ${settings.vision?.model}）`);

const runtimeStatus = (await api("GET", "/api/runtime/status")).body?.status ?? {};
assert(runtimeStatus.sessions?.activeRuns === 0, "runtime activeRuns = 0");

// ---------------------------------------------------------------------------
// 2. Blind isolation preflight（Candidate Freeze 前）
// ---------------------------------------------------------------------------
const manifest = {
  generationPaths: [
    "manuscript/historical/paper_before_revision.tex",
    "manuscript/source/refs.bib",
    "experiments/reports/submission_basis/rdk_x3_full_pipeline_report.md",
    "experiments/reports/submission_basis/extreme_scene_experiment_report.md",
    "experiments/reports/submission_basis/fair_ablation_new_detector.md",
    "experiments/data/board_c0_20260904",
    "experiments/data/fair_ablation",
  ],
  heldOutPaths: [
    "manuscript/historical/paper_before_final_4fix.tex", // Human Final manuscript
    "manuscript/source/paper.tex",                        // Human Final working copy
    "feedback/response_to_reviewers.md",                  // raw shared file（含作者回复）
    "feedback/revision_change_log.md",
    "feedback/response_QA.md",
    "feedback/final_submission_audit.md",
    "feedback/response_letter_submitted.pdf",
    "feedback/response_submission_system_text.txt",
    "manuscript/paper.pdf",                               // final PDF
    "manuscript/word_submission_cea.pdf",
  ],
  reviewerCommentPaths: ["feedback/response_to_reviewers.md"],
};
const reader = new AcceptanceEvaluationReader(CASE_ROOT, manifest);

const blockedPaths = [
  "manuscript/historical/paper_before_final_4fix.tex",
  "feedback/response_to_reviewers.md",
  "feedback/revision_change_log.md",
  "manuscript/paper.pdf",
];
for (const path of blockedPaths) {
  let blocked = false;
  try { await reader.read(path); } catch (error) { blocked = error instanceof HeldOutAccessError; }
  assert(blocked, `held-out blocked until freeze: ${path}`);
}

const commentBlocks = await reader.readReviewerComments("feedback/response_to_reviewers.md");
assert(commentBlocks.length === 5, `reviewer comment blocks = 5（got ${commentBlocks.length}）`);
const editorCount = commentBlocks.filter((block) => block.heading === "Editor").length;
assert(editorCount === 1, `1 Editor（got ${editorCount}）`);
assert(commentBlocks.filter((block) => block.heading.startsWith("Reviewer")).length === 4, "4 Reviewers");
// 作者回复不进入 blocks：每块只含意见内容（长度有界记录，不落原文）
log(`comments parsed: ${commentBlocks.map((b) => `${b.heading}(${b.content.length} chars)`).join(", ")}`);

// ---------------------------------------------------------------------------
// 3. Baseline SHA + 导入 ZIP（paper.tex = paper_before_revision.tex）
// ---------------------------------------------------------------------------
const baselinePath = join(CASE_ROOT, "manuscript", "historical", "paper_before_revision.tex");
const baselineBytes = await readFile(baselinePath);
const baselineSha = createHash("sha256").update(baselineBytes).digest("hex").toUpperCase();
assert(baselineSha === EXPECTED_BASELINE_SHA, `baseline SHA256 == ${EXPECTED_BASELINE_SHA.slice(0, 12)}…`);

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const figsDir = join(CASE_ROOT, "manuscript", "source", "figs");
const figNames = (await readdir(figsDir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
assert(figNames.length === 10, `10 figure assets（got ${figNames.length}）`);
const latexEntries = [
  { name: "paper.tex", data: baselineBytes },
  { name: "refs.bib", data: await readFile(join(CASE_ROOT, "manuscript", "source", "refs.bib")) },
  ...figNames.map((name) => ({ name: `figs/${name}`, data: null })),
];
for (const entry of latexEntries) {
  if (entry.data === null) entry.data = await readFile(join(figsDir, entry.name.slice("figs/".length)));
}
const latexArchive = buildZip(latexEntries);

// ---------------------------------------------------------------------------
// 4. 新 Project（import-paper latex / improvement）
// ---------------------------------------------------------------------------
let projectId = null;
const imported = await api("POST", "/api/projects/import-paper", {
  format: "latex",
  goal: "improvement",
  archiveBase64: latexArchive.toString("base64"),
});
assert(imported.status === 201 && imported.body?.project?.id, "import-paper 201（新 Project）");
projectId = imported.body.project.id;
const report = imported.body.report ?? {};
assert(report.structure?.entryFile === "paper.tex", `entry = paper.tex（got ${report.structure?.entryFile}）`);
assert(report.baselineCompile?.ok === true, "导入期 baseline xelatex+bibtex PASS");
log(`Project ${projectId}（entries=${report.entryCount}，warnings=${report.warnings?.length ?? 0}）`);
await writeFile(
  join(WORK_DIR, "import-report.json"),
  JSON.stringify({ projectId, report }, null, 2),
);

// ---------------------------------------------------------------------------
// 5. Source ingestion（3 报告 + board_c0 + fair_ablation；合法扩展名）
// ---------------------------------------------------------------------------
const sourcePlan = [
  ["experiments/reports/submission_basis/rdk_x3_full_pipeline_report.md", "RDK_X3_full_pipeline_report.md"],
  ["experiments/reports/submission_basis/extreme_scene_experiment_report.md", "Extreme_Scene_experiment_report.md"],
  ["experiments/reports/submission_basis/fair_ablation_new_detector.md", "Fair_Ablation_new_detector.md"],
];
const boardDir = join(CASE_ROOT, "experiments", "data", "board_c0_20260904");
for (const name of (await readdir(boardDir)).sort()) {
  const info = await stat(join(boardDir, name));
  if (info.isFile() && /\.(json|csv)$/i.test(name)) sourcePlan.push([`experiments/data/board_c0_20260904/${name}`, `board_c0_${name}`]);
}
const fairDir = join(CASE_ROOT, "experiments", "data", "fair_ablation");
for (const name of (await readdir(fairDir)).sort()) {
  const info = await stat(join(fairDir, name));
  if (info.isFile() && /\.(json|csv)$/i.test(name)) sourcePlan.push([`experiments/data/fair_ablation/${name}`, `fair_ablation_${name}`]);
}
assert(sourcePlan.length === 23, `23 合法源文件（got ${sourcePlan.length}）`);

const existingSources = (await api("GET", `/api/projects/${projectId}/sources`)).body?.sources ?? [];
assert(existingSources.length === 0, `新项目源库为空（got ${existingSources.length}）`);
const uploaded = [];
for (const [rel, fileName] of sourcePlan) {
  const content = await readFile(join(CASE_ROOT, ...rel.split("/")));
  const response = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: content.toString("base64"),
    sourceRole: "evidence",
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`source upload failed ${fileName}: ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  uploaded.push({ sourceId: response.body.source?.sourceId, fileName, ingestion: response.body.ingestion?.status ?? "?" });
}
log(`sources uploaded: ${uploaded.length}（全部入库，ingestion 触发）`);
await writeFile(join(WORK_DIR, "sources.json"), JSON.stringify(uploaded, null, 2));

// 等待结构化解析完成（非 PDF 同步完成；ParsedDocument.status = ok/failed）
let structuredCount = 0;
for (let i = 0; i < 30; i += 1) {
  const documents = [];
  for (const item of uploaded) {
    const doc = await api("GET", `/api/projects/${projectId}/sources/${item.sourceId}/document`).catch(() => null);
    const status = doc?.body?.document?.status;
    if (status === "ok" || status === "available" || status === "partial") documents.push(item.sourceId);
  }
  structuredCount = documents.length;
  if (structuredCount === uploaded.length) break;
  await sleep(4000);
}
assert(structuredCount === uploaded.length, `structured documents ${structuredCount}/${uploaded.length}`);

// ---------------------------------------------------------------------------
// 6. Comments：解析预览 + 批量导入（blocks → markdown；无作者回复）
// ---------------------------------------------------------------------------
const commentsMarkdown = commentBlocks.map((block) => `## ${block.heading}\n\n${block.content}`).join("\n\n");
const preview = await api("POST", `/api/projects/${projectId}/external-instructions/parse`, { markdown: commentsMarkdown });
assert(preview.status === 200 && preview.body?.comments?.length === 5, `parse 预览 5 条（got ${preview.body?.comments?.length}）`);
const batch = await api("POST", `/api/projects/${projectId}/external-instructions/batch`, { markdown: commentsMarkdown });
assert(batch.status === 200 || batch.status === 201, "batch 导入成功");
const importedComments = batch.body?.instructions ?? [];
assert(importedComments.length === 5, `导入 5 条意见（got ${importedComments.length}）`);
assert((batch.body?.duplicateIds ?? []).length === 0, "0 duplicated");
const canonicalIds = importedComments.map((item) => ({ id: item.instructionId, source: item.source, label: item.reviewerLabel ?? "" }));
log(`comments imported: ${canonicalIds.map((c) => c.id).join(", ")}`);
await writeFile(join(WORK_DIR, "comment-ids.json"), JSON.stringify(canonicalIds, null, 2));

// ---------------------------------------------------------------------------
// 7. 新 Run（existing_paper_improvement / suggest_only）
// ---------------------------------------------------------------------------
const created = await api("POST", `/api/projects/${projectId}/workflows`, { kind: "existing_paper_improvement", stylePolicy: "suggest_only" });
assert(created.status === 202 && created.body?.runId, "workflow run 创建 202");
const runId = created.body.runId;
const runStartedAt = new Date().toISOString();
log(`Run ${runId} started（project ${projectId}）`);
await writeFile(
  join(WORK_DIR, "driver-state.json"),
  JSON.stringify({ phase: "run-started", projectId, runId, baselineSha, runStartedAt }, null, 2),
);

// ---------------------------------------------------------------------------
// 8. HITL 驱动循环
// ---------------------------------------------------------------------------
async function fetchRun() { return (await api("GET", `/api/runs/${runId}`)).body?.run ?? {}; }

async function resume(decision) {
  const response = await api("POST", `/api/runs/${runId}/resume`, { decision });
  if (response.status !== 200) {
    throw new Error(`resume ${decision} failed: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  log(`HITL decision: ${decision}`);
}

const hitlLog = [];
let lastStage = "";
const deadline = Date.now() + 150 * 60_000; // 总墙钟上限 150 分钟
let run = await fetchRun();
while (run.status === "running" || run.status === "awaiting_input" || run.status === "pending") {
  if (Date.now() > deadline) {
    await writeFile(join(WORK_DIR, "driver-state.json"), JSON.stringify({ phase: "timeout", projectId, runId, lastStage }, null, 2));
    throw new Error(`driver 总超时（当前 stage ${lastStage}）——run 仍在执行，需要人工接管`);
  }
  const stage = run.currentStage ?? "";
  if (stage !== lastStage) { log(`stage → ${stage || run.status}`); lastStage = stage; }
  if (run.status === "awaiting_input") {
    const stageId = run.awaiting?.stageId ?? "";
    const options = run.awaiting?.options ?? [];
    hitlLog.push({ stageId, at: new Date().toISOString() });
    log(`awaiting_input: ${stageId}（options: ${options.join("/")}）`);
    if (stageId === "hitl.research_plan") {
      await resume("approve");
    } else if (stageId === "hitl.evidence_supply") {
      await resume("continue");
    } else if (stageId === "hitl.plan_confirm") {
      const items = run.awaiting?.payload?.items ?? [];
      log(`plan_confirm items=${items.length}（${items.map((i) => `${i.section}:${i.actionType ?? "?"}`).join(" | ").slice(0, 400)}）`);
      await resume("approve");
    } else if (stageId === "hitl.revision_validation") {
      const payload = run.awaiting?.payload ?? {};
      const rejected = (payload.items ?? []).filter((i) => i.status === "rejected").length;
      const blocked = payload.blocked === true;
      log(`revision_validation: rejected=${rejected} blocked=${blocked}`);
      await resume(rejected > 0 || blocked ? "needs_review" : "approve");
    } else if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
      await resume("accept_draft");
    } else if (stageId === "hitl.style_polish") {
      await resume("skip");
    } else {
      // 未知 HITL 节点：诚实停止（不猜决策）
      await writeFile(join(WORK_DIR, "driver-state.json"), JSON.stringify({ phase: "unknown-hitl", projectId, runId, stageId, options }, null, 2));
      throw new Error(`未知 HITL 节点 ${stageId}（options ${options.join("/")}）——停止驱动`);
    }
  }
  await sleep(15000);
  run = await fetchRun();
}

log(`run terminal: ${run.status}（completion=${run.completion?.label ?? "?"}${run.error ? ` error=${run.error.code}:${run.error.message}` : ""}）`);
await writeFile(
  join(WORK_DIR, "driver-state.json"),
  JSON.stringify({ phase: "run-terminal", projectId, runId, status: run.status, completion: run.completion?.label ?? null, hitlLog }, null, 2),
);
// completion summary 全量落盘（revisionTaskVerdict / publicationReadiness 在此）
await writeFile(join(WORK_DIR, "run-completion.json"), JSON.stringify(run, null, 2));

// ---------------------------------------------------------------------------
// 9. 工件快照（workdir；不做 held-out 读取）
// ---------------------------------------------------------------------------
const projectDir = `D:\\Projects\\PaperTeam\\projects\\${projectId}`;
const snapshotRoot = join(WORK_DIR, "artifacts");
await mkdir(snapshotRoot, { recursive: true });

async function copyAbs(absPath, label) {
  try {
    await copyFile(absPath, join(snapshotRoot, label));
    return true;
  } catch { return false; }
}

const runDir = join(projectDir, "workflow", "runs", runId);
for (const name of ["checkpoint.json", "events.jsonl", "run-trace.json", "performance-report.md"]) {
  if (!(await copyAbs(join(runDir, name), name))) log(`(missing) ${name}`);
}
// stage records
try {
  const stageFiles = await readdir(join(runDir, "stages"));
  for (const name of stageFiles) await copyAbs(join(runDir, "stages", name), `stages__${name}`);
} catch { log("(missing) stages/"); }
// key project artifacts
for (const [rel, label] of [
  ["reviews\\external-instructions.json", "reviews__external-instructions.json"],
  ["research\\improvement-plan.json", "research__improvement-plan.json"],
  ["evidence\\evidence.jsonl", "evidence__evidence.jsonl"],
  ["project.json", "project.json"],
]) {
  if (!(await copyAbs(join(projectDir, rel), label))) log(`(missing) ${rel}`);
}
try {
  const reviews = await readdir(join(projectDir, "reviews"));
  for (const name of reviews.filter((n) => /patch-validation|quality-gate|revision-validation/.test(n))) {
    await copyAbs(join(projectDir, "reviews", name), `reviews__${name}`);
  }
} catch { log("(missing) reviews/"); }

await writeFile(join(WORK_DIR, "driver-log.txt"), logLines.join("\n"));
log(`DONE. project=${projectId} run=${runId} status=${run.status}`);
console.log(JSON.stringify({ projectId, runId, status: run.status, completion: run.completion ?? null, workDir: WORK_DIR }, null, 2));
