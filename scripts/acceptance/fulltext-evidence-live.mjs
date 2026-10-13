/** M13.8 Phase 3 — bounded REAL FullText → Evidence acceptance through production modules (no replay, no seeding).
 *
 * Usage:
 *   PROJECTS_ROOT=<isolated root> [PAPERTEAM_RESEARCH_PROXY_URL=http://127.0.0.1:7890] \
 *   node fulltext-evidence-live.mjs REPO_ROOT OUTPUT_DIR --model provider/model --arxiv 2304.14394,2403.10826,... \
 *        [--max-tasks 80] [--budget-file PATH] [--judge-cap 8] [--title "..."] [--dry-run]
 *
 * Chain exercised (all backend/dist production code, same wiring as backend/src/index.ts):
 *   Source（importArxiv：arXiv API 元数据）→ FullTextResolver（arxiv 直链）→ downloadPdf（SSRF 逐跳 / 20MB 帽 / %PDF-）
 *   → IngestionService.ingest（docling 结构化）→ RetrievalService chunks → TargetedGroundingService
 *   （claim = 该文献摘要中最长的一句；quote = chunk 逐字窗口）→ EvidenceGroundingService.propose / ground
 *   （quote 逐字校验 → metadata 核验 → 真实语义 judge）→ EvidenceStore verified 记录（provenance 完整）
 *   → EvidenceSelectionService.selectForWriting（Writer 正式证据口径）。
 *
 * Honesty rules: the claim is taken verbatim from the paper's own abstract (deterministic choice: the longest sentence);
 * nothing is written to EvidenceStore except through EvidenceGroundingService.ground; every verified record is
 * re-checked here independently (quote ⊂ chunk text after the same normalization; sourceId / chunkId / verificationLevel).
 * Model calls are bounded by --judge-cap and the shared ledger; the direct-download control is reported, not hidden.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseCli,
  resolveRepoPaths,
  distLoader,
  loadBudget,
  recordRuntime,
  summarizeCalls,
  createModelRuntime,
  createProductionAdapter,
  createResearchNetwork,
  dryRunRuntime,
  sha256,
} from "./lib/m13-7-live.mjs";

const { positional, flags } = parseCli(process.argv);
const [repoArg, outputArg] = positional;
if (!repoArg || !outputArg) throw new Error("Expected REPO_ROOT OUTPUT_DIR");
const dryRun = flags["dry-run"] === true;
const modelSpec = flags.model;
if (!dryRun && (!modelSpec || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(modelSpec))) throw new Error("--model provider/model is required");
const MAX_TASKS = Number(flags["max-tasks"] ?? 80);
if (!Number.isInteger(MAX_TASKS) || MAX_TASKS < 1 || MAX_TASKS > 80) throw new Error("--max-tasks must be 1..80");
const judgeCap = Number(flags["judge-cap"] ?? 8);
if (!Number.isInteger(judgeCap) || judgeCap < 1 || judgeCap > 20) throw new Error("--judge-cap must be 1..20");
const arxivIds = String(flags.arxiv ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (arxivIds.length < 1 || arxivIds.length > 8) throw new Error("--arxiv id1,id2,... (1..8 ids) is required");
const title = typeof flags.title === "string" ? flags.title : "M13.8 FullText → Evidence 真实验收";

const { repo, output } = resolveRepoPaths(repoArg, outputArg);
const load = distLoader(repo);
await mkdir(output, { recursive: true });
const budgetPath = flags["budget-file"] ? resolve(flags["budget-file"]) : join(output, "..", "model-budget.json");
const budget = await loadBudget(budgetPath, MAX_TASKS);

const { loadConfig } = await load("config/config.js");
const { buildServiceStack } = await load("serviceStack.js");
const { ProjectStore } = await load("project/ProjectStore.js");
const { LatexCompiler } = await load("latex/LatexCompiler.js");
const { normalizeForQuoteMatch } = await load("evidence/quoteVerification.js");

const config = loadConfig();
const defaultProjectsRoot = resolve(repo, "backend", "projects");
if (resolve(config.projectsRoot) === defaultProjectsRoot || !process.env.PROJECTS_ROOT) {
  throw new Error(`refusing to run against the default projects root (${config.projectsRoot}); set PROJECTS_ROOT to an isolated acceptance root`);
}
const researchNetwork = await createResearchNetwork({ load, config });

const resultPath = join(output, "result.json");
const result = {
  milestone: "M13.8",
  experiment: "REAL FullText → Ingestion → Chunk → Grounding → Verified Evidence (production modules; bounded)",
  mode: dryRun ? "dry-run" : "live",
  model: modelSpec ?? null,
  projectsRoot: config.projectsRoot,
  researchNetwork: researchNetwork.description,
  arxivIds,
  judgeCap,
  startedAt: new Date().toISOString(),
  calls: [],
  events: [],
  papers: [],
  evidence: [],
  selection: null,
};
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${String(message).slice(0, 600)}`;
  result.events.push(line);
  console.log(line);
};
await save();

let stack;
let adapter = null;
let recording = null;
if (!dryRun) {
  const { modelRuntime } = await createModelRuntime({ repo, load, config, modelSpec });
  const created = await createProductionAdapter({ repo, load, config, modelSpec, modelRuntime, projectsRoot: config.projectsRoot, stackRef: () => stack, maxConcurrentRuns: 2 });
  adapter = created.adapter;
  recording = recordRuntime({ runtime: adapter, budget, budgetPath, output, result, save });
}
const projects = new ProjectStore({ root: config.projectsRoot });
stack = buildServiceStack({
  runtime: recording ?? dryRunRuntime(),
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  longRunTimeoutMs: config.pi.longRunTimeoutMs,
  citation: {
    metadataEnabled: config.citation.metadataEnabled,
    maxMetadataLookups: config.citation.maxMetadataLookups,
    metadataTimeoutMs: config.citation.metadataTimeoutMs,
    ...(config.citation.contactEmail ? { contactEmail: config.citation.contactEmail } : {}),
  },
  search: config.search,
  researchFetch: researchNetwork.router.fetch,
  fullText: { batchConcurrency: config.fullText.batchConcurrency },
  ...(config.pdf.pythonCommand !== undefined ? { pdfPythonCommand: config.pdf.pythonCommand } : {}),
  ...(config.pdf.doclingPythonCommand !== undefined ? { doclingPythonCommand: config.pdf.doclingPythonCommand } : {}),
  doclingMaxConcurrency: config.ingestion.doclingConcurrency,
  log: (message) => result.events.push(`[${new Date().toISOString()}][stack] ${String(message).slice(0, 400)}`),
});

/** Deterministic claim: the longest sentence (≥ 60 chars) of the paper's own abstract. */
function pickClaim(abstract) {
  const sentences = String(abstract ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 60 && sentence.length <= 600);
  if (sentences.length === 0) return null;
  return sentences.sort((a, b) => b.length - a.length)[0];
}

