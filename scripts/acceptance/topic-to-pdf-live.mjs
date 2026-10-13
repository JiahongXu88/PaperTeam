/** M13 Final Closure — REAL Topic → PDF through the PRODUCTION orchestrator (no replay, no seeding).
 *
 * Usage:
 *   PROJECTS_ROOT=<isolated root> node topic-to-pdf-live.mjs REPO_ROOT OUTPUT_DIR --model provider/model --topic "<题目>"
 *        [--field "<研究领域>"] [--language zh] [--year-from 2020] [--year-to 2026] [--target-length "..."]
 *        [--max-tasks 80] [--max-candidates 14] [--max-revision-rounds N] [--budget-file PATH]
 *        [--recover RUN_ID --project-id P] [--dry-run]
 *
 * What runs (all production code from backend/dist, in-process HTTP server, production WorkflowOrchestrator):
 *   POST /api/projects (documentType=survey) → POST /api/projects/:id/workflows (topic_survey) →
 *   research.plan → hitl.research_plan → survey.search (OpenAlex / arXiv / Semantic Scholar; SearXNG optional) →
 *   hitl.literature_selection → survey.fulltext (OA resolver chain + docling) → survey.matrix → hitl.matrix_confirm →
 *   survey.synthesis → survey.outline → hitl.outline_confirm → writing.sections → citation.verify → review.run →
 *   quality.gate → revision.* → build.draft / build.final.
 *
 * HITL protocol (fixed before LIVE; every decision is recorded in result.hitl):
 *   research_plan → approve; literature_selection → approve with the system's recommended set (paper-like first: DOI /
 *   arXiv-bearing, year desc) truncated to --max-candidates (bandwidth / docling time bound — not content-based);
 *   matrix_confirm → approve; outline_confirm → approve; revision_validation → reject (restore; never approve over a
 *   guard) at most twice, then needs_review; revision_stalled / revision_overflow → accept_draft.
 *   No reviewer verdict, evidence, source or gate result is ever injected or edited.
 *
 * Safety: refuses to run unless PROJECTS_ROOT is an isolated root (not <repo>/backend/projects) and no other active run
 * exists under it. Model calls go through the shared ledger (one reservation per runtime task; hard cap, never extended).
 */
import { mkdir, readFile, writeFile, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { freemem, totalmem } from "node:os";

import {
  parseCli,
  resolveRepoPaths,
  distLoader,
  loadBudget,
  recordRuntime,
  summarizeCalls,
  createModelRuntime,
  createProductionAdapter,
  dryRunRuntime,
  sha256,
} from "./lib/m13-7-live.mjs";

const { positional, flags } = parseCli(process.argv);
const [repoArg, outputArg] = positional;
if (!repoArg || !outputArg) throw new Error("Expected REPO_ROOT OUTPUT_DIR");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 80);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 80) throw new Error("--max-tasks must be an integer in 1..80");
const maxCandidates = Number(flags["max-candidates"] ?? 14);
if (!Number.isInteger(maxCandidates) || maxCandidates < 3 || maxCandidates > 25) throw new Error("--max-candidates must be 3..25");
const recoverRunId = typeof flags.recover === "string" ? flags.recover : undefined;
const recoverProjectId = typeof flags["project-id"] === "string" ? flags["project-id"] : undefined;
if ((recoverRunId === undefined) !== (recoverProjectId === undefined)) throw new Error("--recover RUN_ID requires --project-id");
/** Start a NEW run on an existing acceptance project (front stages reuse their persisted artefacts idempotently). */
const reuseProjectId = typeof flags["reuse-project"] === "string" ? flags["reuse-project"] : undefined;
if (reuseProjectId !== undefined && recoverRunId !== undefined) throw new Error("--reuse-project and --recover are mutually exclusive");
const topic = typeof flags.topic === "string" ? flags.topic.trim() : "";
if (recoverRunId === undefined && reuseProjectId === undefined && topic === "") throw new Error("--topic is required for a fresh start");
const field = typeof flags.field === "string" ? flags.field : undefined;
const language = typeof flags.language === "string" ? flags.language : "zh";
const yearFrom = flags["year-from"] !== undefined ? Number(flags["year-from"]) : undefined;
const yearTo = flags["year-to"] !== undefined ? Number(flags["year-to"]) : undefined;
const targetLength = typeof flags["target-length"] === "string" ? flags["target-length"] : undefined;
const maxRevisionRounds = flags["max-revision-rounds"] !== undefined ? Number(flags["max-revision-rounds"]) : undefined;
if (maxRevisionRounds !== undefined && (!Number.isInteger(maxRevisionRounds) || maxRevisionRounds < 0 || maxRevisionRounds > 5)) throw new Error("--max-revision-rounds must be 0..5");

