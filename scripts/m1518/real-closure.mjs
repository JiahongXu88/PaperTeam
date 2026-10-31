#!/usr/bin/env node
/**
 * M15.18 Phase D — 真实模型 × 真实论文 × 真实 HTTP 的审计改写闭环驱动（不注入 / 不绕过服务）。
 *
 * 子命令（按序执行；状态写 <OUT>/state.json，可断点续跑）：
 *   prepare   S1 新项目导入（goal=improvement）→ 冻结 CJIG 指南 → run 暂停 hitl.research_plan
 *             → 修订前稿件快照 → 证据审计（真实模型）→ 计划（零模型）
 *   reaudit   协议 §6：首轮审计无合格 REWRITE 项时重审计 1 次 + 重新生成计划
 *   execute   （作者决策由 ui-decide.mjs 浏览器真实点击完成之后）恢复 run → 完成
 *             → 证据收集（指令 / patch 工件 / 修订 / diff / 事实与引用集合）→ 复评 ×2（幂等）
 *   negatives N1 case-R PDF-only 零伪改动 + stale 409（换稿 / 重审计）+ decide 幂等
 *
 * 模型调用计数：各项目 research/model-ledger.json calls 合计（审计 API 调用另由 telemetry 记账，
 * 若账本未覆盖则相加）；超过 100 立即停止（协议 §2）。
 *
 * 用法：node scripts/m1518/real-closure.mjs <cmd> [--base http://127.0.0.1:3118]
 *        [--root D:\PaperTeamData\M15\M15_18] [--stack <projectsRoot>]
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const CMD = process.argv[2];
const BASE = arg("base", "http://127.0.0.1:3118").replace(/\/$/, "");
const ROOT = arg("root", "D:\\PaperTeamData\\M15\\M15_18");
const STACK = arg("stack", join(ROOT, "e2e-stack"));
const OUT = join(ROOT, "e2e");
const SAMPLE_S1 = arg("sample", "D:\\PaperTeamData\\M15\\M15_17\\e2e\\mot-tbd-survey-2609.08265.pdf");
const SAMPLE_LABEL = arg("label", "S1");
const SAMPLE_SOURCE = arg("source", "arXiv:2609.08265");
const CASE_R = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples\\case-R.pdf";
const B1 = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples\\b1-original.pdf";
const CJIG = "D:\\PaperTeamData\\M15\\M15_9\\phase-c\\guideline-artifacts\\cjig.json";
const MODEL_CALL_BUDGET = 100;
const RUN_TIMEOUT_MS = 120 * 60 * 1000;

const log = (...parts) => console.log(`[m1518:${CMD}]`, ...parts);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const statePath = join(OUT, "state.json");
const loadState = async () => (existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : { steps: [], audits: [] });
const saveState = async (state) => { await mkdir(OUT, { recursive: true }); await writeFile(statePath, JSON.stringify(state, null, 1), "utf8"); };
const assert = (condition, message) => { if (!condition) throw new Error(`断言失败：${message}`); };

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

async function upload(path, pdfPath, extra) {
  const content = await readFile(pdfPath);
  return api("POST", path, { fileName: pdfPath.split(/[\\/]/).pop(), contentBase64: content.toString("base64"), ...extra });
}

/** 物理模型调用总账：账本 calls 合计 + 账本未覆盖的审计 telemetry */
async function modelCallTotal(state) {
  let ledgerCalls = 0;
  const perProject = {};
  if (existsSync(STACK)) {
    for (const entry of await readdir(STACK)) {
      const ledger = join(STACK, entry, "research", "model-ledger.json");
      if (!existsSync(ledger)) continue;
      const parsed = JSON.parse(await readFile(ledger, "utf8"));
      const calls = Object.values(parsed.entries ?? {}).reduce((sum, item) => sum + (item.calls ?? 0), 0);
      perProject[entry] = calls;
      ledgerCalls += calls;
    }
  }
  const auditCalls = (state.audits ?? []).reduce((sum, audit) => sum + (audit.modelCalls ?? 0), 0);
  // 审计调用经 API 直连（无 run trace scope）——账本是否记账由 state.auditInLedger 记录（首轮核定）
  const total = ledgerCalls + (state.auditInLedger === true ? 0 : auditCalls) + (state.extraCalls ?? 0);
  return { total, ledgerCalls, auditCalls, perProject, extraCalls: state.extraCalls ?? 0 };
}

