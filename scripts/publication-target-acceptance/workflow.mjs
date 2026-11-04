#!/usr/bin/env node
/**
 * 发表目标验收 · 生产 stage 运行：review.run → quality.gate → revision.plan（idea_to_paper 生产定义，作者稿件口径）。
 * 冻结路径：ProjectStore.create(publicationTarget)（生产校验器）→ freezeReviewPolicy（createRun 调用的同一函数）→ ctx.state.reviewPolicy。
 * 这不是完整 workflow（不跑 import / research / Writer 修订循环）：报告标注 PRODUCTION_STAGE_SMOKE / FULL_WORKFLOW_NOT_RUN。
 * dry 模式（scripted，零模型）额外记录 reviewUnit / reviewWholePaper 的生产参数，供 ab.mjs 做同输入 A/B 对照。
 *
 *   node scripts/publication-target-acceptance/workflow.mjs --mode dry|live --case <id> --md <paper.md> --arm <A|B|C> [--cap N]
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { MAX_CALLS, REPO, ROOT, callsUsed, createStack, dist, readJson, sha } from "./lib.mjs";
import { ARMS } from "./arms.mjs";
import { markdownToLatexFidelity } from "../m16-verified-findings/md-to-tex-v2.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mode = opt("--mode");
const caseId = opt("--case");
const mdPath = opt("--md");
const arm = opt("--arm") ?? "B";
if (!["dry", "live"].includes(mode) || !caseId || !mdPath || ARMS[arm] === undefined) throw new Error("用法：--mode dry|live --case <id> --md <paper.md> --arm A|B|C");
const runCap = Number(opt("--cap") ?? 16);
const OUT = join(ROOT, "workflow", `${caseId}__${mode}__${arm}`);
const resultPath = join(OUT, "run-result.json");
if (existsSync(resultPath) && readJson(resultPath).status === "completed") {
  console.log(`[skip-completed] ${OUT}`);
  process.exit(0);
}
if (mode === "live" && MAX_CALLS - callsUsed() < runCap) {
  console.error(`[budget] 账本剩余 ${MAX_CALLS - callsUsed()} < 本次上限 ${runCap}：不启动`);
  process.exit(4);
}
await mkdir(join(OUT, "projects"), { recursive: true });
const { stack, projects, config, calls, modelSpec, close } = await createStack({ mode, outDir: OUT, purpose: `workflow/${caseId}/${arm}`, projectsRoot: join(OUT, "projects"), runCap });
const { freezeReviewPolicy } = await import(dist("review/reviewPolicySnapshot.js"));
const { createIdeaToPaperDefinition } = await import(dist("workflow/definitions.js"));

// dry：记录 Reviewer 生产参数（去掉 signal / 函数），ab.mjs 原样回放
const captured = { unit: [], whole: [] };
if (mode === "dry") {
  const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === "signal" || typeof v === "function" ? undefined : v)));
  const unit = stack.reviewer.reviewUnit.bind(stack.reviewer);
  stack.reviewer.reviewUnit = async (p) => { captured.unit.push(strip(p)); return unit(p); };
  const whole = stack.reviewer.reviewWholePaper.bind(stack.reviewer);
  stack.reviewer.reviewWholePaper = async (p) => { captured.whole.push(strip(p)); return whole(p); };
}

const md = readFileSync(mdPath, "utf8");
const { tex, report } = markdownToLatexFidelity(md, "en");
const gitHead = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
const result = {
  schema: "publication-target-acceptance-workflow/v1", caseId, mode, arm, armTarget: ARMS[arm].target, modelSpec, gitHead,
  backendDirty: execSync("git status --porcelain -- backend", { cwd: REPO }).toString().trim() !== "", runCap,
  mdSha256: sha(md), texSha256: sha(tex), texChars: tex.length, fidelityNotes: report.notes,
  reviewConfig: { ...config.review }, startedAt: new Date().toISOString(),
  label: "PRODUCTION_STAGE_SMOKE (review.run → quality.gate → revision.plan); FULL_WORKFLOW_NOT_RUN",
};
const t0 = Date.now();
try {
  const title = (/\\title\{([^{}]*)/.exec(tex)?.[1] ?? caseId).trim();
  const created = await projects.create(title.slice(0, 120), {
    language: "en", documentType: "research_article",
    ...(ARMS[arm].target !== null ? { publicationTarget: ARMS[arm].target } : {}),
  });
  const project = await projects.getRequired(created.id);
  result.projectId = project.id;
  result.storedPublicationTarget = project.publicationTarget ?? null;
  await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), tex, "utf8");
  await mkdir(join(projects.projectDir(project.id), "artifacts"), { recursive: true });
  await writeFile(join(projects.projectDir(project.id), "artifacts", "input-provenance.json"), JSON.stringify({ sourceKind: "pdf_transcription", manuscriptSha256: sha(tex), note: "CoCoReviewBench MinerU Markdown → md-to-tex v2" }, null, 1), "utf8");
  const reviewPolicy = freezeReviewPolicy(project, "idea_to_paper", new Date());
  result.reviewPolicy = reviewPolicy;
  const definition = createIdeaToPaperDefinition(stack.workflowServices);
  const ctx = {
    projectId: project.id, runId: `pta-${caseId}-${arm}`, attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "idea_to_paper", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {}, reviewPolicy },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  };
  // 运行中修改项目设置（本 run 必须不受影响）：review.run 之后、revision.plan 之前把目标改成 JCR Q1
  result.stages = {};
  for (const id of ["review.run", "quality.gate", "revision.plan"]) {
    if (id === "revision.plan") {
      await projects.updateMeta(project.id, { publicationTarget: { scheme: "jcr", tier: "Q1" } });
      result.midRunSettingChange = { to: { scheme: "jcr", tier: "Q1" }, snapshotHashInState: ctx.state.reviewPolicy.policyHash };
    }
    const stage = definition.stages.find((s) => s.id === id);
    const out = await stage.execute(ctx);
    result.stages[id] = out;
    ctx.state.stageResults[id] = out;
    ctx.state.completedStages.push(id);
  }
  result.midRunSettingChange.snapshotHashAfter = ctx.state.reviewPolicy.policyHash;
  const reviewsDir = join(projects.projectDir(project.id), "reviews");
  await mkdir(join(OUT, "artifacts", "review-units"), { recursive: true });
  for (const f of await readdir(reviewsDir)) if (f.endsWith(".json")) await copyFile(join(reviewsDir, f), join(OUT, "artifacts", f));
  if (existsSync(join(reviewsDir, "review-units", "r1"))) for (const f of await readdir(join(reviewsDir, "review-units", "r1"))) await copyFile(join(reviewsDir, "review-units", "r1", f), join(OUT, "artifacts", "review-units", f));
  const artDir = join(projects.projectDir(project.id), "artifacts");
  if (existsSync(artDir)) for (const f of await readdir(artDir)) if (f.endsWith(".json")) await copyFile(join(artDir, f), join(OUT, "artifacts", f));
  result.status = "completed";
} catch (error) {
  result.status = /MODEL_BUDGET_EXCEEDED|任务级模型预算|global budget|\[budget\]/i.test(String(error?.message)) ? "refused_budget" : "failed";
  result.error = String(error?.stack ?? error).slice(0, 3000);
}
result.endedAt = new Date().toISOString();
result.ms = Date.now() - t0;
result.calls = calls;
result.callCount = calls.length;
result.failedCalls = calls.filter((c) => c.status !== "completed").length;
await writeFile(resultPath, JSON.stringify(result, null, 1), "utf8");
if (mode === "dry") await writeFile(join(OUT, "captured-reviewer-params.json"), JSON.stringify(captured, null, 1), "utf8");
console.log(`[${result.status}] ${caseId}/${arm} calls=${result.callCount} failed=${result.failedCalls} ms=${result.ms} ${result.error ? result.error.slice(0, 600) : ""}`);
await close();
process.exit(0);
