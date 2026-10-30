#!/usr/bin/env node
/**
 * M15.15 B2 v2 — 中文稿件 → 英文先前工作：两类真实任务（零模型）。
 *
 * 任务族 1（条目解析，真实产品路径 = M15.14 buildPool 通道 A）：
 *   从 B1 提取的参考文献条目（含 PDF 印刷噪声）构造查询，验证能否命中该条目
 *   自带的印刷 DOI/arXiv 身份。before = M15.14 现状（条目数 0，链路不存在，
 *   已有工件证据）；after = 条目题名查询。Provider：Crossref（DOI 注册库，
 *   bibliographic 检索）/ S2 / OpenAlex，同预算（每任务每家 1 次调用）。
 *   指标 Recall@5/10（正确 DOI/arXiv 出现在前 5/10 位）。
 *
 * 任务族 2（主题发现，M15.14 通道 B）：
 *   before = 中文题名原文直查；after = 确定性英文信号（英文题名块 + Key words 行，
 *   均为 PDF 文本层已有内容）。指标：返回条数 + 与稿件英文关键词的重叠率
 *   （透明代理，不冒充学术相关性）；展示实际 top 结果供人工核验。
 *
 * 网络现实：S2/OpenAlex 匿名调用间歇 429/fetch-failed（与 M15.14 工件一致），
 * 如实记录 note；arXiv/Crossref 稳定。
 *
 * 用法：node scripts/m1515/b2-cross-language-retrieval.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15\\phase-b";
const OUT_DIR = join(ROOT, "b2-tasks");
const CACHE_DIR = join(OUT_DIR, "cache");
await mkdir(OUT_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

const after = JSON.parse(await readFile(join(ROOT, "after", "extraction.json"), "utf8"));

// ---- Provider 适配（限速 + 429 重试 + 磁盘缓存） ----

const MAILTO = process.env.PAPERTEAM_OPENALEX_MAILTO ?? "";
let lastRequestAt = 0;
const REQUEST_INTERVAL_MS = 1600;

async function cachedFetch(url, headers = {}) {
  const cacheKey = createHash("sha256").update(url.toString()).digest("hex").slice(0, 24);
  const cachePath = join(CACHE_DIR, `${cacheKey}.json`);
  if (existsSync(cachePath)) return JSON.parse(await readFile(cachePath, "utf8"));
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `PaperTeam-M1515-research${MAILTO !== "" ? ` (mailto:${MAILTO})` : ""}`, ...headers },
      signal: AbortSignal.timeout(25_000),
    });
    const bodyText = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = { raw: bodyText.slice(0, 300_000) }; }
    const record = { status: response.status, ok: response.ok, body: parsed };
    if (response.ok) await writeFile(cachePath, JSON.stringify(record), "utf8");
    return record;
  } catch (error) {
    return { status: `error:${error.message}`, ok: false, body: null };
  }
}

async function fetchWith429Retry(url, headers = {}) {
  const first = await cachedFetch(url, headers);
  if (first.ok || !String(first.status).startsWith("429")) return first;
  await new Promise((r) => setTimeout(r, 7000));
  return cachedFetch(url, headers);
}

const compact = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function crossrefBibliographic(query) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query.slice(0, 300));
  url.searchParams.set("rows", "10");
  url.searchParams.set("select", "DOI,title");
  const r = await fetchWith429Retry(url);
  if (!r.ok) return { ok: false, note: `crossref:${r.status}`, works: [] };
  const items = r.body?.message?.items ?? [];
  return {
    ok: true,
    works: items.map((it) => ({
      title: Array.isArray(it.title) ? it.title[0] ?? "" : "",
      doi: (it.DOI ?? "").toLowerCase(),
    })),
  };
}

async function s2Search(query) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query.slice(0, 200));
  url.searchParams.set("fields", "title,externalIds");
  url.searchParams.set("limit", "10");
  const r = await fetchWith429Retry(url);
  if (!r.ok) return { ok: false, note: `s2:${r.status}`, works: [] };
  const data = Array.isArray(r.body?.data) ? r.body.data : [];
  return {
    ok: true,
    works: data.map((p) => ({ title: p.title ?? "", doi: p.externalIds?.DOI?.toLowerCase() ?? null, arxivId: p.externalIds?.ArXiv ?? null })),
  };
}

async function openalexTitleSearch(query) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", "title.search:" + query.slice(0, 200));
  url.searchParams.set("per-page", "10");
  url.searchParams.set("select", "id,doi,title");
  const r = await fetchWith429Retry(url);
  if (!r.ok) return { ok: false, note: `openalex:${r.status}`, works: [] };
  const results = Array.isArray(r.body?.results) ? r.body.results : [];
  return { ok: true, works: results.map((w) => ({ title: w.title ?? "", doi: (w.doi ?? "").replace("https://doi.org/", "").toLowerCase() || null })) };
}

async function arxivSearchB2(query) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query.slice(0, 200)}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "10");
  url.searchParams.set("sortBy", "relevance");
  const r = await cachedFetch(url);
  if (!r.ok) return { ok: false, note: `arxiv:${r.status}`, works: [] };
  const raw = typeof r.body?.raw === "string" ? r.body.raw : "";
  const works = [...raw.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<id>http:\/\/arxiv\.org\/abs\/([0-9.]+)(v\d+)?<\/id>/g)]
    .map((m) => ({ title: (m[1] ?? "").replace(/\s+/g, " ").trim(), doi: null }));
  return { ok: true, works };
}

// ---- 任务族 1：条目解析 ----

const MANUSCRIPTS = ["case-R", "10_11834_jig_200037", "10_11834_jig_210794", "10_11834_jig_220670"];

function pickResolutionTasks(references) {
  const withDoi = references.filter((r) => r.doi && (r.title ?? "").length > 10);
  const hyphenated = withDoi.filter((r) => /­|\w- \w/.test(r.title ?? ""));
  const newest = withDoi.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0];
  const noisy = hyphenated[0] ?? withDoi[1] ?? withDoi[0];
  const arxiv = references.filter((r) => r.arxivId && (r.title ?? "").length > 10)[0];
  const picked = [];
  for (const candidate of [newest, noisy, arxiv]) {
    if (candidate && !picked.some((p) => p.referenceId === candidate.referenceId)) picked.push(candidate);
  }
  return picked.slice(0, 2);
}

const resolutionResults = [];
for (const sample of MANUSCRIPTS) {
  const res = after.results.find((r) => r.sample === sample);
  for (const entry of pickResolutionTasks(res.references)) {
    const query = (entry.title ?? "")
      .replace(/­/g, "")
      .replace(/10\s*[.]\s*\d{4,5}\s*[/][^\s]*/g, " ")
      .replace(/\[?\s*DOI[^\]]*\]?/gi, " ")
      .replace(/\s+/g, " ").trim();
    const target = { doi: entry.doi ?? null, arxivId: entry.arxivId ?? null, title: entry.title ?? "" };
    const perProvider = {};
    for (const [provider, fn] of [["crossref", crossrefBibliographic], ["s2", s2Search], ["openalex", openalexTitleSearch]]) {
      const r = await fn(query);
      const works = r.ok ? r.works : [];
      const rank = works.findIndex((w) =>
        (target.doi && w.doi === target.doi) ||
        (target.arxivId && w.arxivId === target.arxivId) ||
        (compact(w.title) !== "" && compact(w.title) === compact(target.title)),
      );
      perProvider[provider] = { ok: r.ok, note: r.note ?? null, n: works.length, rank: rank >= 0 ? rank + 1 : null };
    }
    resolutionResults.push({ sample, query: query.slice(0, 120), targetDoi: target.doi, targetArxiv: target.arxivId, perProvider });
    console.log(`[resolve] ${sample} -> ${target.doi ?? target.arxivId}: crossref@${perProvider.crossref.rank ?? "-"} s2@${perProvider.s2.rank ?? "-"}(${perProvider.s2.ok ? "ok" : perProvider.s2.note}) openalex@${perProvider.openalex.rank ?? "-"}(${perProvider.openalex.ok ? "ok" : perProvider.openalex.note})`);
  }
}

