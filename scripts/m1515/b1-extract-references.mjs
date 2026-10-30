#!/usr/bin/env node
/**
 * M15.15 B1 — 中文 PDF 参考文献提取 before/after 复现 harness（零模型）。
 *
 * 对 phase-b/samples/ 下每个 PDF：
 *   PyMuPdfParser.parseFile → assemblePaper → ReferenceExtractor.extract
 * 输出 {referencesSectionId, references[], callouts, notes}——与产品链路同一
 * 代码路径（不经 HTTP、不落项目库），供 before（main 现状）与 after（修复后）
 * 对照及金标准 recall/precision 计算复用。
 *
 * 用法：node scripts/m1515/b1-extract-references.mjs --samples <dir> --out <file> [--parser <python>]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const SAMPLES_DIR = resolve(arg("samples", "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples"));
const OUT_FILE = resolve(arg("out", "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\before\\extraction.json"));
const PARSE_SCRIPT = join(REPO, "backend", "tools", "parse_paper_pdf.py");

const { assemblePaper } = await import(distUrl("paper", "sectionChunking.js"));
const { ReferenceExtractor } = await import(distUrl("paper", "ReferenceExtractor.js"));

// 直接跑 python 解析脚本（与 PyMuPdfParser 同一脚本/协议），避免依赖 toolchain 探测
async function parsePdf(pdfPath) {
  const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, resolve(pdfPath)], {
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const payloadLine = stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
  const record = JSON.parse(payloadLine);
  if (record["ok"] !== true) throw new Error(`parse failed: ${record["error"]}`);
  return record;
}

const extractor = new ReferenceExtractor();
const files = (await readdir(SAMPLES_DIR)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
const results = [];
for (const file of files) {
  const pdfPath = join(SAMPLES_DIR, file);
  process.stdout.write(`[extract] ${file} ... `);
  const raw = await parsePdf(pdfPath);
  const extraction = {
    pageCount: raw["pageCount"],
    title: raw["title"] ?? "",
    abstract: raw["abstract"] ?? "",
    toc: raw["toc"] ?? [],
    blocks: raw["blocks"] ?? [],
    totalChars: raw["totalChars"] ?? 0,
  };
  const assembled = assemblePaper(extraction);
  const { references, callouts, notes } = extractor.extract(assembled);
  results.push({
    sample: file.replace(/\.pdf$/i, ""),
    pageCount: extraction.pageCount,
    parsedTitle: extraction.title,
    referencesSectionId: assembled.referencesSectionId ?? null,
    sectionTitles: assembled.sections.map((s) => s.title),
    referenceCount: references.length,
    calloutCount: callouts.length,
    calloutStyles: callouts.reduce((acc, c) => ({ ...acc, [c.style]: (acc[c.style] ?? 0) + 1 }), {}),
    notes,
    references: references.map((r) => ({
      referenceId: r.referenceId,
      number: r.number ?? null,
      rawText: r.rawText.slice(0, 500),
      title: r.title ?? null,
      authors: r.authors ?? null,
      year: r.year ?? null,
      doi: r.doi ?? null,
      venue: r.venue ?? null,
      page: r.page,
    })),
  });
  process.stdout.write(
    `refs=${references.length} callouts=${callouts.length} section=${assembled.referencesSectionId ?? "NONE"}\n`,
  );
}

await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), "utf8");
console.log(`[done] ${results.length} samples -> ${OUT_FILE}`);
