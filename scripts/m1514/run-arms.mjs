#!/usr/bin/env node
/**
 * M15.14 Phase C/D — 四臂运行器（每族一次调用）。
 *
 * 臂定义（预注册冻结）：
 *   A0_STRONG  1 调用：main agent + read_only；全文 + 同批 pool 材料（renderPoolMaterial
 *              与 A2 逐字节相同）+ 贡献/prior-work 比较要求的结构化 one-shot prompt。
 *              （M15.11-13 三轮实证 one-shot 强于两步通用——最强合理基线形态）
 *   A1_EXISTING 2 调用：生产 FullPaperReviewService.reviewFullPaper（逐字复用；
 *              sectionFindings=[]；无摘要预置 map——见 prepare-projects 披露）。
 *   A2_NEW     3 调用（+解析重试）：ContributionAuditService（extract→compare→synthesize）。
 *   A2_NO_PRIOR_WORK 消融：A2 同 prompt/结构、pool 材料为空（隔离"检索材料"贡献）。
 *
 * 用法：node scripts/m1514/run-arms.mjs --fam fam-q-XX [--arms a0,a1,a2,a2np]
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const OUT_DIR = join(ROOT, "phase-d", "out");
const CALLS_LOG = join(ROOT, "phase-d", "model-calls.jsonl");
const LEDGER = join(ROOT, "phase-d", "budget-ledger.json");
const BUDGET_CAP = Number(process.env.M1514_BUDGET_CAP ?? "300");

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const famId = argOf("--fam");
if (!famId) throw new Error("--fam fam-q-XX 必填（样本见 phase-c/projects.json）");
const arms = (argOf("--arms") ?? "a0,a1,a2").split(",");

// ---- env 必须在 import dist 之前设置 ----
process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(BUDGET_CAP);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";
process.env["WORKFLOW_MAX_REVISION_ROUNDS"] = "1";

await mkdir(OUT_DIR, { recursive: true });
await mkdir(join(OUT_DIR, famId), { recursive: true });
await mkdir(join(ROOT, "phase-d"), { recursive: true });

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const A0_PROMPT_HEAD = `You are an expert peer reviewer for a top-tier machine learning conference. The full manuscript text is provided, followed by PRIOR WORK MATERIAL retrieved for this submission.

Context: the manuscript was submitted for review around 2016-10-31. Judge novelty and positioning AS OF THAT DATE — never use knowledge of work published after that date as evidence against novelty. The prior-work material was retrieved deterministically (the manuscript's own reference list plus database search with publication-date cutoff); entries are labeled with their observable content level (abstract = title+abstract available; metadata = bibliographic record only). With abstract-level material you may compare ideas but cannot assert implementation-level sameness or difference of details; with metadata-only material you cannot support strong claims.

Your tasks:
1. Identify the manuscript's core claimed contributions (at most 5): for each, a verbatim quote from the manuscript stating the claim.
2. For each contribution, compare it against the closest prior work — from the provided material AND from your own knowledge of work published before the cutoff (for the latter give title + year + DOI/arXiv id when you are confident of the identity): state the shared technical mechanism, the substantive difference (structural novelty / new combination / empirical improvement / scope extension / presentation-only rewording), and what remains undecidable at the available content level. "No similar work found" must be stated as insufficient evidence, never as confirmed novelty.
3. Check claim-evidence support: which claimed advances are actually demonstrated by the manuscript's experiments/ablations/baselines; which are not (missing experiments, weak baselines, no ablation, overclaimed scope).
4. Output findings: substantive, checkable issues about novelty positioning, contribution substance, related-work coverage, claim-evidence support, overclaiming.

Rules:
- Base manuscript statements on the manuscript text; quote or locate passages. Do not invent citations, quotes, or numbers; when judging needs information that is not available, say so explicitly (INSUFFICIENT_EVIDENCE) instead of assuming.
- Focus on substantive academic issues; no typos or formatting problems.

Output ONLY one JSON object, no prose around it:
{"contributions":[{"claimQuote":"...","sectionHint":"..."}],"comparisons":[{"contributionIndex":0,"nearestPriorWorks":[{"title":"...","year":2016,"doi":"...","arxivId":"...","sourceLevel":"pool|model_memory","quote":"..."}],"commonMechanism":"...","substantiveDifference":"...","missingVerification":"..."}],"findings":[{"category":"academic","severity":"major","page":null,"claimText":"<short quoted passage from the manuscript>","message":"<the issue, one to three sentences, concrete and specific>","suggestion":"<what the authors should do>"}]}
Order findings from most severe to least; list every substantive issue you can find, not only the top few.

`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async (line) => {
  console.log(line);
  await appendFile(join(ROOT, "phase-d", "driver-log.txt"), `[${new Date().toISOString()}] ${line}\n`, "utf8").catch(() => {});
};

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { PaperStore } = await import(distUrl("paper", "PaperStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { initResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { renderPoolMaterial } = await import(distUrl("target", "ContributionAuditService.js"));
const { ContributionAuditService } = await import(distUrl("target", "ContributionAuditService.js"));

const config = loadConfig();
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  log: () => {},
});
const budgetLedger = new GlobalBudgetLedger({ path: LEDGER, limits: { maxCalls: BUDGET_CAP, maxTokens: 0 }, label: "M15.14 arms" });
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role_, scope) => skillRegistry.skillAssignmentsFor(role_, scope),
  log: () => {},
});
let physicalCalls = 0;
let currentContributionArm = null; // a2 / a2np 分账标记（scope 相同，顺序 await 保证无交错）
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const idx = physicalCalls;
  const t0 = Date.now();
  const scopeHint = callArgs[0]?.contextScope ?? "";
  const armHint = scopeHint.startsWith("m1514-a0/")
    ? "a0"
    : scopeHint.startsWith("review/fullpaper/")
      ? "a1-fullpaper"
      : scopeHint.startsWith("review/contribution/")
        ? (currentContributionArm === "a2np" ? "a2np" : "a2")
        : "other";
  const result = await originalRunAgent(...callArgs);
  await appendFile(
    CALLS_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      callIndex: idx,
      familyId: famId,
      contextScope: scopeHint,
      armHint,
      status: result.status,
      ms: Date.now() - t0,
      usage: result.usage ?? null,
      taskId: result.taskId,
    }) + "\n",
    "utf8",
  ).catch(() => {});
  return result;
};
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const paperStore = new PaperStore(projects);
const stack = buildServiceStack({
  researchFetch: researchNet.router.fetch,
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) } : { longRunTimeoutMs: 900_000 }),
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.citation !== undefined ? { citation: config.citation } : {}),
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  log: () => {},
});

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const family = projectsInfo.families.find((f) => f.familyId === famId);
if (family === undefined) throw new Error(`${famId} 不在 projects.json`);
const projectId = family.projectId;

async function readManuscriptText() {
  const chunksRaw = await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).sort((a, b) => a.sequence - b.sequence);
  const pages = new Map();
  for (const c of chunks) {
    const label = `[page ${c.pageStart}${c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}]`;
    pages.set(label, (pages.get(label) ?? "") + c.text + "\n");
  }
  return [...pages.entries()].map(([label, text]) => `${label}\n${text}`).join("\n");
}

function lenientJson(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

const SEVERITIES = new Set(["critical", "major", "minor", "info"]);
const CATEGORIES = new Set(["fact", "academic", "style", "citation", "consistency", "visual"]);

function normalizeFindings(parsed) {
  const raw = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const findings = [];
  let dropped = 0;
  for (const f of raw) {
    const fr = f ?? {};
    const message = String(fr.message ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
    if (message === "") { dropped += 1; continue; }
    findings.push({
      category: CATEGORIES.has(String(fr.category)) ? String(fr.category) : "academic",
      severity: SEVERITIES.has(String(fr.severity)) ? String(fr.severity) : "minor",
      page: Number.isFinite(Number(fr.page)) ? Number(fr.page) : null,
      claimText: String(fr.claimText ?? "").slice(0, 600) || undefined,
      message,
      suggestion: String(fr.suggestion ?? "").slice(0, 1000) || undefined,
    });
  }
  return { findings, dropped };
}

async function loadPool(kind) {
  if (kind === "empty") {
    return {
      familyId: famId,
      cutoffDate: "2016-10-31",
      queriesUsed: ["(ablation: no prior-work material provided)"],
      candidates: [],
      buildStats: { ablation: "A2_NO_PRIOR_WORK" },
    };
  }
  const poolPath = join(ROOT, "phase-c", "pools", `${famId}.json`);
  return JSON.parse(await readFile(poolPath, "utf8"));
}

await log(`arms start fam=${famId} arms=${arms.join("+")} projectId=${projectId}`);

// ---- A0 ----
if (arms.includes("a0")) {
  const outFile = join(OUT_DIR, famId, "a0.json");
  if (existsSync(outFile)) {
    await log(`[skip] ${famId} a0 exists`);
  } else {
    const pool = await loadPool();
    const manuscript = await readManuscriptText();
    const prompt = `${A0_PROMPT_HEAD}${renderPoolMaterial(pool)}\n\nMANUSCRIPT:\n${manuscript}`;
    const t0 = Date.now();
    let attempts = 0;
    let parsed;
    let rawOutput = "";
    while (attempts < 2) {
      attempts += 1;
      const task = await adapter.runAgent({
        agentId: "main",
        contextScope: `m1514-a0/${famId}`,
        task: attempts === 2 ? `${prompt}\n\n【格式提醒】上一次输出无法解析为 JSON。请只输出一个合法 JSON 对象（无围栏、无前后说明文字）。` : prompt,
        toolPolicy: "read_only",
        metadata: { stage: "m1514-a0", famId },
      });
      rawOutput = task.status === "completed" ? task.output ?? "" : "";
      parsed = lenientJson(rawOutput);
      if (parsed !== undefined) break;
    }
    const normalized = normalizeFindings(parsed);
    const record = {
      familyId: famId,
      arm: "a0",
      parseFailed: parsed === undefined,
      retried: attempts > 1 && parsed !== undefined,
      ...(parsed !== undefined
        ? {
            contributions: (Array.isArray(parsed.contributions) ? parsed.contributions : []).slice(0, 5),
            comparisons: (Array.isArray(parsed.comparisons) ? parsed.comparisons : []).slice(0, 8),
          }
        : {}),
      findings: normalized.findings,
      droppedFindings: normalized.dropped,
      calls: attempts,
      wallMs: Date.now() - t0,
      outputChars: rawOutput.length,
    };
    await writeFile(outFile, JSON.stringify(record, null, 1), "utf8");
    await log(`[a0] ${famId}: findings=${record.findings.length} parseFailed=${record.parseFailed} calls=${attempts} wallMs=${record.wallMs}`);
  }
}

// ---- A1（生产整稿 pass 直调） ----
if (arms.includes("a1")) {
  const outFile = join(OUT_DIR, famId, "a1.json");
  if (existsSync(outFile)) {
    await log(`[skip] ${famId} a1 exists`);
  } else {
    const t0 = Date.now();
    const outcome = await stack.workflowServices.paper.fullPaperReview.reviewFullPaper({
      projectId,
      runId: `m1514-a1-${famId}`,
      sectionFindings: [],
    });
    const record = {
      familyId: famId,
      arm: "a1",
      findings: outcome.findings,
      extractParseFailed: outcome.extractParseFailed,
      critiqueParseFailed: outcome.critiqueParseFailed,
      extractRetried: outcome.extractRetried,
      critiqueRetried: outcome.critiqueRetried,
      dropped: outcome.dropped,
      coverage: outcome.coverage,
      telemetry: outcome.telemetry,
      calls: outcome.telemetry.calls,
      wallMs: Date.now() - t0,
    };
    await writeFile(outFile, JSON.stringify(record, null, 1), "utf8");
    await log(`[a1] ${famId}: findings=${record.findings.length} calls=${record.telemetry.calls} wallMs=${record.wallMs}`);
  }
}

// ---- A2 / A2_NO_PRIOR_WORK ----
for (const armTag of arms.filter((a) => a === "a2" || a === "a2np")) {
  const outFile = join(OUT_DIR, famId, `${armTag}.json`);
  if (existsSync(outFile)) {
    await log(`[skip] ${famId} ${armTag} exists`);
    continue;
  }
  const service = new ContributionAuditService({
    store: paperStore,
    runtime: adapter,
    reviewerAgentId: "main",
    researchDir: (id) => projects.researchDir(id),
  });
  const pool = await loadPool(armTag === "a2np" ? "empty" : "pool");
  currentContributionArm = armTag;
  const t0 = Date.now();
  const outcome = await service.audit({
    projectId,
    runId: `m1514-${armTag}-${famId}`,
    pool,
    documentType: "research_article",
    toolPolicy: "read_only",
  });
  currentContributionArm = null;
  const record = {
    familyId: famId,
    arm: armTag,
    artifact: outcome.artifact,
    extractParseFailed: outcome.extractParseFailed,
    compareParseFailed: outcome.compareParseFailed,
    synthesizeParseFailed: outcome.synthesizeParseFailed,
    extractRetried: outcome.extractRetried,
    compareRetried: outcome.compareRetried,
    synthesizeRetried: outcome.synthesizeRetried,
    findings: outcome.artifact.findings,
    telemetry: outcome.telemetry,
    calls: outcome.telemetry.calls,
    wallMs: Date.now() - t0,
  };
  await writeFile(outFile, JSON.stringify(record, null, 1), "utf8");
  await log(
    `[${armTag}] ${famId}: contributions=${outcome.artifact.inventory.length} comparisons=${outcome.artifact.comparisons.length} findings=${record.findings.length} guards=${JSON.stringify(outcome.artifact.guards)} calls=${outcome.telemetry.calls} wallMs=${record.wallMs}`,
  );
}

await log(`arms done fam=${famId} physicalCalls(this process)=${physicalCalls}`);
process.exit(0);
