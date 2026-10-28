#!/usr/bin/env node
/**
 * M15.9 Phase B：目标期刊 benchmark 语料采集器（零模型调用）。
 *
 * 采集两本真实中文期刊的参照语料（分层采样，规避 selection.ts 的 top-cited 偏差）：
 *   - CJIG《中国图象图形学报》：Crossref journals/1006-8961/works 元数据（2021-2026）
 *     + 官网 OA 全文 PDF（CC BY-NC-ND 4.0，官网免费下载通道）；
 *   - CEA《计算机工程与应用》：官网过刊 volumn 页 → DOI 文章页元数据
 *     （全文需登录——CEA 仅元数据级语料，如实记录 fulltextAvailability=false）。
 *
 * 采样纪律（任务书 §3.3）：
 *   - 分层：年份桶（2021-2022 / 2023-2024 / 2025-2026 或 2024/2025/2026）× 引用层次
 *     （CJIG 用 Crossref is-referenced-by-count 三分位；CEA 无引用数 → 年份×栏目分层）
 *     —— 不按引用数降序取 top（规避"被引多=质量好"选择偏差）；
 *   - 主题过滤：标题关键词（CV/MOT/图像图形方向）；文章类型一致性：研究论文与综述
 *     分开记录 documentTypeGuess（标题含"综述/进展/Review/Survey"→survey，否则 research）；
 *   - 去重：DOI 唯一；family=DOI（期刊论文单版本）。
 *
 * 复现纪律：--list / --dry-run 只读；--resume 按 raw 文件存在性跳过重抓（SHA 不变即复用）；
 * 官网请求间隔 ≥900ms（礼貌抓取）；Crossref 走 polite pool（mailto）。产物只落仓库外
 * D:\PaperTeamData\M15\M15_9\phase-b\corpus\（PDF 受版权限制不入公开 Git）。
 *
 * CLI：
 *   --list              只枚举计划（零网络）
 *   --dry-run           校验参数与已缓存状态（零网络、不写新文件）
 *   --journal=cjig|cea|all   采集哪本刊（缺省 all）
 *   --max=N             每刊目标篇数（缺省 24；实际按候选池钳制，不人为补齐）
 *   --resume            复用已抓 raw/PDF（文件存在 + SHA 记录一致即跳过）
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = "D:/PaperTeamData/M15/M15_9/phase-b/corpus";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const POLITE_MAILTO = "paperteam-research@example.org"; // Crossref polite pool 标识（非真实邮箱——Crossref 仅用于配额池划分）
const REQUEST_GAP_MS = 900;

// ---- CLI ----
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
const listOnly = has("--list");
const dryRun = has("--dry-run");
const journalFilter = valueOf("journal") ?? "all";
const maxPerJournal = Number(valueOf("max") ?? 24);
const resume = has("--resume");

if (!["cjig", "cea", "all"].includes(journalFilter)) {
  console.error("[refuse] --journal 只接受 cjig|cea|all");
  process.exit(2);
}
if (!Number.isInteger(maxPerJournal) || maxPerJournal < 5 || maxPerJournal > 60) {
  console.error("[refuse] --max 取值 5..60");
  process.exit(2);
}

// ---- 公共工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchBuffer(url, { asBuffer = false } = {}) {
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return asBuffer ? buf : buf;
}

async function cachedFetch(cachePath, url, { binary = false } = {}) {
  // resume 语义：文件存在即复用（采集快照冻结）；否则抓取 + 落盘
  if (resume && existsSync(cachePath)) {
    return { buf: readFileSync(cachePath), cached: true };
  }
  await sleep(REQUEST_GAP_MS);
  const buf = await fetchBuffer(url);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, buf);
  return { buf, cached: false };
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
}

// 主题过滤（标题命中任一即保留；覆盖 CV/MOT/图像图形方向，宽口径——分层在后面做）
const TOPIC_KEYWORDS = [
  "目标跟踪", "多目标", "跟踪", "行人", "重识别", "再识别", "检测", "识别", "分割", "视觉",
  "图像", "图片", "视频", "遥感", "无人机", "深度学习", "神经网络", "特征提取", "三维重建",
  "三维视觉", "点云", "SLAM", "配准", "超分辨", "去噪", "增强现实", "虚拟现实", "场景理解",
  "语义", "实例", "注意力", "Transformer", "卷积", "生成对抗", "扩散模型", "多模态", "轨迹", "姿态估计",
];

function topicHit(title) {
  return TOPIC_KEYWORDS.some((k) => title.includes(k));
}

function documentTypeGuess(title) {
  return /综述|进展|回顾|review|survey|现状|展望/i.test(title) ? "survey" : "research";
}

// 确定性分层选择：候选 → 层（yearBucket × 引用桶/栏目）→ 层内按 (title, doi) 字典序轮转取
function stratifiedPick(candidates, layerOf, target) {
  const layers = new Map();
  for (const c of candidates) {
    const key = layerOf(c);
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push(c);
  }
  for (const bucket of layers.values()) {
    bucket.sort((a, b) => `${a.title}|${a.doi}`.localeCompare(`${b.title}|${b.doi}`));
  }
  const keys = [...layers.keys()].sort();
  const picked = [];
  let added = true;
  while (picked.length < target && added) {
    added = false;
    for (const key of keys) {
      const bucket = layers.get(key);
      const next = bucket.shift();
      if (next !== undefined) {
        picked.push({ ...next, stratum: key });
        added = true;
        if (picked.length >= target) break;
      }
    }
  }
  return picked;
}

function yearBucketCjig(year) {
  if (year <= 2022) return "2021-2022";
  if (year <= 2024) return "2023-2024";
  return "2025-2026";
}

// ---- CJIG ----

async function collectCjig() {
  const dir = join(WORK_DIR, "cjig");
  const rawDir = join(dir, "raw");
  const pdfDir = join(dir, "pdf");
  const metaPath = join(rawDir, "crossref-works.json");

  console.log("[cjig] 1/3 Crossref 元数据（journals/1006-8961/works，2021-2026）…");
  let items = [];
  if (resume && existsSync(metaPath)) {
    items = JSON.parse(readFileSync(metaPath, "utf8")).items;
    console.log(`[cjig]   复用缓存 ${items.length} 条`);
  } else {
    let cursor = "*";
    for (let page = 0; page < 4; page += 1) {
      const url =
        `https://api.crossref.org/journals/1006-8961/works?filter=from-pub-date:2021-01-01,until-pub-date:2026-12-31` +
        `&rows=1000&cursor=${encodeURIComponent(cursor)}&select=DOI,title,author,issued,volume,issue,is-referenced-by-count,type` +
        `&mailto=${encodeURIComponent(POLITE_MAILTO)}`;
      await sleep(REQUEST_GAP_MS);
      const body = JSON.parse((await fetchBuffer(url)).toString("utf8"));
      const batch = body.message.items ?? [];
      items.push(...batch);
      console.log(`[cjig]   page ${page + 1}: +${batch.length}（累计 ${items.length}/${body.message["total-results"]}）`);
      cursor = body.message["next-cursor"];
      if (!cursor || batch.length === 0) break;
    }
    await mkdir(rawDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ fetchedFrom: "api.crossref.org/journals/1006-8961/works", fetchedAt: new Date().toISOString(), items }, null, 1));
  }

  // 候选：标题主题命中 + 中文题名（jig DOI 的 title 为中文）
  const candidates = [];
  for (const it of items) {
    const title = (it.title ?? [])[0] ?? "";
    const year = Number((it.issued?.["date-parts"] ?? [[undefined]])[0]?.[0]);
    if (!title || !year || year < 2021 || year > 2026) continue;
    if (it.type && it.type !== "journal-article") continue;
    if (!topicHit(title)) continue;
    candidates.push({
      doi: it.DOI,
      title,
      year,
      volume: it.volume ?? null,
      issue: it.issue ?? null,
      citationCountCrossref: it["is-referenced-by-count"] ?? 0,
      documentTypeGuess: documentTypeGuess(title),
    });
  }
  console.log(`[cjig] 主题命中候选 ${candidates.length} 篇`);

  // 引用三分位（在候选池内计算——避免 top-cited 偏差：层间轮转而不是引用降序）
  const sortedCites = candidates.map((c) => c.citationCountCrossref).sort((a, b) => a - b);
  const tercile = (v) => {
    const q1 = sortedCites[Math.floor(sortedCites.length / 3)] ?? 0;
    const q2 = sortedCites[Math.floor((sortedCites.length * 2) / 3)] ?? 0;
    return v <= q1 ? "cite-low" : v <= q2 ? "cite-mid" : "cite-high";
  };
  const picked = stratifiedPick(
    candidates,
    (c) => `${yearBucketCjig(c.year)}|${tercile(c.citationCountCrossref)}|${c.documentTypeGuess}`,
    maxPerJournal,
  );
  console.log(`[cjig] 分层选中 ${picked.length} 篇（层：年份桶 × 引用三分位 × 文章类型）`);

  console.log("[cjig] 2/3 官网文章页 + 3/3 OA PDF 下载…");
  const records = [];
  for (const [index, paper] of picked.entries()) {
    const articleUrl = `http://www.cjig.cn/zh/article/doi/${paper.doi}/`;
    const pageCache = join(rawDir, `article-${paper.doi.replace(/[/.,]/g, "_")}.html`);
    let html = "";
    try {
      const { buf, cached } = await cachedFetch(pageCache, articleUrl);
      html = buf.toString("utf8");
      console.log(`[cjig]   (${index + 1}/${picked.length}) ${cached ? "缓存" : "抓取"} ${paper.doi}`);
    } catch (error) {
      records.push({ ...paper, articleUrl, pageError: String(error.message).slice(0, 200), fulltextAvailability: "PAGE_FAILED" });
      continue;
    }
    // PDF 链接（/rc-pub/front/front-article/download/<id>/lowqualitypdf/<name>.pdf）
    const pdfMatch = html.match(/["']([^"']*front-article\/download\/\d+\/[^"']+\.pdf)["']/i);
    let pdf = null;
    let pdfSha = null;
    let pdfBytes = null;
    if (pdfMatch) {
      let pdfUrl = pdfMatch[1];
      if (pdfUrl.startsWith("/")) pdfUrl = `https://www.cjig.cn${pdfUrl}`;
      const pdfName = `${paper.doi.replace(/[/.,]/g, "_")}.pdf`;
      const pdfCache = join(pdfDir, pdfName);
      try {
        const { buf, cached } = await cachedFetch(pdfCache, pdfUrl, { binary: true });
        pdfBytes = buf.length;
        pdfSha = sha256(buf);
        pdf = pdfName;
        if (!cached) console.log(`[cjig]     PDF ${(pdfBytes / 1024).toFixed(0)}KB ${cached ? "(缓存)" : ""}`);
      } catch (error) {
        records.push({ ...paper, articleUrl, pdfError: String(error.message).slice(0, 200) });
        continue;
      }
    }
    records.push({
      ...paper,
      articleUrl,
      columnGuess: html.match(/(?:栏目|专栏)[：:]([^<\n]{2,30})/)?.[1]?.trim() ?? null,
      pdfFile: pdf,
      pdfBytes,
      pdfSha256: pdfSha,
      fulltextAvailability: pdfSha !== null ? "OA_OFFICIAL_SITE" : "NO_PDF_LINK",
      retrievedAt: new Date().toISOString(),
    });
  }

  const manifest = {
    journal: "中国图象图形学报 (Journal of Image and Graphics)",
    issn: "1006-8961",
    openalexSourceId: "S2764372918",
    crossrefSource: "api.crossref.org/journals/1006-8961/works (2021-2026)",
    sampling: { strategy: "yearBucket × citationTercile × documentType 轮转分层", topicKeywords: TOPIC_KEYWORDS.length, targetCount: maxPerJournal, candidatePool: candidates.length },
    fulltextBasis: records.filter((r) => r.pdfSha256).length,
    license: "CC BY-NC-ND 4.0（官网开放获取声明 raw/../cjig_oa.html）",
    generatedAt: new Date().toISOString(),
    papers: records,
  };
  const manifestPath = join(dir, "cjig-manifest.json");
  if (!dryRun && !listOnly) {
    await mkdir(dir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
    console.log(`[cjig] manifest → ${manifestPath}（fulltext ${manifest.fulltextBasis}/${records.length}）`);
  }
  return manifest;
}

// ---- CEA ----

// volumn id ↔ 年/期 映射（从 showOldVolumn.do 实测推导：3326=2026 I20、3300=2025 I18 → 线性递增）
const CEA_VOLUMN_BASE = { 2026: { first: 3307, issues: 20 }, 2025: { first: 3283, issues: 24 }, 2024: { first: 3259, issues: 24 } };

async function collectCea() {
  const dir = join(WORK_DIR, "cea");
  const rawDir = join(dir, "raw");
  // 分层：3 年 × 每年 2 期（期号取年中段，避开专刊首期偏差）
  const issues = [];
  for (const [year, spec] of Object.entries(CEA_VOLUMN_BASE)) {
    for (const frac of [0.25, 0.7]) {
      const no = Math.max(1, Math.min(spec.issues, Math.round(spec.issues * frac)));
      issues.push({ year: Number(year), no, volumnId: spec.first + no - 1 });
    }
  }
  console.log(`[cea] 计划期：${issues.map((i) => `${i.year}No.${i.no}(v${i.volumnId})`).join("、")}`);

  const candidates = [];
  for (const issue of issues) {
    const issueUrl = `http://cea.ceaj.org/CN/volumn/volumn_${issue.volumnId}.shtml`;
    const cache = join(rawDir, `volumn_${issue.volumnId}.shtml`);
    let html;
    try {
      const { buf, cached } = await cachedFetch(cache, issueUrl);
      html = buf.toString("utf8");
      console.log(`[cea]   ${issue.year} No.${issue.no} ${cached ? "缓存" : "抓取"}`);
    } catch (error) {
      console.error(`[cea]   期页失败 ${issueUrl}: ${error.message}`);
      continue;
    }
    // 期页文章：DOI 链接 + 同 <a> 标题（zh）
    const seen = new Set();
    for (const m of html.matchAll(/<a[^>]+href=["'][^"']*?10\.3778\/(j\.issn\.1002-8331\.[\d-]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/g)) {
      const doi = `10.3778/${m[1]}`;
      if (seen.has(doi)) continue;
      seen.add(doi);
      const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!title || title.length < 6) continue;
      if (!topicHit(title)) continue;
      candidates.push({ doi, title, year: issue.year, issueNo: issue.no, volumnId: issue.volumnId });
    }
  }
  console.log(`[cea] 主题命中候选 ${candidates.length} 篇`);

  const picked = stratifiedPick(candidates, (c) => `${c.year}|${documentTypeGuess(c.title)}`, maxPerJournal);
  console.log(`[cea] 分层选中 ${picked.length} 篇（层：年份 × 文章类型）`);

  const records = [];
  for (const [index, paper] of picked.entries()) {
    const articleUrl = `http://cea.ceaj.org/CN/${paper.doi}`;
    const cache = join(rawDir, `article-${paper.doi.replace(/[/.,]/g, "_")}.html`);
    let html;
    try {
      const { buf, cached } = await cachedFetch(cache, articleUrl);
      html = buf.toString("utf8");
      console.log(`[cea]   (${index + 1}/${picked.length}) ${cached ? "缓存" : "抓取"} ${paper.title.slice(0, 30)}…`);
    } catch (error) {
      records.push({ ...paper, articleUrl, pageError: String(error.message).slice(0, 200) });
      continue;
    }
    const text = stripTags(html);
    const abstractZh = text.match(/摘要：\n?([\s\S]{40,1200}?)\n关键词/)?.[1]?.replace(/\n/g, "") ?? null;
    const keywords = text.match(/关键词:\n?([\s\S]{2,200}?)\nAbstract/)?.[1]?.split(/[，,；;]\s*/).map((s) => s.trim()).filter(Boolean) ?? null;
    const column = html.match(/•\s*([^•\n<]{2,20})\s*•/)?.[1]?.trim() ?? null;
    const fund = text.match(/基金资助:\n?([\s\S]{2,300}?)\n(?:Review|[A-Z])/)?.[1]?.replace(/\n/g, " ") ?? null;
    records.push({
      ...paper,
      articleUrl,
      column,
      abstractZh: abstractZh ? abstractZh.slice(0, 1200) : null,
      keywords,
      fund: fund ? fund.slice(0, 300) : null,
      citationCount: null, // 官网静态页无被引数；Crossref 无此前缀；OpenAlex 稀疏——如实 NOT_AVAILABLE
      fulltextAvailability: "LOGIN_REQUIRED（官网 PDF 下载经 user/login.do——元数据级语料）",
      retrievedAt: new Date().toISOString(),
    });
  }

  const manifest = {
    journal: "计算机工程与应用 (Computer Engineering and Applications)",
    issn: "1002-8331",
    openalexSourceId: "S4306515068",
    crossrefSource: "NOT_AVAILABLE（prefixes/10.3778 = Resource not found，DOI 走 ISTIC/ChinaDOI）",
    sampling: { strategy: "year(2024/2025/2026 × 各 2 期) × documentType 轮转分层；期号取年中段", topicKeywords: TOPIC_KEYWORDS.length, targetCount: maxPerJournal, candidatePool: candidates.length, volumnMapping: CEA_VOLUMN_BASE },
    fulltextBasis: 0,
    honestLimit: "CEA 官网全文需登录（CNKI 系付费）——本语料仅元数据/摘要级；结构分位带（正文词数/图表数等）对该刊 NOT_EVALUATED",
    generatedAt: new Date().toISOString(),
    papers: records,
  };
  const manifestPath = join(dir, "cea-manifest.json");
  if (!dryRun && !listOnly) {
    await mkdir(dir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
    console.log(`[cea] manifest → ${manifestPath}（元数据级 ${records.length} 篇）`);
  }
  return manifest;
}

// ---- 主流程 ----
(async () => {
  mkdirSync(WORK_DIR, { recursive: true });
  console.log(`[m159-collect] journal=${journalFilter} max=${maxPerJournal} resume=${resume} mode=${listOnly ? "list" : dryRun ? "dry-run" : "collect"}`);
  console.log(`[m159-collect] 提醒：PDF/HTML 快照只落 ${WORK_DIR}（仓库外；CJIG CC BY-NC-ND 不入公开 Git）`);
  if (listOnly) {
    console.log("[m159-collect] --list：计划如上（各函数内部日志）；真实枚举需 --dry-run（读缓存）或直接采集");
    return;
  }
  if (journalFilter === "cjig" || journalFilter === "all") await collectCjig();
  if (journalFilter === "cea" || journalFilter === "all") await collectCea();
  console.log("[m159-collect] 完成（零模型调用）");
})().catch((error) => {
  console.error(`[m159-collect] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
