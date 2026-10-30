#!/usr/bin/env node
/**
 * M15.15 C — 家族材料准备（确定性，零模型）。
 * - 解析全部 manuscript/prior PDF（PyMuPdfParser → assemblePaper → chunks）
 * - 先前工作：抽取方法相关 chunks 作为 verified_fulltext 摘录（≤3 段、共 ~6k 字符），
 *   摘要取解析产物 abstract（arXiv PDF 首页摘要）
 * - 稿件：参考文献表（ReferenceExtractor）→ 选 2 个 abstract 级干扰项（非目标、有干净标题）
 * - 产出 phase-c/families.json（含 SHA256、cutoff、pool 骨架）
 * 用法：node scripts/m1515/c-prep-families.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15\\phase-c";
const PARSE_SCRIPT = join(REPO, "backend", "tools", "parse_paper_pdf.py");

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { assemblePaper } = await import(distUrl("paper", "sectionChunking.js"));
const { ReferenceExtractor } = await import(distUrl("paper", "ReferenceExtractor.js"));

const sha256 = async (p) => {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
};

async function parsePdf(pdfPath) {
  const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, resolve(pdfPath)], {
    timeout: 180_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const record = JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}");
  if (record.ok !== true) throw new Error(`parse failed: ${pdfPath}: ${record.error}`);
  return {
    pageCount: record.pageCount, title: record.title ?? "", abstract: record.abstract ?? "",
    toc: record.toc ?? [], blocks: record.blocks ?? [], totalChars: record.totalChars ?? 0,
  };
}

/** 方法相关摘录：方法/方法学节 chunk 优先（按标题关键词+词密度），不足时取引言/实验补充 */
function pickExcerpts(assembled, budget = 6_000) {
  const scored = assembled.chunks.map((chunk) => {
    const sectionTitle = assembled.sections.find((s) => s.sectionId === chunk.sectionId)?.title ?? "";
    // 参考文献节的关键词密度是噪声源（F5 实测：References 摘录挤掉方法节）——直接排除
    if (/reference|bibliograph/i.test(sectionTitle)) return { chunk, score: -1 };
    const methodish = /method|approach|architect|propos|algorithm|model|framework|track|associat|metric|formulat|binariz/i.test(sectionTitle);
    const dense = (chunk.text.match(/\b(Kalman|Hungarian|association|query|regression|binariz|segmentation|embedding|matching|detection|tracking|score|confidence|formula|metric)\b/gi) ?? []).length;
    return { chunk, score: (methodish ? 40 : 0) + dense };
  });
  scored.sort((a, b) => b.score - a.score || a.chunk.sequence - b.chunk.sequence);
  const excerpts = [];
  let used = 0;
  for (const { chunk, score } of scored) {
    if (score <= 0 || used >= budget) break;
    const sectionTitle = assembled.sections.find((s) => s.sectionId === chunk.sectionId)?.title ?? "";
    const header = `[${sectionTitle || "body"}; p.${chunk.pageStart}] `;
    const text = header + chunk.text;
    excerpts.push(text.slice(0, 3_000));
    used += text.length;
    if (excerpts.length >= 3) break;
  }
  return excerpts;
}

const FAMILIES = [
  { familyId: "F1", manuscript: "arxiv-2110.06864.pdf", prior: "arxiv-1602.00763.pdf", cutoff: "2021-10-31", priorArxiv: "1602.00763", priorTitle: "Simple online and realtime tracking", priorYear: 2016 },
  { familyId: "F2", manuscript: "arxiv-2203.14360.pdf", prior: "arxiv-1602.00763.pdf", cutoff: "2022-03-31", priorArxiv: "1602.00763", priorTitle: "Simple online and realtime tracking", priorYear: 2016 },
  { familyId: "F3", manuscript: "arxiv-2203.14360.pdf", prior: "arxiv-1703.07402.pdf", cutoff: "2022-03-31", priorArxiv: "1703.07402", priorTitle: "Simple online and realtime tracking with a deep association metric", priorYear: 2017 },
  { familyId: "F4", manuscript: "arxiv-2101.02702.pdf", prior: "arxiv-2005.12872.pdf", cutoff: "2021-01-31", priorArxiv: "2005.12872", priorTitle: "End-to-end object detection with transformers", priorYear: 2020 },
  { familyId: "F5", manuscript: "case-R.pdf", prior: "arxiv-1911.08947.pdf", cutoff: "2023-06-30", priorArxiv: "1911.08947", priorTitle: "Real-time scene text detection with differentiable binarization", priorYear: 2019 },
  { familyId: "F6", manuscript: "arxiv-2009.07736.pdf", prior: "arxiv-1609.01775.pdf", cutoff: "2020-09-30", priorArxiv: "1609.01775", priorTitle: "Online multiple object tracking benchmark evaluation and higher order tracking metrics", priorYear: 2016 },
  { familyId: "F7", manuscript: "arxiv-2105.03247.pdf", prior: "arxiv-1903.05625.pdf", cutoff: "2021-05-31", priorArxiv: "1903.05625", priorTitle: "Tracking without bells and whistles", priorYear: 2019 },
];

