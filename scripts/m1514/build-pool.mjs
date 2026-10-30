#!/usr/bin/env node
/**
 * M15.14 Phase C 前置 — 逐 family 确定性构建先前工作候选 pool（零模型）。
 *
 * 通道（任务书 B2 有界检索）：
 *   A. 论文自引：ReferenceExtractor（生产确定性组件，dist 直调）解析 References 条目
 *      → 逐条 OpenAlex title.search 解析身份/摘要（≤20 条/族）；
 *   B. 数据库检索：q1 = 题名 title.search；q2 = 题名+摘要 top-8 TF 词 search
 *      （per-page 10，publication_year ≤ cutoff 年，服务端过滤）。
 *
 * 纪律：
 * - 时间因果：cutoff = 2016-10-31（ICLR 2017 投稿截止口径；年份过滤 ≤2016 保守执行）；
 * - 自排除：题名指纹等于稿件题名的候选剔除（同族/后续版本防线）；
 * - 去重：DOI > arXiv > 题名指纹（生产 sources/identity 归一器）；
 * - 排名（冻结）：自引优先（year desc → title asc），其后外部（q1 序 → q2 序 →
 *   cited_by_count desc → id asc）；深比较池 ≤12；
 * - OpenAlex 失败/限流：候选降级或剔除如实记录（缺料 → INSUFFICIENT_EVIDENCE 语义），
 *   不重试刷接口；磁盘缓存（phase-c/pools/cache/）保证可复现。
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

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { ReferenceExtractor } = await import(distUrl("paper", "ReferenceExtractor.js"));
const { rebuildAbstract } = await import(distUrl("citation", "scholarly.js"));
const identity = await import(distUrl("sources", "identity.js"));

const STOPWORDS = new Set(
  "a an the and or of for in on to with via using based we our this that these those is are be as at by from into over under new novel propose proposed method methods model models approach approaches paper study work results result experiments experiment show shows shown demonstrate demonstrates demonstrate outperform outperforms state-of-the-art sota".split(" "),
);

function tfTerms(title, abstract) {
  const counts = new Map();
  const feed = `${title} ${abstract ?? ""}`.toLowerCase();
  const tokens = feed.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);
}

const titleFp = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

let lastRequestAt = 0;
async function openalex(params) {
  const url = new URL("https://api.openalex.org/works");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (MAILTO !== "") url.searchParams.set("mailto", MAILTO);
  const cacheKey = createHash("sha256").update(url.toString()).digest("hex").slice(0, 24);
  const cachePath = join(CACHE_DIR, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8"));
  }
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": `PaperTeam-M15114-research${MAILTO !== "" ? ` (mailto:${MAILTO})` : ""}` },
    signal: AbortSignal.timeout(20_000),
  });
  const bodyText = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { parsed = { error: bodyText.slice(0, 200) }; }
  const record = { status: response.status, ok: response.ok, body: parsed };
  if (response.ok) {
    await writeFile(cachePath, JSON.stringify(record), "utf8");
  }
  return record;
}

function projectWork(item) {
  if (item === null || typeof item !== "object") return null;
  const title = typeof item["title"] === "string" ? item["title"] : undefined;
  const year = typeof item["publication_year"] === "number" ? item["publication_year"] : undefined;
  const doiRaw = typeof item["doi"] === "string" ? item["doi"] : undefined;
  const doi = doiRaw !== undefined ? identity.normalizeDoi(doiRaw) : undefined;
  const openalexId = item["ids"]?.openalex ?? undefined;
  const abstractIndex = item["abstract_inverted_index"];
  const abstract = abstractIndex != null && typeof abstractIndex === "object" ? rebuildAbstract(abstractIndex) : undefined;
  const authors = Array.isArray(item["authorships"])
    ? item["authorships"].slice(0, 3).map((a) => a?.author?.display_name ?? "").filter((s) => s !== "").join(", ")
    : undefined;
  const venue = item["primary_location"]?.source?.display_name ?? item["host_venue"]?.display_name ?? undefined;
  let arxivId;
  if (doi !== undefined) arxivId = identity.arxivIdFromDoi(doi) ?? undefined;
  return { title, year, doi, arxivId, openalexId, abstract, authors, venue, citedByCount: item["cited_by_count"] ?? 0 };
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
    const title = document.title ?? "";
    const abstract = document.abstract ?? "";
    const selfFp = titleFp(title);
    const queriesUsed = [];
    const retrieved = [];
    const notes = [];

    // ---- 通道 A：论文自引 ----
    const extraction = extractor.extract(document);
    const refEntries = extraction.references
      .filter((r) => r.title !== undefined && r.title.length > 8)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || String(a.title).localeCompare(String(b.title)))
      .slice(0, MAX_REF_RESOLUTIONS);
    let resolvedRefs = 0;
    for (const ref of refEntries) {
      const q = `title.search:${ref.title}`;
      queriesUsed.push(q);
      const response = await openalex({
        filter: `title.search:${ref.title},publication_year:<=${CUTOFF_YEAR}`,
        "per-page": 3,
        select: "id,doi,title,publication_year,cited_by_count,authorships,primary_location,host_venue,abstract_inverted_index,ids",
      });
      if (!response.ok) {
        notes.push(`ref-resolve-failed:${ref.title.slice(0, 60)} status=${response.status}`);
        // OpenAlex 解析失败：保留 metadata 级自引候选（title/year 来自参考文献解析）
        if (ref.year !== undefined && ref.year <= CUTOFF_YEAR && titleFp(ref.title) !== selfFp) {
          retrieved.push({
            title: ref.title,
            year: ref.year,
            venue: ref.venue,
            doi: ref.doi,
            arxivId: ref.arxivId,
            citedByManuscript: true,
            contentLevel: "metadata",
            source: "reference-list(unresolved)",
          });
        }
        continue;
      }
      const items = response.body?.results ?? [];
      const match = items.find((item) => {
        const w = projectWork(item);
        return w?.title !== undefined && (titleFp(w.title) === titleFp(ref.title) || titleFp(w.title).includes(titleFp(ref.title)) || titleFp(ref.title).includes(titleFp(w.title)));
      });
      if (match !== undefined) {
        const w = projectWork(match);
        if (w?.title !== undefined && (w.year ?? 0) <= CUTOFF_YEAR) {
          resolvedRefs += 1;
          retrieved.push({
            title: w.title,
            year: w.year,
            venue: w.venue,
            doi: w.doi,
            arxivId: w.arxivId,
            authors: w.authors,
            abstract: w.abstract,
            citedByManuscript: true,
            contentLevel: w.abstract !== undefined && w.abstract !== "" ? "abstract" : "metadata",
            source: `openalex:${w.openalexId ?? "?"}`,
          });
        }
      } else if (ref.year !== undefined && ref.year <= CUTOFF_YEAR && titleFp(ref.title) !== selfFp) {
        retrieved.push({
          title: ref.title,
          year: ref.year,
          venue: ref.venue,
          doi: ref.doi,
          arxivId: ref.arxivId,
          citedByManuscript: true,
          contentLevel: "metadata",
          source: "reference-list(unmatched)",
        });
      }
    }

    // ---- 通道 B：题名 + TF 检索 ----
    const q1 = `title.search:${title}`;
    queriesUsed.push(q1);
    const r1 = await openalex({
      filter: `title.search:${title},publication_year:<=${CUTOFF_YEAR}`,
      "per-page": 10,
      select: "id,doi,title,publication_year,cited_by_count,authorships,primary_location,host_venue,abstract_inverted_index,ids",
    });
    if (r1.ok) {
      for (const item of r1.body?.results ?? []) {
        const w = projectWork(item);
        if (w?.title !== undefined) retrieved.push({ ...w, citedByManuscript: false, contentLevel: w.abstract !== undefined && w.abstract !== "" ? "abstract" : "metadata", source: `openalex:${w.openalexId ?? "?"}`, query: "q1" });
      }
    } else {
      notes.push(`q1-failed status=${r1.status}`);
    }

    const terms = tfTerms(title, abstract);
    const q2 = `search:${terms.join(" ")}`;
    queriesUsed.push(q2);
    const r2 = await openalex({
      search: terms.join(" "),
      filter: `publication_year:<=${CUTOFF_YEAR}`,
      "per-page": 10,
      select: "id,doi,title,publication_year,cited_by_count,authorships,primary_location,host_venue,abstract_inverted_index,ids",
    });
    if (r2.ok) {
      for (const item of r2.body?.results ?? []) {
        const w = projectWork(item);
        if (w?.title !== undefined) retrieved.push({ ...w, citedByManuscript: false, contentLevel: w.abstract !== undefined && w.abstract !== "" ? "abstract" : "metadata", source: `openalex:${w.openalexId ?? "?"}`, query: "q2" });
      }
    } else {
      notes.push(`q2-failed status=${r2.status}`);
    }

    // ---- 去重 + 自排除 + 排名 + 截断 ----
    const seen = new Map(); // identityKey → candidate
    const candidates = [];
    let selfExcluded = 0;
    const orderKey = (c) => (c.citedByManuscript ? 0 : 1);
    // 排名：自引优先（已按 year desc 入列）；外部按 q1→q2 入列顺序（OpenAlex 相关性序）
    for (const c of retrieved) {
      if (titleFp(c.title) === selfFp && titleFp(c.title) !== "") {
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
      const entry = {
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
        source: c.source,
      };
      candidates.push(entry);
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
        referenceEntriesWithTitle: extraction.references.filter((r) => r.title !== undefined && r.title.length > 8).length,
        refResolutionsAttempted: refEntries.length,
        refResolvedOnOpenAlex: resolvedRefs,
        externalRetrievedQ1: r1.ok ? (r1.body?.results ?? []).length : 0,
        externalRetrievedQ2: r2.ok ? (r2.body?.results ?? []).length : 0,
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
      `[pool] ${famId}: refs=${extraction.references.length}(resolved ${resolvedRefs}/${refEntries.length}) ext=${pool.buildStats.externalRetrievedQ1}+${pool.buildStats.externalRetrievedQ2} pool=${finalPool.length} (abstract ${pool.buildStats.contentLevels.abstract}/metadata ${pool.buildStats.contentLevels.metadata})`,
    );
  }
  console.log("done");
  process.exit(0);
}

await main();
