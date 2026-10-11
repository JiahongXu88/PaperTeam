/** Bounded, paired M13.7.4 prompt acceptance. No HTTP server or provider search.
 * Usage: node chapter-responsibility-live.mjs BASELINE_ROOT CURRENT_ROOT INPUT_JSON OUTPUT_DIR
 * INPUT_JSON: {outline, instructions, evidence: EvidenceRecord[], bibliography: BibliographyEntryInput[]}
 * Optional fifth argument: before,after (default) or fixed. Run serially.
 * Shared parent model-budget.json counts reservations before dispatch (max 40).
 * Keep the same output parent for every phase; do not run concurrent runners.
 * Supply previously grounded public-paper records, including direct and partial.
 * Uses only the server's already-authorized runtime model settings. Never export auth.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const [baselineArg, currentArg, inputArg, outputArg, selection = "before,after", reviewManuscript] = process.argv.slice(2);
const variants = selection.split(",");
if (variants.some(v => !["before", "after", "fixed", "review", "plan"].includes(v))) throw new Error("Invalid variants");
if (variants.includes("review") && (variants.length !== 1 || !reviewManuscript)) throw new Error("review requires a manuscript path");
if (!outputArg) throw new Error("Expected BASELINE_ROOT CURRENT_ROOT INPUT_JSON OUTPUT_DIR");
const baseline = resolve(baselineArg), current = resolve(currentArg), output = resolve(outputArg);
for (const repo of [baseline, current]) {
  const rel = relative(repo, output);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Output must be outside both repositories");
}
const load = (root, file) => import(pathToFileURL(join(root, "backend/dist", file)).href);
const input = JSON.parse(await readFile(inputArg, "utf8"));
if (!input.evidence?.some((e) => e.supportStrength === "partial") || !input.evidence?.some((e) => e.supportStrength === "direct")) throw new Error("Provide direct and partial public evidence");
if (input.outline?.sections?.length !== 5) throw new Error("Frozen acceptance requires exactly five sections");
// Refuse to overwrite a previous run, including failed or unfavorable outputs.
await mkdir(output);
const budgetPath = join(output, "..", "model-budget.json");
let budget;
try { budget = JSON.parse(await readFile(budgetPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxCalls: 40, reservations: [] }; }
if (budget.maxCalls !== 40) throw new Error("Budget must be 40");

const { loadConfig } = await load(current, "config/config.js");
const { ModelSettingsStore, resolveStartupModelSpec } = await load(current, "settings/ModelSettingsStore.js");
const { applyStoredApiChannels } = await load(current, "settings/apiChannels.js");
const { PiRuntimeAdapter } = await load(current, "runtime/PiRuntimeAdapter.js");
const { ProjectStore } = await load(current, "project/ProjectStore.js");
const { scanStyleSignals } = await load(current, "review/styleSignals.js");
const sdk = await import(pathToFileURL(join(current, "backend/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const config = loadConfig();
const settings = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const spec = await resolveStartupModelSpec(config.pi.model, settings);
if (spec !== "zai/glm-5.3") throw new Error("Expected authorized zai/glm-5.3");
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
await applyStoredApiChannels(modelRuntime, settings);
const runtime = new PiRuntimeAdapter({ modelSpec: spec, modelRuntime, agentDir: config.pi.agentDir, workspaceRoot: config.projectsRoot,
  runTimeoutMs: 180000, executionTimeoutMs: 180000, firstActivityTimeoutMs: 30000, maxConcurrentRuns: 1, maxQueuedRuns: 1,
  roleSkillDirs: (role, scope) => role === "writer" ? [join(scope?.includes("/before/") ? baseline : current, "backend/skills/seed/academic-writing-zh"), join(scope?.includes("/before/") ? baseline : current, "backend/skills/seed/academic-style-zh")] : [],
  agentModelSpecs: async () => (await settings.load()).agents ?? {} });
const frozenConfig = await settings.load();
if (Object.values(frozenConfig.agents ?? {}).some(value => value && value !== spec)) throw new Error("Unexpected agent model override");
const configHash = createHash("sha256").update(JSON.stringify(frozenConfig)).digest("hex");
const inputHash = createHash("sha256").update(await readFile(inputArg)).digest("hex");
const project = await new ProjectStore({ root: config.projectsRoot }).create("M13.7.4 public-paper bounded acceptance");
const result = { model: spec, configHash, inputHash, maxCalls: ["review", "plan"].includes(selection) ? 3 : 5 * variants.length, calls: [], startedAt: new Date().toISOString(), scope: "frozen responsibility only; sequential shared-session production normal/survey prompt builders; manual scoped evidence, no full workflow or provider re-verification" };
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
const run = async (variant, name, prompt, scope) => {
  if (result.calls.length >= result.maxCalls) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
  if (budget.reservations.length >= budget.maxCalls) throw new Error("GLOBAL_MODEL_CALL_BUDGET_EXHAUSTED");
  budget.reservations.push({ output, variant, name, at: new Date().toISOString() });
  await writeFile(budgetPath, JSON.stringify(budget, null, 2));
  const record = { variant, name, promptChars: prompt.length };
  result.calls.push(record); await save();
  await writeFile(join(output, `${variant}-${name}.prompt.txt`), prompt);
  const started = Date.now();
  const task = await runtime.runAgent({ agentId: variant === "review" ? config.agents.reviewer : config.agents.writer, projectId: project.id, contextScope: scope ?? (variant === "review" ? `review/${name}/acceptance` : `writing/acceptance/${variant}/sections`), toolPolicy: "read_only", language: "zh", timeoutMs: 180000, signal: AbortSignal.timeout(190000), task: prompt });
  Object.assign(record, { status: task.status, usage: task.usage, skills: task.skills, seconds: (Date.now() - started) / 1000 });
  await writeFile(join(output, `${variant}-${name}.output.txt`), task.output ?? task.error ?? "");
  if (task.status !== "completed") throw new Error(`Model task ${name}: ${task.status}`);
  await save(); return { text: task.output ?? "", record, task };
};
try {
  for (const variant of variants) {
    const root = variant === "before" ? baseline : current;
    if (variant === "review") {
      const reviewer = await load(root, "agents/ReviewerService.js");
      const manuscriptDigest = await readFile(reviewManuscript, "utf8");
      for (const mode of ["fact", "academic", "style"]) {
        await run(variant, mode, reviewer.buildReviewPrompt({ projectId: project.id, mode,
          manuscriptDigest, evidence: input.evidence, language: "zh", reviewProfile: "survey" }));
      }
      continue;
    }
    const writer = await load(root, "writer/WriterService.js");
    if (variant === "plan") {
      let attempt = 0;
      const trackedRuntime = { runAgent: async request => (await run("plan", `outline-${++attempt}`, request.task, "writing/outline")).task };
      const service = new writer.WriterService({ runtime: trackedRuntime, agentId: config.agents.writer });
      const digest = input.mode === "survey" ? {
        topic: input.outline.title,
        items: Object.values(input.surveyContexts).flatMap(c => c.synthesis).map(s => ({ ...s, entryIds: input.bibliography.map(b => `M-${b.sourceId}`), sourceCount: 2 })),
        literature: input.bibliography.map(b => ({ entryId: `M-${b.sourceId}`, family: "联邦优化", title: b.title, year: b.year, interpretationDepth: "abstract_only" })),
        stats: { totalEntries: 2, fulltext: 0, abstractOnly: 2, unclassified: 0, familyDistribution: [{ label: "联邦优化", count: 2 }], yearDistribution: [], groundingDistribution: { evidence_backed: 3, literature_cited: 0, speculative: 0 } }, truncatedSpeculative: 0,
      } : undefined;
      const planned = await service.planOutline({ projectId: project.id, evidence: input.evidence, bibliography: input.bibliography, language: "zh", requireResponsibility: true,
        feedback: "仅检查结构化规划能力；遵循以下固定五章结构与要点：" + JSON.stringify(input.outline),
        ...(digest ? { surveyDigest: digest } : { researchDigest: { domainOverview: input.outline.title, researchGaps: ["未统一复现，不能排序性能"], potentialContributions: ["文献机制关系的综合整理"] } }),
        experimentContext: { status: "none", observations: [], truncated: false } });
      await writeFile(join(output, "planned-outline.json"), JSON.stringify(planned, null, 2));
      continue;
    }

    const previousSections = [];
    const outline = structuredClone(input.outline);
    if (variant !== "before") outline.responsibility = input.responsibility;
    const { validateOutline } = await load(root, "manuscript/ManuscriptService.js");
    const violations = validateOutline(outline);
    if (violations.length) throw new Error(violations.join(";"));
    for (const section of input.outline.sections) {
      const prompt = input.mode === "survey"
        ? writer.buildSurveySectionPrompt({ section, outline, bibliography: input.bibliography, language: "zh", survey: input.surveyContexts[section.id] }) + "\n" + input.instructions
        : writer.buildSectionPrompt({ section, outline, evidence: input.evidence,
        bibliography: input.bibliography, language: "zh",
        extraInstructions: input.instructions, experimentContext: { status: "none", observations: [], truncated: false } });
      const written = await run(variant, section.id, prompt);
      previousSections.push({ id: section.id, title: section.title, latex: written.text });
      written.record.styleSignals = scanStyleSignals(written.text); await save();
    }
    await writeFile(join(output, `${variant}-manuscript.tex`), previousSections.map(s => s.latex).join("\n\n"));
  }
  result.status = "COMPLETED";
} catch (error) { result.status = "FAILED"; result.error = error.message; process.exitCode = 1; }
finally { await runtime.close(); await save(); console.log(JSON.stringify({ status: result.status, calls: result.calls.length })); }