const { repo, output } = resolveRepoPaths(repoArg, outputArg);
const load = distLoader(repo);
await mkdir(output, { recursive: true });
const budgetPath = flags["budget-file"] ? resolve(flags["budget-file"]) : join(output, "..", "model-budget.json");
const budget = await loadBudget(budgetPath, MAX_TASKS);

const { loadConfig } = await load("config/config.js");
const { buildServiceStack } = await load("serviceStack.js");
const { createTopicSurveyDefinition } = await load("workflow/definitions.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { LatexCompiler } = await load("latex/LatexCompiler.js");
const { WorkflowOrchestrator } = await load("workflow/WorkflowOrchestrator.js");
const { WorkflowRunStore } = await load("workflow/runStore.js");
const { createBackendHttpServer } = await load("httpServer.js");

const config = loadConfig();
const defaultProjectsRoot = resolve(repo, "backend", "projects");
if (resolve(config.projectsRoot) === defaultProjectsRoot || !process.env.PROJECTS_ROOT) {
  throw new Error(`refusing to run against the default projects root (${config.projectsRoot}); set PROJECTS_ROOT to an isolated acceptance root`);
}
const phase = recoverRunId !== undefined ? "recover" : reuseProjectId !== undefined ? "rerun" : "start";
const resultPath = join(output, `result-${phase}.json`);
const result = {
  milestone: "M13 Final Closure",
  experiment: "REAL Topic → PDF through the production orchestrator (topic_survey; no replay / no seeding)",
  phase,
  mode: dryRun ? "dry-run" : "live",
  model: modelSpec ?? null,
  projectsRoot: config.projectsRoot,
  topic: topic || null,
  options: {
    field: field ?? null,
    language,
    yearFrom: yearFrom ?? null,
    yearTo: yearTo ?? null,
    targetLength: targetLength ?? null,
    maxTasks: MAX_TASKS,
    maxCandidates,
    maxRevisionRounds: maxRevisionRounds ?? config.review.maxRevisionRounds,
    academicConfirmation: { band: config.review.academicConfirmationBand, samples: config.review.academicConfirmationSamples },
    argumentUnits: config.workflow.argumentUnitWriting,
    searchProviders: {
      searxng: config.search.searxngUrl ? "configured" : "absent (optional)",
      disabled: config.search.disabledProviders,
      semanticScholarKey: config.search.semanticScholarApiKey ? "configured" : "anonymous",
      openalexMailto: config.search.openalexMailto ? "configured" : "none",
    },
    recover: recoverRunId ?? null,
    reuseProject: reuseProjectId ?? null,
  },
  budgetFile: budgetPath,
  startedAt: new Date().toISOString(),
  hitlProtocol:
    "research_plan→approve; literature_selection→approve(recommended ∩ paper-like, cap --max-candidates); matrix_confirm→approve; outline_confirm→approve; revision_validation→reject×≤2 then needs_review; revision_stalled/overflow→accept_draft; nothing injected",
  calls: [],
  hitl: [],
  events: [],
  resources: [],
  stageTimeline: [],
};
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));
await save();

