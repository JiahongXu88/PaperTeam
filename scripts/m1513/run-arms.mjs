#!/usr/bin/env node
/**
 * M15.13 Phase D — 四臂对照实验运行器（真实生产链路；预算物理计数）。
 *
 * C0     M15.11/12 prompt 逐字重放（纵向锚；scope m1513-c0/<fam>，default role 零 skill）
 * C0+    两步通用全局 Reviewer（M15.12 冻结文本逐字；scope m1513-c0plus/<fam>/{extract,critique}）
 * C1opt  生产 existing_paper_review，paperMapSummaryMode=batched + **sectionReviewMode=batched-small**
 *        + citationSemanticMode=off —— review.sections 及之前阶段产物 = C1opt 快照
 * C2     同一 workflow run + globalReviewMode=on（fullpaper pass 含 M15.13 A1 解析重试）
 *        + priorityView=true —— C2 与 C1opt 共享 run，消融差异恰为整稿 pass
 *
 * 用法：node scripts/m1513/run-arms.mjs --fam fam-pr-XX [--arms c0,c0plus,workflow]
 * 产物：M15_13_ROOT/phase-d/out/<famId>/{c0.json,c0plus.json,workflow.json,meta.json}
 *       + phase-d/model-calls.jsonl（全部物理调用逐条）
 */
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts/m1513
const REPO = resolve(here, "..", "..");
const ROOT = process.env.M1513_ROOT ? resolve(process.env.M1513_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_13");
const MANUSCRIPTS = process.env.M1513_MANUSCRIPTS ?? join(ROOT, "manuscripts");
const OUT_DIR = join(ROOT, "phase-d", "out");
const CALLS_LOG = join(ROOT, "phase-d", "model-calls.jsonl");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const LEDGER = join(ROOT, "phase-d", "budget-ledger.json");
const BUDGET_CAP = Number(process.env.M1513_BUDGET_CAP ?? 600);
// M15.13：墙钟优化——reviewConcurrency 3→5（run 级 env，不改任何审阅语义；
// M15.12 为 3。若 429/限流显著则回退 3 并登记 deviation）
process.env["PAPERTEAM_REVIEW_CONCURRENCY"] = process.env.M1513_REVIEW_CONCURRENCY ?? "5";

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const famId = argOf("--fam");
if (!famId) throw new Error("--fam fam-pr-XX 必填（样本清单见 phase-c/sample-manifest.json）");
const arms = (argOf("--arms") ?? "c0,c0plus,workflow").split(",");

// ---- env 必须在 import dist 之前设置 ----
process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(BUDGET_CAP);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "1";

await mkdir(OUT_DIR, { recursive: true });
await mkdir(PROJECTS_ROOT, { recursive: true });
await mkdir(join(ROOT, "phase-d"), { recursive: true });

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const C0_PROMPT = `You are an experienced peer reviewer for a top-tier machine learning conference. Review the manuscript below on its academic substance: correctness of methods, soundness and sufficiency of experiments and comparisons, novelty and positioning against prior work, alignment of claims with evidence, statistical rigor, reproducibility, and any substantive weaknesses a reviewer should raise.

Rules:
- Base every point on the manuscript text itself; quote or locate the relevant passage where possible.
- Focus on substantive academic issues; do not report typos or formatting problems.
- Do not invent citations or facts that are not in the manuscript.
- Output ONLY one JSON object, no prose around it:
  {"findings": [{"category": "<fact|academic|style|citation|consistency|visual>", "severity": "<critical|major|minor|info>", "page": <integer page number or null>, "claimText": "<short quoted passage from the manuscript this point refers to, or empty string>", "message": "<the issue, one to three sentences, concrete and specific>", "suggestion": "<what the authors should do about it>"}]}
- Order findings from most severe/important to least; list every substantive issue you can find, not only the top few.

MANUSCRIPT:
`;

// C0+ 两步 prompt（M15.12 预注册 §7.2/§7.3 冻结文本逐字沿用）
const C0PLUS_EXTRACT_HEAD = `You are an experienced peer reviewer for a top-tier machine learning conference. Before evaluating, extract the manuscript's own argument structure.

From the manuscript text below, extract ONLY what the manuscript itself states:
- research_goal: the research goal / problem the paper claims to address (closest to the authors' own wording, 1-2 sentences)
- task_definition: the concrete evaluation task(s) the paper uses
- claimed_contributions: list of distinct contribution claims (short paraphrases)
- method_modules: for each proposed method component, the name and the mechanism the paper claims makes it work
- key_claims: main claims about results/performance/general applicability, each with where it is claimed (quote or locate)
- evidence_map: for each key claim, the experiments / baselines / ablations / datasets / metrics the paper offers as support (or "none stated")

Rules:
- Base everything only on the manuscript text; quote or locate passages where possible.
- Do not evaluate or criticize yet; do not infer content that is not written.
- Output ONLY one JSON object, no prose around it:
{"research_goal": "...", "task_definition": "...", "claimed_contributions": ["..."], "method_modules": [{"name": "...", "claimed_mechanism": "..."}], "key_claims": [{"claim": "...", "where": "..."}], "evidence_map": [{"claim": "...", "evidence": "..." }]}

MANUSCRIPT:
`;

const C0PLUS_CRITIQUE_HEAD = `You are an experienced peer reviewer for a top-tier machine learning conference. Using the structured extraction of the manuscript's argument (provided first) and the full manuscript text (provided after), review the paper on whole-paper coherence:

1. Goal-method alignment: do the proposed methods plausibly address the stated research goal, or is the argumentation circular / missing steps?
2. Claim-evidence support: is each key claim supported by adequate experiments, baselines, ablations, datasets, and metrics that actually answer the research question?
3. Overclaiming: are abstract/intro/conclusion claims stronger than what the delivered scope and experiments justify?
4. Consistency: do claims in different sections contradict each other or the reported results?
5. Anything else a substantive reviewer should raise (correctness of methods, soundness of comparisons, statistical rigor, reproducibility).

Rules:
- Base every point on the manuscript text itself; quote or locate the relevant passage where possible.
- Focus on substantive academic issues; do not report typos or formatting problems.
- Do not invent citations or facts that are not in the manuscript. When the manuscript does not provide enough information to judge a point, mark that point INSUFFICIENT_EVIDENCE in the message instead of assuming.
- Output ONLY one JSON object, no prose around it:
{"findings": [{"category": "<fact|academic|style|citation|consistency|visual>", "severity": "<critical|major|minor|info>", "page": <integer page number or null>, "claimText": "<short quoted passage this point refers to, or empty string>", "message": "<the issue, one to three sentences, concrete and specific>", "suggestion": "<what the authors should do about it>"}]}
- Order findings from most severe/important to least; list every substantive issue you can find, not only the top few.

EXTRACTION:
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async (line) => {
  console.log(line);
  await appendFile(join(ROOT, "phase-d", "driver-log.txt"), `[${new Date().toISOString()}] ${line}\n`, "utf8").catch(() => {});
};

// ---- 装配（与 m1512 相同模板） ----
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
const { createExistingPaperReviewDefinition } = await import(distUrl("workflow", "definitions.js"));
const { parseSectionFindingsOutput } = await import(distUrl("paper", "SectionReviewService.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));

const config = loadConfig();
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: () => {},
});
const budgetLedger = new GlobalBudgetLedger({
  path: LEDGER,
  limits: { maxCalls: BUDGET_CAP, maxTokens: 0 },
  label: "M15.13 arms",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role_, scope) => skillRegistry.skillAssignmentsFor(role_, scope),
  log: () => {},
});
let physicalCalls = 0;
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const idx = physicalCalls;
  const t0 = Date.now();
  const scopeHint = callArgs[0]?.contextScope ?? "";
  const armHint = scopeHint.startsWith("m1513-c0/")
    ? "c0"
    : scopeHint.startsWith("m1513-c0plus/")
      ? "c0plus"
      : scopeHint.startsWith("review/fullpaper/")
        ? "c2-fullpaper"
        : scopeHint.startsWith("review/section-batch/")
          ? "workflow-section-batch"
          : scopeHint.startsWith("review/")
            ? "workflow"
            : "other";
  const result = await originalRunAgent(...callArgs);
  await appendFile(
    CALLS_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      callIndex: idx,
      familyId: famId,
      contextScope: scopeHint,
      armHint,
      status: result.status,
      ms: Date.now() - t0,
      usage: result.usage ?? null,
      taskId: result.taskId,
    }) + "\n",
    "utf8",
  ).catch(() => {});
  return result;
};
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const stack = buildServiceStack({
  researchFetch: researchNet.router.fetch,
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  // M15.13：并发显式接线（buildServiceStack 对 review.reviewConcurrency 缺省 3；
  // env 通道只进 config 不进 stack——runner 必须自己传，墙钟目标 ≤4× C0 需要 5）
  review: { reviewConcurrency: Number(process.env.PAPERTEAM_REVIEW_CONCURRENCY ?? "5") },
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: () => {},
});
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore: new WorkflowRunStore(projects, { log: () => {} }),
  definitionFactory: (kind) =>
    kind === "existing_paper_review"
      ? createExistingPaperReviewDefinition(stack.workflowServices)
      : (() => {
          throw new Error(`只装配 existing_paper_review（${kind}）`);
        })(),
  log: () => {},
});
const server = createBackendHttpServer({ runtime: adapter, projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (method, path, body) => {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = { raw: true }; }
  return { status: response.status, body: parsed };
};
await log(`stack ready (port=${server.address().port}, fam=${famId}, arms=${arms.join("+")}, physicalCalls=${physicalCalls})`);

// ---- 工具 ----
async function importPdf() {
  const pdfPath = join(MANUSCRIPTS, `${famId}.pdf`);
  const contentBase64 = (await readFile(pdfPath)).toString("base64");
  const created = await request("POST", "/projects/import-pdf", { fileName: `${famId}.pdf`, contentBase64, goal: "review_only" });
  if (created.status !== 200 && created.status !== 201) throw new Error(`import-pdf failed ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
  return created.body.project.id;
}
async function waitRun(runId, budgetMs = 60 * 60_000) {
  const startedAt = Date.now();
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    const run = body.run;
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (Date.now() - startedAt > budgetMs) throw new Error(`run ${runId} timeout (status=${run.status})`);
    await sleep(5_000);
  }
}
async function readManuscriptText(projectId) {
  const chunksRaw = await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).sort((a, b) => a.sequence - b.sequence);
  const pages = new Map();
  for (const c of chunks) {
    const label = `[page ${c.pageStart}${c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}]`;
    pages.set(label, (pages.get(label) ?? "") + c.text + "\n");
  }
  return [...pages.entries()].map(([label, text]) => `${label}\n${text}`).join("\n");
}
function lenientJson(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

// ---- C0：one-shot 基线（M15.11/12 prompt 逐字） ----
async function runC0(projectId, manuscriptText) {
  const t0 = Date.now();
  const callsBefore = physicalCalls;
  const prompt = C0_PROMPT + manuscriptText;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const task = await adapter.runAgent({
      agentId: "main",
      projectId,
      contextScope: `m1513-c0/${famId}`,
      task: prompt,
      toolPolicy: "read_only",
      metadata: { arm: "c0", attempt },
    });
    const output = task.output ?? "";
    if (task.status === "completed" && output.trim() !== "") {
      const parsed = parseSectionFindingsOutput(output);
      if (!parsed.parseFailed) {
        return { arm: "c0", status: "ok", wallMs: Date.now() - t0, calls: physicalCalls - callsBefore, attempts: attempt, inputChars: prompt.length, parseFailed: false, findings: parsed.findings, dropped: parsed.dropped };
      }
    }
    if (attempt >= 2) {
      return { arm: "c0", status: task.status === "completed" ? "parse_failed" : `agent_${task.status}`, wallMs: Date.now() - t0, calls: physicalCalls - callsBefore, attempts: attempt, inputChars: prompt.length, parseFailed: true, error: (task.error ?? "").slice(0, 300), findings: [] };
    }
    await sleep(2_000);
  }
}

