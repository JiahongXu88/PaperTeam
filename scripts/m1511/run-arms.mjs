#!/usr/bin/env node
/**
 * M15.11 Phase C — C0/C1 对照实验运行器（真实生产链路；预算物理计数）。
 *
 * C0 Generic Reviewer Baseline：同一 PiRuntimeAdapter、同一模型、default role 零 skill，
 *   输入=与 C1 相同 PDF 解析全文（页标记），prompt=PROTOCOL_FROZEN §7。
 * C1 PaperTeam Production Reviewer：existing_paper_review workflow（citationSemanticMode=off）。
 *
 * 用法：node tools/m1511-run-arms.mjs --role dev|heldout [--arms c0,c1] [--fam fam-cand-XX]
 * 产物：phase-c/out/<famId>/{c0.json,c1.json,meta.json} + phase-c/model-calls.jsonl
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <M1511>/tools
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable) // D:\PaperTeamData\M15\M15_11
const OUT_DIR = join(ROOT, "phase-c", "out");
const CALLS_LOG = join(ROOT, "phase-c", "model-calls.jsonl");
const PROJECTS_ROOT = join(ROOT, "phase-c", "projects-root");
const LEDGER = join(ROOT, "phase-c", "budget-ledger.json");
const REPO = "D:\\Projects\\PaperTeam";

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const role = argOf("--role") ?? "dev";
const arms = (argOf("--arms") ?? "c0,c1").split(",");
const famFilter = argOf("--fam");
const famsArg = argOf("--fams");

// ---- env 必须在 import dist 之前设置（loadConfig 读 process.env）----
process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "600";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "1";

await mkdir(OUT_DIR, { recursive: true });
await mkdir(PROJECTS_ROOT, { recursive: true });

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const families = manifest.families.filter(
  (f) => f.role === (role === "dev" ? "DEV" : role === "heldout" ? "HELD-OUT" : role.toUpperCase()) && f.familyId,
);
const targets = famFilter ? families.filter((f) => f.familyId === famFilter) : famsArg ? families.filter((f) => famsArg.split(",").includes(f.familyId)) : families;
if (targets.length === 0) throw new Error(`no families for role=${role}${famFilter ? ` fam=${famFilter}` : ""}`);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async (line) => {
  console.log(line);
  await appendFile(join(ROOT, "phase-c", "driver-log.txt"), `[${new Date().toISOString()}] ${line}\n`, "utf8").catch(() => {});
};

// ---- 装配（m1586 模板）----
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
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.11 arms",
});
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role_, scope) => skillRegistry.skillAssignmentsFor(role_, scope),
  roleCustomTools: (role_, pid) => {
    const tools = [];
    if (stackRef !== undefined && pid !== undefined) {
      if (role_ === "researcher" || role_ === "citation") {
        // existing_paper_review 不触 researcher/citation agent 工具；保守起见与生产一致接线
      }
      if (role_ === "reviewer" || role_ === "researcher" || role_ === "writer") {
        // reviewer 在生产 review/section 路径的 customTools 为空（SectionReviewService 不挂工具）
      }
    }
    return tools;
  },
  log: () => {},
});
let physicalCalls = 0;
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const idx = physicalCalls;
  const t0 = Date.now();
  let scopeHint = callArgs[0]?.contextScope ?? "";
  const result = await originalRunAgent(...callArgs);
  await appendFile(
    CALLS_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      callIndex: idx,
      contextScope: scopeHint,
      armHint: scopeHint.startsWith("m1511-c0/") ? "c0-direct" : scopeHint.startsWith("review/") ? "c1-workflow" : "other",
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
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: () => {},
});
stackRef = stack;
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
await log(`stack ready (port=${server.address().port}, model=${config.pi.model ?? "settings-default"}, families=${targets.length}, arms=${arms.join("+")})`);

// ---- 工具 ----
async function importPdf(famId) {
  const pdfPath = join(ROOT, "manuscripts", `${famId}.pdf`);
  const contentBase64 = (await readFile(pdfPath)).toString("base64");
  const created = await request("POST", "/projects/import-pdf", { fileName: `${famId}.pdf`, contentBase64, goal: "review_only" });
  if (created.status !== 200 && created.status !== 201) throw new Error(`import-pdf failed ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
  return created.body.project.id;
}
async function waitRun(runId, budgetMs = 45 * 60_000) {
  const startedAt = Date.now();
  for (;;) {
    const { body } = await request("GET", `/runs/${runId}`);
    const run = body.run;
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (Date.now() - startedAt > budgetMs) throw new Error(`run ${runId} timeout (status=${run.status})`);
    await sleep(5_000);
  }
}
async function runC1(famId, projectId) {
  const t0 = Date.now();
  const callsBefore = physicalCalls;
  const started = await request("POST", `/projects/${projectId}/workflows`, { kind: "existing_paper_review", citationSemanticMode: "off" });
  if (started.status !== 202) throw new Error(`workflow start failed ${started.status}: ${JSON.stringify(started.body).slice(0, 200)}`);
  const run = await waitRun(started.body.runId);
  const reportPath = run.stageResults?.["review.aggregate"]?.["reportPath"] ?? null;
  let report = null;
  if (reportPath) {
    const abs = join(PROJECTS_ROOT, projectId, reportPath);
    if (existsSync(abs)) report = JSON.parse(await readFile(abs, "utf8"));
  }
  return {
    arm: "c1",
    status: run.status,
    runId: run.runId ?? started.body.runId,
    wallMs: Date.now() - t0,
    calls: physicalCalls - callsBefore,
    findingsTotal: run.stageResults?.["review.sections"]?.["findingsTotal"] ?? (report?.findings?.length ?? null),
    sectionsReviewed: run.stageResults?.["review.sections"]?.["sectionsReviewed"] ?? null,
    sectionsTotal: run.stageResults?.["review.sections"]?.["sectionsTotal"] ?? null,
    failedSections: run.stageResults?.["review.sections"]?.["failedSections"] ?? [],
    stageResults: run.stageResults ?? {},
    report,
  };
}
async function runC0(famId, projectId) {
  const t0 = Date.now();
  const callsBefore = physicalCalls;
  const chunksRaw = await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).sort((a, b) => a.sequence - b.sequence);
  const pages = new Map();
  for (const c of chunks) {
    const label = `[page ${c.pageStart}${c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}]`;
    pages.set(label, (pages.get(label) ?? "") + c.text + "\n");
  }
  const manuscriptText = [...pages.entries()].map(([label, text]) => `${label}\n${text}`).join("\n");
  const prompt = C0_PROMPT + manuscriptText;
  let attempt = 0;
  let last = null;
  for (;;) {
    attempt += 1;
    const task = await adapter.runAgent({
      agentId: "main",
      projectId,
      contextScope: `m1511-c0/${famId}`,
      task: prompt,
      toolPolicy: "read_only",
      metadata: { arm: "c0", attempt },
    });
    const output = task.output ?? "";
    last = { task };
    if (task.status === "completed" && output.trim() !== "") {
      const parsed = parseSectionFindingsOutput(output);
      if (!parsed.parseFailed) {
        return {
          arm: "c0",
          status: "ok",
          wallMs: Date.now() - t0,
          calls: physicalCalls - callsBefore,
          attempts: attempt,
          inputChars: prompt.length,
          manuscriptChars: manuscriptText.length,
          rawOutputChars: output.length,
          findings: parsed.findings,
          dropped: parsed.dropped,
          parseFailed: false,
        };
      }
    }
    if (attempt >= 2) {
      return {
        arm: "c0",
        status: task.status === "completed" ? "parse_failed" : `agent_${task.status}`,
        wallMs: Date.now() - t0,
        calls: physicalCalls - callsBefore,
        attempts: attempt,
        inputChars: prompt.length,
        manuscriptChars: manuscriptText.length,
        parseFailed: true,
        error: (task.error ?? "").slice(0, 300),
        findings: [],
      };
    }
    await sleep(2_000);
  }
}

// ---- 主循环 ----
const summary = [];
for (const fam of targets) {
  const famId = fam.familyId;
  const outDir = join(OUT_DIR, famId);
  const wantC1 = arms.includes("c1");
  const wantC0 = arms.includes("c0");
  const c1Done = existsSync(join(outDir, "c1.json"));
  const c0Done = existsSync(join(outDir, "c0.json"));
  const runC1Flag = wantC1 && !c1Done;
  const runC0Flag = wantC0 && !c0Done;
  if (!runC1Flag && !runC0Flag) {
    await log(`${famId}: all requested arms already present, skipping`);
    summary.push({ famId, skipped: true });
    continue;
  }
  await mkdir(outDir, { recursive: true });
  await log(`=== ${famId} (${fam.role}) ===`);
  const famMeta = { famId, role: fam.role, startedAt: new Date().toISOString() };
  try {
    const projectId = await importPdf(famId);
    famMeta.projectId = projectId;
    let c0 = null;
    let c1 = null;
    try {
      if (runC1Flag) {
        await log(`${famId}: C1 workflow start`);
        c1 = await runC1(famId, projectId);
        await writeFile(join(outDir, "c1.json"), JSON.stringify(c1, null, 1), "utf8");
        await log(`${famId}: C1 ${c1.status} calls=${c1.calls} findings=${c1.findingsTotal} wall=${Math.round(c1.wallMs / 1000)}s`);
      }
    } catch (e) {
      c1 = { arm: "c1", status: "error", error: String(e.message).slice(0, 300) };
      await writeFile(join(outDir, "c1.json"), JSON.stringify(c1, null, 1), "utf8");
      await log(`${famId}: C1 ERROR ${e.message}`);
    }
    try {
      if (runC0Flag) {
        await log(`${famId}: C0 direct review`);
        c0 = await runC0(famId, projectId);
        await writeFile(join(outDir, "c0.json"), JSON.stringify(c0, null, 1), "utf8");
        await log(`${famId}: C0 ${c0.status} calls=${c0.calls} findings=${c0.findings.length} wall=${Math.round(c0.wallMs / 1000)}s`);
      }
    } catch (e) {
      c0 = { arm: "c0", status: "error", error: String(e.message).slice(0, 300) };
      await writeFile(join(outDir, "c0.json"), JSON.stringify(c0, null, 1), "utf8");
      await log(`${famId}: C0 ERROR ${e.message}`);
    }
    famMeta.finishedAt = new Date().toISOString();
    famMeta.c1 = { status: c1?.status, calls: c1?.calls ?? null, findingsTotal: c1?.findingsTotal ?? null };
    famMeta.c0 = { status: c0?.status, calls: c0?.calls ?? null, findings: c0?.findings?.length ?? null };
  } catch (e) {
    famMeta.error = String(e.message).slice(0, 300);
    await log(`${famId}: FATAL ${e.message}`);
  }
  await writeFile(join(outDir, "meta.json"), JSON.stringify(famMeta, null, 1), "utf8");
  summary.push({ famId, c1: famMeta.c1, c0: famMeta.c0, error: famMeta.error ?? null });
}
await log(`batch complete: ${summary.length} families; total physical calls so far: ${physicalCalls}`);
console.log(JSON.stringify(summary, null, 1));
server.close();
process.exit(0);