let stack;
let adapter = null;
let recording = null;
if (!dryRun) {
  const { modelRuntime } = await createModelRuntime({ repo, load, config, modelSpec });
  const created = await createProductionAdapter({ repo, load, config, modelSpec, modelRuntime, projectsRoot: config.projectsRoot, stackRef: () => stack, maxConcurrentRuns: 3 });
  adapter = created.adapter;
  recording = recordRuntime({ runtime: adapter, budget, budgetPath, output, result, save });
}
const projects = new ProjectStore({ root: config.projectsRoot });
stack = buildServiceStack({
  runtime: recording ?? dryRunRuntime(),
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.workflow.stageTimeoutMs,
  stageMaxAttempts: config.workflow.stageMaxAttempts,
  writing: { argumentUnits: config.workflow.argumentUnitWriting },
  longRunTimeoutMs: config.pi.longRunTimeoutMs,
  review: {
    maxRevisionRounds: maxRevisionRounds ?? config.review.maxRevisionRounds,
    academicPassScore: config.review.academicPassScore,
    styleRiskMax: config.review.styleRiskMax,
    academicConfirmationBand: config.review.academicConfirmationBand,
    academicConfirmationSamples: config.review.academicConfirmationSamples,
    reviewConcurrency: config.review.reviewConcurrency,
    reviewSectionLimit: config.review.reviewSectionLimit,
    revisionTask: config.review.revisionTask,
  },
  summaryConcurrency: config.review.summaryConcurrency,
  citation: {
    metadataEnabled: config.citation.metadataEnabled,
    maxMetadataLookups: config.citation.maxMetadataLookups,
    metadataTimeoutMs: config.citation.metadataTimeoutMs,
    ...(config.citation.contactEmail ? { contactEmail: config.citation.contactEmail } : {}),
  },
  search: config.search,
  fullText: { batchConcurrency: config.fullText.batchConcurrency },
  ...(config.pdf.pythonCommand !== undefined ? { pdfPythonCommand: config.pdf.pythonCommand } : {}),
  ...(config.pdf.doclingPythonCommand !== undefined ? { doclingPythonCommand: config.pdf.doclingPythonCommand } : {}),
  doclingMaxConcurrency: config.ingestion.doclingConcurrency,
  log: (message) => {
    result.events.push(`[${new Date().toISOString()}][stack] ${String(message).slice(0, 400)}`);
  },
});
const services = stack.workflowServices;
const runStore = new WorkflowRunStore(projects, { log: () => {} });
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore,
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") throw new Error(`this driver only assembles topic_survey (got ${kind})`);
    return createTopicSurveyDefinition(services);
  },
  log: (message) => {
    result.events.push(`[${new Date().toISOString()}][orchestrator] ${String(message).slice(0, 400)}`);
  },
});
const server = createBackendHttpServer({ runtime: adapter ?? dryRunRuntime(), projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = { raw: true };
  }
  return { status: response.status, body: parsed };
}

// Resource monitor (every 30 s): process RSS / heap, OS free memory, adapter stats.
const monitor = setInterval(() => {
  const memory = process.memoryUsage();
  result.resources.push({
    at: new Date().toISOString(),
    rssMB: Math.round(memory.rss / 1048576),
    heapUsedMB: Math.round(memory.heapUsed / 1048576),
    osFreeMB: Math.round(freemem() / 1048576),
    osTotalMB: Math.round(totalmem() / 1048576),
    runtime: adapter?.runtimeStats ? (() => { try { const stats = adapter.runtimeStats(); return { activeRuns: stats.activeRuns, managedSessions: stats.managedSessions }; } catch { return null; } })() : null,
  });
  save().catch(() => {});
}, 30_000);