async function checkBudget(state, label) {
  const usage = await modelCallTotal(state);
  state.modelCalls = usage;
  log(`模型调用账（${label}）：${usage.total}/${MODEL_CALL_BUDGET}（ledger ${usage.ledgerCalls}，audit ${usage.auditCalls}）`);
  if (usage.total > MODEL_CALL_BUDGET) {
    await saveState(state);
    throw new Error(`模型调用预算耗尽（${usage.total} > ${MODEL_CALL_BUDGET}）——按协议停止模型实验`);
  }
}

function step(state, name, data) {
  state.steps.push({ name, at: new Date().toISOString(), ...data });
  log(name, JSON.stringify(data).slice(0, 600));
}

async function pollRun(runId, { targetStage, untilStatuses = ["completed"], autoDecisions = {}, timeoutMs = RUN_TIMEOUT_MS, onDecision }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body.run;
    if (run.status === "failed") return run;
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (targetStage !== undefined && stageId === targetStage) return run;
      const decision = autoDecisions[stageId];
      if (decision === undefined) return run; // 未预期待办：交还调用方如实记录
      onDecision?.(stageId, decision, run.awaiting);
      await api("POST", `/api/runs/${runId}/resume`, { decision });
      continue;
    }
    if (untilStatuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run 超时（${run.status} @ ${run.currentStage}）`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function auditOnce(state, projectId, label) {
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await api("POST", `/api/projects/${projectId}/target/evidence-audit`);
    if (response.status === 200) {
      const meta = response.body.audit.meta;
      const artifact = response.body.audit.artifact;
      state.audits.push({ label, projectId, modelCalls: meta?.telemetry?.calls ?? 0, totalMs: meta?.telemetry?.totalMs ?? Date.now() - started, attempt });
      return artifact;
    }
    // 失败的审计也可能消耗了调用：保守记 3（telemetry 不可得）并如实登记
    state.audits.push({ label: `${label}-failed-attempt${attempt}`, projectId, modelCalls: 3, failed: true, status: response.status, error: JSON.stringify(response.body).slice(0, 300) });
    if (attempt === 2) throw new Error(`审计失败 ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new Error("unreachable");
}

async function snapshotManuscript(projectId, label) {
  const source = join(STACK, projectId, "manuscript");
  const target = join(OUT, `${projectId}-manuscript-${label}`);
  await cp(source, target, { recursive: true });
  const files = {};
  for (const entry of await readdir(join(source, "sections")).catch(() => [])) {
    files[`sections/${entry}`] = sha256(await readFile(join(source, "sections", entry), "utf8"));
  }
  return { dir: target, files };
}

function planSummary(plan) {
  return {
    planId: plan.planId,
    boundRevision: plan.source.manuscriptRevisionAtPlan,
    fingerprint: plan.source.inputFingerprint,
    summary: plan.summary,
    items: plan.items.map((item) => ({
      itemId: item.itemId,
      contributionId: item.contributionId,
      gap: item.gap,
      sourceActionType: item.sourceActionType,
      classification: item.classification,
      classificationReason: item.classificationReason,
      file: item.anchor.projection.file ?? null,
      dispatchSection: item.anchor.dispatchSection ?? null,
      texAnchor: item.anchor.texAnchor ?? null,
      claimQuote: item.anchor.claimQuote,
    })),
  };
}

