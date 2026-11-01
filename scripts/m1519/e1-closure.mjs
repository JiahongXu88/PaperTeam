#!/usr/bin/env node
/**
 * M15.19 Phase E — 真实模型 × 真实论文 × 真实 HTTP 的「原子子缺口 → 合法改写 → 复评」闭环驱动（不注入 / 不绕过服务）。
 *
 * 协议：D:\PaperTeamData\M15\M15_19\PROTOCOL.md（冻结）；样本 / oracle：e1-screening/ORACLE.md（导入前冻结）。
 *
 * 子命令（按序；状态写 <ROOT>/e1/state.json，可断点续跑）：
 *   prepare   导入 PDF（goal=improvement）→ run 暂停 hitl.research_plan → 修订前快照 → 证据审计（真实模型）→ 计划（零模型）
 *   reaudit   协议 §6.3：首轮无合格可改写子项时恰 1 次重审计 + 重新生成计划
 *   execute   （作者决策由 ui-decide.mjs 浏览器真实点击完成后）恢复 run：
 *             hitl.plan_confirm 首次提交预登记 revise 反馈（逐字）、其后 approve；evidence_supply=continue；
 *             revision_validation=approve；style_polish=skip；revision_overflow / revision_stalled → 停（不 accept / 不 revise_more）
 *   collect   证据收集：指令 / patch 校验 / 修订快照前后 SHA 与 diff / 事实与引用集合 / 复评 ×2（幂等核对）
 *
 * 物理模型调用：项目 research/model-ledger.json calls 合计 + 审计 telemetry（API 直连调用不进账本）+ 连通测试；
 * 合计超过 120（含 DEV 已用）立即停止（协议 §8）。
 *
 * 用法：node scripts/m1519/e1-closure.mjs <cmd> [--base http://127.0.0.1:3118] [--root D:\PaperTeamData\M15\M15_19]
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const CMD = process.argv[2];
const BASE = arg("base", "http://127.0.0.1:3118").replace(/\/$/, "");
const ROOT = arg("root", "D:\\PaperTeamData\\M15\\M15_19");
const STACK = join(ROOT, "e2e-stack");
const OUT = join(ROOT, "e1");
const SAMPLE = join(ROOT, "e1-screening", "2610.23125v1", "paper.pdf");
const SAMPLE_SOURCE = "arXiv:2610.23125v1";
const MODEL_CALL_BUDGET = 120;
/** DEV 已用物理调用（dev/DEV-RESULT.md）+ E1 连通测试计入 extraCalls */
const DEV_CALLS = 4;
const RUN_TIMEOUT_MS = 150 * 60 * 1000;
/** PROTOCOL §6.5 预登记 revise 反馈（逐字；只在 hitl.plan_confirm 使用一次） */
const PLAN_CONFIRM_FEEDBACK =
  "本轮只处理已批准的目标期刊审计改写意见及其直接相关表述；不要删除或改写封面、作者、单位、许可、版权等 PDF 元数据块；不新增实验、数值或文献。其余改进条目本轮不执行。";

const log = (...parts) => console.log(`[m1519:${CMD}]`, ...parts);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const statePath = join(OUT, "state.json");
const loadState = async () => (existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : { steps: [], audits: [], extraCalls: 0 });
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

async function modelCallTotal(state) {
  let ledgerCalls = 0;
  if (existsSync(STACK)) {
    for (const entry of await readdir(STACK)) {
      const ledger = join(STACK, entry, "research", "model-ledger.json");
      if (!existsSync(ledger)) continue;
      const parsed = JSON.parse(await readFile(ledger, "utf8"));
      ledgerCalls += Object.values(parsed.entries ?? {}).reduce((sum, item) => sum + (item.calls ?? 0), 0);
    }
  }
  const auditCalls = (state.audits ?? []).reduce((sum, audit) => sum + (audit.modelCalls ?? 0), 0);
  const total = DEV_CALLS + ledgerCalls + (state.auditInLedger === true ? 0 : auditCalls) + (state.extraCalls ?? 0);
  return { total, dev: DEV_CALLS, ledgerCalls, auditCalls, extraCalls: state.extraCalls ?? 0 };
}

async function checkBudget(state, label) {
  const usage = await modelCallTotal(state);
  state.modelCalls = usage;
  log(`模型调用账（${label}）：${usage.total}/${MODEL_CALL_BUDGET}（dev ${usage.dev} · ledger ${usage.ledgerCalls} · audit ${usage.auditCalls} · extra ${usage.extraCalls}）`);
  if (usage.total > MODEL_CALL_BUDGET) {
    await saveState(state);
    throw new Error(`模型调用预算耗尽（${usage.total} > ${MODEL_CALL_BUDGET}）——按协议停止`);
  }
}

