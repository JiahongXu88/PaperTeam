/** Bounded, paired M13.7.3 prompt acceptance. No HTTP server or provider search.
 * Usage: node cross-section-writing-live.mjs BASELINE_ROOT CURRENT_ROOT INPUT_JSON OUTPUT_DIR
 * INPUT_JSON: {outline, instructions, evidence: EvidenceRecord[], bibliography: BibliographyEntryInput[]}
 * Optional fifth argument: before,after (default) or fixed. Run serially.
 * Shared parent model-budget.json counts reservations before dispatch (max 32).
 * Keep the same output parent for every phase; do not run concurrent runners.
 * Supply previously grounded public-paper records, including direct and partial.
 * Uses only the server's already-authorized runtime model settings. Never export auth.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const [baselineArg, currentArg, inputArg, outputArg, selection = "before,after", reviewManuscript] = process.argv.slice(2);
const variants = selection.split(",");
if (variants.some(v => !["before", "after", "fixed", "review"].includes(v))) throw new Error("Invalid variants");
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
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxCalls: 32, reservations: [] }; }
if (budget.maxCalls !== 32) throw new Error("Budget must be 32");

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
const project = await new ProjectStore({ root: config.projectsRoot }).create("M13.7.3 public-paper bounded acceptance");
const result = { model: spec, maxCalls: selection === "review" ? 3 : 5 * variants.length, calls: [], startedAt: new Date().toISOString(), scope: "sequential shared-session section prompts; not full workflow; supplied public evidence; no provider re-verification" };
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
const run = async (variant, name, prompt) => {
  if (result.calls.length >= result.maxCalls) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
  if (budget.reservations.length >= budget.maxCalls) throw new Error("GLOBAL_MODEL_CALL_BUDGET_EXHAUSTED");
  budget.reservations.push({ output, variant, name, at: new Date().toISOString() });
  await writeFile(budgetPath, JSON.stringify(budget, null, 2));
  const record = { variant, name, promptChars: prompt.length };
  result.calls.push(record); await save();
  await writeFile(join(output, `${variant}-${name}.prompt.txt`), prompt);
  const started = Date.now();
  const task = await runtime.runAgent({ agentId: variant === "review" ? config.agents.reviewer : config.agents.writer, projectId: project.id, contextScope: variant === "review" ? `review/${name}/acceptance` : `writing/acceptance/${variant}/sections`, toolPolicy: "read_only", language: "zh", timeoutMs: 180000, signal: AbortSignal.timeout(190000), task: prompt });
  Object.assign(record, { status: task.status, usage: task.usage, skills: task.skills, seconds: (Date.now() - started) / 1000 });
  await writeFile(join(output, `${variant}-${name}.output.txt`), task.output ?? task.error ?? "");
  if (task.status !== "completed") throw new Error(`Model task ${name}: ${task.status}`);
  await save(); return { text: task.output ?? "", record };
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
    const previousSections = [];
    for (const section of input.outline.sections) {
      const prompt = writer.buildSectionPrompt({ section, outline: input.outline, evidence: input.evidence,
        bibliography: input.bibliography, language: "zh", previousSections,
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
