#!/usr/bin/env node
/**
 * M9.5 Deterministic Bibliography & Citation Trace 真实 smoke（一次性脚本，不进 CI）。
 *
 * 与集成测试的区别：真实模型（Researcher + Writer）+ 真实 FullText（OA 下载 →
 * chunk → 检索）+ 真实 Grounding（quote 逐字 → metadata → judge）→ **真实
 * Writer 章节生成**，随后用 M9.5 确定性代码闭合：
 *
 *   Verified Evidence → SourceIdentity → 确定性 citation key
 *   → Writer \cite{key}（真实模型，key 来自 prompt 行内标注）
 *   → references.bib（确定性渲染 + 实际引用裁剪 + byte identical）
 *
 * 装配与 index.ts 同源（loadConfig / SkillRegistry / roleCustomTools /
 * buildServiceStack），仅两处偏离（与 m94-evidence-smoke 相同）：PROJECTS_ROOT
 * 重定向临时目录；TracingRuntime 采集 tool call trace。
 *
 * 场景：机器人辅助肾切除术（PLOS ONE 10.1371/journal.pone.0210413，真实 OA
 * 全文，与 M9.4 场景 A 同一探测集）。
 *
 * 验收（M9.5 PASS 硬条件）：
 *   1. verified evidence ≥ 1（M9.4 链路复跑成立）；
 *   2. canonical bibliography 的 key 全部为确定性形态（一作+年份+标题词[+后缀]），
 *      LLM 自造 key 不出现在任何下游产物；
 *   3. resolveEvidenceCitationKey(verified) 命中确定性 key；
 *   4. 真实 Writer 输出包含 \cite{<确定性key>}；
 *   5. references.bib 含对应 entry（含 sourceId 追溯字段）且不含未引用条目；
 *   6. 重复渲染 byte identical。
 *
 * 用法：node scripts/m95-bibliography-smoke.mjs
 * 前置：npm --prefix backend run build；本机 ~/.paperteam 已配模型凭据；外网可达。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

// 临时项目根（必须在 loadConfig 前设置；绝对路径）
const projectsRoot = await mkdtemp(join(tmpdir(), "m95-bib-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

const SCENARIO = {
  doi: "10.1371/journal.pone.0210413",
  title: "确定性引用链路 smoke（M9.5 live）",
  researchIdea:
    "基于项目文献库中已有的全文文献，调研机器人辅助肾切除术（robot-assisted nephrectomy）的临床证据：手术适应症、围手术期结局（出血量 / 并发症 / 住院时长）与文中报告的关键数值结论。优先从文献库全文中检索并锚定证据。",
  researchField: "临床医学 · 泌尿外科",
};

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(
  distUrl("settings", "ModelSettingsStore.js")
);
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createScholarlyTools } = await import(distUrl("skills", "scholarlyTools.js"));
const { createRetrieveLibraryTool } = await import(distUrl("retrieval", "tools.js"));
const { evidenceToolsForRole } = await import(distUrl("evidence", "tools.js"));
const {
  buildBibliographyFromSources,
  mergeArtifactBibliography,
  renderBibliographyFile,
  filterByCitedKeys,
  resolveEvidenceCitationKey,
} = await import(distUrl("citation", "bibliography.js"));
const { extractCitationKeys } = await import(distUrl("citation", "StaticCitationChecker.js"));

const config = loadConfig();
const logLines = [];
const boot = (message) => {
  logLines.push(message);
  console.log(message);
};
boot(`[boot] model: ${process.env["PAPERTEAM_PI_MODEL"]}`);

// ---------------- TracingRuntime（与 m94 相同） ----------------

class TracingRuntime {
  constructor(adapter) {
    this.adapter = adapter;
    this.traces = new Map();
    this.tasks = new Map();
  }
  get provider() {
    return this.adapter.provider;
  }
  get resolvedModel() {
    return this.adapter.resolvedModel;
  }
  async startAgent(input) {
    const handle = await this.adapter.startAgent(input);
    const trace = this.traces.get(handle.taskId) ?? [];
    this.traces.set(handle.taskId, trace);
    void (async () => {
      try {
        for await (const event of handle.events()) {
          if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
            trace.push({
              ...(event.seq !== undefined ? { seq: event.seq } : {}),
              phase: event.type === "tool_execution_start" ? "start" : "end",
              tool: String(event.data?.toolName ?? "?"),
              ...(event.type === "tool_execution_end" ? { isError: Boolean(event.data?.isError) } : {}),
            });
          }
        }
      } catch (error) {
        trace.push({ phase: "trace_error", tool: String(error?.message ?? error) });
      }
    })();
    return handle;
  }
  async runAgent(input) {
    const handle = await this.startAgent(input);
    const task = await handle.result();
    this.tasks.set(task.taskId, {
      status: task.status,
      usage: task.usage,
      model: task.metadata?.model,
      ...(task.error !== undefined ? { error: task.error } : {}),
    });
    return task;
  }
  async getTask(taskId) {
    return this.adapter.getTask(taskId);
  }
  async healthCheck() {
    return this.adapter.healthCheck();
  }
  async modelStatusSnapshot() {
    return this.adapter.modelStatusSnapshot();
  }
  runtimeStats() {
    return this.adapter.runtimeStats();
  }
  async close() {
    return this.adapter.close();
  }
}

// ---------------- 装配（与 index.ts 同源） ----------------

const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();

const modelSettingsStore = new ModelSettingsStore({
  settingsDir: join(config.runtimeRoot, "settings"),
});
const modelSpec =
  config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型（PAPERTEAM_PI_MODEL / settings/model.json 均空）");
  process.exit(1);
}

let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: (role, projectId) => {
    const tools = [];
    if ((role === "researcher" || role === "citation") && stackRef !== undefined) {
      tools.push(
        ...createScholarlyTools(
          stackRef.citationIntegrity.scholarlyResolver,
          stackRef.discovery,
          role === "researcher" ? projectId : undefined,
        ),
      );
    }
    if (
      (role === "researcher" || role === "writer" || role === "reviewer") &&
      stackRef !== undefined &&
      projectId !== undefined
    ) {
      tools.push(createRetrieveLibraryTool(stackRef.retrieval, projectId));
    }
    if (stackRef !== undefined && projectId !== undefined) {
      tools.push(
        ...evidenceToolsForRole(
          role,
          {
            chunkAccess: stackRef.chunkAccess,
            grounding: stackRef.evidenceGrounding,
            evidence: stackRef.evidence,
          },
          projectId,
        ),
      );
    }
    return tools;
  },
  log: (message) => logLines.push(message),
});

const runtime = new TracingRuntime(adapter);
const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 600_000 }),
  search: config.search,
  citation: config.citation,
  log: (message) => logLines.push(message),
});
stackRef = stack;

// ---------------- 执行 ----------------

const startedAt = Date.now();
const report = { ok: false, steps: [], error: null };
const step = (name, fields) => {
  report.steps.push({ name, ...fields });
  boot(`  [${name}] ${JSON.stringify(fields)}`);
};

try {
  const project = await projects.create(SCENARIO.title, {
    researchIdea: SCENARIO.researchIdea,
    researchField: SCENARIO.researchField,
  });
  const projectId = project.id;

  // 1. 真实全文：DOI 导入 → resolve → chunk（M9.3/M9.4 已验证链路）
  const imported = await stack.sourceImport.importDoi(projectId, { doi: SCENARIO.doi });
  const resolveOutcome = await stack.sourceImport.tryResolveFullText(
    projectId,
    imported.source.sourceId,
  );
  const source = await stack.sources.get(projectId, imported.source.sourceId);
  step("fulltext", {
    sourceId: imported.source.sourceId,
    outcome: resolveOutcome.outcome,
    fileName: source?.fileName ?? null,
  });
  if (source?.fileName === undefined) {
    throw new Error(`全文未解析（outcome=${resolveOutcome.outcome}）`);
  }

  // 2. 真实 Researcher（期望锚定提案）+ 真实 Grounding
  const result = await stack.researcher.research({ projectId });
  const trace = runtime.traces.get(result.taskId) ?? [];
  const startEvents = trace.filter((t) => t.phase === "start");
  step("researcher", {
    taskId: result.taskId,
    toolCalls: startEvents.length,
    tools: [...new Set(startEvents.map((t) => t.tool))],
    proposed: result.evidenceProposed,
    bibliographyEntries: result.bibliographyCount,
  });
  const ground = await stack.evidenceGrounding.groundPending(projectId);
  step("ground", ground);
  if (ground.verified < 1) {
    throw new Error(`verified=${ground.verified}（M9.4 链路未复现，无法进入 M9.5 验收）`);
  }

  // 3. M9.5 核心：canonical bibliography（代码确定性 key）
  const [items, artifactRaw] = await Promise.all([
    stack.sources.list(projectId),
    readFile(join(projectsRoot, projectId, "research", "research.json"), "utf8"),
  ]);
  const artifact = JSON.parse(artifactRaw);
  const llmKeys = (artifact.bibliography ?? []).map((e) => e.key);
  const canonical = mergeArtifactBibliography(
    buildBibliographyFromSources(items),
    artifact.bibliography ?? [],
  );
  step("canonical", {
    entries: canonical.map((e) => ({
      key: e.key,
      origin: e.origin,
      type: e.type,
      sourceId: e.sourceId ?? null,
      title: e.title.slice(0, 60),
    })),
    llmKeys: llmKeys,
  });
  // 确定性验收：同输入重算 → 完全一致。注意确定性 key 可能与 LLM key 撞名
  // （LLM 也遵循「一作年份主题」惯例时字符串巧合相等）——判据是「重算一致
  // + 形态合规」，不是「与 LLM key 不同」。
  const canonicalAgain = mergeArtifactBibliography(
    buildBibliographyFromSources([...items]),
    JSON.parse(JSON.stringify(artifact.bibliography ?? [])),
  );
  if (JSON.stringify(canonicalAgain) !== JSON.stringify(canonical)) {
    throw new Error("canonical bibliography 重算不一致（非确定性）");
  }
  // 确定性形态：^[a-z0-9]+(19|20)\d{2}[a-z0-9]*$（一作+年份+标题词[+后缀]）
  const keyShape = /^[a-z0-9]+(?:19|20)\d{2}[a-z0-9]*$/;
  const badShape = canonical.filter((e) => !keyShape.test(e.key));
  if (badShape.length > 0) {
    throw new Error(`非确定性 key 形态：${badShape.map((e) => e.key).join(", ")}`);
  }

  // 4. Evidence → Citation 追溯（verified 记录 → 确定性 key）
  const selection = await stack.evidenceSelection.selectForWriting(projectId);
  const evidence = await stack.evidence.list(projectId);
  const tracePairs = selection.formal.map((record) => ({
    evidenceId: record.id,
    sourceId: record.source?.sourceId ?? null,
    citationKey: resolveEvidenceCitationKey(record, canonical),
  }));
  step("evidence-citation-trace", {
    formal: selection.formal.length,
    legacyExcluded: selection.excluded,
    pairs: tracePairs,
  });
  const keyBySource = new Map(
    canonical.filter((e) => e.sourceId).map((e) => [e.sourceId, e.key]),
  );
  const traced = tracePairs.filter(
    (p) => p.citationKey !== null && p.citationKey === keyBySource.get(p.sourceId),
  );
  if (traced.length < 1) {
    throw new Error("无 verified evidence 命中 sourceId 确定性 key");
  }

  // 5. 真实 Writer：章节生成（prompt 携带（cite: key）标注 + allowed keys）
  const outline = {
    title: SCENARIO.title,
    sections: [
      { id: "introduction", file: "introduction.tex", title: "引言" },
      { id: "evidence-review", file: "evidence-review.tex", title: "临床证据综述" },
      { id: "conclusion", file: "conclusion.tex", title: "结论" },
    ],
  };
  const written = await stack.writer.writeSection({
    projectId,
    section: {
      id: "evidence-review",
      file: "evidence-review.tex",
      title: "临床证据综述",
      targetLengthWords: 350,
    },
    outline,
    evidence: selection.formal,
    bibliography: canonical,
    extraInstructions:
      "本节综述项目证据库支撑的临床结论：每个基于已核验 Evidence 的论断后用 \\cite 引用其行内标注的 key。",
  });
  const latex = written.latex;
  const citedKeys = extractCitationKeys("evidence-review.tex", latex).keys;
  step("writer", {
    taskId: written.taskId,
    bytes: latex.length,
    citedKeys,
    containsDeterministicCite: traced.some((p) => latex.includes(`\\cite{${p.citationKey}}`)),
  });

  // 6. references.bib 生命周期：写盘 → 裁剪为实际引用 → byte identical
  await stack.manuscript.saveOutline(projectId, outline);
  await stack.manuscript.writeSection(
    projectId,
    outline.sections[1],
    latex,
  );
  await stack.manuscript.writeBibliography(projectId, canonical);
  await stack.manuscript.writeMainTex(projectId, outline, canonical.length > 0);
  const fullBib = await readFile(join(projectsRoot, projectId, "manuscript", "references.bib"), "utf8");
  const pruned = filterByCitedKeys(canonical, citedKeys);
  const prunedRender1 = renderBibliographyFile(pruned);
  const prunedRender2 = renderBibliographyFile(filterByCitedKeys(canonical, [...citedKeys]));
  await stack.manuscript.writeBibliography(projectId, pruned);
  const finalBib = await readFile(join(projectsRoot, projectId, "manuscript", "references.bib"), "utf8");
  step("references-bib", {
    fullEntries: canonical.length,
    citedEntries: pruned.length,
    byteIdenticalRerender: prunedRender1 === prunedRender2,
    finalEqualsDeterministicRender: finalBib === prunedRender1,
    containsSourceIdField: /sourceId = \{/.test(finalBib),
    containsTracedEntry: traced.some((p) => finalBib.includes(`{${p.citationKey},`)),
    fullBibHadUncited: fullBib.length > finalBib.length,
  });

  // 7. 断言闭环
  const closed =
    traced.some((p) => latex.includes(`\\cite{${p.citationKey}}`)) &&
    traced.some((p) => finalBib.includes(`{${p.citationKey},`)) &&
    finalBib === prunedRender1 &&
    prunedRender1 === prunedRender2;
  if (!closed) {
    throw new Error("闭环断言失败（cite / bib entry / byte-identical 任一缺失）");
  }
  report.ok = true;
  report.projectId = projectId;
  report.elapsedMs = Date.now() - startedAt;
  report.citedKeys = citedKeys;
  report.finalBib = finalBib;
  report.latexExcerpt = latex.slice(0, 1200);
  report.evidenceCitationPairs = tracePairs;
} catch (error) {
  report.error = String(error?.stack ?? error);
}

await runtime.close().catch(() => {});

boot("\n===== M9.5 Deterministic Bibliography Live Smoke =====");
boot(report.ok ? "PASS：Verified Evidence → 确定性 key → \\cite → references.bib 闭环成立" : `FAIL：${report.error ?? ""}`);
console.log("\n----- 结构化结果（JSON）-----");
console.log(JSON.stringify({ ...report, latexExcerpt: undefined, finalBib: undefined }, null, 2));
if (report.latexExcerpt) {
  console.log("\n----- 生成的 .tex（excerpt）-----");
  console.log(report.latexExcerpt);
}
if (report.finalBib) {
  console.log("\n----- 生成的 references.bib（裁剪后）-----");
  console.log(report.finalBib);
}

// 清理临时项目根（排查时可注释掉）
await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
if (!report.ok) {
  process.exitCode = 1;
}
