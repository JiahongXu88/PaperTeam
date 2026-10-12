/** M13.7.11 survey tail through the PRODUCTION orchestrator: Research → PDF second half on an existing seeded project.
 *
 * Usage:
 *   node survey-tail-live.mjs REPO_ROOT PROJECT_ID OUTPUT_DIR --model provider/model [--max-tasks 40] [--budget-file PATH]
 *        [--replay-front] [--recover RUN_ID] [--interrupt-at hitl.<stage>] [--stalled accept_draft|revise_more]
 *        [--max-revision-rounds N] [--dry-run]
 *
 * Mode of truth (reported as such, never as a Topic → PDF E2E):
 *   --replay-front  Stage Replay: the project already holds research artefacts (sources / formal evidence / Survey Matrix /
 *                   Structured Synthesis / frozen corpus / outline / written sections, e.g. the Arm B project of
 *                   argument-unit-ab-live.mjs). A WorkflowState checkpoint is written with the ten front stages marked
 *                   `replayed` (no Planner / search / matrix / synthesis request is issued in this run) and handed to
 *                   WorkflowOrchestrator.recoverInterruptedRuns() — the production checkpoint-recovery interface. The run then
 *                   continues through the production planner: writing.sections (idempotent reuse when the outline fingerprint
 *                   matches the written revision) → citation.verify → review.run → quality.gate → revision.* → build.*.
 *   --recover RUN_ID  Second process: recover the run left awaiting input by --interrupt-at and drive it to completion.
 *   --interrupt-at   Exit the process (checkpoint persisted) when the run first awaits the given HITL stage.
 * HITL protocol (fixed before LIVE): outline / validation → approve; stalled → --stalled (default accept_draft);
 * overflow → accept_draft; style_polish → skip. No reviewer PASS is ever injected.
 * Model calls are recorded and budgeted through the shared ledger (one reservation per runtime task).
 */
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
  collectSections,
  evaluateSurveySections,
} from "./lib/m13-7-live.mjs";

const { positional, flags } = parseCli(process.argv);
const [repoArg, projectId, outputArg] = positional;
if (!repoArg || !projectId || !outputArg) throw new Error("Expected REPO_ROOT PROJECT_ID OUTPUT_DIR");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 40);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 40) throw new Error("--max-tasks must be an integer in 1..40");
const replayFront = flags["replay-front"] === true;
const recoverRunId = typeof flags.recover === "string" ? flags.recover : undefined;
const interruptAt = typeof flags["interrupt-at"] === "string" ? flags["interrupt-at"] : undefined;
const stalledDecision = flags.stalled === "revise_more" ? "revise_more" : "accept_draft";
const maxRevisionRounds = flags["max-revision-rounds"] !== undefined ? Number(flags["max-revision-rounds"]) : undefined;
if (maxRevisionRounds !== undefined && (!Number.isInteger(maxRevisionRounds) || maxRevisionRounds < 0 || maxRevisionRounds > 5)) throw new Error("--max-revision-rounds must be 0..5");
if (!replayFront && recoverRunId === undefined) throw new Error("Choose --replay-front (new run from replayed checkpoint) or --recover RUN_ID");
const { repo, output } = resolveRepoPaths(repoArg, outputArg);
const load = distLoader(repo);
await mkdir(output, { recursive: recoverRunId !== undefined });
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
const { resolveArgumentUnits } = await load("writer/argumentUnit.js");
const { SurveySynthesisArtifactStore } = await load("survey/surveyArtifacts.js");

