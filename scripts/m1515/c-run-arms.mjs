#!/usr/bin/env node
/**
 * M15.15 C — 三臂运行器。
 *   P0 one-shot + abstract 级 pool（目标先前工作仅题录+摘要）
 *   P1 one-shot + verified_fulltext 级 pool（同 P0 + 方法节全文摘录）——prompt 与 P0 逐字节
 *      相同，唯一差异是 pool 材料（renderPoolMaterial 输出），隔离"材料"变量
 *   P2 ContributionAuditService（extract→compare→synthesize 3 调用）+ 同 P1 的 pool
 *      ——检验结构化审计相对 P1 的增量
 * 每族每臂产物落盘 phase-c/out/Fx/{p0,p1,p2}.json；全部物理调用记 model-calls.jsonl。
 * 用法：node scripts/m1515/c-run-arms.mjs [--fams F1,F2] [--arms p0,p1,p2]
 */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15\\phase-c";
const PROJECTS_ROOT = join(ROOT, "projects-root");
const OUT_DIR = join(ROOT, "out");
const CALLS_LOG = join(ROOT, "model-calls.jsonl");
const LEDGER = join(ROOT, "budget-ledger.json");
const BUDGET_CAP = 200;

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const famsArg = argOf("--fams");
const armsArg = argOf("--arms") ?? "p0,p1,p2";

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER;
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(BUDGET_CAP);
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

await mkdir(OUT_DIR, { recursive: true });
await mkdir(PROJECTS_ROOT, { recursive: true });

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { PaperStore } = await import(distUrl("paper", "PaperStore.js"));
const { PaperIngestService } = await import(distUrl("paper", "PaperIngestService.js"));
const { PyMuPdfParser } = await import(distUrl("paper", "PdfParser.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { ContributionAuditService, renderPoolMaterial } = await import(distUrl("target", "ContributionAuditService.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({ path: LEDGER, limits: { maxCalls: BUDGET_CAP, maxTokens: 0 }, label: "M15.15 phaseC" });
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  log: () => {},
});

let physicalCalls = 0;
let currentArm = "p0";
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const t0 = Date.now();
  const scopeHint = callArgs[0]?.contextScope ?? "";
  const result = await originalRunAgent(...callArgs);
  await appendFile(CALLS_LOG, JSON.stringify({
    ts: new Date().toISOString(), callIndex: physicalCalls, familyId: currentFam,
    arm: scopeHint.startsWith("m1515-p0/") ? "p0" : scopeHint.startsWith("m1515-p1/") ? "p1" : currentArm,
    contextScope: scopeHint, status: result.status, ms: Date.now() - t0,
    usage: result.usage ?? null, taskId: result.taskId,
  }) + "\n", "utf8").catch(() => {});
  return result;
};

const projects = new ProjectStore({ root: PROJECTS_ROOT });
const paperStore = new PaperStore(projects);
const ingest = new PaperIngestService({ projects, store: paperStore, parser: new PyMuPdfParser(), log: () => {} });
const auditService = new ContributionAuditService({
  store: paperStore, runtime: adapter, reviewerAgentId: "main",
  researchDir: (id) => projects.researchDir(id),
});

const familiesFile = JSON.parse(await readFile(join(ROOT, "families", "families.json"), "utf8"));
let families = familiesFile.families;
if (famsArg !== null) families = families.filter((f) => famsArg.split(",").includes(f.familyId));

const manuscriptPath = (name) =>
  name === "case-R.pdf"
    ? "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples\\case-R.pdf"
    : join(ROOT, "manuscripts", name);

// ---- pool 构造（P0/P1 唯一差异：目标先前工作的 contentLevel 与摘录） ----
function buildPool(family, level) {
  const priorCandidate = {
    candidateId: "P01",
    title: family.priorTitle,
    year: family.priorYear,
    arxivId: family.priorArxiv,
    ...(family.priorAbstract ? { abstract: family.priorAbstract } : {}),
    ...(level === "verified_fulltext" ? { fullTextExcerpts: family.priorExcerpts } : {}),
    citedByManuscript: true,
    contentLevel: level,
    source: `arxiv:${family.priorArxiv}`,
  };
  return {
    cutoffDate: family.cutoff,
    queriesUsed: ["m1515-c-family-material(frozen)"],
    candidates: [priorCandidate, ...family.distractors],
  };
}

