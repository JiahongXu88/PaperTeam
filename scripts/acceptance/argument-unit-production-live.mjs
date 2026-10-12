/** M13.7.10 production-stage acceptance: real survey.outline (Planner) → argument-unit allocation → real writing.sections stage →
 * section files + writing plan + academic redundancy report + deterministic evaluation. No fixture roles / evidenceIds / tasks are
 * injected: the Planner and resolveArgumentUnits / buildSurveySectionContext decide everything, exactly as in production.
 *
 * Usage:
 *   node argument-unit-production-live.mjs REPO_ROOT FIXTURE_JSON MARKERS_JSON OUTPUT_DIR --model provider/model [--max-tasks 18] [--budget-file PATH] [--dry-run]
 * FIXTURE_JSON: scripts/acceptance/fixtures/m13-7-9/heldout-*.json (only outline.title, evidence, bibliography and the public abstracts are
 * used as *research inputs*; argumentUnitsV2 is ignored on purpose). The script seeds a topic_survey project (sources / formal evidence /
 * Survey Matrix / Structured Synthesis) and then runs the production stage objects from createTopicSurveyDefinition(stack.workflowServices):
 *   1. survey.outline  — real Planner (WriterService.planOutline, survey digest) + validateSurveyOutline + saveOutline
 *   2. writing.sections — surveyWritingSectionsStage: buildSurveySectionContext + resolveArgumentUnits + buildSurveySectionPrompt + writeSection
 * A shared budget file reserves one Writer/Planner TASK per runtime call before dispatch (max --max-tasks, default 18) and records the
 * assistant turns each task actually spent. Refuses to overwrite an existing OUTPUT_DIR; keeps failed outputs. --dry-run seeds the project
 * and resolves argument units from a *fixture-shaped* outline without any provider request (for wiring checks only; not an acceptance).
 * Uses only the runtime model settings already stored under PAPERTEAM_RUNTIME_ROOT (custom providers + auth). Never exports auth.
 * Set PROJECTS_ROOT to a private directory so acceptance projects stay outside the repository.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const positional = [];
const flags = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[value.slice(2)] = next; i += 1; } else { flags[value.slice(2)] = true; }
  } else positional.push(value);
}
const [repoArg, fixtureArg, markersArg, outputArg] = positional;
if (!repoArg || !fixtureArg || !markersArg || !outputArg) throw new Error("Expected REPO_ROOT FIXTURE_JSON MARKERS_JSON OUTPUT_DIR");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 18);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 25) throw new Error("--max-tasks must be an integer in 1..25 (M13.7.10 round cap)");
const repo = resolve(repoArg), output = resolve(outputArg);
const rel = relative(repo, output);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Output must be outside the repository");
const load = (file) => import(pathToFileURL(join(repo, "backend/dist", file)).href);

const fixtureBytes = await readFile(fixtureArg);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const markers = JSON.parse(await readFile(markersArg, "utf8"));
await mkdir(output);
const budgetPath = flags["budget-file"] ? resolve(flags["budget-file"]) : join(output, "..", "model-budget.json");
let budget;
try { budget = JSON.parse(await readFile(budgetPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxTasks: MAX_TASKS, reservations: [] }; }
if (budget.maxTasks !== MAX_TASKS) throw new Error(`Budget file declares ${budget.maxTasks} tasks but --max-tasks is ${MAX_TASKS}`);

const { loadConfig } = await load("config/config.js");
const { ModelSettingsStore } = await load("settings/ModelSettingsStore.js");
const { CustomProviderStore } = await load("settings/CustomProviderStore.js");
const { registerStoredCustomProviders } = await load("settings/ModelSettingsService.js");
const { applyStoredApiChannels } = await load("settings/apiChannels.js");
const { PiRuntimeAdapter } = await load("runtime/PiRuntimeAdapter.js");
const { buildServiceStack } = await load("serviceStack.js");
const { createTopicSurveyDefinition } = await load("workflow/definitions.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { SurveyMatrixArtifactStore, SurveySynthesisArtifactStore } = await load("survey/surveyArtifacts.js");
const { synthesisId } = await load("survey/synthesisTypes.js");
const { matrixEntryId } = await load("survey/matrixTypes.js");
const { fingerprintJson } = await load("util/hash.js");
const { classifyAcademicRedundancy } = await load("review/academicRedundancyClassifier.js");
const { stripLatexForRedundancy, splitRedundancySentences } = await load("review/crossSectionRedundancy.js");
const { resolveArgumentUnits } = await load("writer/argumentUnit.js");
const { LatexCompiler } = await load("latex/LatexCompiler.js");

const config = loadConfig();
const result = {
  milestone: "M13.7.10", mode: dryRun ? "dry-run" : "live", model: modelSpec ?? null, fixtureHash: createHash("sha256").update(fixtureBytes).digest("hex"),
  maxTasks: MAX_TASKS, budgetFile: budgetPath, startedAt: new Date().toISOString(), calls: [], stages: {},
  scope: "production stage objects (survey.outline + writing.sections) from createTopicSurveyDefinition on a seeded topic_survey project; Planner and argument units are real; no Review / Gate / Revision / PDF",
};
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));

// ---- runtime: real PiRuntimeAdapter wrapped by a recording / budgeting proxy -------------------------------------------
let runtime = null;
let recording = null;
if (!dryRun) {
  const sdk = await import(pathToFileURL(join(repo, "backend/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const settings = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
  const customProviders = new CustomProviderStore({ settingsDir: join(config.runtimeRoot, "settings") });
  await registerStoredCustomProviders(modelRuntime, customProviders);
  await applyStoredApiChannels(modelRuntime, settings);
  const storedSettings = await settings.load();
  if (Object.values(storedSettings.agents ?? {}).some((value) => value && value !== modelSpec)) throw new Error("Agent model overrides would break the single-model acceptance");
  runtime = new PiRuntimeAdapter({ modelSpec, modelRuntime, agentDir: config.pi.agentDir, workspaceRoot: config.projectsRoot,
    runTimeoutMs: 300000, executionTimeoutMs: 300000, firstActivityTimeoutMs: 60000, maxConcurrentRuns: 1, maxQueuedRuns: 1,
    roleSkillDirs: (role) => role === "writer" ? [join(repo, "backend/skills/seed/academic-writing-zh"), join(repo, "backend/skills/seed/academic-style-zh")] : [],
    agentModelSpecs: async () => ({}) });
  const committedTasks = () => budget.reservations.length;
  recording = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "runAgent") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (input) => {
        if (committedTasks() + 1 > budget.maxTasks) throw new Error("GLOBAL_TASK_BUDGET_EXHAUSTED");
        const name = `${String(input.contextScope ?? "scope").replace(/[^a-z0-9]+/gi, "-")}-${result.calls.length + 1}`;
        const reservation = { output, name, scope: input.contextScope ?? null, at: new Date().toISOString() };
        budget.reservations.push(reservation);
        await writeFile(budgetPath, JSON.stringify(budget, null, 2));
        const record = { name, agentId: input.agentId, scope: input.contextScope ?? null, metadata: input.metadata ?? null, promptChars: input.task.length };
        result.calls.push(record); await save();
        await writeFile(join(output, `${name}.prompt.txt`), input.task);
        const started = Date.now();
        const task = await target.runAgent(input);
        reservation.turns = Math.max(1, task.usage?.assistantTurns ?? 1);
        await writeFile(budgetPath, JSON.stringify(budget, null, 2));
        Object.assign(record, { status: task.status, usage: task.usage ?? null, skills: task.skills ?? null, seconds: (Date.now() - started) / 1000, error: task.error ?? null });
        await writeFile(join(output, `${name}.output.txt`), task.output ?? task.error ?? "");
        await save();
        return task;
      };
    },
  });
}

// ---- seed a topic_survey project from the frozen fixture (research inputs only) ------------------------------------------
const projects = new ProjectStore({ root: config.projectsRoot });
const stack = buildServiceStack({
  runtime: recording ?? { provider: "pi", healthCheck: async () => ({ ok: false, provider: "pi", status: "unreachable", detail: "dry-run", latencyMs: null, checkedAt: new Date().toISOString() }),
    runAgent: async () => { throw new Error("dry-run: no provider requests"); }, startAgent: async () => { throw new Error("dry-run"); }, getTask: async () => { throw new Error("dry-run"); }, close: async () => {} },
  projects, latex: new LatexCompiler({ timeoutMs: 10000 }), agentIds: config.agents, stageTimeoutMs: 900000, stageMaxAttempts: 1,
  writing: { argumentUnits: true }, citation: { metadataEnabled: false, scholarly: { providers: [] } },
  search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2000 }, fullText: { enabled: false }, log: () => {},
});
const services = stack.workflowServices;
// project.title is the Planner's survey topic: use the fixture title verbatim (run 1 leaked an acceptance prefix into the written intro)
const project = await projects.create(fixture.outline.title.slice(0, 120), { workflowKind: "topic_survey", documentType: "survey", language: "zh", researchIdea: fixture.outline.title });
result.projectId = project.id;

// sources: one metadata-only arXiv record per bibliography entry (SourceStore assigns S001…; remap fixture sourceIds)
const sourceIdMap = new Map();
const abstractsFile = markersArg.replace(/concept-markers-(\w+)\.json$/, "sources-abstracts-$1.json");
let abstracts = [];
try { abstracts = JSON.parse(await readFile(abstractsFile, "utf8")).sources ?? []; } catch { abstracts = []; }
for (const entry of fixture.bibliography) {
  const abstract = abstracts.find((item) => item.sourceId === entry.sourceId);
  const item = await services.sources.addRecord(project.id, {
    sourceType: "arxiv", origin: "USER_ADDED", sourceRole: "both", metadataProvenance: "resolver",
    metadata: { title: entry.title, year: entry.year, url: entry.url, ...(abstract?.arxivId ? { arxivId: abstract.arxivId } : {}), ...(abstract?.authors ? { authors: abstract.authors } : {}), ...(abstract?.abstract ? { abstract: abstract.abstract.slice(0, 3000) } : {}) },
  });
  sourceIdMap.set(entry.sourceId, item.sourceId);
}
// formal evidence: verified + sourceId + chunk anchor (abstract level, exactly as frozen in M13.7.9)
const evidenceIdMap = new Map();
const appended = await services.evidence.appendBatch(project.id, fixture.evidence.map((record) => ({
  input: {
    claim: record.claim, quote: record.quote, source: { sourceId: sourceIdMap.get(record.source.sourceId), title: record.source.title, year: record.source.year, url: record.source.url },
    location: { section: record.location.section, chunk: `${sourceIdMap.get(record.source.sourceId)}:abstract:${record.id.toLowerCase()}` },
    verificationStatus: "verified", verificationMethod: record.verificationMethod.slice(0, 200), supportStrength: record.supportStrength, verificationLevel: record.verificationLevel,
  }, createdBy: "m13-7-10-acceptance-seed",
})));
fixture.evidence.forEach((record, index) => evidenceIdMap.set(record.id, appended[index].id));
const E = (...ids) => ids.map((id) => evidenceIdMap.get(id));
const S = (...ids) => ids.map((id) => sourceIdMap.get(id));
const M = (...ids) => S(...ids).map((id) => matrixEntryId(id));
const now = new Date().toISOString();

// Survey Matrix: per-paper understanding (abstract_only; fields taken from the public abstracts / fixture claims, no invention)
const bySource = (fixtureSourceId) => fixture.evidence.filter((record) => record.source.sourceId === fixtureSourceId && record.supportStrength === "direct");
const seed = fixture.seed ?? inferSeed();
function inferSeed() {
  // Two-route seed derived from the fixture outline: the develop sections between the framing section and the compare section name the
  // routes (their keyPoints are the per-route understanding); the compare section's keyPoint names the comparison dimensions.
  const sections = fixture.outline.sections;
  const compareIndex = sections.findIndex((section) => /比较|对比|comparison/i.test(section.title));
  const routes = sections.slice(1, compareIndex > 0 ? compareIndex : sections.length - 1);
  const ids = fixture.bibliography.map((entry) => entry.sourceId);
  const perRoute = Math.ceil(ids.length / Math.max(1, routes.length));
  const familyBySource = {};
  routes.forEach((route, index) => { for (const id of ids.slice(index * perRoute, (index + 1) * perRoute)) familyBySource[id] = route.id; });
  const comparePoint = (sections[compareIndex]?.keyPoints?.[0] ?? "").replace(/（[^）]*）/g, "").replace(/^沿/, "");
  const comparisons = comparePoint.split(/比较|；|;/)[0].split(/[、，,]/).map((dimension) => dimension.trim()).filter((dimension) => dimension.length > 1 && dimension.length <= 20).slice(0, 4);
  return {
    taxonomy: { families: routes.map((route) => ({ label: route.id, description: route.title })) },
    familyBySource,
    comparisons: comparisons.length > 0 ? comparisons : ["机制", "结果口径", "限制"],
  };
}
const matrix = {
  schemaVersion: 1, updatedAt: now, taxonomy: seed.taxonomy,
  entries: fixture.bibliography.map((entry) => ({
    entryId: matrixEntryId(sourceIdMap.get(entry.sourceId)), sourceId: sourceIdMap.get(entry.sourceId), interpretationDepth: "abstract_only",
    researchProblem: entry.title, methodFamily: seed.familyBySource[entry.sourceId],
    mainIdea: bySource(entry.sourceId)[0]?.claim.slice(0, 300), keyFindings: bySource(entry.sourceId).map((record) => record.claim.slice(0, 200)).slice(0, 4),
    anchors: [], status: "confirmed", updatedAt: now,
  })),
};
await new SurveyMatrixArtifactStore(projects).write(project.id, matrix);
const matrixFingerprint = fingerprintJson(matrix);
// Structured Synthesis: taxonomy ×2 (one per family), comparison ×N (dimensions from the fixture's compare keyPoints), research_gap ×1, future_direction ×1 (inferred → speculative)
const families = seed.taxonomy.families.map((family) => family.label);
const sourcesIn = (family) => fixture.bibliography.filter((entry) => seed.familyBySource[entry.sourceId] === family).map((entry) => entry.sourceId);
const item = (kind, claim, fixtureSourceIds, evidenceIds, detail, groundingLevel) => ({
  synthesisId: synthesisId(kind, claim, S(...fixtureSourceIds)), kind, claim, groundingLevel, evidenceIds: E(...evidenceIds), sourceIds: S(...fixtureSourceIds).sort(),
  derivedFrom: { entryIds: M(...fixtureSourceIds).sort() }, ...(detail ? { detail } : {}), groundingReason: "M13.7.10 acceptance seed: evidence_backed = bound formal evidence exists; literature_cited = abstract-only; speculative = inferred", updatedAt: now,
});
const directIds = (sourceIds) => fixture.evidence.filter((record) => sourceIds.includes(record.source.sourceId) && record.supportStrength === "direct").map((record) => record.id);
const partialIds = fixture.evidence.filter((record) => record.supportStrength === "partial").map((record) => record.id);
const allSources = fixture.bibliography.map((entry) => entry.sourceId);
const items = [
  ...families.map((family) => item("taxonomy", `${seed.taxonomy.families.find((f) => f.label === family).description}：该路线的机制与结果由其代表文献的摘要直接给出。`, sourcesIn(family), directIds(sourcesIn(family)), { kind: "taxonomy", family }, "evidence_backed")),
  ...seed.comparisons.map((dimension, index) => item("comparison", `两条路线在「${dimension}」维度上存在实质差异；各文的指标定义、平台与实验设置不同，不能据此给出性能排序。`, allSources, [...directIds(allSources), ...(index < partialIds.length ? [partialIds[index]] : [])],
    { kind: "comparison", dimension, sides: families.map((family) => ({ label: seed.taxonomy.families.find((f) => f.label === family).description.slice(0, 80), entryIds: M(...sourcesIn(family)), basis: `${family} 代表文献摘要中与「${dimension}」相关的陈述` })) }, "evidence_backed")),
  item("research_gap", "材料仅为四篇公开摘要，未在统一指标、平台与设置下复现，两条路线的性能不可直接横向比较。", allSources, [], { kind: "research_gap", trigger: "literature_limitation", basis: "各文自述的指标口径与设置不同；本综述无自己的实验" }, "literature_cited"),
  item("future_direction", "在统一任务、指标与平台下复现并比较两条路线，是尚未完成的工作。", allSources, [], { kind: "future_direction", origin: "inferred" }, "speculative"),
];
await new SurveySynthesisArtifactStore(projects).write(project.id, { schemaVersion: 1, updatedAt: now, matrixFingerprint, items });
result.seed = { sources: [...sourceIdMap.entries()], evidence: [...evidenceIdMap.entries()], synthesis: items.map((entry) => ({ id: entry.synthesisId, kind: entry.kind, grounding: entry.groundingLevel, evidence: entry.evidenceIds.length })) };
await save();

// ---- production stages -------------------------------------------------------------------------------------------------
const definition = createTopicSurveyDefinition(services);
const stage = (id) => { const found = definition.stages.find((candidate) => candidate.id === id); if (!found || typeof found.execute !== "function") throw new Error(`stage ${id} not found`); return found; };
const runId = `acc-${createHash("sha256").update(`${project.id}:${result.startedAt}`).digest("hex").slice(0, 12)}`;
const state = { schemaVersion: 1, runId, projectId: project.id, workflowKind: "topic_survey", status: "running", createdAt: now, updatedAt: now, completedStages: [], stageResults: {}, stageHistory: [], inputs: {}, eventSeq: 0 };
const progress = [];
const ctx = (stageId) => ({ runId, projectId: project.id, attempt: 1, state, signal: new AbortController().signal,
  emitProgress: async (data) => { progress.push({ stageId, at: new Date().toISOString(), ...data }); await writeFile(join(output, "progress.json"), JSON.stringify(progress, null, 2)); },
  emitDomain: async () => {}, log: (message) => { result.logs ??= []; result.logs.push(message.slice(0, 400)); } });

try {
  if (dryRun) {
    // Wiring check only: a fixture-shaped outline (ids / titles / keyPoints) with synthesisRefs assigned by role; no provider request.
    const outline = { title: fixture.outline.title, sections: fixture.outline.sections.map((section, index) => ({ id: section.id, file: section.file, title: section.title, targetLengthWords: section.targetLengthWords, keyPoints: section.keyPoints,
      ...(index === 0 || index === fixture.outline.sections.length - 1 ? {} : { synthesisRefs: items.filter((entry) => (index === 3 ? entry.kind !== "taxonomy" && entry.kind !== "future_direction" : entry.kind === "taxonomy" && entry.detail.family === families[index - 1])).map((entry) => entry.synthesisId), literatureRefs: M(...allSources) }) })) };
    await services.manuscript.saveOutline(project.id, outline);
    const synthesis = await new SurveySynthesisArtifactStore(projects).read(project.id);
    result.stages["survey.outline"] = { dryRun: true, sections: outline.sections.length };
    result.argumentUnits = resolveArgumentUnits({ outline, synthesis }).map((unit) => ({ id: unit.sectionId, role: unit.role, roleSource: unit.roleSource, confidence: unit.roleConfidence, upperBound: unit.targetLengthUpperBound, doNotExplain: unit.doNotExplain.length, warnings: unit.warnings }));
    result.status = "DRY_RUN_COMPLETED";
  } else {
    const outlineStarted = Date.now();
    result.stages["survey.outline"] = await stage("survey.outline").execute(ctx("survey.outline"));
    result.stages["survey.outline"].seconds = (Date.now() - outlineStarted) / 1000;
    state.stageResults["survey.outline"] = result.stages["survey.outline"];
    state.stageResults["hitl.outline_confirm"] = { decision: "approve" };
    const outline = await services.manuscript.loadOutline(project.id);
    await writeFile(join(output, "outline.json"), JSON.stringify(outline, null, 2));
    const synthesis = await new SurveySynthesisArtifactStore(projects).read(project.id);
    result.argumentUnits = resolveArgumentUnits({ outline, synthesis }).map((unit) => ({ id: unit.sectionId, title: unit.title, role: unit.role, roleSource: unit.roleSource, confidence: unit.roleConfidence, upperBound: unit.targetLengthUpperBound, lengthSource: unit.lengthSource, doNotExplain: unit.doNotExplain, limitationOwner: unit.limitationOwner, warnings: unit.warnings, plannerArgument: outline.sections.find((section) => section.id === unit.sectionId)?.argument ?? null }));
    await save();
    if (outline.sections.length > budget.maxTasks - budget.reservations.length) throw new Error(`Outline has ${outline.sections.length} sections but only ${budget.maxTasks - budget.reservations.length} tasks remain in the budget`);
    const writingStarted = Date.now();
    result.stages["writing.sections"] = await stage("writing.sections").execute(ctx("writing.sections"));
    result.stages["writing.sections"].seconds = (Date.now() - writingStarted) / 1000;
    result.status = "COMPLETED";
  }
} catch (error) { result.status = "FAILED"; result.error = error.message; process.exitCode = 1; }
finally {
  // ---- collect artifacts + deterministic evaluation (no model calls) ------------------------------------------------------
  try {
    const outline = await services.manuscript.loadOutline(project.id);
    const sections = [];
    for (const section of outline?.sections ?? []) {
      try { sections.push({ id: section.id, title: section.title, file: section.file, latex: await readFile(services.manuscript.sectionPath(project.id, section), "utf8") }); } catch { /* unwritten */ }
    }
    await writeFile(join(output, "production-sections.json"), JSON.stringify(sections, null, 2));
    await writeFile(join(output, "production-manuscript.tex"), sections.map((section) => section.latex).join("\n\n"));
    const plan = await services.reviewArtifacts.loadWritingPlan(project.id);
    if (plan) await writeFile(join(output, "writing-plan.json"), JSON.stringify(plan, null, 2));
    const redundancy = await services.reviewArtifacts.latestAcademicRedundancy(project.id);
    if (redundancy) await writeFile(join(output, "academic-redundancy.json"), JSON.stringify(redundancy, null, 2));
    if (sections.length > 0) {
      const roles = Object.fromEntries((plan?.sections ?? []).map((section) => [section.sectionId, section.role]));
      const classified = classifyAcademicRedundancy(sections, Object.keys(roles).length > 0 ? { roles } : {});
      const plain = (latex) => stripLatexForRedundancy(latex).replace(/\s+/g, " ");
      // Production cite keys are canonical (buildCanonicalBibliography), not the fixture's: the whitelist is in the writing plan
      // (Survey allowedCitationKeys) with references.bib as fallback.
      const knownKeys = new Set((plan?.sections ?? []).flatMap((section) => section.citationKeys.allowed ?? section.citationKeys.evidenceBacked));
      try { for (const match of (await readFile(services.manuscript.bibPath(project.id), "utf8")).matchAll(/^@\w+\{([^,\s]+),/gm)) knownKeys.add(match[1]); } catch { /* no bib */ }
      // Concept markers: keep math-mode content (M13.7.9 blind spot ③ — `$\Lambda=2.14$` was invisible to the stripper-based markers)
      const plainWithMath = (latex) => latex
        .replace(/\\(?:sub)*section\*?\{[^{}]*\}/g, "\n")
        .replace(/\\(?:cite|citep|citet|label|ref|eqref)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ")
        .replace(/\\%/g, "%")
        .replace(/\\(?:times|pm|mu|Lambda|approx)\b/g, " ")
        .replace(/[${}^_]/g, "")
        .replace(/\s+/g, " ");
      const citeKeysOf = (latex) => [...latex.matchAll(/\\cite\w*\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g)].flatMap((match) => match[1].split(",").map((key) => key.trim()).filter(Boolean));
      const concepts = markers.concepts.map((concept) => {
        const carriers = sections.filter((section) => concept.all.every((pattern) => new RegExp(pattern).test(plainWithMath(section.latex)))).map((section) => section.id);
        const strippedCarriers = sections.filter((section) => concept.all.every((pattern) => new RegExp(pattern).test(plain(section.latex)))).map((section) => section.id);
        return { id: concept.id, label: concept.label, present: carriers.length > 0, carriers, carrierRoles: carriers.map((id) => roles[id] ?? null), mathModeOnly: carriers.length > 0 && strippedCarriers.length === 0 };
      });
      const controls = markers.negativeControls ?? [];
      const escalations = [];
      for (const control of controls) for (const section of sections) for (const sentence of splitRedundancySentences(plain(section.latex))) {
        const match = new RegExp(control.pattern).exec(sentence); if (!match) continue;
        const negated = new RegExp(control.negationWindow).test(sentence.slice(0, match.index)) || /(不|未|无|缺乏|尚|并非|不能|无法|没有)/.test(sentence.slice(match.index));
        escalations.push({ control: control.id, section: section.id, sentence: sentence.slice(0, 200), negated });
      }
      const numberTokens = (text) => [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
      const allowedNumbers = new Set([...fixture.evidence.flatMap((record) => numberTokens(record.quote)), ...fixture.bibliography.map((entry) => String(entry.year))]);
      const numbersOutsideQuotes = sections.flatMap((section) => splitRedundancySentences(section.latex.replace(/\\cite\w*\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ").replace(/\\(?:label|ref|eqref|section)\{[^{}]*\}/g, "\n")).flatMap((sentence) => {
        const outside = [...new Set(numberTokens(sentence))].filter((n) => !allowedNumbers.has(n));
        return outside.length > 0 ? [{ section: section.id, numbers: outside, sentence: sentence.replace(/\s+/g, " ").trim().slice(0, 200) }] : [];
      }));
      result.evaluation = {
        sections: sections.map((section) => ({ id: section.id, role: roles[section.id] ?? null, chars: section.latex.length, cjk: (section.latex.match(/[一-鿿]/g) ?? []).length, cites: (section.latex.match(/\\cite\w*\{/g) ?? []).length, unknownKeys: [...new Set(citeKeysOf(section.latex).filter((key) => !knownKeys.has(key)))] })),
        totals: { cjk: sections.reduce((sum, section) => sum + (section.latex.match(/[一-鿿]/g) ?? []).length, 0), cites: sections.reduce((sum, section) => sum + (section.latex.match(/\\cite\w*\{/g) ?? []).length, 0) },
        lexical: classified.summary.lexical, harmful: classified.summary.harmful, harmfulUpperShare: classified.summary.harmfulUpperShare, classCounts: classified.summary.classCounts,
        harmfulSentences: classified.harmfulSentences, uncertainSentences: classified.uncertainSentences, signpostSentences: classified.signpostSentences.filter((sentence) => sentence.harmful || sentence.role !== "framing"),
        concepts, conceptsMissing: concepts.filter((concept) => !concept.present).map((concept) => concept.id), negativeControlEscalations: escalations.filter((entry) => !entry.negated), negativeControlMentions: escalations,
        numbersOutsideQuotes, limitationSentences: classified.detector.limitationSentences,
      };
      await writeFile(join(output, "classified-pairs.json"), JSON.stringify(classified.pairs, null, 2));
    }
  } catch (error) { result.evaluationError = error.message; }
  result.finishedAt = new Date().toISOString();
  result.tasksCommitted = budget.reservations.length;
  result.assistantTurns = result.calls.reduce((sum, call) => sum + (call.usage?.assistantTurns ?? 0), 0);
  result.usageTotals = result.calls.reduce((acc, call) => { for (const [key, value] of Object.entries(call.usage ?? {})) if (typeof value === "number") acc[key] = (acc[key] ?? 0) + value; return acc; }, {});
  result.secondsTotal = result.calls.reduce((sum, call) => sum + (call.seconds ?? 0), 0);
  if (runtime) await runtime.close();
  await save();
  console.log(JSON.stringify({ status: result.status, projectId: project.id, calls: result.calls.length, tasksCommitted: result.tasksCommitted, assistantTurns: result.assistantTurns, harmfulShare: result.evaluation?.harmful?.share ?? null, lexicalShare: result.evaluation?.lexical?.restatedCharShare ?? null, conceptsMissing: result.evaluation?.conceptsMissing ?? null, error: result.error ?? null }));
}