// ---- C0+：两步通用全局 Reviewer（M15.12 冻结文本） ----
async function runC0Plus(projectId, manuscriptText) {
  const t0 = Date.now();
  const callsBefore = physicalCalls;
  const extractPrompt = C0PLUS_EXTRACT_HEAD + manuscriptText;
  const extractTask = await adapter.runAgent({
    agentId: "main",
    projectId,
    contextScope: `m1513-c0plus/${famId}/extract`,
    task: extractPrompt,
    toolPolicy: "read_only",
    metadata: { arm: "c0plus", pass: "extract" },
  });
  const extractOutput = extractTask.status === "completed" ? (extractTask.output ?? "") : "";
  const extraction = lenientJson(extractOutput);
  const critiquePrompt = C0PLUS_CRITIQUE_HEAD + (extraction !== undefined ? JSON.stringify(extraction, null, 1).slice(0, 12_000) : "(extraction unavailable — review from manuscript text alone)") + "\n\nMANUSCRIPT:\n" + manuscriptText;
  const critiqueTask = await adapter.runAgent({
    agentId: "main",
    projectId,
    contextScope: `m1513-c0plus/${famId}/critique`,
    task: critiquePrompt,
    toolPolicy: "read_only",
    metadata: { arm: "c0plus", pass: "critique" },
  });
  const critiqueOutput = critiqueTask.status === "completed" ? (critiqueTask.output ?? "") : "";
  const parsed = critiqueOutput.trim() === "" ? { findings: [], parseFailed: true, dropped: 0 } : parseSectionFindingsOutput(critiqueOutput);
  return {
    arm: "c0plus",
    status: parsed.parseFailed ? "parse_failed" : "ok",
    wallMs: Date.now() - t0,
    calls: physicalCalls - callsBefore,
    extractStatus: extractTask.status,
    extractParseFailed: extraction === undefined,
    inputChars: critiquePrompt.length,
    findings: parsed.findings,
    dropped: parsed.dropped,
    extraction,
  };
}

