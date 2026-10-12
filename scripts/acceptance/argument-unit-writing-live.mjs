/** Bounded M13.7.7 / M13.7.8 / M13.7.9 acceptance runner: same-harness model contrast + argument-unit input organization (+ its
 * single-factor ablations, the B2 revision and the H3-only arm) + post-draft collapse.
 * Usage:
 *   node argument-unit-writing-live.mjs REPO_ROOT INPUT_JSON OUTPUT_DIR --arm baseline|argument-unit|evidence-only|length-only|argument-unit-v2|task-only --model provider/model [--max-tasks N] [--budget-file PATH]
 *   node argument-unit-writing-live.mjs REPO_ROOT INPUT_JSON OUTPUT_DIR --arm collapse --model provider/model --source BASELINE_OUTPUT_DIR [--max-targets 3]
 * INPUT_JSON: fixtures/m13-7-7/dev.json, fixtures/m13-7-8/heldout.json or fixtures/m13-7-9/*.json shape
 *   ({outline, evidence, bibliography, instructions, argumentUnits? (v1/v2 = Arm B), argumentUnitsV2? (B2)}).
 * Arms (all through production buildSectionPrompt parameters only; production code unchanged):
 *   baseline          full evidence snapshot, fixture length, fixture instructions (production input organization)
 *   evidence-only     H1 only: per-section argumentUnits.evidenceIds; length / instructions unchanged
 *   length-only       H2 only: full evidence; per-section argumentUnits.targetLengthWords as upper bound + lengthPolicy sentence
 *   argument-unit     B  = H1 + H2 + H3: evidence partition + upper-bound length + argument-task block (role / task / doNotExplain with「见 X 一节」pointers)
 *   argument-unit-v2  B2 = same partition / lengths / lengthPolicy as B, but the task block from argumentUnitsV2 (behavioural
 *                     cross-section policy instead of rendered pointers; synthesis-style compare task) — M13.7.9
 *   task-only         H3-only: full evidence snapshot + fixture length / instructions (as baseline) + the B2 task block without the
 *                     lengthPolicy line — M13.7.9 attribution arm
 * Shared budget file (default OUTPUT_DIR/../model-budget.json, override --budget-file) reserves one Writer TASK per section before
 * dispatch (max --max-tasks, default 20) and records the assistant turns (underlying provider requests) each task actually spent;
 * tasks and requests are reported separately.
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
const WRITING_ARMS = ["baseline", "argument-unit", "evidence-only", "length-only", "argument-unit-v2", "task-only"];
if (![...WRITING_ARMS, "collapse"].includes(arm)) throw new Error("--arm must be baseline | argument-unit | evidence-only | length-only | argument-unit-v2 | task-only | collapse");
const V2_ARMS = ["argument-unit-v2", "task-only"];
const LENGTH_SWAP_ARMS = ["argument-unit", "argument-unit-v2", "length-only"];
const modelSpec = flags.model;
if (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec)) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 20);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 30) throw new Error("--max-tasks must be an integer in 1..30 (M13.7.9 round cap is 30 Writer tasks)");
const maxTargets = Number(flags["max-targets"] ?? 3);
const repo = resolve(repoArg), output = resolve(outputArg);
const rel = relative(repo, output);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Output must be outside the repository");
const load = (file) => import(pathToFileURL(join(repo, "backend/dist", file)).href);
const inputBytes = await readFile(inputArg);
const input = JSON.parse(inputBytes.toString("utf8"));
if (input.outline?.sections?.length !== 5) throw new Error("Frozen acceptance requires exactly five sections");
// Which argument-unit block this arm consumes: B / C / D read argumentUnits (v1); B2 / H3-only read argumentUnitsV2.
// baseline needs neither, but validates whichever block is present so a broken fixture is caught before any request.
const units = V2_ARMS.includes(arm) ? input.argumentUnitsV2 : (input.argumentUnits ?? input.argumentUnitsV2);
if (arm !== "baseline" && arm !== "collapse" && !units?.sections) throw new Error(`Fixture must carry ${V2_ARMS.includes(arm) ? "argumentUnitsV2" : "argumentUnits"} for arm ${arm}`);
for (const block of [input.argumentUnits, input.argumentUnitsV2].filter(Boolean)) {
  for (const section of input.outline.sections) {
    const unit = block.sections?.[section.id];
    if (!unit) throw new Error(`argument-unit block missing section ${section.id}`);
    for (const id of unit.evidenceIds) if (!input.evidence.some((e) => e.id === id)) throw new Error(`Unknown evidence ${id} in ${section.id}`);
    for (const item of unit.doNotExplain ?? []) if (!input.outline.sections.some((s) => s.id === item.ownerSectionId)) throw new Error(`Unknown owner ${item.ownerSectionId}`);
  }
}
// Length wording swap used by the length-bearing arms (argument-unit / argument-unit-v2 / length-only): fixture-declared, must actually occur in the instructions.
const lengthSwap = units?.lengthInstructionReplace ?? { from: "约350中文字（允许合理浮动），", to: "长度以下方「目标长度」为上限参考，" };
if (LENGTH_SWAP_ARMS.includes(arm) && !input.instructions.includes(lengthSwap.from)) throw new Error("instructions do not contain the length wording declared for replacement");
// Refuse to overwrite a previous run, including failed or unfavorable outputs.
await mkdir(output);
const budgetPath = flags["budget-file"] ? resolve(flags["budget-file"]) : join(output, "..", "model-budget.json");
let budget;
try { budget = JSON.parse(await readFile(budgetPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxTasks: MAX_TASKS, reservations: [] }; }
if (budget.maxTasks !== MAX_TASKS) throw new Error(`Budget file declares ${budget.maxTasks} Writer tasks but --max-tasks is ${MAX_TASKS}`);
const committedTasks = () => budget.reservations.length;
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
const project = await new ProjectStore({ root: config.projectsRoot }).create(`M13.7.9 ${arm} ${modelSpec}`);
const NO_EXPERIMENTS = { status: "none", observations: [], truncated: false };
const result = { arm, model: modelSpec, inputHash: createHash("sha256").update(inputBytes).digest("hex"), maxTasks: MAX_TASKS, budgetFile: budgetPath,
  unitsBlock: V2_ARMS.includes(arm) ? "argumentUnitsV2" : (arm === "baseline" || arm === "collapse" ? null : "argumentUnits"),
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
  if (committedTasks() + 1 > budget.maxTasks) throw new Error("GLOBAL_WRITER_TASK_BUDGET_EXHAUSTED");
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
    `长度口径：${units.lengthPolicy}`,
  ].join("\n");
}

// B2 task block (M13.7.9): no rendered「见 X 一节」pointers; one behavioural cross-section policy; lengthPolicy only for the length-bearing arm.
function renderArgumentUnitV2(unit, { withLengthPolicy }) {
  const labels = units.roleLabels ?? {};
  return [
    "===== 本节论证任务（组织约定，不是事实证据）=====",
    `角色：${labels[unit.role] ?? ROLE_LABEL[unit.role] ?? unit.role}`,
    `任务：${unit.task}`,
    ...(unit.doNotExplain?.length
      ? ["本节不重新解释的内容（由其他章节完整展开；如论述需要，以半句点到为止）：", ...unit.doNotExplain.map((item) => `- ${item.concept}`)]
      : []),
    `跨章节约定：${units.crossSectionPolicy}`,
    ...(withLengthPolicy ? [`长度口径：${units.lengthPolicy}`] : []),
  ].join("\n");
}

function buildArmPrompt(section) {
  const unit = units?.sections?.[section.id];
  const partition = unit ? unit.evidenceIds.map((id) => input.evidence.find((e) => e.id === id)) : input.evidence;
  const bounded = unit ? { ...section, targetLengthWords: unit.targetLengthWords } : section;
  const lengthInstructions = input.instructions.replace(lengthSwap.from, lengthSwap.to);
  const common = { outline: input.outline, bibliography: input.bibliography, language: "zh", experimentContext: NO_EXPERIMENTS };
  switch (arm) {
    case "baseline":
      return writer.buildSectionPrompt({ ...common, section, evidence: input.evidence, extraInstructions: input.instructions });
    case "argument-unit-v2":
      return writer.buildSectionPrompt({ ...common, section: bounded, evidence: partition,
        extraInstructions: `${lengthInstructions}\n${renderArgumentUnitV2(unit, { withLengthPolicy: true })}` });
    case "task-only":
      return writer.buildSectionPrompt({ ...common, section, evidence: input.evidence,
        extraInstructions: `${input.instructions}\n${renderArgumentUnitV2(unit, { withLengthPolicy: false })}` });
    case "evidence-only":
      return writer.buildSectionPrompt({ ...common, section, evidence: partition, extraInstructions: input.instructions });
    case "length-only":
      return writer.buildSectionPrompt({ ...common, section: bounded, evidence: input.evidence,
        extraInstructions: `${lengthInstructions}\n长度口径：${units.lengthPolicy}` });
    case "argument-unit":
      return writer.buildSectionPrompt({ ...common, section: bounded, evidence: partition,
        extraInstructions: `${lengthInstructions}\n${renderArgumentUnit(unit)}` });
    default:
      throw new Error(`unsupported writing arm ${arm}`);
  }
}

async function writeArm() {
  const written = [];
  for (const section of input.outline.sections) {
    const prompt = buildArmPrompt(section);
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
  result.tasksCommitted = committedTasks();
  result.requestsCommitted = committedRequests();
  result.assistantTurns = result.calls.reduce((sum, c) => sum + (c.usage?.assistantTurns ?? 0), 0);
  await runtime.close(); await save();
  console.log(JSON.stringify({ status: result.status, arm, model: modelSpec, calls: result.calls.length, tasksCommitted: result.tasksCommitted, requestsCommitted: result.requestsCommitted, assistantTurns: result.assistantTurns, error: result.error }));
}