let projectId = recoverProjectId ?? reuseProjectId ?? null;
let runId = recoverRunId ?? null;
let run = null;
let validationRejects = 0;
let interrupted = false;
const onSignal = async () => {
  interrupted = true;
  result.status = "INTERRUPTED_BY_SIGNAL";
  result.events.push(`[${new Date().toISOString()}] SIGINT/SIGTERM received; checkpoint stays on disk for --recover`);
  await save();
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  // Safety: recoverInterruptedRuns() scans EVERY project under PROJECTS_ROOT.
  for (const otherProjectId of await projects.list()) {
    for (const otherRunId of await runStore.listRunIds(otherProjectId)) {
      const state = await runStore.loadCheckpoint(otherProjectId, otherRunId);
      if (state === null) continue;
      const active = ["pending", "running", "awaiting_input"].includes(state.status);
      if (active && !(recoverRunId !== undefined && otherRunId === recoverRunId && otherProjectId === projectId)) {
        throw new Error(`another active run exists under PROJECTS_ROOT: ${otherProjectId}/${otherRunId} (${state.status}); cancel it first`);
      }
    }
  }
  const providers = await request("GET", "/research/providers");
  result.providersAtStart = providers.body;
  const runtimeStatus = await request("GET", "/runtime/status");
  result.runtimeAtStart = runtimeStatus.body;
  await save();

  if (recoverRunId === undefined) {
    if (reuseProjectId === undefined) {
      const created = await request("POST", "/projects", {
        title: topic,
        documentType: "survey",
        language,
        ...(field !== undefined ? { researchField: field } : {}),
      });
      if (created.status !== 201) throw new Error(`create project failed: ${created.status} ${JSON.stringify(created.body).slice(0, 400)}`);
      projectId = created.body.project.id;
      result.project = { id: projectId, workflowKind: created.body.project.workflowKind, documentType: created.body.project.documentType, language: created.body.project.language };
    } else {
      const existing = await request("GET", `/projects/${reuseProjectId}`);
      if (existing.status !== 200) throw new Error(`reuse project not found: ${existing.status}`);
      result.project = { id: reuseProjectId, reused: true, title: existing.body.project?.title ?? null, workflowKind: existing.body.project?.workflowKind ?? null };
      result.topic = existing.body.project?.title ?? null;
    }
    result.projectId = projectId;
    await save();
    const started = await request("POST", `/projects/${projectId}/workflows`, {
      kind: "topic_survey",
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(yearTo !== undefined ? { yearTo } : {}),
      ...(targetLength !== undefined ? { targetLength } : {}),
    });
    if (started.status !== 202) throw new Error(`start workflow failed: ${started.status} ${JSON.stringify(started.body).slice(0, 400)}`);
    runId = started.body.runId;
    result.runId = runId;
  } else {
    result.projectId = projectId;
    const recovered = await orchestrator.recoverInterruptedRuns();
    result.recovered = recovered;
    const mine = recovered.find((entry) => entry.runId === runId);
    if (mine === undefined) throw new Error(`run ${runId} was not recovered from disk: ${JSON.stringify(recovered)}`);
    result.recoveredOutcome = mine.outcome;
    result.runId = runId;
  }
  await save();

  const startedAt = Date.now();
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  let lastStage = null;
  let lastStatus = null;
  for (;;) {
    const { status, body } = await request("GET", `/runs/${runId}`);
    if (status !== 200) throw new Error(`GET run failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    run = body.run;
    if (run.currentStage !== lastStage || run.status !== lastStatus) {
      lastStage = run.currentStage;
      lastStatus = run.status;
      result.stageTimeline.push({ at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 6000) / 10, stage: run.currentStage, status: run.status });
      await save();
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      const payload = run.awaiting?.payload ?? {};
      let decision = "approve";
      let decisionPayload;
      let rationale = "pre-authorised acceptance continuation (ordinary confirmation point)";
      if (stageId === "hitl.literature_selection") {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const recommended = Array.isArray(payload.recommendedCandidateIds) ? payload.recommendedCandidateIds : [];
        const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
        // Follow the system's recommendation order; prefer paper-like identity (arXiv / DOI) so full text can be resolved;
        // truncate for bandwidth / docling time. Never pick by content.
        const ordered = [
          ...recommended.filter((id) => byId.get(id)?.arxivId !== undefined),
          ...recommended.filter((id) => byId.get(id)?.arxivId === undefined && byId.get(id)?.doi !== undefined),
          ...recommended.filter((id) => byId.get(id)?.arxivId === undefined && byId.get(id)?.doi === undefined),
        ];
        const selected = ordered.slice(0, maxCandidates);
        if (selected.length > 0) decisionPayload = { candidateIds: selected };
        rationale = `recommended=${recommended.length} pending=${payload.pendingCount ?? "?"} → selected ${selected.length} (arXiv-first, then DOI; cap ${maxCandidates})`;
        result.literatureSelection = {
          pendingCount: payload.pendingCount ?? null,
          recommendedCandidateIds: recommended,
          selectedCandidateIds: selected,
          selected: selected.map((id) => byId.get(id) ?? { candidateId: id }),
          notSelected: recommended.filter((id) => !selected.includes(id)).map((id) => byId.get(id) ?? { candidateId: id }),
          allCandidates: candidates,
          questions: payload.questions ?? null,
          taxonomyIntent: payload.taxonomyIntent ?? null,
        };
      } else if (stageId === "hitl.revision_validation") {
        validationRejects += 1;
        decision = validationRejects <= 2 ? "reject" : "needs_review";
        rationale = decision === "reject"
          ? "validation blocked by a deterministic guard → restore previous revision (never approve over a guard)"
          : "third blocked validation → needs_review (keeps revision; blocks Final; author decision boundary)";
      } else if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
        decision = "accept_draft";
        rationale = stageId === "hitl.revision_stalled" ? "NO_PROGRESS → honest draft terminal" : "revision budget exhausted → honest draft terminal";
      } else if (stageId === "hitl.style_polish") {
        decision = "skip";
      }
      result.hitl.push({
        stageId,
        decision,
        ...(decisionPayload !== undefined ? { payload: decisionPayload } : {}),
        rationale,
        at: new Date().toISOString(),
        elapsedMin: Math.round((Date.now() - startedAt) / 6000) / 10,
        prompt: run.awaiting?.prompt ?? null,
        awaitingPayload: JSON.parse(JSON.stringify(payload).slice(0, 20000)),
      });
      await save();
      const resume = await request("POST", `/runs/${runId}/resume`, { decision, ...(decisionPayload !== undefined ? { payload: decisionPayload } : {}) });
      if (resume.status !== 200) throw new Error(`resume ${stageId} failed: ${resume.status} ${JSON.stringify(resume.body).slice(0, 400)}`);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timeout (${run.status} / ${run.currentStage})`);
    await new Promise((wait) => setTimeout(wait, 3000));
  }
  result.status = run.status === "completed" ? "COMPLETED" : run.status.toUpperCase();
  result.run = { status: run.status, completion: run.completion ?? null, error: run.error ?? null, completedStages: run.completedStages, stageResults: run.stageResults, stageHistory: run.stageHistory, counters: run.counters ?? {} };
} catch (error) {
  result.status = interrupted ? "INTERRUPTED_BY_SIGNAL" : "FAILED";
  result.error = error.message;
  result.errorStack = String(error.stack ?? "").slice(0, 2000);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  if (dryRun && runId !== null) await orchestrator.cancel(runId).catch(() => {});
  try {
    if (projectId !== null) {
      const projectDir = projects.projectDir(projectId);
      for (const sub of ["research", "evidence", "manuscript", "reviews", "build", "artifacts", "sources", "workflow"]) {
        const dir = join(projectDir, sub);
        if (existsSync(dir)) await cp(dir, join(output, `project-${phase}`, sub), { recursive: true });
      }
      for (const file of ["project.json"]) {
        const path = join(projectDir, file);
        if (existsSync(path)) await cp(path, join(output, `project-${phase}`, file));
      }
      // Hashes of the main artefacts (PDF / main.tex / bib / outline / synthesis / matrix / research plan)
      const hashes = {};
      const hashDirs = [join(projectDir, "artifacts"), join(projectDir, "build"), join(projectDir, "manuscript"), join(projectDir, "research")];
      for (const dir of hashDirs) {
        if (!existsSync(dir)) continue;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!/\.(pdf|tex|bib|json)$/i.test(entry.name)) continue;
          const path = join(dir, entry.name);
          hashes[relative(projectDir, path).replaceAll("\\", "/")] = sha256(await readFile(path));
        }
      }
      result.artifactSha256 = hashes;
      const [sources, candidatesAccepted, evidence, artifacts] = await Promise.all([
        request("GET", `/projects/${projectId}/sources`),
        request("GET", `/projects/${projectId}/sources/candidates?status=accepted`),
        request("GET", `/projects/${projectId}/evidence`),
        request("GET", `/projects/${projectId}/artifacts`),
      ]);
      result.counts = {
        sources: Array.isArray(sources.body?.sources) ? sources.body.sources.length : sources.body,
        acceptedCandidates: Array.isArray(candidatesAccepted.body?.candidates) ? candidatesAccepted.body.candidates.length : candidatesAccepted.body,
        evidence: Array.isArray(evidence.body?.evidence) ? evidence.body.evidence.length : evidence.body,
        evidenceVerified: Array.isArray(evidence.body?.evidence) ? evidence.body.evidence.filter((record) => record.verificationStatus === "verified").length : null,
        artifacts: artifacts.body,
      };
      result.sourcesList = sources.body;
      result.evidenceList = evidence.body;
      const providersEnd = await request("GET", "/research/providers");
      result.providersAtEnd = providersEnd.body;
      const runtimeEnd = await request("GET", "/runtime/status");
      result.runtimeAtEnd = runtimeEnd.body;
    }
  } catch (error) {
    result.artifactError = error.message;
  }
  result.finishedAt = new Date().toISOString();
  summarizeCalls(result);
  await save();
  await new Promise((done) => server.close(done));
  await orchestrator.close();
  if (adapter) await adapter.close();
  console.log(
    JSON.stringify({
      phase,
      status: result.status,
      projectId,
      runId,
      runStatus: run?.status ?? null,
      label: run?.completion?.label ?? null,
      qualityStatus: run?.completion?.summary?.qualityStatus ?? null,
      calls: result.calls.length,
      turns: result.assistantTurns,
      callsByScope: result.callsByScope,
      hitl: result.hitl.map((entry) => `${entry.stageId}:${entry.decision}`),
      error: result.error ?? run?.error ?? null,
    }),
  );
}
