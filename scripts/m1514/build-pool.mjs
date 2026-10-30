#!/usr/bin/env node
/**
 * M15.14 Phase C 前置 — 逐 family 确定性构建先前工作候选 pool（零模型）。
 *
 * 多供应商链（2026-10-30 事实：OpenAlex 匿名共享日预算耗尽 429——切合法免费链，
 * 生产栈本就融合 OpenAlex/S2/arXiv）：
 *   题名解析链：OpenAlex title.search → Semantic Scholar paper/search → Crossref
 *   query.bibliographic（逐级回退，磁盘缓存，确定性同序）；
 *   外部检索链：S2 search（相关性序）→ arXiv API（published 截断）。
 *
 * 纪律：
 * - 时间因果：cutoff = 2016-10-31（年份 ≤2016 客户端/服务端过滤，保守）；
 * - 自排除（题名指纹=稿件题名）；去重 DOI>arXiv>题名指纹+年；
 * - 排名（冻结）：自引优先（year desc → title asc），其后外部（S2 序 → arXiv 序）；
 *   深比较池 ≤12；内容等级标注（abstract/metadata）；
 * - 供应商失败/限流如实记录 buildNotes（缺料 → INSUFFICIENT_EVIDENCE 语义）；
 *   磁盘缓存（phase-c/pools/cache/）保证复现。
 *
 * 用法：node scripts/m1514/build-pool.mjs [--fam fam-q-XX]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const PROJECTS_FILE = join(ROOT, "phase-c", "projects.json");
const POOL_DIR = join(ROOT, "phase-c", "pools");
const CACHE_DIR = join(POOL_DIR, "cache");

const CUTOFF_DATE = "2016-10-31";
const CUTOFF_YEAR = 2016;
const POOL_CAP = 12;
const MAX_REF_RESOLUTIONS = 20;
const REQUEST_INTERVAL_MS = 1100;
const MAILTO = process.env.PAPERTEAM_OPENALEX_MAILTO ?? "";

/** PDF 提取文本清理：软连字符/零宽剥除 + 连字归一（ﬁ→fi 等） */
const LIGATURE_MAP = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl" };
const cleanText = (t) =>
  String(t ?? "")
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/[\ufb00-\ufb04]/g, (m) => LIGATURE_MAP[m] ?? m);
/** filter/query 值消毒：软连字符/零宽剥除 + 非 ASCII 字母数字折叠 */
const sanitizeQueryValue = (s) =>
  cleanText(s).replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const STOPWORDS = new Set(
  ("a an the and or of for in on to with via using based we our this that these those is are be as at by from into over under new novel propose proposed method methods model models approach approaches paper study work results result experiments experiment show shows shown showing demonstrate demonstrates demonstrated outperform outperforms outperformed state-of-the-art sota can could would should may might must not no any all each both few more most other some such only own same so than too very just also then once here there when where why how what which who whom whose does did doing done has have had having been being was were will shall about against between during before after above below up down out off again further because until while known well good better best large small high low use used uses one two three first second third general simple effective efficient significant significantly various different similar important key main propose present presented introduce introduced consider considered based called named given let et al".split(" ")),
);
function tfTerms(title, abstract) {
  const counts = new Map();
  const feed = cleanText(`${title} ${abstract ?? ""}`).toLowerCase();
  const tokens = (feed.match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((t) => t.length >= 4);
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);
}

