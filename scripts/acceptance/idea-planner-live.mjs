/** M13.7.11 idea_to_paper real Planner + section-aware evidence allocation (no writing, no PDF).
 *
 * Usage:
 *   node idea-planner-live.mjs REPO_ROOT FIXTURE_JSON MARKERS_JSON OUTPUT_DIR --model provider/model --idea "…" \
 *        [--max-tasks 40] [--budget-file PATH] [--dry-run]
 *
 * Seeds an idea_to_paper project with the frozen fixture's four sources (metadata + public abstract) and twelve
 * abstract-level verified evidence records (formal pool), then drives the PRODUCTION idea_to_paper workflow through the
 * orchestrator (research.idea → evidence.ground → research.feasibility → hitl.feasibility_confirm → outline.plan) until the
 * run awaits hitl.outline_confirm. At that point the real Planner outline is recorded, the production
 * resolveArgumentUnits + allocateSectionEvidence are applied to it with the project's formal pool (exactly what
 * writingSectionsStage would do) and the run is CANCELLED — the writing stage is not executed: a research paper without
 * author-provided experiment data must stop at the Experiment Requirement / Author Decision boundary, never fabricate results.
 * Model tasks: research.idea (1) + research.feasibility (1) + outline.plan (1), plus any Evidence Grounding judge the
 * researcher's proposals trigger (recorded per scope). Budgeted through the shared ledger.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseCli,
  resolveRepoPaths,
  distLoader,
  sha256,
  loadBudget,
  recordRuntime,
  summarizeCalls,
  createModelRuntime,
  createProductionAdapter,
  dryRunRuntime,
  seedSurveyFixtureProject,
} from "./lib/m13-7-live.mjs";

const { positional, flags } = parseCli(process.argv);
const [repoArg, fixtureArg, markersArg, outputArg] = positional;
if (!repoArg || !fixtureArg || !markersArg || !outputArg) throw new Error("Expected REPO_ROOT FIXTURE_JSON MARKERS_JSON OUTPUT_DIR");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const idea = typeof flags.idea === "string" && flags.idea.trim() !== "" ? flags.idea.trim() : undefined;
if (idea === undefined) throw new Error("--idea TEXT is required (the research idea; frozen in protocol.json)");
const MAX_TASKS = Number(flags["max-tasks"] ?? 40);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 40) throw new Error("--max-tasks must be an integer in 1..40");
const { repo, output } = resolveRepoPaths(repoArg, outputArg);
const load = distLoader(repo);
const fixtureBytes = await readFile(fixtureArg);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const abstractsFile = markersArg.replace(/concept-markers-(\w+)\.json$/, "sources-abstracts-$1.json");
let abstracts = [];
try {
  abstracts = JSON.parse(await readFile(abstractsFile, "utf8")).sources ?? [];
} catch {
  abstracts = [];
}
await mkdir(output);
const budgetPath = flags["budget-file"] ? resolve(flags["budget-file"]) : join(output, "..", "model-budget.json");
const budget = await loadBudget(budgetPath, MAX_TASKS);

const { loadConfig } = await load("config/config.js");
const { buildServiceStack } = await load("serviceStack.js");
const { createIdeaToPaperDefinition } = await load("workflow/definitions.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { LatexCompiler } = await load("latex/LatexCompiler.js");
const { WorkflowOrchestrator } = await load("workflow/WorkflowOrchestrator.js");
const { WorkflowRunStore } = await load("workflow/runStore.js");
const { createBackendHttpServer } = await load("httpServer.js");
const { resolveArgumentUnits, renderArgumentUnitLines } = await load("writer/argumentUnit.js");
const { allocateSectionEvidence, projectAllocatedEvidence } = await load("evidence/sectionEvidenceAllocation.js");

const config = loadConfig();
const result = {
  milestone: "M13.7.11",
  experiment: "idea_to_paper real Planner + section-aware evidence allocation (stops at hitl.outline_confirm; no writing)",
  mode: dryRun ? "dry-run" : "live",
  model: modelSpec ?? null,
  idea,
  fixtureHash: sha256(fixtureBytes),
  maxTasks: MAX_TASKS,
  budgetFile: budgetPath,
  startedAt: new Date().toISOString(),
  calls: [],
  hitl: [],
  events: [],
};
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));

let stack;
let adapter = null;
let recording = null;
if (!dryRun) {
  const { modelRuntime } = await createModelRuntime({ repo, load, config, modelSpec });
  const created = await createProductionAdapter({ repo, load, config, modelSpec, modelRuntime, projectsRoot: config.projectsRoot, stackRef: () => stack, maxConcurrentRuns: 2 });
  adapter = created.adapter;
  // writing/* scopes are not allowed here: the acceptance must not write a research paper without experiment data
  recording = recordRuntime({ runtime: adapter, budget, budgetPath, output, result, save, allowScopes: ["research", "citation/evidence", "writing/outline", "target"] });
}
const projects = new ProjectStore({ root: config.projectsRoot });
stack = buildServiceStack({
  runtime: recording ?? dryRunRuntime(),
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.workflow.stageTimeoutMs,
  stageMaxAttempts: 1,
  writing: { argumentUnits: true },
  longRunTimeoutMs: config.pi.longRunTimeoutMs,
  citation: { metadataEnabled: false, scholarly: { providers: [] } },
  search: { ...config.search, disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"] },
  fullText: { enabled: false },
  log: (message) => {
    result.events.push(`[stack] ${message.slice(0, 300)}`);
  },
});
const services = stack.workflowServices;
const seeded = await seedSurveyFixtureProject({
  load,
  services,
  projects,
  fixture,
  abstracts,
  createdBy: "m13-7-11-idea-seed",
  workflowKind: "idea_to_paper",
  requestTitle: idea,
  researchIdea: idea,
  surveyArtifacts: false,
});
result.projectId = seeded.project.id;
result.seed = seeded.summary;
await save();

const runStore = new WorkflowRunStore(projects, { log: () => {} });
const orchestrator = new WorkflowOrchestrator({
  projects,
  runStore,
  definitionFactory: (kind) => {
    if (kind !== "idea_to_paper") throw new Error(`this driver only assembles idea_to_paper (got ${kind})`);
    return createIdeaToPaperDefinition(services);
  },
  log: (message) => {
    result.events.push(`[orchestrator] ${message.slice(0, 300)}`);
  },
});
const server = createBackendHttpServer({ runtime: adapter ?? dryRunRuntime(), projects, generation: stack.generation, orchestrator, stack });
await new Promise((onListen) => server.listen(0, "127.0.0.1", onListen));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, path, body) {
  const response = await fetch(`${base}/api${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = { raw: true };
  }
  return { status: response.status, body: parsed };
}

let runId = null;
let run = null;
try {
  if (dryRun) {
    result.status = "DRY_RUN_COMPLETED";
  } else {
    const started = await request("POST", `/projects/${seeded.project.id}/workflows`, { kind: "idea_to_paper" });
    if (started.status !== 202) throw new Error(`run start failed: ${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
    runId = started.body.runId;
    result.runId = runId;
    const deadline = Date.now() + 60 * 60 * 1000;
    let lastStage = null;
    for (;;) {
      const { body } = await request("GET", `/runs/${runId}`);
      run = body.run;
      if (run.currentStage !== lastStage) {
        lastStage = run.currentStage;
        result.events.push(`[${new Date().toISOString()}] stage=${run.currentStage} status=${run.status}`);
        await save();
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
      if (run.status === "awaiting_input") {
        const stageId = run.awaiting?.stageId ?? "";
        result.hitl.push({ stageId, at: new Date().toISOString(), payload: JSON.parse(JSON.stringify(run.awaiting?.payload ?? {}).slice(0, 6000)) });
        if (stageId === "hitl.outline_confirm") {
          // Boundary: the real Planner outline is on disk. Record, allocate, then cancel — no writing without experiment data.
          result.status = "STOPPED_AT_OUTLINE_CONFIRM";
          await save();
          const cancelled = await request("POST", `/runs/${runId}/cancel`);
          result.cancel = { status: cancelled.status };
          break;
        }
        if (stageId === "hitl.feasibility_confirm") {
          const resume = await request("POST", `/runs/${runId}/resume`, { decision: "approve" });
          if (resume.status !== 200) throw new Error(`resume ${stageId} failed: ${resume.status} ${JSON.stringify(resume.body).slice(0, 300)}`);
          result.hitl[result.hitl.length - 1].decision = "approve";
          continue;
        }
        throw new Error(`unexpected HITL before outline confirm: ${stageId}`);
      }
      if (Date.now() > deadline) throw new Error(`timeout (${run.status} / ${run.currentStage})`);
      await new Promise((wait) => setTimeout(wait, 3000));
    }
    if (result.status !== "STOPPED_AT_OUTLINE_CONFIRM") result.status = run.status === "failed" ? "FAILED" : run.status.toUpperCase();
    result.run = { status: run.status, stageResults: run.stageResults, stageHistory: run.stageHistory, error: run.error ?? null };
  }
} catch (error) {
  result.status = "FAILED";
  result.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    const outline = await services.manuscript.loadOutline(seeded.project.id);
    if (outline !== null) {
      await writeFile(join(output, "outline.json"), JSON.stringify(outline, null, 2));
      const allFormal = (await services.evidenceSelection.selectForWriting(seeded.project.id, { limit: Number.MAX_SAFE_INTEGER })).formal;
      const units = resolveArgumentUnits({ outline });
      const allocation = allocateSectionEvidence({ outline, units, evidence: await services.evidence.list(seeded.project.id) });
      result.planner = {
        title: outline.title,
        sections: outline.sections.map((section) => ({ id: section.id, title: section.title, targetLengthWords: section.targetLengthWords ?? null, keyPoints: (section.keyPoints ?? []).length, argument: section.argument ?? null })),
        plannerArgumentFields: outline.sections.filter((section) => section.argument !== undefined).length,
        plannerEvidenceIds: outline.sections.flatMap((section) => section.argument?.evidenceIds ?? []),
      };
      result.argumentUnits = units.map((unit) => ({ id: unit.sectionId, title: unit.title, role: unit.role, roleSource: unit.roleSource, confidence: unit.roleConfidence, upperBound: unit.targetLengthUpperBound, lengthSource: unit.lengthSource, doNotExplain: unit.doNotExplain, pinned: unit.pinnedEvidenceIds, limitationOwner: unit.limitationOwner, warnings: unit.warnings, taskSummary: unit.task.slice(0, 240) }));
      result.allocation = {
        formalIds: allocation.formalIds,
        excludedNonFormal: allocation.excludedNonFormal,
        unassigned: allocation.unassigned,
        sections: allocation.sections.map((section) => ({
          id: section.sectionId,
          role: section.role,
          evidence: section.evidenceIds,
          pinned: section.pinned,
          pinnedRejected: section.pinnedRejected,
          relevanceSelected: section.relevanceSelected,
          coverageAdded: section.coverageAdded,
          partial: section.partialIds,
          diagnostics: section.diagnostics,
          claims: projectAllocatedEvidence(section, allFormal).map((record) => `${record.id}: ${record.claim.slice(0, 90)}`),
        })),
      };
      result.renderedTaskBlocks = Object.fromEntries(units.map((unit, index) => [unit.sectionId, renderArgumentUnitLines(unit, { evidenceCount: allocation.sections[index].evidenceIds.length }).join("\n")]));
    }
    const research = await readFile(join(projects.researchDir(seeded.project.id), "research.json"), "utf8").catch(() => null);
    if (research !== null) await writeFile(join(output, "research.json"), research);
    const feasibility = await readFile(join(projects.researchDir(seeded.project.id), "feasibility.json"), "utf8").catch(() => null);
    if (feasibility !== null) {
      await writeFile(join(output, "feasibility.json"), feasibility);
      const parsed = JSON.parse(feasibility);
      result.feasibility = { level: parsed.report?.level ?? parsed.level ?? null, requiredExperiments: (parsed.report?.requiredExperiments ?? parsed.requiredExperiments ?? []).slice(0, 6), missingRequirements: (parsed.report?.missingRequirements ?? parsed.missingRequirements ?? []).slice(0, 6) };
    }
    result.evidenceAfter = { total: (await services.evidence.list(seeded.project.id)).length, candidatesPending: (await services.candidates.list(seeded.project.id, "pending_review")).length };
  } catch (error) {
    result.artifactError = error.message;
  }
  result.finishedAt = new Date().toISOString();
  summarizeCalls(result);
  await save();
  await new Promise((done) => server.close(done));
  await orchestrator.close();
  if (adapter) await adapter.close();
  console.log(JSON.stringify({ status: result.status, projectId: seeded.project.id, runId, calls: result.calls.length, callsByScope: result.callsByScope, sections: result.planner?.sections.length ?? null, roles: result.argumentUnits?.map((unit) => `${unit.id}:${unit.role}`) ?? null, unassigned: result.allocation?.unassigned ?? null, error: result.error ?? null }));
}