async function readManuscriptText(projectId) {
  const chunksRaw = await readFile(join(PROJECTS_ROOT, projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).sort((a, b) => a.sequence - b.sequence);
  const pages = new Map();
  for (const c of chunks) {
    const label = `[page ${c.pageStart}${c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}]`;
    pages.set(label, (pages.get(label) ?? "") + c.text + "\n");
  }
  return [...pages.entries()].map(([label, text]) => `${label}\n${text}`).join("\n");
}

const ONE_SHOT_PROMPT = `You are an expert peer reviewer. The full manuscript text is provided, followed by PRIOR WORK MATERIAL retrieved deterministically for this submission (publication date <= the cutoff shown).

Tasks (output ONLY one JSON object, no prose):
1. Identify at most 3 core claimed contributions of the manuscript: for each, a verbatim claimQuote from the manuscript.
2. For each contribution, compare against the closest prior work from the provided material (use candidateId). State:
   - commonMechanism: the technical mechanism shared with that prior work;
   - substantiveDifference: what is actually different (structural novelty / new combination / empirical improvement / scope extension / presentation-only rewording). Rephrasing is NOT a difference.
   - differenceBasis: the observable content level your judgment rests on: "abstract" | "metadata" | "fulltext" | "none".
   - quote: a verbatim quote from the prior-work material you relied on (pool entries only; never fabricate).
   - status: "SUPPORTED_DIFFERENCE" | "POTENTIAL_OVERLAP" | "EVIDENCE_GAP" | "INSUFFICIENT_EVIDENCE".
   - missingVerification: what additional evidence would decide it.
3. Content-level rules (strict): with abstract-level material you may compare ideas, but you CANNOT assert implementation-level sameness or difference of details; with metadata-only material you cannot support strong claims. ONLY with verified_fulltext material (excerpts provided verbatim) may you assert implementation-level sameness or difference — then differenceBasis must be "fulltext" and quote must be a verbatim passage from those excerpts. "No similar work found" is NEVER sufficient for SUPPORTED_DIFFERENCE.

Judge novelty AS OF the cutoff date shown in the material header; never use knowledge of work published after that date.

Output schema:
{"contributions":[{"claimQuote":"..."}],"comparisons":[{"contributionIndex":0,"nearestPriorWorks":[{"candidateId":"P01","title":"...","year":0}],"commonMechanism":"...","substantiveDifference":"...","differenceBasis":"abstract|metadata|fulltext|none","quote":"...","status":"...","missingVerification":"..."}]}`;

function lenientJson(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

let currentFam = "?";
for (const family of families) {
  currentFam = family.familyId;
  const outDir = join(OUT_DIR, family.familyId);
  await mkdir(outDir, { recursive: true });
  const done = (arm) => existsSync(join(outDir, `${arm}.json`));

  // 稿件项目（P2 需要；P0/P1 读同一解析文本）
  const projectIdFile = join(outDir, "project-id.txt");
  let projectId;
  if (existsSync(projectIdFile)) {
    projectId = (await readFile(projectIdFile, "utf8")).trim();
  } else {
    const project = await projects.create(`M15.15 C ${family.familyId} ${family.manuscriptParsedTitle.slice(0, 40)}`);
    projectId = project.id;
    const content = await readFile(manuscriptPath(family.manuscript));
    await ingest.ingest(projectId, { fileName: family.manuscript, content });
    await writeFile(projectIdFile, projectId, "utf8");
  }
  const manuscriptText = await readManuscriptText(projectId);
  const poolAbstract = buildPool(family, "abstract");
  const poolFulltext = buildPool(family, "verified_fulltext");

  const arms = armsArg.split(",");
  if (arms.includes("p0") && !done("p0")) {
    currentArm = "p0";
    const prompt = `${ONE_SHOT_PROMPT}\n\n【MANUSCRIPT FULL TEXT】\n${manuscriptText}\n\n${renderPoolMaterial(poolAbstract)}`;
    const t0 = Date.now();
    const result = await adapter.runAgent({
      agentId: "main",
      projectId,
      contextScope: `m1515-p0/${family.familyId}`,
      task: prompt,
      toolPolicy: "read_only",
    });
    await writeFile(join(outDir, "p0.json"), JSON.stringify({
      familyId: family.familyId, arm: "p0", status: result.status, ms: Date.now() - t0,
      usage: result.usage ?? null, output: result.output ?? "" ?? null,
      parsed: lenientJson(result.output ?? ""),
      poolMaterial: renderPoolMaterial(poolAbstract),
    }, null, 2), "utf8");
    console.log(`[F${family.familyId} p0] status=${result.status} ms=${Date.now() - t0}`);
  }
  if (arms.includes("p1") && !done("p1")) {
    currentArm = "p1";
    const prompt = `${ONE_SHOT_PROMPT}\n\n【MANUSCRIPT FULL TEXT】\n${manuscriptText}\n\n${renderPoolMaterial(poolFulltext)}`;
    const t0 = Date.now();
    const result = await adapter.runAgent({
      agentId: "main",
      projectId,
      contextScope: `m1515-p1/${family.familyId}`,
      task: prompt,
      toolPolicy: "read_only",
    });
    await writeFile(join(outDir, "p1.json"), JSON.stringify({
      familyId: family.familyId, arm: "p1", status: result.status, ms: Date.now() - t0,
      usage: result.usage ?? null, output: result.output ?? "" ?? null,
      parsed: lenientJson(result.output ?? ""),
      poolMaterial: renderPoolMaterial(poolFulltext),
    }, null, 2), "utf8");
    console.log(`[F${family.familyId} p1] status=${result.status} ms=${Date.now() - t0}`);
  }
  if (arms.includes("p2") && !done("p2")) {
    currentArm = "p2";
    const t0 = Date.now();
    const outcome = await auditService.audit({
      projectId,
      runId: `m1515-c-${family.familyId}`,
      pool: poolFulltext,
      documentType: "research_article",
      toolPolicy: "read_only",
    });
    await writeFile(join(outDir, "p2.json"), JSON.stringify({
      familyId: family.familyId, arm: "p2", ms: Date.now() - t0,
      artifact: outcome.artifact, telemetry: outcome.telemetry,
      parseFailures: { extract: outcome.extractParseFailed, compare: outcome.compareParseFailed, synthesize: outcome.synthesizeParseFailed },
      poolMaterial: renderPoolMaterial(poolFulltext),
    }, null, 2), "utf8");
    console.log(`[F${family.familyId} p2] status=${outcome.artifact?.status ?? "?"} ms=${Date.now() - t0}`);
  }
}
console.log(`[done] physical calls this run: ${physicalCalls}`);