const titleFp = (t) => cleanText(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** 词元重叠匹配（容忍 PDF 提取断词/残缺标题） */
function tokenOverlap(a, b) {
  const A = new Set(titleFp(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(titleFp(b).split(" ").filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { ReferenceExtractor } = await import(distUrl("paper", "ReferenceExtractor.js"));
const { rebuildAbstract } = await import(distUrl("citation", "scholarly.js"));
const identity = await import(distUrl("sources", "identity.js"));

let lastRequestAt = 0;
async function cachedFetch(url, headers = {}) {
  const cacheKey = createHash("sha256").update(`${url.toString()}|${JSON.stringify(headers)}`).digest("hex").slice(0, 24);
  const cachePath = join(CACHE_DIR, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8"));
  }
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `PaperTeam-M15114-research${MAILTO !== "" ? ` (mailto:${MAILTO})` : ""}`, ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    const bodyText = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = { error: bodyText.slice(0, 300_000) }; }
    const record = { status: response.status, ok: response.ok, body: parsed };
    if (response.ok) await writeFile(cachePath, JSON.stringify(record), "utf8");
    return record;
  } catch (error) {
    return { status: `error:${error.message}`, ok: false, body: null };
  }
}

/** S2 匿名限流突发 429：单次退避重试（仍失败如实降级到链上下一家） */
async function cachedFetchWithRetry(url, headers = {}) {
  const first = await cachedFetch(url, headers);
  if (first.ok || !String(first.status).startsWith("429")) return first;
  await new Promise((r) => setTimeout(r, 6000));
  return cachedFetch(url, headers);
}

// ---- 供应商适配（统一 work 形状：title/year/doi/arxivId/abstract/venue/authors/provider） ----

async function openalexTitleSearch(title) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `title.search:${sanitizeQueryValue(title)},publication_year:<${CUTOFF_YEAR + 1}`);
  url.searchParams.set("per-page", "3");
  url.searchParams.set("select", "id,doi,title,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index,ids");
  const r = await cachedFetch(url);
  if (!r.ok) return { ok: false, note: `openalex:${r.status}` };
  const works = (r.body?.results ?? []).map((item) => {
    const doiRaw = typeof item["doi"] === "string" ? item["doi"] : undefined;
    const doi = doiRaw !== undefined ? identity.normalizeDoi(doiRaw) : undefined;
    return {
      title: cleanText(item["title"]),
      year: item["publication_year"],
      doi,
      arxivId: doi !== undefined ? identity.arxivIdFromDoi(doi) : undefined,
      abstract: item["abstract_inverted_index"] != null ? rebuildAbstract(item["abstract_inverted_index"]) : undefined,
      venue: item["primary_location"]?.source?.display_name,
      authors: Array.isArray(item["authorships"]) ? item["authorships"].slice(0, 3).map((a) => a?.author?.display_name ?? "").filter(Boolean).join(", ") : undefined,
      provider: `openalex:${item["ids"]?.openalex ?? item["id"] ?? "?"}`,
    };
  });
  return { ok: true, works };
}

async function s2Search(query, { yearFilter = true, perPage = 10 } = {}) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", sanitizeQueryValue(query).slice(0, 200));
  url.searchParams.set("fields", "title,year,abstract,externalIds,venue,authors");
  url.searchParams.set("limit", String(perPage));
  const r = await cachedFetchWithRetry(url);
  if (!r.ok) return { ok: false, note: `s2:${r.status}` };
  const works = (r.body?.data ?? [])
    .filter((p) => !yearFilter || (p.year ?? 0) <= CUTOFF_YEAR)
    .map((p) => {
      const doi = p.externalIds?.DOI !== undefined ? identity.normalizeDoi(p.externalIds.DOI) : undefined;
      const arxivId = p.externalIds?.ArXiv;
      return {
        title: cleanText(p.title),
        year: p.year,
        doi,
        arxivId,
        abstract: p.abstract !== undefined && p.abstract !== "" ? cleanText(p.abstract) : undefined,
        venue: p.venue,
        authors: Array.isArray(p.authors) ? p.authors.slice(0, 3).map((a) => a?.name ?? "").filter(Boolean).join(", ") : undefined,
        provider: `s2:${p.paperId ?? "?"}`,
      };
    });
  return { ok: true, works };
}

async function crossrefTitleSearch(title) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", sanitizeQueryValue(title).slice(0, 200));
  url.searchParams.set("rows", "3");
  url.searchParams.set("select", "DOI,title,issued,container-title,author");
  const r = await cachedFetch(url);
  if (!r.ok) return { ok: false, note: `crossref:${r.status}` };
  const works = (r.body?.message?.items ?? [])
    .map((item) => ({
      title: cleanText(Array.isArray(item.title) ? item.title[0] : undefined),
      year: item.issued?.["date-parts"]?.[0]?.[0],
      doi: item.DOI !== undefined ? identity.normalizeDoi(item.DOI) : undefined,
      abstract: undefined,
      venue: Array.isArray(item["container-title"]) ? item["container-title"][0] : undefined,
      authors: Array.isArray(item.author) ? item.author.slice(0, 3).map((a) => [a.given, a.family].filter(Boolean).join(" ")).join(", ") : undefined,
      provider: `crossref:${item.DOI ?? "?"}`,
    }))
    .filter((w) => w.title !== undefined && w.title !== "" && (w.year ?? 0) <= CUTOFF_YEAR);
  return { ok: true, works };
}

async function arxivSearch(terms) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${sanitizeQueryValue(terms.join(" "))}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "10");
  url.searchParams.set("sortBy", "relevance");
  const r = await cachedFetch(url);
  if (!r.ok) return { ok: false, note: `arxiv:${r.status}` };
  const raw = r.body && typeof r.body === "object" ? r.body : null;
  const text = raw === null ? "" : JSON.stringify(raw);
  // Atom XML 响应：cachedFetch 已尝试 JSON.parse（失败则 body={error:text}）
  const xml = raw?.error ?? text;
  const works = [];
  const entries = String(xml).split("<entry>").slice(1);
  for (const entry of entries) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return m !== null ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
    };
    const title = cleanText(pick("title") ?? "");
    const published = pick("published");
    const year = published !== undefined ? Number.parseInt(published.slice(0, 4), 10) : undefined;
    const idMatch = /abs\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})/.exec(entry);
    const summary = pick("summary");
    if (title !== "" && (year ?? 0) <= CUTOFF_YEAR) {
      works.push({
        title,
        year,
        arxivId: idMatch !== null ? identity.normalizeArxivId(idMatch[1]) : undefined,
        abstract: summary !== undefined && summary !== "" ? cleanText(summary) : undefined,
        venue: "arXiv",
        provider: `arxiv:${idMatch?.[1] ?? "?"}`,
      });
    }
  }
  return { ok: entries.length > 0 || String(xml).includes("<entry"), works };
}

