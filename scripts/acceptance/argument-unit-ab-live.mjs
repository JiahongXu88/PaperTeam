/** M13.7.11 same-condition production A/B: frozen real Planner outline → production `writing.sections` stage (topic_survey)
 * with the argument-unit switch OFF (Arm A, old organisation) or ON (Arm B, B2) in two independent projects / processes.
 *
 * Usage:
 *   node argument-unit-ab-live.mjs REPO_ROOT FIXTURE_JSON MARKERS_JSON FROZEN_OUTLINE_JSON OUTPUT_DIR --arm A|B \
 *        --model provider/model [--max-tasks 40] [--budget-file PATH] [--dry-run]
 *
 * Both arms seed the same topic_survey project state from the frozen M13.7.9 fixture (sources, abstract-level verified
 * evidence, Survey Matrix, Structured Synthesis; plus accepted candidates and a frozen corpus snapshot so the project can
 * later be replayed through the production orchestrator) and save the SAME outline (a real M13.7.10 Planner output).
 * No Planner request is issued here. The stage object comes from createTopicSurveyDefinition(stack.workflowServices);
 * the switch is applied at ServiceStack construction (writing.argumentUnits) — exactly how PAPERTEAM_ARGUMENT_UNIT_WRITING
 * reaches production — so each arm is a separately instantiated stack, not a mutated running service.
 * The adapter is the production-equivalent wiring (SkillRegistry skills + role tools + workspace guard).
 * Refuses to overwrite OUTPUT_DIR; keeps failed outputs; --dry-run seeds + saves the outline + checks refs without any
 * provider request.
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
  collectSections,
  evaluateSurveySections,
  makeStageCtx,
} from "./lib/m13-7-live.mjs";

const { positional, flags } = parseCli(process.argv);
const [repoArg, fixtureArg, markersArg, outlineArg, outputArg] = positional;
if (!repoArg || !fixtureArg || !markersArg || !outlineArg || !outputArg) {
  throw new Error("Expected REPO_ROOT FIXTURE_JSON MARKERS_JSON FROZEN_OUTLINE_JSON OUTPUT_DIR");
}
const arm = flags.arm;
if (arm !== "A" && arm !== "B") throw new Error("--arm must be A (argument units off) or B (argument units on)");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 40);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 40) throw new Error("--max-tasks must be an integer in 1..40 (M13.7.11 round cap)");
const { repo, output } = resolveRepoPaths(repoArg, outputArg);
const load = distLoader(repo);

const fixtureBytes = await readFile(fixtureArg);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const markers = JSON.parse(await readFile(markersArg, "utf8"));
const outlineBytes = await readFile(outlineArg);
const frozenOutline = JSON.parse(outlineBytes.toString("utf8"));
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
const { createTopicSurveyDefinition } = await load("workflow/definitions.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { LatexCompiler } = await load("latex/LatexCompiler.js");
const { SurveySynthesisArtifactStore, SurveyMatrixArtifactStore } = await load("survey/surveyArtifacts.js");
const { buildSurveySectionContext } = await load("survey/sectionContext.js");
const { resolveArgumentUnits, ARGUMENT_UNIT_BLOCK_HEADER } = await load("writer/argumentUnit.js");

const config = loadConfig();
const result = {
  milestone: "M13.7.11",
  experiment: "same-condition production A/B",
  arm,
  argumentUnits: arm === "B",
  mode: dryRun ? "dry-run" : "live",
  model: modelSpec ?? null,
  fixtureHash: sha256(fixtureBytes),
  frozenOutlineHash: sha256(outlineBytes),
  maxTasks: MAX_TASKS,
  budgetFile: budgetPath,
  startedAt: new Date().toISOString(),
  calls: [],
  stages: {},
  scope:
    "production writing.sections stage object (createTopicSurveyDefinition) on a seeded topic_survey project with a frozen real Planner outline; no Planner request; Review / Gate / Revision / PDF are NOT part of this script (see survey-tail-live.mjs)",
};
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));

let stack;
let runtime = null;
let recording = null;
if (!dryRun) {
  const { modelRuntime } = await createModelRuntime({ repo, load, config, modelSpec });
  const created = await createProductionAdapter({ repo, load, config, modelSpec, modelRuntime, projectsRoot: config.projectsRoot, stackRef: () => stack });
  runtime = created.adapter;
  recording = recordRuntime({ runtime, budget, budgetPath, output, result, save, allowScopes: ["writing/sections"] });
}
const projects = new ProjectStore({ root: config.projectsRoot });
stack = buildServiceStack({
  runtime: recording ?? dryRunRuntime(),
  projects,
  latex: new LatexCompiler({ timeoutMs: 10000 }),
  agentIds: config.agents,
  stageTimeoutMs: 900000,
  stageMaxAttempts: 1,
  writing: { argumentUnits: arm === "B" },
  citation: { metadataEnabled: false, scholarly: { providers: [] } },
  search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2000 },
  fullText: { enabled: false },
  log: () => {},
});
const services = stack.workflowServices;
if ((services.writing?.argumentUnits ?? true) !== (arm === "B")) throw new Error("ServiceStack did not pick up the argument-unit switch for this arm");

const seeded = await seedSurveyFixtureProject({
  load,
  services,
  projects,
  fixture,
  abstracts,
  createdBy: "m13-7-11-ab-seed",
  withCandidates: true,
  freezeCorpus: true,
});
result.projectId = seeded.project.id;
result.seed = seeded.summary;
await save();

// Frozen outline (real M13.7.10 run-2 Planner output) saved through the production manuscript service (validateOutline).
await services.manuscript.saveOutline(seeded.project.id, frozenOutline);
const outline = await services.manuscript.loadOutline(seeded.project.id);
const synthesis = await new SurveySynthesisArtifactStore(projects).read(seeded.project.id);
const matrix = await new SurveyMatrixArtifactStore(projects).read(seeded.project.id);
const sourceItems = await services.sources.list(seeded.project.id);
const titleBySource = new Map(sourceItems.map((item) => [item.sourceId, item.metadata.title ?? ""]));
const yearBySource = new Map(sourceItems.filter((item) => item.metadata.year !== undefined).map((item) => [item.sourceId, item.metadata.year]));
const evidence = (await services.evidence.list(seeded.project.id)).filter((record) => record.verificationStatus === "verified");
const synthesisById = new Map(synthesis.items.map((item) => [item.synthesisId, item]));
const formalIds = new Set(evidence.map((record) => record.id));
const refCheck = outline.sections.map((section) => {
  // Dangling refs are fail-closed in the production stage; the per-section evidence projection itself is recorded by the
  // stage (writing-plan.json for Arm B; the recorded prompts for both arms). Here: refs resolve + bound formal ids.
  const context = buildSurveySectionContext({ section, matrix, synthesis, bibliography: [], evidence, titleBySource, yearBySource });
  const bound = [...new Set((section.synthesisRefs ?? []).flatMap((ref) => synthesisById.get(ref)?.evidenceIds ?? []))].filter((id) => formalIds.has(id)).sort();
  return {
    id: section.id,
    synthesisRefs: (section.synthesisRefs ?? []).length,
    literatureRefs: (section.literatureRefs ?? []).length,
    danglingSynthesisRefs: context.danglingSynthesisRefs,
    danglingLiteratureRefs: context.danglingLiteratureRefs,
    boundFormalEvidence: bound,
    boundPartial: bound.filter((id) => evidence.find((record) => record.id === id)?.supportStrength === "partial"),
  };
});
result.frozenOutlineRefCheck = refCheck;
const dangling = refCheck.filter((entry) => entry.danglingSynthesisRefs.length > 0 || entry.danglingLiteratureRefs.length > 0);
if (dangling.length > 0) {
  result.status = "FAILED";
  result.error = `frozen outline has dangling refs against the seeded synthesis / matrix: ${JSON.stringify(dangling)}`;
  await save();
  throw new Error(result.error);
}
result.argumentUnits = arm === "B"
  ? resolveArgumentUnits({ outline, synthesis }).map((unit) => ({ id: unit.sectionId, title: unit.title, role: unit.role, roleSource: unit.roleSource, confidence: unit.roleConfidence, upperBound: unit.targetLengthUpperBound, lengthSource: unit.lengthSource, doNotExplain: unit.doNotExplain, limitationOwner: unit.limitationOwner, warnings: unit.warnings, isFinalSection: unit.sectionId === outline.sections[outline.sections.length - 1].id, plannerArgument: outline.sections.find((section) => section.id === unit.sectionId)?.argument ?? null }))
  : { enabled: false, note: "Arm A: resolveArgumentUnits is not consulted by the stage (services.writing.argumentUnits=false)" };
await save();

// ---- production stage -------------------------------------------------------------------------------------------------
const definition = createTopicSurveyDefinition(services);
const stage = definition.stages.find((candidate) => candidate.id === "writing.sections");
if (!stage || typeof stage.execute !== "function") throw new Error("writing.sections stage not found");
const runId = `ab-${arm.toLowerCase()}-${sha256(`${seeded.project.id}:${result.startedAt}`).slice(0, 12)}`;
result.runId = runId;
const now = new Date().toISOString();
const state = {
  schemaVersion: 1,
  runId,
  projectId: seeded.project.id,
  workflowKind: "topic_survey",
  status: "running",
  createdAt: now,
  updatedAt: now,
  completedStages: [],
  stageResults: { "hitl.outline_confirm": { decision: "approve" } },
  stageHistory: [],
  inputs: {},
  eventsSeq: 0,
};
const progress = [];
const logs = [];
const ctx = makeStageCtx({ runId, projectId: seeded.project.id, state, output, progress, logs });

try {
  if (dryRun) {
    result.status = "DRY_RUN_COMPLETED";
  } else {
    if (outline.sections.length > budget.maxTasks - budget.reservations.length) {
      throw new Error(`Outline has ${outline.sections.length} sections but only ${budget.maxTasks - budget.reservations.length} tasks remain in the budget`);
    }
    const started = Date.now();
    result.stages["writing.sections"] = await stage.execute(ctx("writing.sections"));
    result.stages["writing.sections"].seconds = (Date.now() - started) / 1000;
    await writeFile(join(output, "writing-stage-result.json"), JSON.stringify(result.stages["writing.sections"], null, 2));
    result.status = "COMPLETED";
  }
} catch (error) {
  result.status = "FAILED";
  result.error = error.message;
  process.exitCode = 1;
} finally {
  result.logs = logs;
  try {
    const { sections } = await collectSections({ services, projectId: seeded.project.id, output });
    const plan = await services.reviewArtifacts.loadWritingPlan(seeded.project.id);
    if (plan) await writeFile(join(output, "writing-plan.json"), JSON.stringify(plan, null, 2));
    const redundancy = await services.reviewArtifacts.latestAcademicRedundancy(seeded.project.id);
    if (redundancy) await writeFile(join(output, "academic-redundancy.json"), JSON.stringify(redundancy, null, 2));
    // Arm behaviour check from the recorded prompts: A must be the old organisation, B must carry the B2 task block.
    const prompts = [];
    for (const call of result.calls) {
      try {
        prompts.push({ name: call.name, text: await readFile(join(output, `${call.name}.prompt.txt`), "utf8") });
      } catch {
        /* missing */
      }
    }
    result.armCheck = {
      prompts: prompts.length,
      withTaskBlock: prompts.filter((prompt) => prompt.text.includes(ARGUMENT_UNIT_BLOCK_HEADER)).length,
      withUpperBoundLength: prompts.filter((prompt) => /目标长度：不超过 \d+ 字（上限参考，不是配额）/.test(prompt.text)).length,
      withLegacyLength: prompts.filter((prompt) => /目标长度：约 \d+ 字/.test(prompt.text)).length,
      withBibliographyIdentity: prompts.filter((prompt) => prompt.text.includes("===== 文献身份")).length,
      withSignpostTemplate: prompts.filter((prompt) => /见「[^」]+」一节/.test(prompt.text)).length,
      writingPlanPresent: plan !== null,
      redundancyReportPresent: redundancy !== null,
      expected: arm === "B"
        ? "every prompt has the task block + upper-bound length; writing-plan.json and academic-redundancy-rev*.json exist"
        : "no prompt has the task block; legacy 「约 N 字」 length; no writing-plan / redundancy artefacts",
    };
    result.armCheck.consistent = arm === "B"
      ? result.armCheck.withTaskBlock === prompts.length && result.armCheck.withUpperBoundLength === prompts.length && result.armCheck.withLegacyLength === 0 && plan !== null
      : result.armCheck.withTaskBlock === 0 && result.armCheck.withUpperBoundLength === 0 && result.armCheck.withLegacyLength === prompts.length && plan === null && redundancy === null;
    if (sections.length > 0) {
      // Roles: Arm B from the writing plan (production roles); Arm A has no plan — use the SAME roles (the outline is
      // identical, roles are a property of the outline, not of the arm) so metric B is computed with one role map.
      const roles = Object.fromEntries(resolveArgumentUnits({ outline, synthesis }).map((unit) => [unit.sectionId, unit.role]));
      result.evaluation = await evaluateSurveySections({ load, services, projectId: seeded.project.id, fixture, markers, sections, roles, output });
      result.evaluation.rolesNote = "roles from resolveArgumentUnits(frozen outline + synthesis) for BOTH arms (identical outline → identical roles); Arm B's writing-plan roles are the same mapping";
    }
  } catch (error) {
    result.evaluationError = error.message;
  }
  result.finishedAt = new Date().toISOString();
  summarizeCalls(result);
  if (runtime) await runtime.close();
  await save();
  console.log(
    JSON.stringify({
      arm,
      status: result.status,
      projectId: seeded.project.id,
      calls: result.calls.length,
      assistantTurns: result.assistantTurns,
      armConsistent: result.armCheck?.consistent ?? null,
      harmfulShare: result.evaluation?.harmful?.share ?? null,
      harmfulUpper: result.evaluation?.harmfulUpperShare ?? null,
      lexicalShare: result.evaluation?.lexical?.restatedCharShare ?? null,
      conceptsMissing: result.evaluation?.conceptsMissing ?? null,
      escalations: result.evaluation?.negativeControlEscalations?.length ?? null,
      error: result.error ?? null,
    }),
  );
}
