/** Shared helpers for the M13.7.x production live-acceptance drivers (M13.7.10 / M13.7.11).
 *
 * Everything here is deterministic glue around production modules in backend/dist: CLI parsing, a budget-recording
 * runtime proxy, the frozen-fixture topic_survey seeding (sources / formal evidence / Survey Matrix / Structured
 * Synthesis), the production-equivalent PiRuntimeAdapter wiring (skills + tools + workspace guard, mirrors
 * backend/src/index.ts) and the deterministic manuscript evaluation (classifier + concept markers + negative controls).
 * No module here issues a provider request by itself; model calls only happen through the recorded runtime proxy.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[value.slice(2)] = next;
        i += 1;
      } else {
        flags[value.slice(2)] = true;
      }
    } else {
      positional.push(value);
    }
  }
  return { positional, flags };
}

export function assertOutsideRepo(repo, output) {
  const rel = relative(repo, output);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Output must be outside the repository");
  }
}

export function distLoader(repo) {
  return (file) => import(pathToFileURL(join(repo, "backend/dist", file)).href);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Shared ledger: one reservation per runtime task before dispatch; the cap is the round cap, never auto-extended. */
export async function loadBudget(budgetPath, maxTasks) {
  let budget;
  try {
    budget = JSON.parse(await readFile(budgetPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    budget = { maxTasks, reservations: [] };
  }
  if (budget.maxTasks !== maxTasks) {
    throw new Error(`Budget file declares ${budget.maxTasks} tasks but --max-tasks is ${maxTasks}`);
  }
  return budget;
}

/**
 * Wrap a real runtime: reserve a task in the shared ledger before each runAgent, record prompt / output / usage per
 * call into OUTPUT_DIR and result.calls. Throws GLOBAL_TASK_BUDGET_EXHAUSTED instead of dispatching past the cap.
 */
export function recordRuntime({ runtime, budget, budgetPath, output, result, save, allowScopes }) {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== "runAgent") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (input) => {
        const scope = String(input.contextScope ?? "scope");
        if (allowScopes !== undefined && !allowScopes.some((prefix) => scope.startsWith(prefix))) {
          throw new Error(`SCOPE_NOT_ALLOWED_IN_THIS_ACCEPTANCE: ${scope}`);
        }
        if (budget.reservations.length + 1 > budget.maxTasks) {
          throw new Error("GLOBAL_TASK_BUDGET_EXHAUSTED");
        }
        const name = `${scope.replace(/[^a-z0-9]+/gi, "-")}-${result.calls.length + 1}`;
        const reservation = { output, name, scope, at: new Date().toISOString() };
        budget.reservations.push(reservation);
        await writeFile(budgetPath, JSON.stringify(budget, null, 2));
        const record = {
          name,
          agentId: input.agentId,
          scope,
          metadata: input.metadata ?? null,
          promptChars: input.task.length,
          startedAt: new Date().toISOString(),
        };
        result.calls.push(record);
        await save();
        await writeFile(join(output, `${name}.prompt.txt`), input.task);
        const started = Date.now();
        const task = await target.runAgent(input);
        reservation.turns = Math.max(1, task.usage?.assistantTurns ?? 1);
        await writeFile(budgetPath, JSON.stringify(budget, null, 2));
        Object.assign(record, {
          status: task.status,
          usage: task.usage ?? null,
          skills: task.skills ?? null,
          seconds: (Date.now() - started) / 1000,
          error: task.error ?? null,
        });
        await writeFile(join(output, `${name}.output.txt`), task.output ?? task.error ?? "");
        await save();
        return task;
      };
    },
  });
}

