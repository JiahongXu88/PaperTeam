#!/usr/bin/env node
/**
 * 发表目标验收 · 同输入 A/B 直接调用生产 ReviewerService 入口（PROTOCOL.md §3）。
 * - 研究论文参数：workflow.mjs dry（B 臂）在真实 review.run 中捕获的 reviewWholePaper / reviewUnit 参数原样回放；
 *   只替换 projectId（每次调用新建项目 = 新会话，无 shared-session 顺序污染）与 reviewPolicy（按臂冻结；inactive 时不传，同生产）。
 * - 每个新项目写入同一 main.tex（非隔离会话下 Reviewer 工具可读工作区，保持各臂可用上下文一致）。
 * - 综述：PaperTeam 自产中文综述（M13 Final Closure），正文按 review.run 同一 span / 单元切分拼接。
 *
 *   node scripts/publication-target-acceptance/ab.mjs --mode dry|live --call <ID>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_CALLS, ROOT, callsUsed, createStack, dist, readJson, sha } from "./lib.mjs";
import { ARMS } from "./arms.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mode = opt("--mode");
const callId = opt("--call");

const RESEARCH_DRY = join(ROOT, "workflow", "probe-2410.21665v1__dry__B");
const SURVEY_SRC = "D:\\PaperTeamData\\M13_Final_Closure\\projects\\p-47370dc6a0f0\\manuscript";
const UNIT_ID = "main.tex::subsection:5.2 EXPERIMENTS";

/** 预先登记的调用（PROTOCOL.md §3 表；顺序 = 预算优先级） */
const CALLS = {
  "WP-A1": { kind: "whole", arm: "A" },
  "WP-B2": { kind: "whole", arm: "B" },
  "WP-A2": { kind: "whole", arm: "A" },
  "WP-C1": { kind: "whole", arm: "C" },
  "U-A": { kind: "unit", arm: "A" },
  "U-B": { kind: "unit", arm: "B" },
  "SV-N": { kind: "survey-whole", arm: "S0", legacy: true },
  "SV-S0": { kind: "survey-whole", arm: "S0" },
};
const spec = CALLS[callId];
if (!["dry", "live"].includes(mode) || spec === undefined) throw new Error(`用法：--mode dry|live --call ${Object.keys(CALLS).join("|")}`);
// --retry：PROTOCOL §7 每个 ID 最多 1 次重试；首次尝试目录原样保留，重试写 __retry1 并在账本标 retry
const retry = args.includes("--retry");
const OUT = join(ROOT, "ab", `${callId}__${mode}${retry ? "__retry1" : ""}`);
if (existsSync(join(OUT, "result.json")) && readJson(join(OUT, "result.json")).status === "completed") {
  console.log(`[skip-completed] ${callId}`);
  process.exit(0);
}
if (mode === "live" && callsUsed() >= MAX_CALLS) {
  console.error(`[budget] 账本已达 ${MAX_CALLS}：不启动`);
  process.exit(4);
}
await mkdir(join(OUT, "projects"), { recursive: true });
const { stack, projects, calls, modelSpec, close } = await createStack({ mode, outDir: OUT, purpose: `ab/${callId}${retry ? "/retry1" : ""}`, projectsRoot: join(OUT, "projects"), runCap: 1, retry });
const { freezeReviewPolicy } = await import(dist("review/reviewPolicySnapshot.js"));

const result = { schema: "publication-target-acceptance-ab/v1", callId, ...spec, mode, modelSpec, startedAt: new Date().toISOString() };
try {
  let response;
  if (spec.kind === "whole" || spec.kind === "unit") {
    const captured = readJson(join(RESEARCH_DRY, "captured-reviewer-params.json"));
    const tex = readFileSync(join(RESEARCH_DRY, "projects", readdirSync(join(RESEARCH_DRY, "projects"))[0], "manuscript", "main.tex"), "utf8");
    const project = await projects.create(`ab-${callId}`, { language: "en", documentType: "research_article", ...(ARMS[spec.arm].target !== null ? { publicationTarget: ARMS[spec.arm].target } : {}) });
    await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), tex, "utf8");
    const policy = freezeReviewPolicy(await projects.getRequired(project.id), "idea_to_paper", new Date());
    result.policy = policy;
    result.texSha256 = sha(tex);
    const base = spec.kind === "whole" ? captured.whole[0] : captured.unit.find((u) => u.unit.unitId === UNIT_ID);
    const { reviewPolicy: _drop, ...rest } = base;
    const params = { ...rest, projectId: project.id, ...(policy.active ? { reviewPolicy: policy } : {}) };
    result.inputSha256 = sha(spec.kind === "whole" ? params.text : params.unit.text);
    response = spec.kind === "whole" ? await stack.reviewer.reviewWholePaper(params) : await stack.reviewer.reviewUnit(params);
  } else {
    const { reviewSourceSpans } = await import(dist("review/coverageLedger.js"));
    const { partitionSpanIntoUnits } = await import(dist("review/logicalSpan.js"));
    const mainTex = readFileSync(join(SURVEY_SRC, "main.tex"), "utf8");
    const order = [...mainTex.matchAll(/\\input\{sections\/([^}]+)\}/g)].map((m) => m[1]);
    const sections = order.map((name) => ({ file: `sections/${name}.tex`, content: readFileSync(join(SURVEY_SRC, "sections", `${name}.tex`), "utf8") }));
    const sources = [{ file: "main.tex", content: mainTex, root: true }, ...sections];
    // 与 review.run 整稿输入同口径：覆盖计划单元原文按顺序以空行拼接（definitions.ts 整稿 fullText）
    const text = sources.flatMap((entry) => reviewSourceSpans(entry).flatMap((span) => partitionSpanIntoUnits(span, 9000).units.map((u) => u.content))).filter((t) => t.trim() !== "").join("\n\n");
    const project = await projects.create(`ab-${callId}`, { language: "zh", documentType: "survey", ...(ARMS[spec.arm].target !== null ? { publicationTarget: ARMS[spec.arm].target } : {}) });
    await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), mainTex, "utf8");
    await mkdir(join(projects.manuscriptDir(project.id), "sections"), { recursive: true });
    for (const s of sections) await writeFile(join(projects.manuscriptDir(project.id), s.file), s.content, "utf8");
    const policy = freezeReviewPolicy(await projects.getRequired(project.id), "topic_survey", new Date());
    result.policy = spec.legacy === true ? null : policy;
    result.inputSha256 = sha(text);
    result.inputChars = text.length;
    // SV-N：不传政策 = 升级前 / 旧 run 的整稿口径（研究论文类别），作为综述对照
    response = await stack.reviewer.reviewWholePaper({ projectId: project.id, text, inputMode: "FULL_TEXT", language: "zh", ...(spec.legacy !== true ? { reviewPolicy: policy } : {}) });
  }
  result.response = response;
  result.status = "completed";
} catch (error) {
  result.status = "failed";
  result.error = String(error?.stack ?? error).slice(0, 3000);
}
result.endedAt = new Date().toISOString();
result.calls = calls;
await writeFile(join(OUT, "result.json"), JSON.stringify(result, null, 1), "utf8");
console.log(`[${result.status}] ${callId} calls=${calls.length} issues=${result.response?.issues?.length ?? "-"} prompt=${calls[0]?.promptSha256?.slice(0, 12) ?? "-"} ${result.error ? result.error.slice(0, 500) : ""}`);
await close();
process.exit(0);