// ---- 任务族 2：主题发现 ----

function extractEnglishTitle(pageBlocks) {
  // CJIG「论文引用格式：… YYYY. <English title>. Journal of Image and Graph…」逐字含英文题名
  for (const block of pageBlocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    const m = /^.*论文引用格式[：:]\s*(.+)$/.exec(text) ?? (/论文引用格式[：:]\s*([^.]+\.\s*(?:19|20)\d{2}[a-z]?\.\s+(.+?))\./.exec(text) ?? null);
    if (m !== null) {
      const rest = m[1] ?? "";
      const yearSplit = /(?:19|20)\d{2}[a-z]?\.\s+(.+?)(?:\.\s+(?:Journal|Chinese Journal|J\.)|$)/.exec(rest);
      const title = (yearSplit?.[1] ?? "").trim();
      if (title.split(" ").length >= 4 && !/\p{Script=Han}/u.test(title)) return title;
    }
  }
  const candidates = [];
  for (const block of pageBlocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (text === "" || /\p{Script=Han}/u.test(text)) continue;
    const words = text.split(" ");
    if (words.length < 5 || words.length > 18) continue;
    if (/[.]$/.test(text)) continue;
    if (/^(abstract|key\s*words|keywords|school|supported|fund|corresponding|email|doi|http|editor|distributed|address)/i.test(text)) continue;
    if (/university|institute|press|beijing/i.test(text)) continue;
    if (/(the|of|and|as|to|in).{0,40}(the|of|and|as|to|in).{0,40}(the|of|and|as|to|in)/i.test(text)) continue; // 摘要句特征
    candidates.push(text);
  }
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0] ?? null;
}

