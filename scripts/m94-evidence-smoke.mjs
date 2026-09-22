#!/usr/bin/env node
/**
 * M9.4 Anchored Evidence Activation 真实 smoke（一次性脚本，不进 CI）。
 *
 * 与单元测试的区别：跑真实 Researcher Agent（真实模型 + 真实工具面：
 * retrieve_library / get_chunk / propose_evidence）+ 真实 FullText（OA 下载
 * → PDF 解析 → chunk → 检索）+ 真实 Evidence Grounding（quote 逐字校验 →
 * ScholarlyResolver 外部核验 → 真实模型语义 judge）。装配与 index.ts 同源
 * （loadConfig / SkillRegistry / roleCustomTools / buildServiceStack），仅两处
 * 偏离（与 m71-discovery-smoke 相同）：PROJECTS_ROOT 重定向临时目录；
 * Runtime 外包 TracingRuntime 采集 tool call trace。
 *
 * 场景（docs/research/M9.4_ANCHORED_EVIDENCE_ACTIVATION.md §Live Smoke）：
 *   A 机器人辅助肾切除术（PLOS ONE 10.1371/journal.pone.0210413，真实 OA 全文）
 *   B X 染色体拷贝数变异（PLOS ONE 10.1371/journal.pone.0097746，真实 OA 全文）
 * 每场景：导入 DOI → resolve 全文 → 真实 researcher.research →
 * evidenceGrounding.groundPending → 统计 proposed / quote_passed /
 * metadata_passed / semantic_passed / verified / rejected。
 *
 * 验收（M9.4 PASS 硬条件）：跨场景 Verified Evidence ≥ 1。
 *
 * 用法：node scripts/m94-evidence-smoke.mjs
 * 前置：npm --prefix backend run build（backend/dist 最新）；本机
 * ~/.paperteam 已配模型凭据（zai-coding-cn）；外网可达。
 * 可用 PAPERTEAM_PI_MODEL 覆盖模型（缺省 zai-coding-cn/glm-5.3-highspeed）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

// 临时项目根（必须在 loadConfig 前设置；绝对路径）
const projectsRoot = await mkdtemp(join(tmpdir(), "m94-evidence-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
// 模型缺省（本机 ~/.paperteam/runtime/pi/agent/auth.json 的 zai-coding-cn 通道；
// 注意订阅不含 glm-5.3-highspeed——探测于 2026-09-22，429 code=1311）
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
// OpenAlex 礼貌池（metadata 核验通道）
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

// 真实 OA 论文（与 M9.3 live smoke 同一探测集：2026-09-22 OpenAlex best_oa_location
// 有效、CC-BY、体积在下载超时内；两篇独立主题 → 两个独立研究问题场景）
const SCENARIOS = [
  {
    tag: "A",
    title: "机器人辅助肾切除术证据调研（M9.4 live A）",
    doi: "10.1371/journal.pone.0210413",
    researchIdea:
      "基于项目文献库中已有的全文文献，调研机器人辅助肾切除术（robot-assisted nephrectomy）的临床证据：手术适应症、围手术期结局（出血量 / 并发症 / 住院时长）与文中报告的关键数值结论。优先从文献库全文中检索并锚定证据。",
    researchField: "临床医学 · 泌尿外科",
  },
  {
    tag: "B",
    title: "X 染色体拷贝数变异证据调研（M9.4 live B）",
    doi: "10.1371/journal.pone.0097746",
    researchIdea:
      "基于项目文献库中已有的全文文献，调研 X 染色体拷贝数变异（X-linked CNV）与神经发育疾病的关联证据：变异类型、受累基因区域、文中报告的关键结论。优先从文献库全文中检索并锚定证据。",
    researchField: "遗传学 · 神经发育",
  },
];

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

const config = loadConfig();
const logLines = [];
const boot = (message) => {
  logLines.push(message);
  console.log(message);
};
boot(`[boot] model: ${process.env["PAPERTEAM_PI_MODEL"]}`);

// ---------------- TracingRuntime：透明转发 + tool call trace 采集 ----------------

class TracingRuntime {
  constructor(adapter) {
    this.adapter = adapter;
    /** @type {Map<string, Array<{seq?:number, phase:string, tool:string, isError?:boolean}>>} */
    this.traces = new Map();
    /** @type {Map<string, {status:string, usage?:unknown, model?:unknown, error?:string}>} */
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
  // 与 index.ts 完全同源的 roleCustomTools 接线
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

// ---------------- 场景执行 ----------------

const scenarioResults = [];

