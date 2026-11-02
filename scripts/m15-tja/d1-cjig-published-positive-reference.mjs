#!/usr/bin/env node
/**
 * M15 TJA · D1：CJIG 已发表论文上的规则检查器正向参照检验（零模型、只读）。
 *
 * 样本：D:\PaperTeamData\M15\M15_9\phase-b\corpus\cjig（官方 OA 渠道获取的 23 篇全文 PDF；不入库）。
 * 链路：backend/tools/parse_paper_pdf.py → assemblePaper → pdfReferenceStatsOf(evalYear = 论文年份)
 *       → evaluateProfileRules(CJIG profile, PDF-only facts, 稿型 = manifest documentTypeGuess)。
 * 口径：已发表 = 编辑部接受的正向参照；VIOLATED 只能解释为「检查器误报」或「编辑部未严格执行」，
 *       不是负例，也不据此调阈值（协议冻结后只跑一次）。
 *
 * 用法：node scripts/m15-tja/d1-cjig-published-positive-reference.mjs --corpus <dir> --out <file.json>
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const CORPUS = arg("corpus");
const OUT = arg("out");
if (CORPUS === undefined || OUT === undefined) throw new Error("需要 --corpus 与 --out");
const distUrl = (...p) => `file://${join(REPO, "backend", "dist", ...p).replaceAll("\\", "/")}`;
const { assemblePaper } = await import(distUrl("paper", "sectionChunking.js"));
const { pdfReferenceStatsOf } = await import(distUrl("target", "guidelineFacts.js"));
const { BUILTIN_JOURNAL_PROFILES } = await import(distUrl("target", "journal", "profileRegistry.js"));
const { evaluateProfileRules } = await import(distUrl("target", "journal", "criteria.js"));
const PARSE = join(REPO, "backend", "tools", "parse_paper_pdf.py");
const cjig = BUILTIN_JOURNAL_PROFILES.find((p) => p.journalId === "cjig");

const manifest = JSON.parse(await readFile(join(CORPUS, "cjig-manifest-v2.json"), "utf8"));
const papers = manifest.papers.filter((p) => typeof p.pdfFile === "string");
const rows = [];
for (const paper of papers) {
  const pdfPath = join(CORPUS, "pdf", paper.pdfFile);
  let record;
  try {
    const { stdout } = await execFileAsync("python", [PARSE, pdfPath], { timeout: 240_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
    record = JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}");
  } catch (error) {
    rows.push({ doi: paper.doi, error: String(error).slice(0, 200) });
    continue;
  }
  if (record.ok !== true) {
    rows.push({ doi: paper.doi, error: record.error ?? "parse_failed" });
    continue;
  }
  const document = assemblePaper(record);
  const { references } = pdfReferenceStatsOf(document, paper.year);
  const guideline = { exists: references !== null, source: references !== null ? "pdf" : null, titleRaw: null, titleCjkChars: null, titleEnWords: null, keywordCount: null, keywords: null, abstractStructured: null, abstractCjkChars: null, bodyCjkAndWordChars: null, references, bibSource: null };
  const facts = { guideline, fidelity: references !== null ? "pdf" : "none", titleChars: null, abstractEnWords: null, abstractCitations: null, abstractCrossRefs: null, abstractResultHasNumber: null, footnoteCount: null, sectionTitles: null, hasAbstractEnv: null, hasBibliography: null, language: null, clcNumberPresent: null, dataAvailabilityMentioned: null, humanSubjectSignals: null, ethicsStatementSignals: null, figureCount: null, tableCount: null, manuscriptFiles: [] };
  const articleType = paper.documentTypeGuess === "survey" ? "survey" : "research";
  const criteria = evaluateProfileRules(cjig, facts, articleType, null, new Date(`${paper.year}-12-31T00:00:00Z`));
  rows.push({
    doi: paper.doi,
    year: paper.year,
    articleType,
    references: references === null ? null : { entryCount: references.entryCount, withYearCount: references.withYearCount, recent10yRatio: references.recent10yRatio, withDoiCount: references.withDoiCount, yearUnparsedCount: references.yearUnparsedCount },
    criteria: criteria.map((c) => ({ ruleId: c.ruleId, status: c.status, observed: c.observed })),
  });
  console.log(`[d1] ${paper.doi} ${articleType} refs=${references?.entryCount ?? "none"} ${criteria.filter((c) => c.ruleId.startsWith("cjig-refs") && c.status !== "NOT_EVALUATED").map((c) => `${c.ruleId}=${c.status}`).join(" ")}`);
}
const ruleIds = ["cjig-refs-15", "cjig-refs-recent-60", "cjig-refs-doi", "article-type:research", "article-type:survey"];
const summary = Object.fromEntries(
  ruleIds.map((id) => {
    const statuses = rows.flatMap((r) => (r.criteria ?? []).filter((c) => c.ruleId === id).map((c) => c.status));
    return [id, statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})];
  }),
);
await writeFile(OUT, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), profile: cjig.rulesVersion, n: papers.length, parsed: rows.filter((r) => r.error === undefined).length, summary, rows }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
