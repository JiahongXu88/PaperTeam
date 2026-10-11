/** Run serially in an isolated checkout with existing authorized runtime config.
 * node scripts/acceptance/revision-fidelity-live.mjs PRIVATE_OUTPUT_DIR
 * Production Planner stage -> approved plan ledger -> Writer stage -> validation.
 * Hard budget: 16 runtime tasks including structured/patch/model repairs.
 * Provider turns are separately counted (tool use can create several per task).
 * No server, package install, provider search or private input required.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../../backend/dist/config/config.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../backend/dist/settings/ModelSettingsStore.js";
import { applyStoredApiChannels } from "../../backend/dist/settings/apiChannels.js";
import { PiRuntimeAdapter } from "../../backend/dist/runtime/PiRuntimeAdapter.js";
import { ProjectStore } from "../../backend/dist/project/ProjectStore.js";
import { buildServiceStack } from "../../backend/dist/serviceStack.js";
import { createExistingPaperDefinition } from "../../backend/dist/workflow/definitions.js";
import { recordImprovementPlanApproval } from "../../backend/dist/quality/cumulativeFactPreservation.js";
import { aggregateReviews } from "../../backend/dist/review/ReviewAggregator.js";
import { ModelRuntime } from "../../backend/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2] || output.startsWith(resolve("."))) throw new Error("Output must be outside checkout");
await mkdir(output); // refuse to overwrite a previous run
const config = loadConfig();
const settings = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const spec = await resolveStartupModelSpec(config.pi.model, settings);
if (spec !== "zai/glm-5.3") throw new Error("Expected authorized zai/glm-5.3");
const stored = await settings.load();
if (Object.values(stored.agents ?? {}).some(value => value && value !== spec)) throw new Error("Unexpected role model override");
const modelRuntime = await ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
await applyStoredApiChannels(modelRuntime, settings);
const runtime = new PiRuntimeAdapter({ modelSpec: spec, modelRuntime, agentDir: config.pi.agentDir, workspaceRoot: config.projectsRoot,
  runTimeoutMs: 180000, executionTimeoutMs: 180000, firstActivityTimeoutMs: 30000, maxConcurrentRuns: 1, maxQueuedRuns: 1,
  agentModelSpecs: async () => (await settings.load()).agents ?? {} });
const result = { model: spec, configHash: createHash("sha256").update(JSON.stringify(stored)).digest("hex"), maxCalls: 16,
  startedAt: new Date().toISOString(), calls: [], cases: [] };
const budgetPath = join(output, "..", "model-budget.json");
let budget;
try { budget = JSON.parse(await readFile(budgetPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; budget = { maxCalls: 16, reservations: [], assistantTurns: 0 }; }
if (budget.maxCalls !== 16) throw new Error("Expected shared budget of 16 tasks");
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
// Serial queue also covers any concurrent production caller. Budget is reserved before dispatch.
let queue = Promise.resolve();
const tracked = Object.create(runtime);
tracked.runAgent = input => {
  const operation = queue.then(async () => {
    if (budget.reservations.length >= 16 || budget.assistantTurns >= 16) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
    budget.reservations.push({ output, scope: input.contextScope, at: new Date().toISOString() });
    await writeFile(budgetPath, JSON.stringify(budget, null, 2));
    const index = result.calls.length + 1;
    const record = { index, scope: input.contextScope, startedAt: new Date().toISOString() };
    result.calls.push(record); await save();
    await writeFile(join(output, `${index}.prompt.txt`), input.task);
    const started = Date.now();
    try {
      const task = await runtime.runAgent({ ...input, toolPolicy: "read_only", signal: AbortSignal.timeout(190000) });
      Object.assign(record, { status: task.status, usage: task.usage, seconds: (Date.now() - started) / 1000 });
      budget.assistantTurns += task.usage?.assistantTurns ?? 0;
      await writeFile(budgetPath, JSON.stringify(budget, null, 2));
      await writeFile(join(output, `${index}.output.txt`), task.output ?? task.error ?? "");
      return task;
    } catch (error) { record.error = String(error); throw error; }
    finally { await save(); }
  });
  queue = operation.catch(() => {});
  return operation;
};
const projects = new ProjectStore({ root: config.projectsRoot });
const stack = buildServiceStack({ runtime: tracked, projects, agentIds: config.agents, search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"] }, fullText: { enabled: false } });
const PAPER = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}\label{sec:intro}
We study a compact adapter.\cite{base}
\section{Method}\label{sec:method}
The model use a compact adapter.\cite{base}

The original representation remains frozen.
\section{Results}\label{sec:results}
Accuracy is 82.4\%.
\begin{equation}\label{eq:score} S = a + b \end{equation}
\section{Conclusion}\label{sec:end}
We report the stated evaluation.
\end{document}
`;
const FORMULA = String.raw`\[ L = L_{task} + \lambda L_{reg} \]`;
const cases = [
  { name: "missing-loss", comment: "建议补充损失函数的数学表达式，并说明各项权重。", context: "方法没有定义损失函数，原稿、Evidence 和作者实验材料均无损失项、符号定义、权重值或计算过程。" },
  { name: "local-grammar", comment: "只纠正 Method 第一段 The model use 的主谓一致，其他句子不变。", context: "仅需 use 改为 uses。" },
  { name: "authorized-loss", comment: "按作者提供的真实定义补充损失函数并解释符号，保留既有公式。", context: "作者授权仅增加给定公式及符号解释，禁止推导、改变变量或参数。", formula: true },
];
try {
  for (const scenario of cases) {
    const project = await projects.create(`M13.7.5 ${scenario.name}`, { language: "zh" });
    const entry = { name: scenario.name, projectId: project.id, callStart: result.calls.length, stages: {} };
    result.cases.push(entry); await save();
    await writeFile(join(projects.manuscriptDir(project.id), "main.tex"), PAPER);
    await writeFile(join(projects.manuscriptDir(project.id), "references.bib"), "@article{base,title={Frozen public fixture},year={2020}}");
    await stack.revisions.commit(project.id, "baseline");
    if (scenario.formula) await stack.evidence.append(project.id, { claim: `作者提供的真实损失函数 ${FORMULA}，L 为总损失，L_task 为任务损失，L_reg 为正则损失，lambda 为作者定义的权重；仅整理公式，不指定未知权重数值。`, quote: FORMULA,
      verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct", location: { section: "Method" } }, "user");
    await stack.externalInstructions.add(project.id, { source: "journal_reviewer", text: scenario.comment, section: "sec:method" });
    await writeFile(join(projects.researchDir(project.id), "research.json"), JSON.stringify({ report: { domainOverview: scenario.context, researchGaps: [scenario.comment], relatedWorkDirections: [], potentialContributions: [], researchQuestions: [], literaturePlan: [] }, evidence: [], bibliography: [] }));
    const definition = createExistingPaperDefinition(stack.workflowServices);
    const ctx = { projectId: project.id, runId: `live-${scenario.name}`, attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} }, emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} };
    const execute = async name => { const stage = definition.stages.find(s => s.id === name); entry.stages[name] = await stage.execute(ctx); await save(); };
    try {
      await execute("plan.improvement");
      const plan = JSON.parse(await readFile(join(projects.researchDir(project.id), "improvement-plan.json"), "utf8")).plan;
      entry.plan = plan;
      // The fixture author approves the edit scope, not invented scientific facts.
      await recordImprovementPlanApproval(projects, project.id, ctx.runId);
      await execute("revision.apply");
      const revision = await stack.revisions.currentRevision(project.id);
      entry.patchValidation = await stack.reviewArtifacts.loadPatchValidation(project.id, revision);
      entry.instructions = await stack.externalInstructions.load(project.id);
      const after = await readFile(join(projects.manuscriptDir(project.id), "main.tex"), "utf8");
      await writeFile(join(output, `${scenario.name}.before.tex`), PAPER);
      await writeFile(join(output, `${scenario.name}.after.tex`), after);
      entry.unchanged = after === PAPER;
      entry.exactLocalChange = after === PAPER.replace("model use", "model uses");
      entry.containsAuthorizedFormula = after.includes("L_{task}") && after.includes("L_{reg}");
      // Deterministic production validation with a structured equivalent pre-review.
      await stack.reviewArtifacts.saveSummary(project.id, 1, { ...aggregateReviews([], 1), reviewedRevision: 1 });
      await execute("revision.validate");
      entry.validatedPatch = await stack.reviewArtifacts.loadPatchValidation(project.id, revision);
    } catch (error) { entry.error = String(error); }
    entry.callEnd = result.calls.length; await save();
  }
  // A4: actual Fact Reviewer on a deliberately unsupported optimization claim.
  const p = await projects.create("M13.7.5 mechanism review", { language: "zh" });
  const evidence = [await stack.evidence.append(p.id, { claim: "原始表示保持冻结，仅训练适配器。", quote: "原始表示保持冻结，仅训练适配器。", verificationStatus: "verified", supportStrength: "direct", verificationLevel: "fulltext", location: { chunk: "fixture:1" }, source: { sourceId: "fixture" } }, "fixture")];
  try { result.mechanismReview = await stack.reviewer.reviewMode({ projectId: p.id, mode: "fact", language: "zh", evidence,
    manuscriptDigest: "方法：原始表示保持冻结，仅训练适配器。由于冻结参数无需保存优化器状态，训练在低秩子空间中完成，并通过估计梯度偏差抵消客户端漂移。\\cite{base}\n给定材料仅支持第一句，没有优化器、低秩子空间或偏差估计的实验或推导材料。" }); }
  catch (error) { result.mechanismError = String(error); }
} finally { result.finishedAt = new Date().toISOString(); await save(); await runtime.close(); }