async function readJsonIfExist(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** 从候选终态推导核验漏斗指标（quote_passed / metadata_passed / semantic_passed） */
function funnelOf(candidates) {
  const total = candidates.length;
  let quotePassed = 0;
  let metadataPassed = 0;
  let semanticPassed = 0;
  let verified = 0;
  let mismatch = 0;
  let rejected = 0;
  let unverifiable = 0;
  for (const c of candidates) {
    const reason = c.statusReason ?? "";
    const quoteFailed = c.status === "mismatch" && reason.includes("quote_not_found_in_chunk");
    const metadataFailed = c.status === "mismatch" && reason.includes("metadata_mismatch");
    if (c.status === "mismatch" && !quoteFailed && !metadataFailed) {
      // 其它确定性不一致（罕见）：quote/metadata 双不计通过
    }
    if (!quoteFailed) quotePassed += 1;
    if (!metadataFailed) metadataPassed += 1;
    if (c.judgeVerdict === "supported" || c.judgeVerdict === "partially_supported") {
      semanticPassed += 1;
    }
    if (c.status === "verified") verified += 1;
    if (c.status === "mismatch") mismatch += 1;
    if (c.status === "rejected") rejected += 1;
    if (c.status === "unverifiable") unverifiable += 1;
  }
  return {
    proposed: total,
    quote_passed: quotePassed,
    metadata_passed: metadataPassed,
    semantic_passed: semanticPassed,
    verified,
    mismatch,
    rejected,
    unverifiable,
  };
}

async function runScenario(scenario) {
  const startedAt = Date.now();
  boot(`\n===== Scenario ${scenario.tag} start（${scenario.doi}）=====`);
  const project = await projects.create(scenario.title, {
    researchIdea: scenario.researchIdea,
    researchField: scenario.researchField,
  });
  const projectId = project.id;

  // 1. 真实全文：DOI 导入（enrich 默认开：crossref/openalex 元数据解析）→ resolve → chunk
  const imported = await stack.sourceImport.importDoi(projectId, { doi: scenario.doi });
  const resolveOutcome = await stack.sourceImport.tryResolveFullText(projectId, imported.source.sourceId);
  boot(`  [fulltext] ${imported.source.sourceId} → ${resolveOutcome.outcome}${resolveOutcome.note ? `（${resolveOutcome.note.slice(0, 120)}）` : ""}`);
  const source = await stack.sources.get(projectId, imported.source.sourceId);
  const hasFile = source?.fileName !== undefined;
  // 检索探测：多个常用词并集（只证明「chunk 可检索」，不要求特定词命中）
  const probeWords = ["study", "results", "patients", "analysis", "the"];
  const seenChunks = new Set();
  for (const word of probeWords) {
    const probe = await stack.retrieval.search(projectId, word);
    for (const entry of probe.results) {
      if (entry.chunk.sourceId === imported.source.sourceId) {
        seenChunks.add(entry.chunk.chunkId);
      }
    }
  }
  const chunkCount = seenChunks.size;
  if (!hasFile) {
    return {
      scenario: scenario.tag,
      ok: false,
      error: `全文未解析（outcome=${resolveOutcome.outcome}），场景无法进行锚定验收`,
      projectId,
      elapsedMs: Date.now() - startedAt,
    };
  }
  boot(`  [fulltext] 文件已落盘（${source.fileName}），检索索引可见 chunk（探测命中 ${chunkCount} 条）`);

  // 2. 真实 Researcher：研究问题 → （期望）retrieve_library → get_chunk → propose_evidence
  const result = await stack.researcher.research({ projectId });
  const trace = runtime.traces.get(result.taskId) ?? [];
  const startEvents = trace.filter((t) => t.phase === "start");
  const toolsCalled = [...new Set(startEvents.map((t) => t.tool))];
  boot(
    `  [researcher] taskId=${result.taskId} 工具调用 ${startEvents.length} 次 [${toolsCalled.join(", ")}]`,
  );
  boot(
    `  [researcher] evidence=appended:${result.evidenceAppended}/proposed:${result.evidenceProposed} bibliography=${result.bibliographyCount}`,
  );

  // 3. 真实 Grounding：quote 逐字 → ScholarlyResolver（crossref/openalex）→ 模型 judge
  const ground = await stack.evidenceGrounding.groundPending(projectId);
  boot(
    `  [ground] pending=${ground.pending} processed=${ground.processed} verified=${ground.verified} mismatch=${ground.mismatch} rejected=${ground.rejected} unverifiable=${ground.unverifiable}`,
  );

  // 4. 指标与证据明细（不 dump 论文原文，只记锚点与裁决）
  const candidates = await stack.evidenceCandidates.list(projectId);
  const funnel = funnelOf(candidates);
  const evidence = await stack.evidence.list(projectId);
  const artifact = await readJsonIfExist(join(projectsRoot, projectId, "research", "research.json"));
  const details = candidates.map((c) => ({
    candidateId: c.candidateId,
    sourceId: c.sourceId,
    chunkId: c.chunkId,
    status: c.status,
    metadataOutcome: c.metadataOutcome ?? null,
    judgeVerdict: c.judgeVerdict ?? null,
    statusReason: (c.statusReason ?? "").slice(0, 160),
    evidenceId: c.evidenceId ?? null,
    claim: c.claim.slice(0, 120),
  }));
  return {
    scenario: scenario.tag,
    ok: ground.verified >= 1,
    projectId,
    taskId: result.taskId,
    model: runtime.tasks.get(result.taskId)?.model,
    usage: runtime.tasks.get(result.taskId)?.usage,
    elapsedMs: Date.now() - startedAt,
    fulltext: { outcome: resolveOutcome.outcome, sourceId: imported.source.sourceId, fileName: source.fileName },
    researcher: {
      toolCallsTotal: startEvents.length,
      toolsCalled,
      evidenceAppended: result.evidenceAppended,
      evidenceProposed: result.evidenceProposed,
      researchJsonEvidenceEntries: Array.isArray(artifact?.evidence) ? artifact.evidence.length : 0,
      gaps: result.report.researchGaps.length,
    },
    ground,
    funnel,
    groundedEvidence: evidence
      .filter((r) => r.verificationStatus === "verified")
      .map((r) => ({
        id: r.id,
        claim: r.claim.slice(0, 120),
        sourceId: r.source?.sourceId ?? null,
        chunkId: r.location?.chunk ?? null,
        section: r.location?.section ?? null,
        page: r.location?.page ?? null,
        supportStrength: r.supportStrength ?? null,
        verificationMethod: r.verificationMethod ?? null,
      })),
    legacyUnverified: evidence.filter((r) => r.verificationStatus !== "verified").length,
    candidates: details,
    checks: {
      fulltextResolved: resolveOutcome.outcome === "resolved" || resolveOutcome.outcome === "skipped_has_file",
      researcherUsedRetrieval: toolsCalled.includes("retrieve_library"),
      anchoredProposals: candidates.length > 0,
      verifiedAtLeastOne: ground.verified >= 1,
    },
  };
}

let fatal = null;
for (const scenario of SCENARIOS) {
  try {
    scenarioResults.push(await runScenario(scenario));
  } catch (error) {
    fatal = error?.message ?? String(error);
    scenarioResults.push({
      scenario: scenario.tag,
      ok: false,
      error: String(error?.stack ?? error),
    });
  }
}

await runtime.close().catch(() => {});

// ---------------- 汇总 ----------------

const totals = scenarioResults.reduce(
  (acc, r) => {
    if (r.funnel !== undefined) {
      for (const key of Object.keys(r.funnel)) {
        acc[key] = (acc[key] ?? 0) + r.funnel[key];
      }
    }
    return acc;
  },
  {},
);

boot("\n===== M9.4 Anchored Evidence Live Smoke 汇总 =====");
for (const r of scenarioResults) {
  boot(
    `  Scenario ${r.scenario}: ${r.ok ? "VERIFIED≥1 ✓" : "未达标 ✗"}${r.funnel !== undefined ? ` — proposed=${r.funnel.proposed} quote_passed=${r.funnel.quote_passed} metadata_passed=${r.funnel.metadata_passed} semantic_passed=${r.funnel.semantic_passed} verified=${r.funnel.verified} mismatch=${r.funnel.mismatch} rejected=${r.funnel.rejected} unverifiable=${r.funnel.unverifiable}` : ` — ${r.error ?? ""}`}`,
  );
}
boot(`  TOTAL: ${JSON.stringify(totals)}`);
const pass = scenarioResults.length > 0 && scenarioResults.every((r) => r.ok !== false);
boot(`\nM9.4 LIVE SMOKE: ${pass ? "PASS（Verified Evidence ≥ 1 已达成）" : "FAIL"}`);

console.log("\n----- 结构化结果（JSON）-----");
console.log(JSON.stringify({ pass, totals, scenarios: scenarioResults }, null, 2));

// 清理临时项目根（保留 stdout 汇总；排查时可注释掉）
await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
if (fatal) {
  process.exitCode = 1;
}
if (!pass) {
  process.exitCode = 1;
}