function extractEnglishKeywords(blocks) {
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    const match = /^(?:Key\s*words|Keywords)\s*[：:]\s*(.+)$/i.exec(text);
    if (match !== null) {
      return (match[1] ?? "").split(/[;；]/).map((p) => p.replace(/[^A-Za-z0-9 ()\-]/g, "").trim()).filter((p) => p.length >= 3).slice(0, 6);
    }
  }
  return [];
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const PARSE_SCRIPT = join(REPO, "backend", "tools", "parse_paper_pdf.py");
const parseCache = new Map();
async function parse(sample) {
  if (!parseCache.has(sample)) {
    const { stdout } = await execFileAsync("python", [PARSE_SCRIPT, join(ROOT, "samples", `${sample}.pdf`)],
      { timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" } });
    parseCache.set(sample, JSON.parse(stdout.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "{}"));
  }
  return parseCache.get(sample);
}

const discoveryResults = [];
for (const sample of MANUSCRIPTS) {
  const res = after.results.find((r) => r.sample === sample);
  const raw = await parse(sample);
  const head = (raw.blocks ?? []).filter((b) => b.page <= 8);
  const enTitle = extractEnglishTitle(head);
  const enKw = extractEnglishKeywords((raw.blocks ?? []).filter((b) => b.page <= 8));
  const kwText = enKw.join(" ");
  const kwTokens = new Set(kwText.toLowerCase().split(/\s+/).filter((w) => w.length >= 4));
  const arms = {
    beforeZhTitle: res.parsedTitle,
    afterEnSignals: [enTitle, kwText].filter(Boolean).join(" ").slice(0, 200),
  };
  const entry = { sample, enTitle, enKeywords: enKw, arms: {} };
  for (const [arm, query] of Object.entries(arms)) {
    const perProvider = {};
    for (const [provider, fn] of [["s2", s2Search], ["openalex", openalexTitleSearch], ["arxiv", arxivSearchB2]]) {
      const r = await fn(query);
      const works = r.ok ? r.works.slice(0, 10) : [];
      const overlap = works.map((w) => {
        const tokens = (w.title ?? "").toLowerCase().split(/\s+/).filter((w2) => w2.length >= 4);
        const inter = tokens.filter((t) => kwTokens.has(t)).length;
        return tokens.length > 0 ? inter / Math.min(tokens.length, kwTokens.size || 1) : 0;
      });
      perProvider[provider] = {
        ok: r.ok, note: r.note ?? null, n: works.length,
        meanKeywordOverlap: overlap.length > 0 ? Number((overlap.reduce((a, b) => a + b, 0) / overlap.length).toFixed(3)) : null,
        top3: works.slice(0, 3).map((w) => (w.title ?? "").slice(0, 90)),
      };
    }
    entry.arms[arm] = { query, perProvider };
    console.log(`[discover] ${sample} [${arm}] q="${query.slice(0, 50)}" s2(${perProvider.s2.n}/${perProvider.s2.meanKeywordOverlap}) oa(${perProvider.openalex.n}) arxiv(${perProvider.arxiv?.n ?? "-"}/${perProvider.arxiv?.meanKeywordOverlap ?? "-"})`);
  }
  discoveryResults.push(entry);
}

// ---- 失败重试（fetch failed/429 的环境抖动）：单次二 pass ----
await new Promise((r) => setTimeout(r, 10_000));
for (const row of resolutionResults) {
  for (const [provider, fn] of [["crossref", crossrefBibliographic], ["s2", s2Search], ["openalex", openalexTitleSearch]]) {
    if (row.perProvider[provider]?.ok) continue;
    const r = await fn(row.query);
    if (!r.ok) { row.perProvider[provider].note = `${r.note}(retry)`; continue; }
    const target = { doi: row.targetDoi, arxivId: row.targetArxiv };
    const works = r.works;
    const rank = works.findIndex((w) =>
      (target.doi && w.doi === target.doi) ||
      (target.arxivId && w.arxivId === target.arxivId));
    row.perProvider[provider] = { ok: true, note: "retry-ok", n: works.length, rank: rank >= 0 ? rank + 1 : null };
  }
}

await writeFile(join(OUT_DIR, "results.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), resolutionResults, discoveryResults,
}, null, 2), "utf8");

// ---- 汇总 ----

const recallAt = (rows, provider, k) => {
  const eligible = rows.filter((r) => r.perProvider[provider]?.ok);
  const hit = eligible.filter((r) => (r.perProvider[provider]?.rank ?? 99) <= k);
  return eligible.length > 0 ? `${hit.length}/${eligible.length}` : "n/a(no provider ok)";
};
console.log(`\n[族1 条目解析] crossref R@5=${recallAt(resolutionResults, "crossref", 5)} R@10=${recallAt(resolutionResults, "crossref", 10)} | s2 R@5=${recallAt(resolutionResults, "s2", 5)} | openalex R@5=${recallAt(resolutionResults, "openalex", 5)}`);
console.log("[done] ->", join(OUT_DIR, "results.json"));