// ---- C1opt/C2 共享 workflow run（M15.13：+sectionReviewMode=batched-small） ----
async function runWorkflow(projectId) {
  const t0 = Date.now();
  const callsBefore = physicalCalls;
  const started = await request("POST", `/projects/${projectId}/workflows`, {
    kind: "existing_paper_review",
    citationSemanticMode: "off",
    paperMapSummaryMode: "batched",
    sectionReviewMode: "batched-small",
    globalReviewMode: "on",
    priorityView: true,
  });
  if (started.status !== 202) throw new Error(`workflow start failed ${started.status}: ${JSON.stringify(started.body).slice(0, 200)}`);
  const run = await waitRun(started.body.runId);
  const reportPath = run.stageResults?.["review.aggregate"]?.["reportPath"] ?? null;
  let report = null;
  if (reportPath) {
    const abs = join(PROJECTS_ROOT, projectId, reportPath);
    if (existsSync(abs)) report = JSON.parse(await readFile(abs, "utf8"));
  }
  return {
    arm: "workflow",
    status: run.status,
    runId: run.runId ?? started.body.runId,
    wallMs: Date.now() - t0,
    calls: physicalCalls - callsBefore,
    stageResults: run.stageResults ?? {},
    report,
  };
}

// ---- 主流程 ----
const outDir = join(OUT_DIR, famId);
await mkdir(outDir, { recursive: true });
const meta = { famId, startedAt: new Date().toISOString(), arms };
try {
  const projectId = await importPdf();
  meta.projectId = projectId;
  const manuscriptText = await readManuscriptText(projectId);
  meta.manuscriptChars = manuscriptText.length;

  if (arms.includes("workflow") && !existsSync(join(outDir, "workflow.json"))) {
    await log(`${famId}: C1opt/C2 workflow start (batched + batched-small sections + fullpaper)`);
    const wf = await runWorkflow(projectId);
    const sections = wf.stageResults?.["review.sections"] ?? {};
    const fullpaper = wf.stageResults?.["review.fullpaper"] ?? null;
    const sectionFindings = Array.isArray(sections["findings"]) ? sections["findings"] : [];
    const fullpaperFindings = fullpaper !== null && Array.isArray(fullpaper["findings"]) ? fullpaper["findings"] : [];
    const c1opt = {
      arm: "c1opt",
      status: wf.status === "completed" && Array.isArray(sections["failedSections"]) && sections["failedSections"].length === 0 ? "ok" : wf.status,
      wallMs: wf.wallMs,
      calls: wf.calls - (fullpaper?.["modelTelemetry"]?.["calls"] ?? 0),
      sectionsReviewed: sections["sectionsReviewed"] ?? null,
      sectionsTotal: sections["sectionsTotal"] ?? null,
      sectionReviewMode: sections["sectionReviewMode"] ?? null,
      reviewCalls: sections["reviewCalls"] ?? null,
      batchGroups: sections["batchGroups"] ?? null,
      paperMapTelemetry: wf.stageResults?.["paper.ensure"]?.["paperMapTelemetry"] ?? null,
      modelTelemetry: sections["modelTelemetry"] ?? null,
      findings: sectionFindings,
      findingsTotal: sectionFindings.length,
    };
    const c2 = {
      arm: "c2",
      status: wf.status,
      wallMs: wf.wallMs,
      calls: wf.calls,
      fullpaperTelemetry: fullpaper?.["modelTelemetry"] ?? null,
      fullpaperCoverage: fullpaper?.["coverage"] ?? null,
      fullpaperRetries: {
        extractRetried: fullpaper?.["extractRetried"] ?? null,
        critiqueRetried: fullpaper?.["critiqueRetried"] ?? null,
      },
      fullpaperDropped: fullpaper?.["dropped"] ?? null,
      findings: [...sectionFindings, ...fullpaperFindings],
      findingsTotal: sectionFindings.length + fullpaperFindings.length,
      priorityView: wf.report?.priorityView ?? null,
    };
    await writeFile(join(outDir, "c1opt.json"), JSON.stringify(c1opt, null, 1), "utf8");
    await writeFile(join(outDir, "c2.json"), JSON.stringify(c2, null, 1), "utf8");
    await writeFile(join(outDir, "workflow.json"), JSON.stringify({ ...wf, report: wf.report ? { ...wf.report, findings: undefined } : null }, null, 1), "utf8");
    await log(`${famId}: workflow ${wf.status} calls=${wf.calls} (c1opt=${c1opt.calls}; reviewCalls=${c1opt.reviewCalls} batchGroups=${c1opt.batchGroups}) findings sec=${sectionFindings.length} fullpaper=${fullpaperFindings.length} wall=${Math.round(wf.wallMs / 1000)}s`);
    meta.workflow = { status: wf.status, calls: wf.calls, c1optCalls: c1opt.calls, reviewCalls: c1opt.reviewCalls, findings: c2.findingsTotal };
  }
  if (arms.includes("c0") && !existsSync(join(outDir, "c0.json"))) {
    await log(`${famId}: C0 direct review`);
    const c0 = await runC0(projectId, manuscriptText);
    await writeFile(join(outDir, "c0.json"), JSON.stringify(c0, null, 1), "utf8");
    await log(`${famId}: C0 ${c0.status} calls=${c0.calls} findings=${c0.findings.length} wall=${Math.round(c0.wallMs / 1000)}s`);
    meta.c0 = { status: c0.status, calls: c0.calls, findings: c0.findings.length };
  }
  if (arms.includes("c0plus") && !existsSync(join(outDir, "c0plus.json"))) {
    await log(`${famId}: C0+ two-step global review`);
    const c0plus = await runC0Plus(projectId, manuscriptText);
    await writeFile(join(outDir, "c0plus.json"), JSON.stringify(c0plus, null, 1), "utf8");
    await log(`${famId}: C0+ ${c0plus.status} calls=${c0plus.calls} findings=${c0plus.findings.length} wall=${Math.round(c0plus.wallMs / 1000)}s`);
    meta.c0plus = { status: c0plus.status, calls: c0plus.calls, findings: c0plus.findings.length };
  }
} catch (e) {
  meta.error = String(e.message).slice(0, 400);
  await log(`${famId}: FATAL ${e.message}`);
}
meta.finishedAt = new Date().toISOString();
meta.physicalCallsTotal = physicalCalls;
await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 1), "utf8");
await log(`${famId}: done; physical calls this process: ${physicalCalls}`);
console.log(JSON.stringify(meta, null, 1));
server.close();
process.exit(0);