const config = loadConfig();
const phase = recoverRunId !== undefined ? "recover" : "start";
const resultPath = join(output, `result-${phase}.json`);
const result = {
  milestone: "M13.7.11",
  experiment: "survey production tail (Stage Replay → Review / Gate / Revision / PDF) via WorkflowOrchestrator",
  phase,
  mode: dryRun ? "dry-run" : "live",
  model: modelSpec ?? null,
  projectId,
  maxTasks: MAX_TASKS,
  budgetFile: budgetPath,
  startedAt: new Date().toISOString(),
  options: { replayFront, recoverRunId: recoverRunId ?? null, interruptAt: interruptAt ?? null, stalledDecision, maxRevisionRounds: maxRevisionRounds ?? config.review.maxRevisionRounds },
  calls: [],
  hitl: [],
  events: [],
  scope: replayFront
    ? "STAGE REPLAY: front stages (research.plan … hitl.outline_confirm) marked replayed in the checkpoint; research artefacts were seeded from the frozen M13.7.9 fixture (abstract-level verified evidence) and the outline is a real M13.7.10 Planner output; writing.sections reused if already written; tail stages run for real"
    : "RECOVERY: continue a run left awaiting input from its persisted checkpoint (recoverInterruptedRuns + resume)",
};
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));

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
  writing: { argumentUnits: true },
  longRunTimeoutMs: config.pi.longRunTimeoutMs,
  review: {
    maxRevisionRounds: maxRevisionRounds ?? config.review.maxRevisionRounds,
    academicPassScore: config.review.academicPassScore,
    styleRiskMax: config.review.styleRiskMax,
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
  search: { ...config.search, disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"] },
  fullText: { batchConcurrency: config.fullText.batchConcurrency },
  log: (message) => {
    result.events.push(`[stack] ${message.slice(0, 300)}`);
  },
});
const services = stack.workflowServices;
await projects.getRequired(projectId);
const runStore = new WorkflowRunStore(projects, { log: () => {} });
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore,
  definitionFactory: (kind) => {
    if (kind !== "topic_survey") throw new Error(`this driver only assembles topic_survey (got ${kind})`);
    return createTopicSurveyDefinition(services);
  },
  log: (message) => {
    result.events.push(`[orchestrator] ${message.slice(0, 300)}`);
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

const FRONT = ["research.plan", "hitl.research_plan", "survey.search", "hitl.literature_selection", "survey.fulltext", "survey.matrix", "hitl.matrix_confirm", "survey.synthesis", "survey.outline", "hitl.outline_confirm"];
const REPLAY_NOTE = "M13.7.11 stage replay: research artefacts seeded from the frozen M13.7.9 fixture (abstract-level verified evidence, Survey Matrix, Structured Synthesis, frozen corpus); outline = real M13.7.10 run-2 Planner output; this stage was NOT executed in this run";

let runId = recoverRunId ?? null;
let run = null;
let interrupted = false;
try {
  // Preconditions recorded before anything runs (what the tail will consume).
  const outline = await services.manuscript.loadOutline(projectId);
  const synthesis = await new SurveySynthesisArtifactStore(projects).read(projectId);
  const statuses = await services.manuscript.sectionStatuses(projectId);
  const revisions = await services.revisions.load(projectId);
  const plan = await services.reviewArtifacts.loadWritingPlan(projectId);
  const redundancy = await services.reviewArtifacts.latestAcademicRedundancy(projectId);
  result.preconditions = {
    outlineSections: outline?.sections.length ?? 0,
    sectionsWritten: statuses.filter((status) => status.exists && status.nonEmpty).length,
    currentRevision: revisions.revisions.length > 0 ? Math.max(...revisions.revisions.map((record) => record.revision)) : null,
    revisionReasons: revisions.revisions.map((record) => `${record.revision}:${record.reason}`),
    writingPlan: plan === null ? null : { fingerprint: plan.fingerprint.slice(0, 16), attempt: plan.attempt, revision: plan.revision ?? null, runId: plan.runId },
    redundancyReportRevision: redundancy?.revision ?? null,
    corpusFrozen: (await services.corpus.get(projectId)) !== null,
    acceptedCandidates: (await services.candidates.list(projectId, "accepted")).length,
    formalEvidence: (await services.evidence.list(projectId)).filter((record) => record.verificationStatus === "verified").length,
    argumentUnits: outline !== null && synthesis !== null ? resolveArgumentUnits({ outline, synthesis }).map((unit) => `${unit.sectionId}:${unit.role}`) : null,
  };
  await save();

  // Safety: recoverInterruptedRuns() scans EVERY project under PROJECTS_ROOT. Refuse to run if any other project has an
  // active checkpoint — recovering it here would spend model tasks on a run this acceptance does not own.
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
  if (replayFront) {
    const now = new Date().toISOString();
    runId = `w-replay${Date.now().toString(36)}`;
    const stageResults = {};
    for (const stageId of FRONT) {
      stageResults[stageId] = stageId.startsWith("hitl.") ? { decision: "approve", replayed: true, note: REPLAY_NOTE } : { replayed: true, note: REPLAY_NOTE };
    }
    const state = {
      schemaVersion: 1,
      runId,
      projectId,
      workflowKind: "topic_survey",
      status: "running",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      request: { acceptance: "M13.7.11 stage replay", replayedFront: FRONT },
      currentStage: "hitl.outline_confirm",
      completedStages: [...FRONT],
      stageResults,
      stageHistory: [],
      inputs: {},
      counters: {},
      eventsSeq: 0,
    };
    await runStore.saveCheckpoint(state);
    result.replayCheckpoint = { runId, path: runStore.checkpointPath(projectId, runId), completedStages: FRONT };
    const recovered = await orchestrator.recoverInterruptedRuns();
    result.recovered = recovered;
    if (!recovered.some((entry) => entry.runId === runId && entry.outcome === "restarted")) throw new Error(`recoverInterruptedRuns did not restart ${runId}: ${JSON.stringify(recovered)}`);
  } else {
    const recovered = await orchestrator.recoverInterruptedRuns();
    result.recovered = recovered;
    const mine = recovered.find((entry) => entry.runId === runId);
    if (mine === undefined) throw new Error(`run ${runId} was not recovered from disk: ${JSON.stringify(recovered)}`);
    result.recoveredOutcome = mine.outcome;
  }
  result.runId = runId;
  await save();

  const startedAt = Date.now();
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  let stalledSeen = 0;
  let lastStage = null;
  for (;;) {
    const { status, body } = await request("GET", `/runs/${runId}`);
    if (status !== 200) throw new Error(`GET run failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    run = body.run;
    if (run.currentStage !== lastStage) {
      lastStage = run.currentStage;
      result.events.push(`[${new Date().toISOString()}] stage=${run.currentStage} status=${run.status}`);
      await save();
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (interruptAt !== undefined && stageId === interruptAt && !result.hitl.some((entry) => entry.stageId === stageId && entry.interrupted)) {
        result.hitl.push({ stageId, at: new Date().toISOString(), interrupted: true, payload: run.awaiting?.payload ?? null });
        interrupted = true;
        result.status = "INTERRUPTED_AT_HITL";
        await save();
        break;
      }
      let decision = "approve";
      if (stageId === "hitl.revision_stalled") {
        stalledSeen += 1;
        decision = stalledSeen <= 1 ? stalledDecision : "accept_draft";
      } else if (stageId === "hitl.revision_overflow") decision = "accept_draft";
      else if (stageId === "hitl.style_polish") decision = "skip";
      else if (stageId === "hitl.literature_selection") {
        const accepted = await services.candidates.list(projectId, "accepted");
        if (accepted.length > 0) decision = "approve";
      }
      const payload = run.awaiting?.payload ?? {};
      result.hitl.push({ stageId, decision, at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 60000), payload: JSON.parse(JSON.stringify(payload).slice(0, 4000)) });
      await save();
      const resume = await request("POST", `/runs/${runId}/resume`, { decision });
      if (resume.status !== 200) throw new Error(`resume ${stageId} failed: ${resume.status} ${JSON.stringify(resume.body).slice(0, 400)}`);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timeout (${run.status} / ${run.currentStage})`);
    await new Promise((wait) => setTimeout(wait, 3000));
  }
  if (!interrupted) result.status = run.status === "completed" ? "COMPLETED" : run.status.toUpperCase();
  if (dryRun && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
    await orchestrator.cancel(runId).catch(() => {});
  }
  result.run = { status: run.status, completion: run.completion ?? null, error: run.error ?? null, completedStages: run.completedStages, stageResults: run.stageResults, stageHistory: run.stageHistory, counters: run.counters ?? {} };
} catch (error) {
  result.status = "FAILED";
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (dryRun && runId !== null) {
    // never leave a dry-run checkpoint active: a later LIVE recoverInterruptedRuns() would restart it with a real model
    await orchestrator.cancel(runId).catch(() => {});
  }
  try {
    // Artefacts: reviews dir (summaries / gate / plans / validation / redundancy / writing plan), iteration history, PDFs.
    const reviewsDir = projects.reviewsDir(projectId);
    if (existsSync(reviewsDir)) await cp(reviewsDir, join(output, `reviews-${phase}`), { recursive: true });
    const buildDir = join(projects.projectDir(projectId), "build");
    if (existsSync(buildDir)) await cp(buildDir, join(output, `build-${phase}`), { recursive: true });
    const artifactsDir = join(projects.projectDir(projectId), "artifacts");
    if (existsSync(artifactsDir)) await cp(artifactsDir, join(output, `artifacts-${phase}`), { recursive: true });
    const { sections } = await collectSections({ services, projectId, output, prefix: `manuscript-${phase}` });
    const outline = await services.manuscript.loadOutline(projectId);
    const synthesis = await new SurveySynthesisArtifactStore(projects).read(projectId);
    const roles = outline !== null && synthesis !== null ? Object.fromEntries(resolveArgumentUnits({ outline, synthesis }).map((unit) => [unit.sectionId, unit.role])) : undefined;
    if (sections.length > 0 && flags.fixture && flags.markers) {
      const fixture = JSON.parse(await readFile(flags.fixture, "utf8"));
      const markers = JSON.parse(await readFile(flags.markers, "utf8"));
      result.evaluation = await evaluateSurveySections({ load, services, projectId, fixture, markers, sections, roles, output, prefix: `manuscript-${phase}` });
    }
    const revisions = await services.revisions.load(projectId);
    result.revisions = revisions.revisions.map((record) => ({ revision: record.revision, reason: record.reason, runId: record.runId ?? null, at: record.createdAt ?? null }));
    const plan = await services.reviewArtifacts.loadWritingPlan(projectId);
    result.writingPlanAfter = plan === null ? null : { fingerprint: plan.fingerprint.slice(0, 16), previousFingerprint: plan.previousFingerprint?.slice(0, 16) ?? null, attempt: plan.attempt, revision: plan.revision ?? null, runId: plan.runId, warnings: plan.warnings };
    try {
      result.iterationHistory = JSON.parse(await readFile(join(reviewsDir, "iteration-history.json"), "utf8"));
    } catch {
      result.iterationHistory = null;
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
      runId,
      runStatus: run?.status ?? null,
      label: run?.completion?.label ?? null,
      qualityStatus: run?.completion?.summary?.qualityStatus ?? null,
      calls: result.calls.length,
      callsByScope: result.callsByScope,
      hitl: result.hitl.map((entry) => `${entry.stageId}:${entry.decision ?? "INTERRUPT"}`),
      error: result.error ?? run?.error ?? null,
    }),
  );
}
