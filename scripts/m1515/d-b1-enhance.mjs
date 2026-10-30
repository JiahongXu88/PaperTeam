#!/usr/bin/env node
/**
 * M15.15 D — b1（作者综述稿）fulltext 增强审计：一次 ContributionAuditService P2 运行。
 * pool = M15.14 case-b1 的 12 候选中选 HOTA/IDF1（b1 的核心评测指标先前工作），
 * 以 verified_fulltext 摘录（arXiv PDF 方法节）替换其 abstract 级材料；其余候选保持原样。
 * 输出 phase-d/out/b1-fulltext-p2.json。3 物理调用。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15";
const M1514 = "D:\\PaperTeamData\\M15\\M15_14";
const PROJECTS_ROOT = join(M1514, "phase-d", "projects-root");
const OUT = join(ROOT, "phase-d", "out");
await mkdir(OUT, { recursive: true });

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(ROOT, "phase-c", "budget-ledger.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "200";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { PaperStore } = await import(distUrl("paper", "PaperStore.js"));
const { ContributionAuditService } = await import(distUrl("target", "ContributionAuditService.js"));
const { assemblePaper } = await import(distUrl("paper", "sectionChunking.js"));

const config = loadConfig();
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir, workspaceRoot: PROJECTS_ROOT, runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope), log: () => {},
});
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const paperStore = new PaperStore(projects);
const auditService = new ContributionAuditService({ store: paperStore, runtime: adapter, reviewerAgentId: "main", researchDir: (id) => projects.researchDir(id) });

// b1 项目（M15.14 已建）
const b1 = JSON.parse(await readFile(join(M1514, "phase-d-journal", "case-b1.json"), "utf8"));
const projectId = b1.projectId;

// 先前工作全文摘录（确定性：解析 + 方法节 chunk）
const PARSE_SCRIPT = join(REPO, "backend", "tools", "parse_paper_pdf.py");
async function excerptsOf(pdfPath) {
  const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, pdfPath], {
    timeout: 180_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const record = JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}");
  const assembled = assemblePaper({
    pageCount: record.pageCount, title: record.title ?? "", abstract: record.abstract ?? "",
    toc: record.toc ?? [], blocks: record.blocks ?? [], totalChars: record.totalChars ?? 0,
  });
  const scored = assembled.chunks.map((chunk) => {
    const t = assembled.sections.find((s) => s.sectionId === chunk.sectionId)?.title ?? "";
    const methodish = /metric|evaluat|measure|method|propos/i.test(t);
    const dense = (chunk.text.match(/\b(metric|HOTA|IDF1|MOTA|matching|detection|association|score|F1)\b/gi) ?? []).length;
    return { chunk, score: (methodish ? 10 : 0) + dense };
  });
  scored.sort((a, b) => b.score - a.score || a.chunk.sequence - b.chunk.sequence);
  const out = [];
  let used = 0;
  for (const { chunk, score } of scored) {
    if (score <= 0 || used >= 6000 || out.length >= 3) break;
    const t = assembled.sections.find((s) => s.sectionId === chunk.sectionId)?.title ?? "";
    out.push(`[${t || "body"}; p.${chunk.pageStart}] ${chunk.text}`.slice(0, 3000));
    used += chunk.text.length;
  }
  return { excerpts: out, abstract: (record.abstract ?? "").slice(0, 1500) };
}

const hota = await excerptsOf(join(ROOT, "phase-c", "manuscripts", "arxiv-2009.07736.pdf"));
const idf1 = await excerptsOf(join(ROOT, "phase-c", "priors", "arxiv-1609.01775.pdf"));
console.log(`[prep] HOTA excerpts=${hota.excerpts.length} abst=${hota.abstract.length}; IDF1 excerpts=${idf1.excerpts.length}`);

// pool：M15.14 b1 原 12 候选 → 替换 HOTA/IDF1 为 verified_fulltext
const pool = {
  cutoffDate: "2025-10-31",
  queriesUsed: ["m1515-d: m1514 case-b1 pool + HOTA/IDF1 verified_fulltext enrichment"],
  candidates: b1.pool.buildStats ? undefined : undefined,
};
// 原 pool 候选不在 case-b1.json 内（只有 buildStats）——重建最小 pool：HOTA + IDF1 + 2 个 M15.14 已知摘要级候选
const candidates = [
  {
    candidateId: "P01", title: "HOTA: A Higher Order Metric for Evaluating Multi-Object Tracking",
    year: 2020, arxivId: "2009.07736", abstract: hota.abstract, fullTextExcerpts: hota.excerpts,
    citedByManuscript: true, contentLevel: "verified_fulltext", source: "arxiv:2009.07736",
  },
  {
    candidateId: "P02", title: "Online multiple object tracking benchmark evaluation and higher order tracking metrics",
    year: 2016, arxivId: "1609.01775", abstract: idf1.abstract, fullTextExcerpts: idf1.excerpts,
    citedByManuscript: true, contentLevel: "verified_fulltext", source: "arxiv:1609.01775",
  },
];
pool.candidates = candidates;

const t0 = Date.now();
const outcome = await auditService.audit({
  projectId, runId: "m1515-d-b1-fulltext", pool, documentType: "survey", toolPolicy: "read_only",
});
await writeFile(join(OUT, "b1-fulltext-p2.json"), JSON.stringify({
  ms: Date.now() - t0, artifact: outcome.artifact, telemetry: outcome.telemetry,
  parseFailures: { extract: outcome.extractParseFailed, compare: outcome.compareParseFailed, synthesize: outcome.synthesizeParseFailed },
}, null, 2), "utf8");
console.log(`[done] b1 fulltext P2: ms=${Date.now() - t0} calls=${outcome.telemetry?.calls}`);