export function summarizeCalls(result) {
  result.tasksCommitted = result.calls.length;
  result.assistantTurns = result.calls.reduce((sum, call) => sum + (call.usage?.assistantTurns ?? 0), 0);
  result.usageTotals = result.calls.reduce((acc, call) => {
    for (const [key, value] of Object.entries(call.usage ?? {})) {
      if (typeof value === "number") acc[key] = (acc[key] ?? 0) + value;
    }
    return acc;
  }, {});
  result.secondsTotal = result.calls.reduce((sum, call) => sum + (call.seconds ?? 0), 0);
  result.callsByScope = result.calls.reduce((acc, call) => {
    acc[call.scope] = (acc[call.scope] ?? 0) + 1;
    return acc;
  }, {});
}

/** The runtime model settings already stored under PAPERTEAM_RUNTIME_ROOT (custom providers + auth); never exports auth. */
export async function createModelRuntime({ repo, load, config, modelSpec }) {
  const sdk = await import(pathToFileURL(join(repo, "backend/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const { ModelSettingsStore } = await load("settings/ModelSettingsStore.js");
  const { CustomProviderStore } = await load("settings/CustomProviderStore.js");
  const { registerStoredCustomProviders } = await load("settings/ModelSettingsService.js");
  const { applyStoredApiChannels } = await load("settings/apiChannels.js");
  const settings = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(config.pi.agentDir, "auth.json"),
    modelsPath: join(config.pi.agentDir, "models.json"),
  });
  const customProviders = new CustomProviderStore({ settingsDir: join(config.runtimeRoot, "settings") });
  await registerStoredCustomProviders(modelRuntime, customProviders);
  await applyStoredApiChannels(modelRuntime, settings);
  const storedSettings = await settings.load();
  if (Object.values(storedSettings.agents ?? {}).some((value) => value && value !== modelSpec)) {
    throw new Error("Agent model overrides would break the single-model acceptance");
  }
  return { modelRuntime, settings };
}

/**
 * Production-equivalent adapter (mirrors backend/src/index.ts): SkillRegistry role skills, scholarly / retrieve_library /
 * evidence tools per role, workspace guard. `stackRef()` is read lazily so tools share the stack built afterwards.
 */
export async function createProductionAdapter({ repo, load, config, modelSpec, modelRuntime, projectsRoot, stackRef, maxConcurrentRuns = 1 }) {
  const { PiRuntimeAdapter } = await load("runtime/PiRuntimeAdapter.js");
  const { SkillRegistry } = await load("skills/SkillRegistry.js");
  const { createScholarlyTools } = await load("skills/scholarlyTools.js");
  const { createRetrieveLibraryTool } = await load("retrieval/tools.js");
  const { evidenceToolsForRole } = await load("evidence/tools.js");
  const { createWorkspaceGuardPolicy, createWorkspaceGuardTools } = await load("runtime/pi/workspaceGuard.js");
  const skillRegistry = new SkillRegistry({
    storeRoot: join(config.runtimeRoot, "skills"),
    disabledSkillIds: config.skills.disabledSkillIds,
    log: () => {},
  });
  await skillRegistry.ensureInstalled();
  const adapter = new PiRuntimeAdapter({
    modelSpec,
    modelRuntime,
    agentDir: config.pi.agentDir,
    workspaceRoot: projectsRoot,
    runTimeoutMs: config.pi.runTimeoutMs,
    ...(config.pi.executionTimeoutMs !== undefined ? { executionTimeoutMs: config.pi.executionTimeoutMs } : {}),
    firstActivityTimeoutMs: config.pi.firstActivityTimeoutMs,
    maxConcurrentRuns,
    maxQueuedRuns: config.pi.maxQueuedRuns,
    maxRunsPerSession: config.pi.maxRunsPerSession,
    sessionIdleTtlMs: config.pi.sessionIdleTtlMs,
    maxSessions: config.pi.maxSessions,
    agentModelSpecs: async () => ({}),
    roleSkills: (role, scope, language) => skillRegistry.skillAssignmentsFor(role, scope, language),
    roleCustomTools: (role, projectId) => {
      const stack = stackRef();
      const tools = [];
      if ((role === "researcher" || role === "citation") && stack !== undefined) {
        tools.push(...createScholarlyTools(stack.citationIntegrity.scholarlyResolver, stack.discovery, role === "researcher" ? projectId : undefined));
      }
      if ((role === "researcher" || role === "writer" || role === "reviewer") && stack !== undefined && projectId !== undefined) {
        tools.push(createRetrieveLibraryTool(stack.retrieval, projectId));
      }
      if (stack !== undefined && projectId !== undefined) {
        tools.push(...evidenceToolsForRole(role, { chunkAccess: stack.chunkAccess, grounding: stack.evidenceGrounding, evidence: stack.evidence }, projectId));
      }
      return tools;
    },
    workspaceGuard: async ({ projectId, cwd, skillDirs, toolNames }) => {
      const stack = stackRef();
      let protectedSourceIds = [];
      let protectAllSources = false;
      if (projectId !== undefined) {
        if (stack === undefined) protectAllSources = true;
        else {
          try {
            protectedSourceIds = (await stack.sources.list(projectId)).filter((item) => item.origin === "EXPERIMENT_PACKAGE").map((item) => item.sourceId);
          } catch {
            protectAllSources = true;
          }
        }
      }
      return createWorkspaceGuardTools(createWorkspaceGuardPolicy({ projectDir: cwd, readOnlyRoots: skillDirs, protectedSourceIds, protectAllSources }), { cwd, toolNames });
    },
    log: () => {},
  });
  return { adapter, skillRegistry };
}

/** No-provider runtime for dry runs / wiring checks. */
export function dryRunRuntime() {
  return {
    provider: "pi",
    healthCheck: async () => ({ ok: false, provider: "pi", status: "unreachable", detail: "dry-run", latencyMs: null, checkedAt: new Date().toISOString() }),
    runAgent: async () => { throw new Error("dry-run: no provider requests"); },
    startAgent: async () => { throw new Error("dry-run"); },
    getTask: async () => { throw new Error("dry-run"); },
    close: async () => {},
  };
}

function inferSeed(fixture) {
  // Two-route seed derived from the fixture outline: the develop sections between the framing section and the compare
  // section name the routes (their keyPoints are the per-route understanding); the compare section's keyPoint names the
  // comparison dimensions. Deterministic — identical to the M13.7.10 seeding.
  const sections = fixture.outline.sections;
  const compareIndex = sections.findIndex((section) => /比较|对比|comparison/i.test(section.title));
  const routes = sections.slice(1, compareIndex > 0 ? compareIndex : sections.length - 1);
  const ids = fixture.bibliography.map((entry) => entry.sourceId);
  const perRoute = Math.ceil(ids.length / Math.max(1, routes.length));
  const familyBySource = {};
  routes.forEach((route, index) => {
    for (const id of ids.slice(index * perRoute, (index + 1) * perRoute)) familyBySource[id] = route.id;
  });
  const comparePoint = (sections[compareIndex]?.keyPoints?.[0] ?? "").replace(/（[^）]*）/g, "").replace(/^沿/, "");
  const comparisons = comparePoint
    .split(/比较|；|;/)[0]
    .split(/[、，,]/)
    .map((dimension) => dimension.trim())
    .filter((dimension) => dimension.length > 1 && dimension.length <= 20)
    .slice(0, 4);
  return {
    taxonomy: { families: routes.map((route) => ({ label: route.id, description: route.title })) },
    familyBySource,
    comparisons: comparisons.length > 0 ? comparisons : ["机制", "结果口径", "限制"],
  };
}


/** Survey Matrix (abstract_only, confirmed) + Structured Synthesis seeded from the fixture (deterministic ids). */
async function seedSurveyArtifacts({ load, projects, projectId, fixture, sourceIdMap, evidenceIdMap }) {
  const { SurveyMatrixArtifactStore, SurveySynthesisArtifactStore } = await load("survey/surveyArtifacts.js");
  const { synthesisId } = await load("survey/synthesisTypes.js");
  const { matrixEntryId } = await load("survey/matrixTypes.js");
  const { fingerprintJson } = await load("util/hash.js");
  const E = (...ids) => ids.map((id) => evidenceIdMap.get(id));
  const S = (...ids) => ids.map((id) => sourceIdMap.get(id));
  const M = (...ids) => S(...ids).map((id) => matrixEntryId(id));
  const now = new Date().toISOString();
  const bySource = (fixtureSourceId) => fixture.evidence.filter((record) => record.source.sourceId === fixtureSourceId && record.supportStrength === "direct");
  const seed = fixture.seed ?? inferSeed(fixture);
  const matrix = {
    schemaVersion: 1,
    updatedAt: now,
    taxonomy: seed.taxonomy,
    entries: fixture.bibliography.map((entry) => ({
      entryId: matrixEntryId(sourceIdMap.get(entry.sourceId)),
      sourceId: sourceIdMap.get(entry.sourceId),
      interpretationDepth: "abstract_only",
      researchProblem: entry.title,
      methodFamily: seed.familyBySource[entry.sourceId],
      mainIdea: bySource(entry.sourceId)[0]?.claim.slice(0, 300),
      keyFindings: bySource(entry.sourceId).map((record) => record.claim.slice(0, 200)).slice(0, 4),
      anchors: [],
      status: "confirmed",
      updatedAt: now,
    })),
  };
  await new SurveyMatrixArtifactStore(projects).write(projectId, matrix);
  const matrixFingerprint = fingerprintJson(matrix);
  const families = seed.taxonomy.families.map((family) => family.label);
  const sourcesIn = (family) => fixture.bibliography.filter((entry) => seed.familyBySource[entry.sourceId] === family).map((entry) => entry.sourceId);
  const item = (kind, claim, fixtureSourceIds, evidenceIds, detail, groundingLevel) => ({
    synthesisId: synthesisId(kind, claim, S(...fixtureSourceIds)),
    kind,
    claim,
    groundingLevel,
    evidenceIds: E(...evidenceIds),
    sourceIds: S(...fixtureSourceIds).sort(),
    derivedFrom: { entryIds: M(...fixtureSourceIds).sort() },
    ...(detail ? { detail } : {}),
    groundingReason: "M13.7.10 acceptance seed: evidence_backed = bound formal evidence exists; literature_cited = abstract-only; speculative = inferred",
    updatedAt: now,
  });
  const directIds = (sourceIds) => fixture.evidence.filter((record) => sourceIds.includes(record.source.sourceId) && record.supportStrength === "direct").map((record) => record.id);
  const partialIds = fixture.evidence.filter((record) => record.supportStrength === "partial").map((record) => record.id);
  const allSources = fixture.bibliography.map((entry) => entry.sourceId);
  const items = [
    ...families.map((family) =>
      item("taxonomy", `${seed.taxonomy.families.find((f) => f.label === family).description}：该路线的机制与结果由其代表文献的摘要直接给出。`, sourcesIn(family), directIds(sourcesIn(family)), { kind: "taxonomy", family }, "evidence_backed"),
    ),
    ...seed.comparisons.map((dimension, index) =>
      item(
        "comparison",
        `两条路线在「${dimension}」维度上存在实质差异；各文的指标定义、平台与实验设置不同，不能据此给出性能排序。`,
        allSources,
        [...directIds(allSources), ...(index < partialIds.length ? [partialIds[index]] : [])],
        {
          kind: "comparison",
          dimension,
          sides: families.map((family) => ({ label: seed.taxonomy.families.find((f) => f.label === family).description.slice(0, 80), entryIds: M(...sourcesIn(family)), basis: `${family} 代表文献摘要中与「${dimension}」相关的陈述` })),
        },
        "evidence_backed",
      ),
    ),
    item("research_gap", "材料仅为四篇公开摘要，未在统一指标、平台与设置下复现，两条路线的性能不可直接横向比较。", allSources, [], { kind: "research_gap", trigger: "literature_limitation", basis: "各文自述的指标口径与设置不同；本综述无自己的实验" }, "literature_cited"),
    item("future_direction", "在统一任务、指标与平台下复现并比较两条路线，是尚未完成的工作。", allSources, [], { kind: "future_direction", origin: "inferred" }, "speculative"),
  ];
  await new SurveySynthesisArtifactStore(projects).write(projectId, { schemaVersion: 1, updatedAt: now, matrixFingerprint, items });
  return { items, matrix, matrixFingerprint, seed, families, allSources };
}

/**
 * Seed a topic_survey project from a frozen M13.7.9 fixture (research inputs only: title, bibliography, public abstracts,
 * abstract-level verified evidence). Writes sources, formal evidence, Survey Matrix (abstract_only, confirmed) and
 * Structured Synthesis (taxonomy ×2 / comparison ×N / research_gap / future_direction). Optionally also registers one
 * accepted candidate per source (so the production literature-selection HITL has a legal selection) and freezes the
 * research corpus snapshot (so survey.fulltext is a deterministic no-op). Returns the id maps for evaluation.
 */
export async function seedSurveyFixtureProject({ load, services, projects, fixture, abstracts, createdBy, withCandidates = false, freezeCorpus = false, requestTitle, workflowKind = "topic_survey", researchIdea, surveyArtifacts = true }) {
  const project = await projects.create((requestTitle ?? fixture.outline.title).slice(0, 120), {
    workflowKind,
    ...(workflowKind === "topic_survey" ? { documentType: "survey" } : {}),
    language: "zh",
    researchIdea: researchIdea ?? fixture.outline.title,
  });
  const sourceIdMap = new Map();
  for (const entry of fixture.bibliography) {
    const abstract = abstracts.find((item) => item.sourceId === entry.sourceId);
    const item = await services.sources.addRecord(project.id, {
      sourceType: "arxiv",
      origin: "USER_ADDED",
      sourceRole: "both",
      metadataProvenance: "resolver",
      metadata: {
        title: entry.title,
        year: entry.year,
        url: entry.url,
        ...(abstract?.arxivId ? { arxivId: abstract.arxivId } : {}),
        ...(abstract?.authors ? { authors: abstract.authors } : {}),
        ...(abstract?.abstract ? { abstract: abstract.abstract.slice(0, 3000) } : {}),
      },
    });
    sourceIdMap.set(entry.sourceId, item.sourceId);
  }
  const candidateIds = [];
  if (withCandidates) {
    for (const entry of fixture.bibliography) {
      const abstract = abstracts.find((item) => item.sourceId === entry.sourceId);
      const added = await services.candidates.add(project.id, {
        title: entry.title,
        year: entry.year,
        url: entry.url,
        ...(abstract?.arxivId ? { arxivId: abstract.arxivId } : {}),
        ...(abstract?.authors ? { authors: abstract.authors.slice(0, 3) } : {}),
        origin: "manual",
      });
      const candidate = added.candidate ?? added;
      await services.candidates.markAccepted(project.id, candidate.candidateId, sourceIdMap.get(entry.sourceId), "M13.7.11 stage replay: fixture literature registered as accepted candidate");
      candidateIds.push(candidate.candidateId);
    }
  }
  const evidenceIdMap = new Map();
  const appended = await services.evidence.appendBatch(
    project.id,
    fixture.evidence.map((record) => ({
      input: {
        claim: record.claim,
        quote: record.quote,
        source: { sourceId: sourceIdMap.get(record.source.sourceId), title: record.source.title, year: record.source.year, url: record.source.url },
        location: { section: record.location.section, chunk: `${sourceIdMap.get(record.source.sourceId)}:abstract:${record.id.toLowerCase()}` },
        verificationStatus: "verified",
        verificationMethod: record.verificationMethod.slice(0, 200),
        supportStrength: record.supportStrength,
        verificationLevel: record.verificationLevel,
      },
      createdBy,
    })),
  );
  fixture.evidence.forEach((record, index) => evidenceIdMap.set(record.id, appended[index].id));
  let items = [];
  let matrix = null;
  let matrixFingerprint = null;
  let seed = null;
  let families = [];
  const allSources = fixture.bibliography.map((entry) => entry.sourceId);
  if (surveyArtifacts) {
    const built = await seedSurveyArtifacts({ load, projects, projectId: project.id, fixture, sourceIdMap, evidenceIdMap });
    items = built.items;
    matrix = built.matrix;
    matrixFingerprint = built.matrixFingerprint;
    seed = built.seed;
    families = built.families;
  }
  let corpus = null;
  if (freezeCorpus) {
    corpus = await services.corpus.freeze(project.id, { matrix });
  }
  return {
    project,
    sourceIdMap,
    evidenceIdMap,
    candidateIds,
    items,
    matrix,
    matrixFingerprint,
    seed,
    families,
    allSources,
    corpus,
    summary: {
      sources: [...sourceIdMap.entries()],
      evidence: [...evidenceIdMap.entries()],
      candidates: candidateIds,
      synthesis: items.map((entry) => ({ id: entry.synthesisId, kind: entry.kind, grounding: entry.groundingLevel, evidence: entry.evidenceIds.length })),
      workflowKind,
      ...(corpus !== null ? { corpus: { revision: corpus.revision, fingerprint: corpus.fingerprint } } : {}),
    },
  };
}

/** Collect the written sections of a project (unwritten sections skipped) and dump manuscript artifacts. */
export async function collectSections({ services, projectId, output, prefix = "production" }) {
  const outline = await services.manuscript.loadOutline(projectId);
  const sections = [];
  for (const section of outline?.sections ?? []) {
    try {
      sections.push({ id: section.id, title: section.title, file: section.file, latex: await readFile(services.manuscript.sectionPath(projectId, section), "utf8") });
    } catch {
      /* unwritten */
    }
  }
  await writeFile(join(output, `${prefix}-sections.json`), JSON.stringify(sections, null, 2));
  await writeFile(join(output, `${prefix}-manuscript.tex`), sections.map((section) => section.latex).join("\n\n"));
  return { outline, sections };
}

/**
 * Deterministic evaluation (no model calls): academic redundancy classification with the writing-plan roles (or title /
 * position inference when the plan is absent — Arm A), citation whitelist, concept markers (math-mode aware),
 * negative-control escalations and numbers outside the evidence quotes. Identical to the M13.7.10 evaluation.
 */
export async function evaluateSurveySections({ load, services, projectId, fixture, markers, sections, roles: rolesIn, output, prefix = "production" }) {
  const { classifyAcademicRedundancy, inferSectionRoles } = await load("review/academicRedundancyClassifier.js");
  const { stripLatexForRedundancy, splitRedundancySentences } = await load("review/crossSectionRedundancy.js");
  const plan = await services.reviewArtifacts.loadWritingPlan(projectId);
  const roles = rolesIn ?? (plan !== null ? Object.fromEntries(plan.sections.map((section) => [section.sectionId, section.role])) : inferSectionRoles(sections));
  const classified = classifyAcademicRedundancy(sections, Object.keys(roles).length > 0 ? { roles } : {});
  const plain = (latex) => stripLatexForRedundancy(latex).replace(/\s+/g, " ");
  const knownKeys = new Set((plan?.sections ?? []).flatMap((section) => section.citationKeys.allowed ?? section.citationKeys.evidenceBacked));
  try {
    for (const match of (await readFile(services.manuscript.bibPath(projectId), "utf8")).matchAll(/^@\w+\{([^,\s]+),/gm)) knownKeys.add(match[1]);
  } catch {
    /* no bib */
  }
  const plainWithMath = (latex) =>
    latex
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
  for (const control of controls) {
    for (const section of sections) {
      for (const sentence of splitRedundancySentences(plain(section.latex))) {
        const match = new RegExp(control.pattern).exec(sentence);
        if (!match) continue;
        const negated = new RegExp(control.negationWindow).test(sentence.slice(0, match.index)) || /(不|未|无|缺乏|尚|并非|不能|无法|没有)/.test(sentence.slice(match.index));
        escalations.push({ control: control.id, section: section.id, sentence: sentence.slice(0, 200), negated });
      }
    }
  }
  const numberTokens = (text) => [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
  const allowedNumbers = new Set([...fixture.evidence.flatMap((record) => numberTokens(record.quote)), ...fixture.bibliography.map((entry) => String(entry.year))]);
  const numbersOutsideQuotes = sections.flatMap((section) =>
    splitRedundancySentences(section.latex.replace(/\\cite\w*\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ").replace(/\\(?:label|ref|eqref|section)\{[^{}]*\}/g, "\n")).flatMap((sentence) => {
      const outside = [...new Set(numberTokens(sentence))].filter((n) => !allowedNumbers.has(n));
      return outside.length > 0 ? [{ section: section.id, numbers: outside, sentence: sentence.replace(/\s+/g, " ").trim().slice(0, 200) }] : [];
    }),
  );
  const evaluation = {
    rolesSource: rolesIn !== undefined ? "explicit" : plan !== null ? "writing-plan" : "inferred(title/position)",
    sections: sections.map((section) => ({
      id: section.id,
      role: roles[section.id] ?? null,
      chars: section.latex.length,
      cjk: (section.latex.match(/[一-鿿]/g) ?? []).length,
      cites: (section.latex.match(/\\cite\w*\{/g) ?? []).length,
      unknownKeys: [...new Set(citeKeysOf(section.latex).filter((key) => !knownKeys.has(key)))],
    })),
    totals: {
      cjk: sections.reduce((sum, section) => sum + (section.latex.match(/[一-鿿]/g) ?? []).length, 0),
      cites: sections.reduce((sum, section) => sum + (section.latex.match(/\\cite\w*\{/g) ?? []).length, 0),
      charCount: classified.summary.charCount, sentenceCount: classified.summary.sentenceCount,
    },
    lexical: classified.summary.lexical,
    harmful: classified.summary.harmful,
    harmfulUpperShare: classified.summary.harmfulUpperShare,
    classCounts: classified.summary.classCounts,
    harmfulSentences: classified.harmfulSentences,
    uncertainSentences: classified.uncertainSentences,
    signpostSentences: classified.signpostSentences.filter((sentence) => sentence.harmful || sentence.role !== "framing"),
    concepts,
    conceptsMissing: concepts.filter((concept) => !concept.present).map((concept) => concept.id),
    negativeControlEscalations: escalations.filter((entry) => !entry.negated),
    negativeControlMentions: escalations,
    numbersOutsideQuotes,
    limitationSentences: classified.detector.limitationSentences,
  };
  await writeFile(join(output, `${prefix}-classified-pairs.json`), JSON.stringify(classified.pairs, null, 2));
  return evaluation;
}

/** Minimal stage context for running a production StageSpec outside the orchestrator (M13.7.10 pattern). */
export function makeStageCtx({ runId, projectId, state, output, progress, logs }) {
  return (stageId) => ({
    runId,
    projectId,
    attempt: 1,
    state,
    signal: new AbortController().signal,
    emitProgress: async (data) => {
      progress.push({ stageId, at: new Date().toISOString(), ...data });
      await writeFile(join(output, "progress.json"), JSON.stringify(progress, null, 2));
    },
    emitDomain: async () => {},
    log: (message) => {
      logs.push(message.slice(0, 400));
    },
  });
}

export function resolveRepoPaths(repoArg, outputArg) {
  const repo = resolve(repoArg);
  const output = resolve(outputArg);
  assertOutsideRepo(repo, output);
  return { repo, output };
}