const t0 = Date.now();
try {
  const project = await projects.create(title, { documentType: "survey", language: "zh" });
  result.projectId = project.id;
  log(`project ${project.id} created under ${config.projectsRoot}`);

  // 1. Source：arXiv 元数据导入（经 Research 代理路由；router.stats 记录出口）
  const sourceIds = [];
  for (const arxivId of arxivIds) {
    const paper = { arxivId, importedAt: new Date().toISOString() };
    result.papers.push(paper);
    try {
      const imported = await stack.sourceImport.importArxiv(project.id, { arxivId, sourceRole: "evidence" });
      paper.sourceId = imported.source.sourceId;
      paper.title = imported.source.metadata?.title ?? null;
      paper.year = imported.source.metadata?.year ?? null;
      paper.abstractChars = (imported.source.metadata?.abstract ?? "").length;
      paper.created = imported.created;
      sourceIds.push(paper.sourceId);
      log(`import ${arxivId} → ${paper.sourceId} "${(paper.title ?? "").slice(0, 80)}" (${paper.year ?? "?"}) abstract=${paper.abstractChars}ch`);
    } catch (error) {
      paper.importError = String(error?.message ?? error).slice(0, 300);
      log(`import ${arxivId} FAILED: ${paper.importError}`);
    }
    await save();
  }
  result.routerStatsAfterImport = researchNetwork.router.stats();

  // 2. FullTextResolver → downloadPdf（生产批量入口；有界并发）
  const fulltextStarted = Date.now();
  const fulltext = await stack.sourceImport.resolveFullTextBatch(project.id, sourceIds);
  result.fulltext = { summary: fulltext.summary, ms: Date.now() - fulltextStarted, results: fulltext.results.map((entry) => ({ sourceId: entry.sourceId, outcome: entry.outcome, note: entry.note ?? null, fullText: entry.source?.fullText ?? null, fileName: entry.source?.fileName ?? null, contentHash: entry.source?.contentHash ?? null })) };
  for (const entry of fulltext.results) {
    const paper = result.papers.find((candidate) => candidate.sourceId === entry.sourceId);
    if (paper) {
      paper.fulltextOutcome = entry.outcome;
      paper.fulltextNote = entry.note ?? null;
      paper.fileName = entry.source?.fileName ?? null;
      paper.bytes = entry.source?.fullText?.bytes ?? null;
      paper.resolver = entry.source?.fullText?.resolver ?? null;
    }
  }
  log(`fulltext batch: ${JSON.stringify(fulltext.summary)} in ${Date.now() - fulltextStarted}ms; router=${JSON.stringify(researchNetwork.router.stats())}`);
  result.routerStatsAfterFulltext = researchNetwork.router.stats();
  await save();

  // 3. Ingestion（docling；同步等待）→ chunks（RetrievalService 已由 onFullTextAttached 钩子重建，这里再确认）
  for (const paper of result.papers) {
    if (paper.fulltextOutcome !== "resolved") continue;
    const started = Date.now();
    try {
      const existing = await stack.ingestion.getDocument(project.id, paper.sourceId);
      const document = existing ?? (await stack.ingestion.ingest(project.id, paper.sourceId));
      paper.ingestion = { parser: document.parser ?? null, status: document.status ?? null, blocks: document.blocks?.length ?? null, sections: document.sections?.length ?? null, textChars: document.blocks?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? null, ms: Date.now() - started, reused: existing !== null };
      log(`ingest ${paper.sourceId}: ${JSON.stringify(paper.ingestion)}`);
    } catch (error) {
      paper.ingestion = { error: String(error?.message ?? error).slice(0, 300), ms: Date.now() - started };
      log(`ingest ${paper.sourceId} FAILED: ${paper.ingestion.error}`);
    }
    await save();
  }
  try {
    await stack.retrieval.rebuild(project.id);
  } catch (error) {
    log(`retrieval rebuild note: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  const retrievalStats = await stack.retrieval.stats(project.id);
  result.retrieval = retrievalStats;
  log(`retrieval: ${JSON.stringify(retrievalStats)}`);
  for (const paper of result.papers) {
    if (!paper.sourceId) continue;
    try {
      const probe = await stack.retrieval.search(project.id, (paper.title ?? "method").split(/\s+/).slice(0, 6).join(" "), { topK: 5, filter: { sourceIds: [paper.sourceId] }, mode: "lexical" });
      paper.chunks = probe.results.filter((entry) => entry.chunk.sourceId === paper.sourceId).length;
      paper.chunkSample = probe.results[0]?.chunk?.chunkId ?? null;
    } catch (error) {
      paper.chunkProbeError = String(error?.message ?? error).slice(0, 200);
    }
  }
  await save();

  // 4. Claims（文献自己摘要中最长的一句）→ TargetedGrounding（propose → ground：quote 逐字 / metadata / 真实 judge）
  const requests = [];
  for (const paper of result.papers) {
    if (paper.fulltextOutcome !== "resolved") continue;
    const source = await stack.sources.get(project.id, paper.sourceId);
    const claim = pickClaim(source?.metadata?.abstract);
    paper.claim = claim;
    if (claim === null) {
      log(`no claim for ${paper.sourceId} (abstract too short)`);
      continue;
    }
    requests.push({ claimId: `m138-${paper.arxivId}`, claim, section: "acceptance", sourceIds: [paper.sourceId] });
  }
  result.requests = requests;
  await save();
  if (dryRun) {
    log("dry-run: skipping grounding (no model)");
  } else {
    const grounding = [];
    for (const request of requests) {
      if (result.calls.length >= judgeCap) {
        log(`judge cap ${judgeCap} reached; remaining claims not grounded`);
        break;
      }
      const started = Date.now();
      const summary = await stack.targetedGrounding.groundClaims(project.id, [request]);
      const outcome = summary.outcomes[0];
      grounding.push({ ...outcome, ms: Date.now() - started, callsSoFar: result.calls.length });
      const paper = result.papers.find((candidate) => candidate.sourceId === request.sourceIds[0]);
      if (paper) paper.grounding = { status: outcome.status, evidenceIds: outcome.evidenceIds, attempts: outcome.attempts, reason: outcome.reason ?? null };
      log(`ground ${request.claimId}: ${outcome.status} evidence=${outcome.evidenceIds.join(",") || "-"} attempts=${outcome.attempts.length} calls=${result.calls.length}`);
      await save();
    }
    result.grounding = grounding;
  }

  // 5. Verified Evidence provenance + independent quote re-check + Writer formal selection
  const records = await stack.evidence.list(project.id);
  for (const record of records) {
    let quoteInChunk = null;
    const chunkId = record.location?.chunk ?? null;
    try {
      if (chunkId !== null && typeof record.quote === "string") {
        const resolved = await stack.chunkAccess.resolve(project.id, chunkId);
        quoteInChunk = normalizeForQuoteMatch(resolved.chunk.text).includes(normalizeForQuoteMatch(record.quote));
        if (resolved.source.sourceId !== record.source?.sourceId) quoteInChunk = `source mismatch: chunk→${resolved.source.sourceId} record→${record.source?.sourceId}`;
      }
    } catch (error) {
      quoteInChunk = `error: ${String(error?.message ?? error).slice(0, 120)}`;
    }
    result.evidence.push({
      id: record.id,
      verificationStatus: record.verificationStatus,
      verificationLevel: record.verificationLevel ?? null,
      supportStrength: record.supportStrength ?? null,
      verificationMethod: record.verificationMethod ?? null,
      sourceId: record.source?.sourceId ?? null,
      sourceTitle: record.source?.title ?? null,
      chunkId,
      page: record.location?.page ?? null,
      section: record.location?.section ?? null,
      claim: record.claim,
      quoteChars: record.quote?.length ?? 0,
      quoteSha256: record.quote ? sha256(Buffer.from(record.quote, "utf8")).slice(0, 16) : null,
      quoteInChunk,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    });
  }
  const selection = await stack.evidenceSelection.selectForWriting(project.id);
  result.selection = { formal: selection.formal.length, excluded: selection.excluded, formalIds: selection.formal.map((record) => record.id) };
  const candidates = await stack.evidenceGrounding.candidateStats(project.id);
  result.candidateStats = candidates;
  result.routerStatsEnd = researchNetwork.router.stats();
  log(`evidence: ${records.length} records (verified=${records.filter((record) => record.verificationStatus === "verified").length}); formal for Writer=${selection.formal.length}; candidates=${JSON.stringify(candidates.byStatus)}`);
  result.status = records.some((record) => record.verificationStatus === "verified") ? "VERIFIED_EVIDENCE_PRESENT" : "NO_VERIFIED_EVIDENCE";
} catch (error) {
  result.status = "DRIVER_ERROR";
  result.error = String(error?.stack ?? error).slice(0, 2000);
  log(`DRIVER ERROR: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  result.wallClockSeconds = (Date.now() - t0) / 1000;
  summarizeCalls(result);
  await save();
  if (adapter) await adapter.close().catch(() => {});
  await researchNetwork.router.close().catch(() => {});
  console.log(`\n${result.status} → ${resultPath}`);
}