const NUMBER_RE = /(?<![A-Za-z_\\])\d+(?:\.\d+)?%?/g;
const citeKeys = (tex) => [...tex.matchAll(/\\cite[a-zA-Z]*\{([^}]*)\}/g)].flatMap((match) => match[1].split(",").map((key) => key.trim())).filter(Boolean).sort();
const numbers = (tex) => [...tex.replace(/\\(?:label|ref|eqref|cite[a-zA-Z]*)\{[^}]*\}/g, "").matchAll(NUMBER_RE)].map((match) => match[0]).sort();

// ---------------------------------------------------------------------------

const state = await loadState();
const cjig = JSON.parse(await readFile(CJIG, "utf8"));

if (CMD === "prepare") {
  const imported = await upload("/api/projects/import-paper", SAMPLE_S1, {
    format: "pdf",
    title: `M15.18 ${SAMPLE_LABEL} ${SAMPLE_SOURCE}（CJIG·改进·测试项目）`,
    researchField: "multiple object tracking",
    documentType: "survey",
    targetVenue: "中国图象图形学报",
    workflowKind: "existing_paper_improvement",
  });
  assert(imported.status === 201, `import S1 失败 ${imported.status}`);
  if (state.s1 !== undefined) state.previousSamples = [...(state.previousSamples ?? []), state.s1];
  state.s1 = { label: SAMPLE_LABEL, source: SAMPLE_SOURCE, projectId: imported.body.project.id, sample: SAMPLE_S1, sampleSha256: sha256(await readFile(SAMPLE_S1)) };
  step(state, `D1 import ${SAMPLE_LABEL}`, { projectId: state.s1.projectId, sampleSha256: state.s1.sampleSha256, source: SAMPLE_SOURCE });
  const guideline = await api("PUT", `/api/projects/${state.s1.projectId}/target/guideline`, { guideline: cjig });
  assert(guideline.status === 200, "PUT guideline 失败");
  const created = await api("POST", `/api/projects/${state.s1.projectId}/workflows`, {});
  assert(created.status === 202, `create run 失败 ${created.status}`);
  state.s1.runId = created.body.runId;
  await saveState(state);
  log("D2 run 启动 → 等待 hitl.research_plan（真实模型：review.run 等）…");
  const t0 = Date.now();
  const paused = await pollRun(state.s1.runId, { targetStage: "hitl.research_plan" });
  assert(paused.status === "awaiting_input" && paused.awaiting?.stageId === "hitl.research_plan", `run 未暂停在 research_plan：${paused.status} ${paused.awaiting?.stageId ?? ""} ${paused.error?.code ?? ""} ${paused.error?.message ?? ""}`);
  const revisions = (await api("GET", `/api/projects/${state.s1.projectId}/revisions`)).body.revisions ?? [];
  state.s1.revisionAtPause = revisions.length;
  state.s1.before = await snapshotManuscript(state.s1.projectId, "before");
  step(state, "D2 run 暂停 research_plan", { runId: state.s1.runId, durationMs: Date.now() - t0, revisionAtPause: state.s1.revisionAtPause, sectionFiles: Object.keys(state.s1.before.files).length });
  await checkBudget(state, "pause");
  log("D3 证据审计（真实模型）…");
  const ledgerBefore = (await modelCallTotal({ audits: [] })).ledgerCalls;
  const artifact = await auditOnce(state, state.s1.projectId, `${SAMPLE_LABEL}-audit-1`);
  const ledgerAfter = (await modelCallTotal({ audits: [] })).ledgerCalls;
  state.auditInLedger = ledgerAfter > ledgerBefore;
  step(state, "D3 S1 证据审计", {
    modelCalls: state.audits.at(-1).modelCalls, totalMs: state.audits.at(-1).totalMs, auditInLedger: state.auditInLedger,
    inputFingerprint: artifact.inputFingerprint, gapPlan: artifact.gapPlan.map((gap) => ({ id: gap.contributionId, actionType: gap.actionType, gap: gap.gap })),
    guards: artifact.guards, poolSize: artifact.priorWork.poolSize,
  });
  await checkBudget(state, "audit-1");
  const plan = await api("POST", `/api/projects/${state.s1.projectId}/target/evidence-audit/revision-plan`);
  assert(plan.status === 200, `计划失败 ${plan.status} ${JSON.stringify(plan.body).slice(0, 200)}`);
  state.s1.plan = planSummary(plan.body.plan.plan);
  step(state, "D4 S1 计划（零模型）", state.s1.plan);
  state.s1.rewriteEligible = state.s1.plan.items.filter((item) => item.classification === "REWRITE_ELIGIBLE").length;
  await saveState(state);
  log(`可改写项 ${state.s1.rewriteEligible}/${state.s1.plan.items.length}；下一步：ui-decide.mjs（浏览器真实点击）`);
} else if (CMD === "reaudit") {
  const projectId = state.s1.projectId;
  const artifact = await auditOnce(state, projectId, `${state.s1.label ?? "S1"}-audit-2`);
  step(state, "D3b S1 重审计（协议 §6）", { modelCalls: state.audits.at(-1).modelCalls, gapPlan: artifact.gapPlan.map((gap) => ({ id: gap.contributionId, actionType: gap.actionType, gap: gap.gap })) });
  await checkBudget(state, "audit-2");
  const plan = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
  assert(plan.status === 200, `重计划失败 ${plan.status} ${JSON.stringify(plan.body).slice(0, 200)}`);
  state.s1.plan = planSummary(plan.body.plan.plan);
  state.s1.rewriteEligible = state.s1.plan.items.filter((item) => item.classification === "REWRITE_ELIGIBLE").length;
  step(state, "D4b S1 重计划", state.s1.plan);
  await saveState(state);
} else if (CMD === "execute" || CMD === "collect") {
  const { projectId, runId } = state.s1;
  const decided = (await api("GET", `/api/projects/${projectId}/target/evidence-audit/revision-plan`)).body.plan;
  assert(decided?.plan?.status === "decided", `计划未全部决策（${decided?.plan?.status}）——先完成 ui-decide`);
  if (CMD === "execute") {
  state.s1.decisions = decided.plan.items.map((item) => ({ itemId: item.itemId, classification: item.classification, decision: item.authorDecision?.decision ?? null, decidedAt: item.authorDecision?.decidedAt ?? null, instructionId: item.instructionId ?? null }));
  step(state, "D6 决策核对（UI 点击产生）", { decisions: state.s1.decisions });
  const hitlDecisions = [];
  await api("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  log("D7 恢复 run（真实模型；可能 30–90 分钟）…");
  const t0 = Date.now();
  const finished = await pollRun(runId, {
    untilStatuses: ["completed"],
    autoDecisions: {
      "hitl.evidence_supply": "continue",
      "hitl.plan_confirm": "approve",
      "hitl.revision_validation": "approve",
      "hitl.style_polish": "skip",
    },
    onDecision: (stageId, decision) => hitlDecisions.push({ stageId, decision, at: new Date().toISOString(), note: "测试项目代理决策（M15.18 验收）" }),
  });
  step(state, "D7 run 结束态", { status: finished.status, awaiting: finished.awaiting?.stageId ?? null, error: finished.error ?? null, durationMs: Date.now() - t0, completedStages: finished.completedStages, hitlDecisions });
  await saveState(state);
  }
  await checkBudget(state, "run");
  // ---- 证据收集（零模型；/events 是 SSE 流——改为复制落盘的 events.jsonl）----
  await cp(join(STACK, projectId, "workflow", "runs", runId, "events.jsonl"), join(OUT, `${runId}-events.jsonl`));
  const instructions = (await api("GET", `/api/projects/${projectId}/external-instructions`)).body.instructions;
  await writeFile(join(OUT, `${projectId}-instructions.json`), JSON.stringify(instructions, null, 1), "utf8");
  const revisions = (await api("GET", `/api/projects/${projectId}/revisions`)).body.revisions ?? [];
  state.s1.after = await snapshotManuscript(projectId, "after");
  const reviewsDir = join(STACK, projectId, "reviews");
  const patchArtifacts = {};
  for (const entry of (await readdir(reviewsDir)).filter((name) => name.startsWith("patch-validation-rev-"))) {
    patchArtifacts[entry] = JSON.parse(await readFile(join(reviewsDir, entry), "utf8"));
  }
  await writeFile(join(OUT, `${projectId}-patch-validation.json`), JSON.stringify(patchArtifacts, null, 1), "utf8");
  const plan = decided.plan;
  const lineage = [];
  for (const item of plan.items.filter((entry) => entry.instructionId !== undefined)) {
    const instruction = instructions.find((entry) => entry.instructionId === item.instructionId);
    const file = item.anchor.projection.file;
    const beforeText = file !== undefined && existsSync(join(state.s1.before.dir, file)) ? await readFile(join(state.s1.before.dir, file), "utf8") : null;
    const afterText = file !== undefined && existsSync(join(state.s1.after.dir, file)) ? await readFile(join(state.s1.after.dir, file), "utf8") : null;
    let diff = null;
    if (beforeText !== null && afterText !== null && beforeText !== afterText) {
      try {
        execFileSync("git", ["diff", "--no-index", "--word-diff=plain", "-U1", join(state.s1.before.dir, file), join(state.s1.after.dir, file)], { encoding: "utf8" });
      } catch (error) { diff = String(error.stdout ?? "").slice(0, 20_000); }
    }
    const patches = Object.entries(patchArtifacts).flatMap(([name, artifact]) => [...(artifact.records ?? []), ...(artifact.attemptHistory ?? [])]
      .filter((record) => record.commentIds?.includes(item.instructionId))
      .map((record) => ({ artifact: name, patchId: record.patchId, file: record.file, logicalTarget: record.logicalTarget, planItemIds: record.planItemIds, overall: record.overall, finalStatus: record.finalStatus ?? null, failedStage: record.failedStage ?? null, scope: record.scope, fact: record.fact, citation: record.citation, beforeFileHash: record.beforeFileHash, afterFileHash: record.afterFileHash })));
    lineage.push({
      itemId: item.itemId, classification: item.classification, externalInstructionId: item.instructionId,
      instructionStatus: instruction?.status ?? null, statusNote: instruction?.statusNote ?? null,
      origin: instruction?.origin ?? null, planItemOutcomes: instruction?.planItemOutcomes ?? [],
      targetFile: file ?? null, targetExactQuote: item.anchor.texAnchor ?? null,
      fileShaBefore: beforeText !== null ? sha256(beforeText) : null, fileShaAfter: afterText !== null ? sha256(afterText) : null,
      citeKeysPreserved: beforeText !== null && afterText !== null ? JSON.stringify(citeKeys(beforeText)) === JSON.stringify(citeKeys(afterText)) : null,
      numbersPreserved: beforeText !== null && afterText !== null ? JSON.stringify(numbers(beforeText)) === JSON.stringify(numbers(afterText)) : null,
      anchorStillPresent: afterText !== null && item.anchor.texAnchor !== undefined ? afterText.includes(item.anchor.texAnchor) : null,
      patches, diff,
    });
  }
  const reassess1 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
  assert(reassess1.status === 200, `reassess 失败 ${reassess1.status}`);
  const reassess2 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
  const stable = JSON.stringify(reassess1.body.report.items.map((i) => i.closure)) === JSON.stringify(reassess2.body.report.items.map((i) => i.closure));
  await writeFile(join(OUT, `${projectId}-reassess.json`), JSON.stringify(reassess1.body.report, null, 1), "utf8");
  await writeFile(join(OUT, `${projectId}-lineage.json`), JSON.stringify(lineage, null, 1), "utf8");
  step(state, "D8 证据收集 + 复评", {
    revisionsBefore: state.s1.revisionAtPause, revisionsAfter: revisions.length,
    revisionReasons: revisions.slice(state.s1.revisionAtPause).map((revision) => ({ revision: revision.revision, reason: revision.reason })),
    summary: reassess1.body.report.summary, reassessStable: stable,
    items: reassess1.body.report.items.map((item) => ({ itemId: item.itemId, closure: item.closure, checks: item.checks ?? null, basis: item.basis.slice(0, 240) })),
    lineage: lineage.map((entry) => ({ itemId: entry.itemId, status: entry.instructionStatus, outcomes: entry.planItemOutcomes.map((o) => `${o.planItemId}:${o.outcome}`), patches: entry.patches.map((p) => `${p.patchId}:${p.overall}/${p.finalStatus ?? "?"}${p.failedStage ? `@${p.failedStage}` : ""}`), changed: entry.fileShaBefore !== entry.fileShaAfter, citeKeysPreserved: entry.citeKeysPreserved, numbersPreserved: entry.numbersPreserved })),
  });
  await saveState(state);
} else if (CMD === "negatives") {
  // N1 case-R PDF-only：只读 → 可改写项不得 REWRITE_ELIGIBLE；全批准 → 零修改
  const caseR = await upload("/api/projects/import-paper", CASE_R, {
    format: "pdf", title: "M15.18 N1 case-R（CJIG·只读·测试项目）", researchField: "scene text detection",
    documentType: "journal_article", targetVenue: "中国图象图形学报", workflowKind: "existing_paper_review",
  });
  assert(caseR.status === 201, "import case-R 失败");
  const projectId = caseR.body.project.id;
  state.n1 = { projectId };
  await api("PUT", `/api/projects/${projectId}/target/guideline`, { guideline: cjig });
  const before = await snapshotManuscript(projectId, "before").catch(() => null);
  const artifact = await auditOnce(state, projectId, "N1-audit");
  await checkBudget(state, "n1-audit");
  const plan = (await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`)).body.plan.plan;
  const items = plan.items.map((item) => ({ itemId: item.itemId, sourceActionType: item.sourceActionType, classification: item.classification }));
  const rewriteOnReadOnly = items.filter((item) => item.classification === "REWRITE_ELIGIBLE");
  const decide1 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, { decisions: plan.items.map((item) => ({ itemId: item.itemId, decision: "approve" })) });
  const decide2 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, { decisions: plan.items.map((item) => ({ itemId: item.itemId, decision: "approve" })) });
  const reassess = (await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`)).body.report;
  const after = await snapshotManuscript(projectId, "after").catch(() => null);
  step(state, "N1 case-R PDF-only 零伪改动", {
    projectId, gapPlan: artifact.gapPlan.map((gap) => gap.actionType), items, rewriteOnReadOnly: rewriteOnReadOnly.length,
    instructions: decide1.body.plan.instructions.length, idempotentInstructions: decide2.body.plan.instructions.length,
    closure: reassess.summary, manuscriptUnchanged: before === null || after === null ? "no-editable-manuscript" : JSON.stringify(before.files) === JSON.stringify(after.files),
  });
  // stale：换稿 → 计划生成 / 决策 409（C1 补跑）
  const stalePlanView = (await api("GET", `/api/projects/${projectId}/target/evidence-audit/revision-plan`)).body.plan.plan;
  const replaced = await upload(`/api/projects/${projectId}/paper/pdf`, B1, {});
  const auditView = (await api("GET", `/api/projects/${projectId}/target/evidence-audit`)).body.audit;
  const regen = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
  const staleDecide = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, { decisions: [{ itemId: stalePlanView.items[0].itemId, decision: "reject" }] });
  step(state, "C1 stale（换稿）", { replaceStatus: replaced.status, auditStale: auditView?.stale ?? null, regenStatus: regen.status, regenCode: regen.body.error?.code ?? null, decideStatus: staleDecide.status, decideCode: staleDecide.body.error?.code ?? null });
  await saveState(state);
} else {
  console.error("用法：real-closure.mjs prepare|reaudit|execute|negatives");
  process.exit(2);
}
