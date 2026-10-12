/** Bounded M13.7.7 acceptance runner: same-harness model contrast + argument-unit input organization + post-draft collapse.
 * Usage:
 *   node argument-unit-writing-live.mjs REPO_ROOT INPUT_JSON OUTPUT_DIR --arm baseline|argument-unit --model provider/model
 *   node argument-unit-writing-live.mjs REPO_ROOT INPUT_JSON OUTPUT_DIR --arm collapse --model provider/model --source BASELINE_OUTPUT_DIR [--max-targets 3]
 * INPUT_JSON: fixtures/m13-7-7/dev.json shape ({outline, evidence, bibliography, instructions, argumentUnits}).
 * Shared parent OUTPUT_DIR/../model-budget.json counts underlying provider requests (assistant turns) before dispatch (max 20).
 * Runs serially; refuses to overwrite an existing OUTPUT_DIR; keeps failed outputs. --dry-run writes prompts only (no provider request, no reservation).
 * Uses only the runtime model settings already stored under PAPERTEAM_RUNTIME_ROOT (custom providers + auth). Never exports auth.
 * Set PROJECTS_ROOT to a private directory so acceptance projects stay outside the repository.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const positional = [];
const flags = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith("--")) {
    flags[value.slice(2)] = process.argv[i + 1];
    i += 1;
  } else {
    positional.push(value);
  }
}
const [repoArg, inputArg, outputArg] = positional;
if (!repoArg || !inputArg || !outputArg) throw new Error("Expected REPO_ROOT INPUT_JSON OUTPUT_DIR");
const arm = flags.arm;
if (!["baseline", "argument-unit", "collapse"].includes(arm)) throw new Error("--arm must be baseline | argument-unit | collapse");
const modelSpec = flags.model;
if (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec)) throw new Error("--model provider/model is required");
const MAX_REQUESTS = 20;
const maxTargets = Number(flags["max-targets"] ?? 3);
const repo = resolve(repoArg), output = resolve(outputArg);
const rel = relative(repo, output);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Output must be outside the repository");
const load = (file) => import(pathToFileURL(join(repo, "backend/dist", file)).href);
const inputBytes = await readFile(inputArg);
const input = JSON.parse(inputBytes.toString("utf8"));
if (input.outline?.sections?.length !== 5) throw new Error("Frozen acceptance requires exactly five sections");
if (!input.argumentUnits?.sections) throw new Error("Fixture must carry argumentUnits");
for (const section of input.outline.sections) {
  const unit = input.argumentUnits.sections[section.id];
  if (!unit) throw new Error(`argumentUnits missing section ${section.id}`);
  for (const id of unit.evidenceIds) if (!input.evidence.some((e) => e.id === id)) throw new Error(`Unknown evidence ${id} in ${section.id}`);
  for (const item of unit.doNotExplain ?? []) if (!input.outline.sections.some((s) => s.id === item.ownerSectionId)) throw new Error(`Unknown owner ${item.ownerSectionId}`);
}
// Refuse to overwrite a previous run, including failed or unfavorable outputs.
await mkdir(output);
const budgetPath = join(output, "..", "model-budget.json");
let budget;
try { budget = JSON.parse(await readFile(budgetPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxRequests: MAX_REQUESTS, reservations: [] }; }
if (budget.maxRequests !== MAX_REQUESTS) throw new Error("Budget must be 20 underlying requests");
const committedRequests = () => budget.reservations.reduce((sum, r) => sum + (r.turns ?? 1), 0);

const { loadConfig } = await load("config/config.js");
const { ModelSettingsStore } = await load("settings/ModelSettingsStore.js");
const { CustomProviderStore } = await load("settings/CustomProviderStore.js");
const { registerStoredCustomProviders } = await load("settings/ModelSettingsService.js");
const { applyStoredApiChannels } = await load("settings/apiChannels.js");
const { PiRuntimeAdapter } = await load("runtime/PiRuntimeAdapter.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { scanStyleSignals } = await load("review/styleSignals.js");
const { analyzeCrossSectionRedundancy, stripLatexForRedundancy } = await load("review/crossSectionRedundancy.js");
const { checkRevisionScope, revisionSourceHash } = await load("review/revisionScope.js");
const { extractCitationKeys, extractNumericTokens } = await load("review/styleInvariants.js");
const writer = await load("writer/WriterService.js");
const sdk = await import(pathToFileURL(join(repo, "backend/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const config = loadConfig();
const settings = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
const customProviders = new CustomProviderStore({ settingsDir: join(config.runtimeRoot, "settings") });
await registerStoredCustomProviders(modelRuntime, customProviders);
await applyStoredApiChannels(modelRuntime, settings);
const storedSettings = await settings.load();
if (Object.values(storedSettings.agents ?? {}).some((value) => value && value !== modelSpec)) throw new Error("Agent model overrides would break the single-model contrast");
const runtime = new PiRuntimeAdapter({ modelSpec, modelRuntime, agentDir: config.pi.agentDir, workspaceRoot: config.projectsRoot,
  runTimeoutMs: 300000, executionTimeoutMs: 300000, firstActivityTimeoutMs: 60000, maxConcurrentRuns: 1, maxQueuedRuns: 1,
  roleSkillDirs: (role) => role === "writer" ? [join(repo, "backend/skills/seed/academic-writing-zh"), join(repo, "backend/skills/seed/academic-style-zh")] : [],
  agentModelSpecs: async () => ({}) });
const project = await new ProjectStore({ root: config.projectsRoot }).create(`M13.7.7 ${arm} ${modelSpec}`);
const NO_EXPERIMENTS = { status: "none", observations: [], truncated: false };
const result = { arm, model: modelSpec, inputHash: createHash("sha256").update(inputBytes).digest("hex"), maxRequests: MAX_REQUESTS,
  calls: [], startedAt: new Date().toISOString(),
  scope: "sequential shared-session production buildSectionPrompt (baseline / argument-unit) or production buildRevisePrompt targeted collapse; fixture evidence; no full workflow, no provider re-verification" };
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
const sectionTitle = (id) => input.outline.sections.find((s) => s.id === id)?.title ?? id;

const dryRun = "dry-run" in flags;
const run = async (name, prompt, scope, agentId = config.agents.writer) => {
  if (dryRun) {
    await writeFile(join(output, `${arm}-${name}.prompt.txt`), prompt);
    result.calls.push({ name, promptChars: prompt.length, status: "dry_run" }); await save();
    return "\\section{" + name + "}\n（dry-run：未调用模型）\n";
  }
  if (committedRequests() + 1 > budget.maxRequests) throw new Error("GLOBAL_MODEL_REQUEST_BUDGET_EXHAUSTED");
  const reservation = { output, arm, name, at: new Date().toISOString() };
  budget.reservations.push(reservation);
  await writeFile(budgetPath, JSON.stringify(budget, null, 2));
  const record = { name, promptChars: prompt.length };
  result.calls.push(record); await save();
  await writeFile(join(output, `${arm}-${name}.prompt.txt`), prompt);
  const started = Date.now();
  const task = await runtime.runAgent({ agentId, projectId: project.id, contextScope: scope, toolPolicy: "read_only", language: "zh",
    timeoutMs: 300000, signal: AbortSignal.timeout(310000), task: prompt });
  reservation.turns = Math.max(1, task.usage?.assistantTurns ?? 1);
  await writeFile(budgetPath, JSON.stringify(budget, null, 2));
  Object.assign(record, { status: task.status, usage: task.usage, skills: task.skills, seconds: (Date.now() - started) / 1000, error: task.error });
  await writeFile(join(output, `${arm}-${name}.output.txt`), task.output ?? task.error ?? "");
  if (task.status !== "completed") throw new Error(`Model task ${name}: ${task.status} ${task.error ?? ""}`);
  await save(); return task.output ?? "";
};

const ROLE_LABEL = { framing: "framing（界定范围与组织，不展开机制）", develop: "develop（本节是指定概念的唯一完整展开位置）", compare: "compare（沿给定维度比较，不重新解释机制）", conclude: "conclude（综合回答问题，一句承接限制）" };
function renderArgumentUnit(unit) {
  return [
    "===== 本节论证任务（组织约定，不是事实证据）=====",
    `角色：${ROLE_LABEL[unit.role] ?? unit.role}`,
    `任务：${unit.task}`,
    ...(unit.doNotExplain?.length
      ? ["本节不重新解释（其他节已完整展开；如需提及，最多一句回指该节标题）：", ...unit.doNotExplain.map((item) => `- ${item.concept}（见「${sectionTitle(item.ownerSectionId)}」一节）`)]
      : []),
    `长度口径：${input.argumentUnits.lengthPolicy}`,
  ].join("\n");
}

async function writeArm() {
  const written = [];
  for (const section of input.outline.sections) {
    let prompt;
    if (arm === "baseline") {
      prompt = writer.buildSectionPrompt({ section, outline: input.outline, evidence: input.evidence, bibliography: input.bibliography,
        language: "zh", extraInstructions: input.instructions, experimentContext: NO_EXPERIMENTS });
    } else {
      const unit = input.argumentUnits.sections[section.id];
      const evidence = unit.evidenceIds.map((id) => input.evidence.find((e) => e.id === id));
      const instructions = input.instructions.replace("约350中文字（允许合理浮动），", "长度以下方「目标长度」为上限参考，");
      prompt = writer.buildSectionPrompt({ section: { ...section, targetLengthWords: unit.targetLengthWords }, outline: input.outline, evidence,
        bibliography: input.bibliography, language: "zh", extraInstructions: `${instructions}\n${renderArgumentUnit(unit)}`, experimentContext: NO_EXPERIMENTS });
    }
    const latex = await run(section.id, prompt, `writing/acceptance/${arm}/sections`);
    const record = result.calls.at(-1);
    record.outputChars = latex.length;
    record.cjkChars = (latex.match(/[一-鿿]/g) ?? []).length;
    record.citeCommands = (latex.match(/\\cite\w*\{/g) ?? []).length;
    record.styleSignals = scanStyleSignals(latex);
    written.push({ id: section.id, title: section.title, file: section.file, latex });
    await save();
  }
  await writeFile(join(output, `${arm}-sections.json`), JSON.stringify(written, null, 2));
  await writeFile(join(output, `${arm}-manuscript.tex`), written.map((s) => s.latex).join("\n\n"));
  const redundancy = analyzeCrossSectionRedundancy(written);
  await writeFile(join(output, "redundancy.json"), JSON.stringify(redundancy, null, 2));
  result.redundancySummary = redundancy.summary;
}

function paragraphsOf(latex) {
  const parts = [];
  let cursor = 0;
  for (const piece of latex.split(/\n\s*\n/)) {
    const start = latex.indexOf(piece, cursor);
    parts.push({ text: piece, start, end: start + piece.length });
    cursor = start + piece.length;
  }
  return parts.filter((p) => p.text.trim() !== "" && !/^\s*\\section/.test(p.text));
}
const counts = (list) => list.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map());

async function collapseArm() {
  if (!flags.source) throw new Error("--source BASELINE_OUTPUT_DIR is required for collapse");
  const sourceDir = resolve(flags.source);
  const sectionsFile = (await readdir(sourceDir)).find((f) => f.endsWith("-sections.json"));
  if (!sectionsFile) throw new Error("source directory has no *-sections.json");
  const sections = JSON.parse(await readFile(join(sourceDir, sectionsFile), "utf8"));
  const before = analyzeCrossSectionRedundancy(sections);
  result.source = { dir: sourceDir, file: sectionsFile, redundancyBefore: before.summary };
  // Targets: later-section paragraphs containing the strongest restatement of an earlier (owner) section, one per section, strongest first.
  const bySection = new Map();
  for (const pair of before.pairs) if (!bySection.has(pair.later.section)) bySection.set(pair.later.section, pair);
  const targets = [...bySection.values()].slice(0, maxTargets);
  result.targets = [];
  const working = sections.map((s) => ({ ...s }));
  for (const [index, pair] of targets.entries()) {
    const section = working.find((s) => s.id === pair.later.section);
    const owner = working.find((s) => s.id === pair.earlier.section);
    const outlineSection = input.outline.sections.find((s) => s.id === section.id);
    const paragraph = paragraphsOf(section.latex).find((p) => stripLatexForRedundancy(p.text).replace(/\s+/g, " ").includes(pair.later.text.slice(0, 20)));
    const target = { section: section.id, owner: owner.id, laterSentence: pair.later.text, earlierSentence: pair.earlier.text, containment: pair.containment };
    result.targets.push(target);
    if (!paragraph) { target.status = "paragraph_not_located"; await save(); continue; }
    target.paragraphChars = paragraph.text.length;
    const ownerNumbers = new Set(extractNumericTokens(owner.latex));
    const paragraphNumbers = extractNumericTokens(paragraph.text);
    const outsideNumbers = extractNumericTokens(section.latex.slice(0, paragraph.start) + section.latex.slice(paragraph.end));
    const mustPreserveValues = [...new Set([...outsideNumbers, ...paragraphNumbers.filter((n) => !ownerNumbers.has(n))])].slice(0, 40);
    const paragraphKeys = [...new Set(extractCitationKeys(paragraph.text))];
    const ownerTitle = sectionTitle(owner.id);
    const item = { id: `redundancy:${section.id}:${index + 1}`, kind: "review_finding", priority: "medium", section: section.file, status: "planned", actionType: "modify", riskLevel: "low",
      problem: `本段完整重述了「${ownerTitle}」一节已经展开的机制（该节原句：「${pair.earlier.text.slice(0, 80)}」），没有新增本节自己的分析。`,
      instruction: `把「唯一允许修改的原文」这一段压缩为一到两句：只保留本节自己的论点与承接，机制细节改为一句回指（如「如「${ownerTitle}」一节所述」）；段内已有的全部 \\cite 保留在压缩后的句子中；不得新增事实、数字或引文之外的细节；该段之外的文本逐字保留。`,
      expectedOutcome: "该段不再完整重述机制；引用、数值与本节论点保持。", targetQuote: paragraph.text,
      mustPreserve: { values: mustPreserveValues, citationKeys: [...new Set(extractCitationKeys(section.latex))].slice(0, 30) } };
    const issue = { category: "style", severity: "major", section: section.file, blocking: false,
      description: `与「${ownerTitle}」一节重复展开同一机制：「${pair.later.text.slice(0, 60)}」`, suggestedAction: "压缩为回指句，保留引用" };
    const prompt = writer.buildRevisePrompt({ section: outlineSection, outline: input.outline, currentLatex: section.latex, issues: [issue], revisionItems: [item],
      evidence: input.evidence, bibliography: input.bibliography, language: "zh", experimentContext: NO_EXPERIMENTS });
    let candidate;
    try { candidate = await run(`${section.id}-collapse`, prompt, `writing/acceptance/collapse/${section.id}`); }
    catch (error) { target.status = "model_failed"; target.error = error.message; await save(); if (error.message.includes("BUDGET")) throw error; continue; }
    candidate = candidate.trim().replace(/^```[a-z]*\n/, "").replace(/\n```$/, "");
    if (!candidate.endsWith("\n") && section.latex.endsWith("\n")) candidate += "\n";
    const scope = checkRevisionScope(section.latex, candidate, { start: paragraph.start, end: paragraph.end, originalHash: revisionSourceHash(paragraph.text) });
    const beforeKeys = counts(extractCitationKeys(section.latex)), afterKeys = counts(extractCitationKeys(candidate));
    const keysPreserved = [...beforeKeys.keys()].every((k) => afterKeys.has(k)) && [...afterKeys.keys()].every((k) => beforeKeys.has(k));
    const paragraphKeysKept = paragraphKeys.every((k) => afterKeys.has(k));
    const afterNumbers = new Set(extractNumericTokens(candidate));
    const beforeNumbers = new Set(extractNumericTokens(section.latex));
    const valuesPreserved = mustPreserveValues.every((v) => afterNumbers.has(v));
    const noNewNumbers = [...afterNumbers].every((n) => beforeNumbers.has(n));
    const replaced = candidate.slice(paragraph.start, candidate.length - (section.latex.length - paragraph.end));
    const trial = working.map((s) => (s.id === section.id ? { ...s, latex: candidate } : s));
    const after = analyzeCrossSectionRedundancy(trial);
    const pairsBefore = analyzeCrossSectionRedundancy(working).pairs.filter((p) => p.later.section === section.id).length;
    const pairsAfter = after.pairs.filter((p) => p.later.section === section.id).length;
    Object.assign(target, { scope, keysPreserved, paragraphKeysKept, valuesPreserved, noNewNumbers, replacedChars: replaced.length, replacedText: replaced,
      pairsBefore, pairsAfter, accepted: scope.allowed && keysPreserved && paragraphKeysKept && valuesPreserved && noNewNumbers && pairsAfter < pairsBefore });
    target.status = target.accepted ? "accepted" : "rejected";
    if (target.accepted) section.latex = candidate;
    await writeFile(join(output, `${arm}-${section.id}.candidate.tex`), candidate);
    await save();
  }
  const after = analyzeCrossSectionRedundancy(working);
  await writeFile(join(output, "redundancy.json"), JSON.stringify({ before, after }, null, 2));
  await writeFile(join(output, `${arm}-sections.json`), JSON.stringify(working, null, 2));
  await writeFile(join(output, `${arm}-manuscript.tex`), working.map((s) => s.latex).join("\n\n"));
  result.redundancySummary = { before: before.summary, after: after.summary };
}

try {
  if (arm === "collapse") await collapseArm(); else await writeArm();
  result.status = "COMPLETED";
} catch (error) { result.status = "FAILED"; result.error = error.message; process.exitCode = 1; }
finally {
  result.finishedAt = new Date().toISOString();
  result.requestsCommitted = committedRequests();
  await runtime.close(); await save();
  console.log(JSON.stringify({ status: result.status, arm, model: modelSpec, calls: result.calls.length, requestsCommitted: result.requestsCommitted, error: result.error }));
}