function step(state, name, data) {
  state.steps.push({ name, at: new Date().toISOString(), ...data });
  log(name, JSON.stringify(data).slice(0, 700));
}

async function pollRun(runId, { targetStage, untilStatuses = ["completed", "cancelled"], decide, timeoutMs = RUN_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body.run;
    if (run.status === "failed") return run;
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (targetStage !== undefined && stageId === targetStage) return run;
      const resume = decide?.(stageId, run.awaiting);
      if (resume === undefined) return run; // 未预期 / 协议要求停下的待办：交还调用方如实记录
      const response = await api("POST", `/api/runs/${runId}/resume`, resume);
      if (response.status >= 400) throw new Error(`resume ${stageId} 失败 ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
      continue;
    }
    if (untilStatuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run 超时（${run.status} @ ${run.currentStage}）`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function auditOnce(state, projectId, label) {
  const started = Date.now();
  const response = await api("POST", `/api/projects/${projectId}/target/evidence-audit`);
  if (response.status !== 200) {
    // 失败的审计也可能消耗了调用：保守记 3 并如实登记；不自动重试（协议：不追加未登记审计）
    state.audits.push({ label: `${label}-failed`, projectId, modelCalls: 3, failed: true, status: response.status, error: JSON.stringify(response.body).slice(0, 300) });
    await saveState(state);
    throw new Error(`审计失败 ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  const meta = response.body.audit.meta;
  state.audits.push({ label, projectId, modelCalls: meta?.telemetry?.calls ?? 0, failedCalls: meta?.telemetry?.failed ?? 0, totalMs: meta?.telemetry?.totalMs ?? Date.now() - started, approxPromptChars: meta?.telemetry?.approxPromptChars, outputChars: meta?.telemetry?.outputChars });
  await writeFile(join(OUT, `${label}-audit.json`), JSON.stringify(response.body.audit, null, 1), "utf8");
  return response.body.audit;
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
    classifierVersion: plan.source.classifierVersion,
    boundRevision: plan.source.manuscriptRevisionAtPlan,
    summary: plan.summary,
    items: plan.items.map((item) => ({
      itemId: item.itemId,
      contributionId: item.contributionId,
      gapKind: item.subGap?.gapKind ?? null,
      gap: item.gap,
      classification: item.classification,
      rewriteBasis: item.rewriteBasis ?? null,
      classificationReason: item.classificationReason,
      file: item.anchor.projection.file ?? null,
      dispatchSection: item.anchor.dispatchSection ?? null,
      texAnchor: item.anchor.texAnchor ?? null,
      targetQuote: item.anchor.claimQuote,
      evidenceAnchors: (item.subGap?.evidenceAnchors ?? []).map((anchor) => ({ sectionId: anchor.sectionId, quote: anchor.quote, verified: anchor.verified, replayed: anchor.replayed, distinct: anchor.distinctFromTarget })),
      evidenceRequest: item.evidenceRequest ?? null,
    })),
  };
}

async function auditAndPlan(state, label) {
  const projectId = state.e1.projectId;
  const audit = await auditOnce(state, projectId, label);
  const artifact = audit.artifact;
  step(state, `${label} 证据审计`, {
    modelCalls: state.audits.at(-1).modelCalls, totalMs: state.audits.at(-1).totalMs, promptVersion: artifact.promptVersion,
    inputFingerprint: artifact.inputFingerprint, guards: artifact.guards, poolSize: artifact.priorWork.poolSize,
    poolBuild: { refSelectionBasis: audit.meta?.poolBuild?.refSelectionBasis, refResolved: audit.meta?.poolBuild?.refResolved, eligible: audit.meta?.poolBuild?.referenceEntriesEligible, contentLevels: audit.meta?.poolBuild?.contentLevels, buildNotes: audit.meta?.poolBuild?.buildNotes },
    gapPlan: artifact.gapPlan.map((gap) => ({ subGapId: gap.subGapId, c: gap.contributionId, kind: gap.gapKind, gap: gap.gap })),
  });
  await checkBudget(state, label);
  const plan = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
  assert(plan.status === 200, `计划失败 ${plan.status} ${JSON.stringify(plan.body).slice(0, 200)}`);
  state.e1.plan = planSummary(plan.body.plan.plan);
  state.e1.rewriteEligible = state.e1.plan.items.filter((item) => item.classification === "REWRITE_ELIGIBLE").length;
  step(state, `${label} 计划（零模型）`, { planId: state.e1.plan.planId, summary: state.e1.plan.summary, rewriteEligible: state.e1.rewriteEligible });
  await writeFile(join(OUT, `${label}-plan.json`), JSON.stringify(plan.body.plan, null, 1), "utf8");
}

const NUMBER_RE = /(?<![A-Za-z_\\])\d+(?:\.\d+)?%?/g;
const citeKeys = (tex) => [...tex.matchAll(/\\cite[a-zA-Z]*\{([^}]*)\}/g)].flatMap((match) => match[1].split(",").map((key) => key.trim())).filter(Boolean).sort();
const numbers = (tex) => [...tex.replace(/\\(?:label|ref|eqref|cite[a-zA-Z]*)\{[^}]*\}/g, "").matchAll(NUMBER_RE)].map((match) => match[0]).sort();
const multisetDiff = (a, b) => {
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  const extra = [];
  for (const x of b) {
    const n = counts.get(x) ?? 0;
    if (n > 0) counts.set(x, n - 1); else extra.push(x);
  }
  return extra;
};

// ---------------------------------------------------------------------------

const state = await loadState();

if (CMD === "prepare") {
  assert(state.e1 === undefined, "E1 已导入——协议禁止换样本 / 重复导入");
  const connectivity = await api("POST", "/api/settings/model/test", { model: "zai-coding-cn/glm-5.3" });
  state.extraCalls = (state.extraCalls ?? 0) + 1;
  step(state, "E0 模型连通测试（1 次物理调用）", { status: connectivity.status, body: JSON.stringify(connectivity.body).slice(0, 200) });
  const content = await readFile(SAMPLE);
  const imported = await api("POST", "/api/projects/import-paper", {
    format: "pdf",
    fileName: "2610.23125v1.pdf",
    contentBase64: content.toString("base64"),
    title: `M15.19 E1 ${SAMPLE_SOURCE}（改进·隔离测试项目）`,
    researchField: "multi-object tracking",
    documentType: "research_article",
    workflowKind: "existing_paper_improvement",
  });
  assert(imported.status === 201, `导入失败 ${imported.status} ${JSON.stringify(imported.body).slice(0, 300)}`);
  state.e1 = { source: SAMPLE_SOURCE, projectId: imported.body.project.id, sampleSha256: sha256(content) };
  step(state, "E1 导入", { projectId: state.e1.projectId, sampleSha256: state.e1.sampleSha256 });
  await saveState(state);
  const created = await api("POST", `/api/projects/${state.e1.projectId}/workflows`, {});
  assert(created.status === 202, `create run 失败 ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  state.e1.runId = created.body.runId;
  await saveState(state);
  log("E2 run 启动 → 等待 hitl.research_plan（真实模型：review.run 等）…");
  const t0 = Date.now();
  const paused = await pollRun(state.e1.runId, { targetStage: "hitl.research_plan" });
  assert(paused.status === "awaiting_input" && paused.awaiting?.stageId === "hitl.research_plan", `run 未暂停在 research_plan：${paused.status} ${paused.awaiting?.stageId ?? ""} ${JSON.stringify(paused.error ?? {}).slice(0, 300)}`);
  const revisions = (await api("GET", `/api/projects/${state.e1.projectId}/revisions`)).body.revisions ?? [];
  state.e1.revisionAtPause = revisions.length;
  state.e1.before = await snapshotManuscript(state.e1.projectId, "before");
  const reconstruction = JSON.parse(await readFile(join(STACK, state.e1.projectId, "manuscript", "reconstruction.json"), "utf8").catch(() => "{}"));
  step(state, "E2 run 暂停 research_plan", { runId: state.e1.runId, durationMs: Date.now() - t0, revisionAtPause: state.e1.revisionAtPause, sectionFiles: Object.keys(state.e1.before.files), reconstruction: JSON.stringify(reconstruction).slice(0, 600) });
  await checkBudget(state, "pause");
  await auditAndPlan(state, "E1-audit-1");
  await saveState(state);
  log(`可改写子项 ${state.e1.rewriteEligible}/${state.e1.plan.items.length}；下一步：ui-decide.mjs（浏览器真实点击）`);
} else if (CMD === "reaudit") {
  assert(state.e1 !== undefined && (state.audits ?? []).filter((audit) => audit.projectId === state.e1.projectId && !audit.failed).length === 1, "协议：仅允许在首轮审计之后恰 1 次重审计");
  assert(state.e1.rewriteEligible === 0, "首轮已有合格可改写子项——协议不允许重审计");
  await auditAndPlan(state, "E1-audit-2");
  await saveState(state);
} else if (CMD === "execute") {
  const { projectId, runId } = state.e1;
  const decided = (await api("GET", `/api/projects/${projectId}/target/evidence-audit/revision-plan`)).body.plan;
  assert(decided?.plan?.status === "decided", `计划未全部决策（${decided?.plan?.status}）——先完成 ui-decide`);
  state.e1.decisions = decided.plan.items.map((item) => ({ itemId: item.itemId, classification: item.classification, decision: item.authorDecision?.decision ?? null, instructionId: item.instructionId ?? null }));
  step(state, "E4 决策核对（UI 点击产生）", { decisions: state.e1.decisions });
  const hitl = [];
  let planConfirmSeen = 0;
  const decide = (stageId) => {
    const at = new Date().toISOString();
    if (stageId === "hitl.plan_confirm") {
      planConfirmSeen += 1;
      const resume = planConfirmSeen === 1 ? { decision: "revise", payload: { feedback: PLAN_CONFIRM_FEEDBACK } } : { decision: "approve" };
      hitl.push({ stageId, decision: resume.decision, at, note: planConfirmSeen === 1 ? "PROTOCOL §6.5 预登记反馈（逐字）" : "代理批准" });
      return resume;
    }
    const fixed = { "hitl.evidence_supply": "continue", "hitl.revision_validation": "approve", "hitl.style_polish": "skip" }[stageId];
    if (fixed === undefined) {
      hitl.push({ stageId, decision: null, at, note: "协议：停（不 accept_draft / 不 revise_more / 未预期待办交还记录）" });
      return undefined;
    }
    hitl.push({ stageId, decision: fixed, at, note: "隔离测试项目代理决策（M15.19 验收）" });
    return { decision: fixed };
  };
  const resumed = await api("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  assert(resumed.status < 400, `research_plan resume 失败 ${resumed.status}`);
  log("E5 恢复 run（真实模型；可能 30–120 分钟）…");
  const t0 = Date.now();
  const finished = await pollRun(runId, { decide });
  state.e1.runEnd = { status: finished.status, awaiting: finished.awaiting?.stageId ?? null, error: finished.error ?? null, durationMs: Date.now() - t0 };
  step(state, "E5 run 结束态", { ...state.e1.runEnd, completedStages: finished.completedStages, hitl });
  await checkBudget(state, "after-run");
  await saveState(state);
} else if (CMD === "collect") {
  const { projectId } = state.e1;
  const projectDir = join(STACK, projectId);
  state.e1.after = await snapshotManuscript(projectId, "after");
  const files = {};
  for (const file of new Set([...Object.keys(state.e1.before.files), ...Object.keys(state.e1.after.files)])) {
    const before = await readFile(join(state.e1.before.dir, file), "utf8").catch(() => "");
    const after = await readFile(join(state.e1.after.dir, file), "utf8").catch(() => "");
    files[file] = {
      changed: sha256(before) !== sha256(after),
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      citeKeysRemoved: multisetDiff(citeKeys(after), citeKeys(before)),
      citeKeysAdded: multisetDiff(citeKeys(before), citeKeys(after)),
      numbersRemoved: multisetDiff(numbers(after), numbers(before)),
      numbersAdded: multisetDiff(numbers(before), numbers(after)),
    };
  }
  state.e1.fileDiffs = files;
  const instructions = (await api("GET", `/api/projects/${projectId}/external-instructions`)).body;
  await writeFile(join(OUT, "instructions-after.json"), JSON.stringify(instructions, null, 1), "utf8");
  for (const name of ["external-instructions.json"]) {
    const path = join(projectDir, "reviews", name);
    if (existsSync(path)) await cp(path, join(OUT, `reviews-${name}`));
  }
  for (const entry of await readdir(join(projectDir, "reviews")).catch(() => [])) {
    if (/^(patch-validation-rev-\d+|quality-gate-r\d+)\.json$/.test(entry)) await cp(join(projectDir, "reviews", entry), join(OUT, `reviews-${entry}`));
  }
  const report1 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
  const report2 = await api("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
  assert(report1.status === 200 && report2.status === 200, `复评失败 ${report1.status}/${report2.status}`);
  const strip = (report) => report.items.map((item) => ({ itemId: item.itemId, closure: item.closure, checks: item.checks ?? null }));
  const r1 = report1.body.report ?? report1.body;
  const r2 = report2.body.report ?? report2.body;
  state.e1.reassess = { summary: r1.summary, idempotent: JSON.stringify(strip(r1)) === JSON.stringify(strip(r2)), items: r1.items.map((item) => ({ itemId: item.itemId, classification: item.classification, gapKind: item.gapKind ?? null, closure: item.closure, basis: item.basis, checks: item.checks ?? null, lineage: item.lineage ?? null })) };
  await writeFile(join(OUT, "reassess-1.json"), JSON.stringify(r1, null, 1), "utf8");
  await writeFile(join(OUT, "reassess-2.json"), JSON.stringify(r2, null, 1), "utf8");
  step(state, "E6 证据收集 + 复评 ×2", { files: Object.fromEntries(Object.entries(files).filter(([, value]) => value.changed)), reassess: state.e1.reassess.summary, idempotent: state.e1.reassess.idempotent });
  await checkBudget(state, "final");
  await saveState(state);
} else {
  throw new Error(`未知子命令 ${CMD}（prepare | reaudit | execute | collect）`);
}