// 稿件路径（case-R 复用 phase-b 样本）
const manuscriptPath = (name) =>
  name === "case-R.pdf"
    ? "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples\\case-R.pdf"
    : join(ROOT, "manuscripts", name);

const extractor = new ReferenceExtractor();
const priorCache = new Map();
const out = [];
for (const family of FAMILIES) {
  const mPath = manuscriptPath(family.manuscript);
  const mParsed = await parsePdf(mPath);
  if (mParsed.pageCount < 3) throw new Error(`${family.familyId} manuscript 疑似损坏: ${mParsed.title}`);
  const mAssembled = assemblePaper(mParsed);
  const mRefs = extractor.extract(mAssembled);
  // 干扰项：稿件参考文献中标题干净、非目标的头 2 条
  const distractors = mRefs.references
    .filter((r) => (r.title ?? "").length > 20 && !r.title.toLowerCase().includes("simple online and realtime"))
    .slice(0, 2)
    .map((r, i) => ({
      candidateId: `D${String(i + 1).padStart(2, "0")}`,
      title: r.title ?? "", year: r.year, doi: r.doi, arxivId: r.arxivId,
      abstract: undefined, citedByManuscript: true, contentLevel: "metadata", source: "reference-list(dist)",
    }));

  if (!priorCache.has(family.prior)) {
    const pPath = join(ROOT, "priors", family.prior);
    const pParsed = await parsePdf(pPath);
    if (pParsed.pageCount < 3) throw new Error(`${family.familyId} prior 疑似损坏`);
    const pAssembled = assemblePaper(pParsed);
    priorCache.set(family.prior, {
      sha256: await sha256(pPath), title: pParsed.title, abstract: pParsed.abstract,
      pageCount: pParsed.pageCount, excerpts: pickExcerpts(pAssembled),
    });
  }
  const prior = priorCache.get(family.prior);
  if ((prior.abstract ?? "").trim() === "") {
    // 解析产物无摘要（部分 arXiv PDF 首页版式）→ arXiv API 元数据兜底（确定性，非模型）
    try {
      const xml = await readFile(join(ROOT, `api-${family.priorArxiv}.xml`), "utf8");
      const m = /<summary>([\s\S]*?)<\/summary>/.exec(xml ?? "");
      if (m !== null) prior.abstract = (m[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 1500);
    } catch {}
  }
  const entry = {
    ...family,
    manuscriptSha256: await sha256(mPath),
    manuscriptParsedTitle: mParsed.title,
    manuscriptRefCount: mRefs.references.length,
    priorSha256: prior.sha256,
    priorParsedTitle: prior.title,
    priorAbstract: prior.abstract.slice(0, 1_500),
    priorExcerpts: prior.excerpts,
    distractors,
  };
  out.push(entry);
  console.log(`[prep] ${family.familyId}: m="${mParsed.title.slice(0, 50)}" refs=${mRefs.references.length} prior="${prior.title.slice(0, 40)}" excerpts=${prior.excerpts.length} abst=${prior.abstract.length}ch distr=${distractors.length}`);
}

await mkdir(join(ROOT, "families"), { recursive: true });
await writeFile(join(ROOT, "families", "families.json"), JSON.stringify({ generatedAt: new Date().toISOString(), families: out }, null, 2), "utf8");
console.log("[done] ->", join(ROOT, "families", "families.json"));