/** 题名解析链：s2（摘要优先）→ openalex → crossref（无摘要兜底）；词元重叠 ≥0.6 命中 */
async function resolveTitle(refTitle, notes) {
  const titleWords = cleanText(refTitle).split(/\s+/).filter((w) => w.replace(/[^A-Za-z0-9-]/g, "").length > 2).slice(0, 8);
  const attempts = [
    { name: "s2", run: () => s2Search(refTitle, { perPage: 5 }) },
    { name: "arxiv", run: () => arxivSearch(titleWords) },
    { name: "openalex", run: () => openalexTitleSearch(refTitle) },
    { name: "crossref", run: () => crossrefTitleSearch(refTitle) },
  ];
  for (const attempt of attempts) {
    const result = await attempt.run();
    if (!result.ok) {
      notes.push(`resolve:${attempt.name}-failed(${result.note}):${cleanText(refTitle).slice(0, 50)}`);
      continue;
    }
    const match = (result.works ?? []).find((w) => tokenOverlap(w.title, refTitle) >= 0.6);
    if (match !== undefined) return { work: match, via: attempt.name };
  }
  return { work: null, via: null };
}

async function main() {
  await mkdir(POOL_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  const projectsInfo = JSON.parse(await readFile(PROJECTS_FILE, "utf8"));
  const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
  const extractor = new ReferenceExtractor();

  for (const family of projectsInfo.families) {
    const famId = family.familyId;
    if (famArg !== null && famId !== famArg) continue;
    const poolPath = join(POOL_DIR, `${famId}.json`);
    if (existsSync(poolPath)) {
      console.log(`[skip] ${famId} pool exists`);
      continue;
    }
    const document = JSON.parse(await readFile(join(PROJECTS_ROOT, family.projectId, "paper", "parsed", "document.json"), "utf8"));
    const chunksRaw = await readFile(join(PROJECTS_ROOT, family.projectId, "paper", "parsed", "chunks.jsonl"), "utf8");
    document.chunks = chunksRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const title = document.title ?? "";
    const abstract = document.abstract ?? "";
    const selfFp = titleFp(title);
    const queriesUsed = [];
    const retrieved = [];
    const notes = [];
    const providerUse = { openalex: 0, s2: 0, crossref: 0, arxiv: 0 };

    // ---- 通道 A：论文自引（题名解析链） ----
    const extraction = extractor.extract(document);
    const isJunkTitle = (t) =>
      /^https?:|^www\.|accessed:/i.test(String(t)) || String(t).split(" ").length < 3;
    const refEntries = extraction.references
      .filter((r) => r.title !== undefined && r.title.length > 8 && !isJunkTitle(r.title) && (r.year ?? CUTOFF_YEAR) <= CUTOFF_YEAR)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || String(a.title).localeCompare(String(b.title)))
      .slice(0, MAX_REF_RESOLUTIONS);
    let resolvedRefs = 0;
    for (const ref of refEntries) {
      queriesUsed.push(`resolve:${cleanText(ref.title).slice(0, 80)}`);
      const { work, via } = await resolveTitle(ref.title, notes);
      if (work !== null) {
        resolvedRefs += 1;
        providerUse[via] += 1;
        retrieved.push({
          title: work.title,
          year: work.year,
          venue: work.venue,
          doi: work.doi,
          arxivId: work.arxivId,
          authors: work.authors,
          abstract: work.abstract,
          citedByManuscript: true,
          contentLevel: work.abstract !== undefined && work.abstract !== "" ? "abstract" : "metadata",
          source: work.provider,
        });
      } else {
        retrieved.push({
          title: cleanText(ref.title),
          year: ref.year,
          venue: ref.venue,
          doi: ref.doi,
          arxivId: ref.arxivId,
          citedByManuscript: true,
          contentLevel: "metadata",
          source: "reference-list(unresolved)",
        });
      }
    }

    // ---- 通道 B：外部检索（S2 → arXiv） ----
    // 外部检索词：题名词 top-6（比摘要 TF 词更具判别性——摘要词过泛导致 AND 检索近零）
    const terms = tfTerms(title, "");
    const q2 = `s2-search:${terms.join(" ")}`;
    queriesUsed.push(q2);
    const s2 = await s2Search(terms.join(" "), { perPage: 10 });
    if (s2.ok) {
      for (const w of s2.works) {
        retrieved.push({ ...w, citedByManuscript: false, contentLevel: w.abstract !== undefined && w.abstract !== "" ? "abstract" : "metadata", query: "s2" });
      }
      providerUse.s2 += s2.works.length;
    } else {
      notes.push(`s2-search-failed(${s2.note})`);
    }
    const q3 = `arxiv-search:${terms.join(" ")}`;
    queriesUsed.push(q3);
    const ax = await arxivSearch(terms);
    if (ax.ok) {
      for (const w of ax.works) {
        retrieved.push({ ...w, citedByManuscript: false, contentLevel: w.abstract !== undefined && w.abstract !== "" ? "abstract" : "metadata", query: "arxiv" });
      }
      providerUse.arxiv += ax.works.length;
    } else {
      notes.push(`arxiv-search-failed(${ax.note})`);
    }

    // ---- 去重 + 自排除 + 排名 + 截断 ----
    // 排名（冻结）：内容等级优先（abstract 先于 metadata——深比较需要材料），
    // 同级内自引优先（作者已认定相关）→ year desc → title asc
    retrieved.sort((a, b) => {
      const la = a.abstract !== undefined && a.abstract !== "" ? 0 : 1;
      const lb = b.abstract !== undefined && b.abstract !== "" ? 0 : 1;
      if (la !== lb) return la - lb;
      if ((b.citedByManuscript === true) !== (a.citedByManuscript === true)) return a.citedByManuscript === true ? -1 : 1;
      return (b.year ?? 0) - (a.year ?? 0) || String(a.title).localeCompare(String(b.title));
    });
    const seen = new Map();
    const candidates = [];
    let selfExcluded = 0;
    for (const c of retrieved) {
      if (c.title === undefined || c.title === "") continue;
      if (titleFp(c.title) === selfFp && selfFp !== "") {
        selfExcluded += 1;
        continue;
      }
      if ((c.year ?? CUTOFF_YEAR) > CUTOFF_YEAR) continue;
      const doiKey = c.doi !== undefined ? `doi:${c.doi}` : null;
      const normArxiv = c.arxivId !== undefined ? identity.normalizeArxivId(c.arxivId) : undefined;
      const arxivKey = normArxiv !== undefined ? `arxiv:${normArxiv}` : null;
      const fpKey = `tf:${titleFp(c.title)}|${c.year ?? ""}`;
      const keys = [doiKey, arxivKey, fpKey].filter((k) => k !== null && !k.endsWith("|"));
      if (keys.some((k) => seen.has(k))) continue;
      const candidateId = `P${String(candidates.length + 1).padStart(2, "0")}`;
      candidates.push({
        candidateId,
        title: c.title,
        year: c.year,
        venue: c.venue,
        doi: c.doi,
        arxivId: c.arxivId,
        authors: c.authors,
        abstract: c.abstract,
        citedByManuscript: c.citedByManuscript === true,
        contentLevel: c.abstract !== undefined && c.abstract !== "" ? "abstract" : "metadata",
        source: c.source ?? c.provider,
      });
      for (const k of keys) seen.set(k, candidateId);
    }
    const finalPool = candidates.slice(0, POOL_CAP);
    const pool = {
      familyId: famId,
      cutoffDate: CUTOFF_DATE,
      queriesUsed,
      candidates: finalPool,
      buildStats: {
        referenceEntriesTotal: extraction.references.length,
        referenceEntriesEligible: refEntries.length,
        refResolved: resolvedRefs,
        providerUse,
        externalRetrievedS2: s2.ok ? s2.works.length : 0,
        externalRetrievedArxiv: ax.ok ? ax.works.length : 0,
        dedupedCandidates: candidates.length,
        selfExcluded,
        poolCap: POOL_CAP,
        truncatedToCap: candidates.length > POOL_CAP,
        contentLevels: {
          abstract: finalPool.filter((c) => c.contentLevel === "abstract").length,
          metadata: finalPool.filter((c) => c.contentLevel === "metadata").length,
        },
        extractorNotes: extraction.notes.slice(0, 5),
        buildNotes: notes,
      },
    };
    await writeFile(poolPath, JSON.stringify(pool, null, 1), "utf8");
    console.log(
      `[pool] ${famId}: refs=${extraction.references.length}(resolved ${resolvedRefs}/${refEntries.length} via ${JSON.stringify(providerUse)}) ext=s2:${pool.buildStats.externalRetrievedS2}+arxiv:${pool.buildStats.externalRetrievedArxiv} pool=${finalPool.length} (abstract ${pool.buildStats.contentLevels.abstract}/metadata ${pool.buildStats.contentLevels.metadata})`,
    );
  }
  console.log("done");
  process.exit(0);
}

await main();
