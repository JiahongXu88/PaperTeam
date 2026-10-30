#!/usr/bin/env node
/**
 * M15.16 — CJIG 7 份 PDF 参考文献统计回归 fixture 生成器（脱敏结构化导出）。
 *
 * 对 M15.15 phase-b 的 7 份 CJIG 中文 PDF 样本跑生产链路
 * （PyMuPdfParser → assemblePaper → ReferenceExtractor v4 → pdfReferenceStatsOf），
 * 导出逐条 {number, year, hasDoi}（不含 rawText/title——版权全文不进仓库）。
 * 金标准对照：M15_15 phase-b gold（465 条 / DOI 405/407）。
 *
 * 用法：node scripts/m1516/build-cjig-fixture.mjs（需 backend dist 已构建 + python pymupdf）
 */
import { writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const SAMPLES = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples";
const OUT = join(REPO, "backend", "test", "target", "fixtures", "cjigPdfReferenceStats.json");
const PARSE_SCRIPT = join(REPO, "backend", "tools", "parse_paper_pdf.py");

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { assemblePaper } = await import(distUrl("paper", "sectionChunking.js"));
const { ReferenceExtractor } = await import(distUrl("paper", "ReferenceExtractor.js"));
const { pdfReferenceStatsOf } = await import(distUrl("target", "guidelineFacts.js"));
const { REFERENCE_EXTRACTION_VERSION } = await import(distUrl("paper", "ReferenceExtractor.js"));

const SAMPLES_TO_USE = [
  "10_11834_jig_200037.pdf",
  "10_11834_jig_200544.pdf",
  "10_11834_jig_210794.pdf",
  "10_11834_jig_211153.pdf",
  "10_11834_jig_220670.pdf",
  "case-R.pdf",
  "case-S.pdf",
];

async function parsePdf(pdfPath) {
  const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, resolve(pdfPath)], {
    timeout: 180_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const record = JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}");
  if (record.ok !== true) throw new Error(`parse failed: ${pdfPath}: ${record.error}`);
  return record;
}

const EVAL_YEAR = 2026;
const extractor = new ReferenceExtractor();
const results = [];
for (const name of SAMPLES_TO_USE) {
  const parsed = await parsePdf(join(SAMPLES, name));
  const assembled = assemblePaper(parsed);
  const extraction = extractor.extract(assembled);
  const stats = pdfReferenceStatsOf(assembled, EVAL_YEAR);
  results.push({
    sample: name.replace(/\.pdf$/, ""),
    entries: extraction.references.map((r) => ({
      number: r.number ?? null,
      year: r.year ?? null,
      hasDoi: r.doi !== undefined && r.doi !== "",
      hasArxiv: r.arxivId !== undefined && r.arxivId !== "",
    })),
    stats: stats.references,
    extractorNotes: extraction.notes,
  });
  console.log(
    `[fixture] ${name}: entries=${extraction.references.length} withDoi=${stats.references?.withDoiCount} withYear=${stats.references?.withYearCount} recent=${stats.references?.recent10yCount}`,
  );
}

const fixture = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  extractorVersion: REFERENCE_EXTRACTION_VERSION,
  evalYear: EVAL_YEAR,
  provenance: {
    source: "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples（许可内本地样本；不提交仓库）",
    gold: "M15.15 phase-b GOLD_STANDARD.md：7 份 CJIG 合计 465 条、DOI 405/407（99.5% 召回）；2 条已知缺失形态见金标准文档",
    deidentification: "逐条仅保留 number/year/hasDoi/hasArxiv——rawText/title 不导出（版权全文不进仓库）",
  },
  samples: results,
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(fixture, null, 1), "utf8");
const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0);
const totalDoi = results.reduce((sum, r) => sum + (r.stats?.withDoiCount ?? 0), 0);
console.log(`[fixture] 合计 entries=${totalEntries} withDoi=${totalDoi}（金标准：465 / 405）→ ${OUT}`);
