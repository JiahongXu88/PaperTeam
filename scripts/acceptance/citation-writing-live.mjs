/** Bounded, paired M13.7.2 prompt acceptance. No HTTP server or provider search.
 * Usage: node citation-writing-live.mjs BASELINE_ROOT CURRENT_ROOT INPUT_JSON OUTPUT_DIR
 * INPUT_JSON: {evidence: EvidenceRecord[], bibliography: BibliographyEntryInput[]}
 * Supply previously grounded public-paper records, including direct and partial.
 * Uses only the server's already-authorized runtime model settings. Never export auth.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const [baselineArg, currentArg, inputArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error("Expected BASELINE_ROOT CURRENT_ROOT INPUT_JSON OUTPUT_DIR");
const baseline = resolve(baselineArg), current = resolve(currentArg), output = resolve(outputArg);
for (const repo of [baseline, current]) {
  const rel = relative(repo, output);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Output must be outside both repositories");
}
const load = (root, file) => import(pathToFileURL(join(root, "backend/dist", file)).href);
const input = JSON.parse(await readFile(inputArg, "utf8"));
if (!input.evidence?.some((e) => e.supportStrength === "partial") || !input.evidence?.some((e) => e.supportStrength === "direct")) throw new Error("Provide direct and partial public evidence");
await mkdir(output, { recursive: true });
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
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(config.pi.agentDir, "auth.json"), modelsPath: join(config.pi.agentDir, "models.json") });
await applyStoredApiChannels(modelRuntime, settings);
const runtime = new PiRuntimeAdapter({ modelSpec: spec, modelRuntime, agentDir: config.pi.agentDir, workspaceRoot: config.projectsRoot,
  runTimeoutMs: 90000, executionTimeoutMs: 90000, firstActivityTimeoutMs: 30000, maxConcurrentRuns: 1, maxQueuedRuns: 1,
  roleSkillDirs: (role, scope) => role === "writer" ? [join(scope?.includes("/before/") ? baseline : current, "backend/skills/seed/academic-writing-zh"), join(scope?.includes("/before/") ? baseline : current, "backend/skills/seed/academic-style-zh")] : [],
  agentModelSpecs: async () => (await settings.load()).agents ?? {} });
const project = await new ProjectStore({ root: config.projectsRoot }).create("M13.7.2 public-paper bounded acceptance");
const result = { model: spec, maxCalls: 14, calls: [], startedAt: new Date().toISOString(), scope: "paired prompts; no full workflow; supplied public-paper evidence; no provider re-verification" };
const save = () => writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
const run = async (variant, name, prompt) => {
  if (result.calls.length >= result.maxCalls) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
  const record = { variant, name, promptChars: prompt.length };
  result.calls.push(record); await save();
  await writeFile(join(output, `${variant}-${name}.prompt.txt`), prompt);
  const started = Date.now();
  const role = ["partial", "limitations", "background"].includes(name) ? "writing" : "citation";
  const task = await runtime.runAgent({ agentId: config.agents.writer, projectId: project.id, contextScope: `${role}/acceptance/${variant}/${name}`, toolPolicy: "read_only", language: "zh", timeoutMs: 90000, signal: AbortSignal.timeout(100000), task: prompt });
  Object.assign(record, { status: task.status, usage: task.usage, skills: task.skills, seconds: (Date.now() - started) / 1000 });
  await writeFile(join(output, `${variant}-${name}.output.txt`), task.output ?? task.error ?? "");
  if (task.status !== "completed") throw new Error(`Model task ${name}: ${task.status}`);
  await save(); return { text: task.output ?? "", record };
};
try {
  for (const [variant, root] of [["before", baseline], ["after", current]]) {
    const writer = await load(root, "writer/WriterService.js");
    const verifier = await load(root, "citation/semanticVerifier.js");
    const partial = input.evidence.filter((e) => e.supportStrength === "partial");
    const key = input.bibliography[0].key;
    const cases = [
      { id: "partial", title: "相关方法", points: ["说明 Transformer 不使用循环与卷积的架构设计，准确使用现有证据。"], evidence: partial, extra: "仅写一个约120字的中文段落，不补充证据快照以外的事实。" },
      { id: "limitations", title: "方法与适用范围", points: ["描述已实现的注意力序列建模思路。", "当前仅完成小样本初步观察，尚缺跨域评测，未来计划比较计算开销。"], evidence: input.evidence, extra: "内部工作记录：本轮检索未发现更多可用文献；作者确认、尚未核验；待补实验。撰写约180字正式论文正文，保留科学限制，不虚构实验。", experimentContext: { status: "none", observations: [], truncated: false } },
      { id: "background", title: "引言", points: ["围绕序列建模组织研究背景，注意力模型作为相关研究方向；不讨论数值性能。"], evidence: [], extra: `仅写约100字研究背景，可引用 ${key}，不声称外部论文证明本文结果。` },
    ];
    for (const item of cases) {
      const section = { id: item.id, title: item.title, file: `${item.id}.tex`, keyPoints: item.points, targetLengthWords: 150 };
      const prompt = writer.buildSectionPrompt({ section, outline: { title: "序列建模研究", sections: [section] }, evidence: item.evidence, bibliography: input.bibliography, extraInstructions: item.extra, experimentContext: item.experimentContext });
      const written = await run(variant, item.id, prompt);
      written.record.styleSignals = scanStyleSignals(written.text);
      written.record.hasCitation = written.text.includes(key);
      written.record.mentionsConvolution = /卷积|convolution/i.test(written.text);
      written.record.retainsScientificLimit = /跨域|小样本/.test(written.text);
      await save();
    }
    const record = input.evidence.find((e) => e.supportStrength === "direct");
    const canonical = { title: record.source.title, year: record.source.year, provider: "fixture-public-paper", recordId: "public-paper" };
    const metadataRecords = new Map([["R001", { referenceId: "R001", status: "VERIFIED", canonical }]]);
    const evidence = [{ source: "fixture-public-paper", text: record.quote, evidenceLevel: record.verificationLevel === "fulltext" ? "fulltext" : "abstract", retrievedAt: "2026-10-11T00:00:00Z" }];
    for (const [name, claim] of [
      ["relevant", "注意力序列建模是本文的研究背景。"],
      ["irrelevant", "岩层地质年代测定是本文的研究背景。"],
      ["own-result", "本文方法在实验中准确率达到93.2%，优于基线。"],
      ["opposing", "与本文采用循环结构不同，被引文献提出不依赖循环、完全依赖注意力的模型。"],
    ]) {
      const prompt = verifier.buildJudgePrompt({ claimText: claim, sourceSentence: claim, referenceIds: ["R001"], references: [], metadataRecords, groupRawText: "[1]", evidence });
      const judged = await run(variant, name, prompt);
      try { judged.record.parsed = verifier.parseJudgeOutput(judged.text, evidence, "full", claim); }
      catch (error) { judged.record.parseError = error.message; }
      await save();
    }
  }
  result.status = "COMPLETED";
} catch (error) { result.status = "FAILED"; result.error = error.message; process.exitCode = 1; }
finally { await runtime.close(); await save(); console.log(JSON.stringify({ status: result.status, calls: result.calls.length })); }
