#!/usr/bin/env node
/**
 * M15.10 Phase B3：盲测 held-out 候选样本采集器（零模型调用）。
 *
 * 目的：为独立专家标注包选取"与 M15.9 benchmark 严格隔离"的新鲜 CJIG 论文族
 * （paper family = DOI）。M15.9 的 CJIG 24 篇 benchmark 论文族已被
 * target-benchmark profile / rubric 开发消费——对期刊级 held-out 判别而言是
 * 污染族，本采集器从候选池中确定性排除它们（任务书 §B3 隔离红线）。
 *
 * 采样纪律（与 m159-collect-benchmark.mjs 同构，便于同口径对照）：
 *   - 候选池：复用 M15.9 已缓存的 Crossref journals/1006-8961/works 快照
 *     （不重复打 Crossref；快照 fetchedAt 记入 manifest）；
 *   - 过滤：主题命中（CV/MOT/图像图形方向，同 m159 词表）+ 期刊论文类型 +
 *     2021-2026 年份窗；
 *   - 排除：M15.9 cjig-manifest-v2.json 的全部 benchmark DOI（记录排除数）；
 *   - 分层：年份桶 × 候选池（排除后）引用三分位 × 文章类型，层内
 *     (title|doi) 字典序轮转——不按引用降序取 top（规避被引=质量偏差）；
 *   - 抓取：官网文章页 + OA PDF（CC BY-NC-ND 4.0；间隔 ≥900ms 礼貌抓取）；
 *     PDF/HTML 只落仓库外 D:\PaperTeamData\M15\M15_10\phase-b\corpus-fresh\。
 *
 * 采样概率登记：manifest.sampling 记录层→(池大小, 选中数)，排除原因逐条
 * 保留（PAGE_FAILED / NO_PDF_LINK 不顶替、不补抓）。
 *
 * CLI：
 *   --list            只枚举计划（读缓存，零网络）
 *   --dry-run         校验缓存与排除集，不写文件
 *   --max=N           目标篇数（缺省 12；5..24）
 *   --resume          复用已抓 raw/PDF（存在即跳过）
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = "D:/PaperTeamData/M15/M15_10/phase-b/corpus-fresh";
const M159_CROSSREF_CACHE = "D:/PaperTeamData/M15/M15_9/phase-b/corpus/cjig/raw/crossref-works.json";
const M159_BENCHMARK_MANIFEST = "D:/PaperTeamData/M15/M15_9/phase-b/corpus/cjig/cjig-manifest-v2.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REQUEST_GAP_MS = 900;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
const listOnly = has("--list");
const dryRun = has("--dry-run");
const target = Number(valueOf("max") ?? 12);
const resume = has("--resume");

if (!Number.isInteger(target) || target < 5 || target > 24) {
  console.error("[refuse] --max 取值 5..24");
  process.exit(2);
}
for (const required of [M159_CROSSREF_CACHE, M159_BENCHMARK_MANIFEST]) {
  if (!existsSync(required)) {
    console.error(`[refuse] 上游缓存缺失：${required}（M15.9 数据目录必须先行存在）`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function cachedFetch(cachePath, url) {
  if (resume && existsSync(cachePath)) return { buf: readFileSync(cachePath), cached: true };
  await sleep(REQUEST_GAP_MS);
  const buf = await fetchBuffer(url);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, buf);
  return { buf, cached: false };
}

// 与 m159 相同的主题词表（同口径对照；复制自 m159-collect-benchmark.mjs，冻结不变）
const TOPIC_KEYWORDS = [
  "目标跟踪", "多目标", "跟踪", "行人", "重识别", "再识别", "检测", "识别", "分割", "视觉",
  "图像", "图片", "视频", "遥感", "无人机", "深度学习", "神经网络", "特征提取", "三维重建",
  "三维视觉", "点云", "SLAM", "配准", "超分辨", "去噪", "增强现实", "虚拟现实", "场景理解",
  "语义", "实例", "注意力", "Transformer", "卷积", "生成对抗", "扩散模型", "多模态", "轨迹", "姿态估计",
];
const topicHit = (title) => TOPIC_KEYWORDS.some((k) => title.includes(k));
const documentTypeGuess = (title) =>
  /综述|进展|回顾|review|survey|现状|展望/i.test(title) ? "survey" : "research";
const yearBucket = (year) => (year <= 2022 ? "2021-2022" : year <= 2024 ? "2023-2024" : "2025-2026");

function stratifiedPick(candidates, layerOf, want) {
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
  while (picked.length < want && added) {
    added = false;
    for (const key of keys) {
      const next = layers.get(key).shift();
      if (next !== undefined) {
        picked.push({ ...next, stratum: key });
        added = true;
        if (picked.length >= want) break;
      }
    }
  }
  return { picked, layerSizes: Object.fromEntries([...layers].map(([k, v]) => [k, v.length + picked.filter((p) => p.stratum === k).length])) };
}

(async () => {
  mkdirSync(WORK_DIR, { recursive: true });
  const crossrefSnapshot = JSON.parse(readFileSync(M159_CROSSREF_CACHE, "utf8"));
  const benchmark = JSON.parse(readFileSync(M159_BENCHMARK_MANIFEST, "utf8"));
  const excludedDois = new Set(benchmark.papers.map((p) => p.doi.toLowerCase()));
  console.log(`[m1510] Crossref 快照 ${crossrefSnapshot.items.length} 条（fetchedAt ${crossrefSnapshot.fetchedAt}）`);
  console.log(`[m1510] benchmark 排除集 ${excludedDois.size} DOI`);

  const candidates = [];
  let excludedByBenchmark = 0;
  for (const it of crossrefSnapshot.items) {
    const title = (it.title ?? [])[0] ?? "";
    const year = Number((it.issued?.["date-parts"] ?? [[undefined]])[0]?.[0]);
    if (!title || !year || year < 2021 || year > 2026) continue;
    if (it.type && it.type !== "journal-article") continue;
    if (!topicHit(title)) continue;
    if (excludedDois.has(String(it.DOI).toLowerCase())) {
      excludedByBenchmark += 1;
      continue;
    }
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
  console.log(`[m1510] 隔离后候选池 ${candidates.length} 篇（排除 benchmark 族 ${excludedByBenchmark}）`);
  if (listOnly || dryRun) {
    console.log("[m1510] --list/--dry-run：到此为止（零网络、零写入）");
    return;
  }

  // 引用三分位在"排除后的新鲜池"内重算（与 benchmark 无关的独立分层基准）
  const sortedCites = candidates.map((c) => c.citationCountCrossref).sort((a, b) => a - b);
  const tercile = (v) => {
    const q1 = sortedCites[Math.floor(sortedCites.length / 3)] ?? 0;
    const q2 = sortedCites[Math.floor((sortedCites.length * 2) / 3)] ?? 0;
    return v <= q1 ? "cite-low" : v <= q2 ? "cite-mid" : "cite-high";
  };
  const { picked, layerSizes } = stratifiedPick(
    candidates,
    (c) => `${yearBucket(c.year)}|${tercile(c.citationCountCrossref)}|${c.documentTypeGuess}`,
    target,
  );
  console.log(`[m1510] 分层选中 ${picked.length} 篇；层池大小 ${JSON.stringify(layerSizes)}`);

  const rawDir = join(WORK_DIR, "raw");
  const pdfDir = join(WORK_DIR, "pdf");
  const records = [];
  for (const [index, paper] of picked.entries()) {
    const articleUrl = `http://www.cjig.cn/zh/article/doi/${paper.doi}/`;
    const pageCache = join(rawDir, `article-${paper.doi.replace(/[/.,]/g, "_")}.html`);
    let html = "";
    try {
      const { buf, cached } = await cachedFetch(pageCache, articleUrl);
      html = buf.toString("utf8");
      console.log(`[m1510]   (${index + 1}/${picked.length}) ${cached ? "缓存" : "抓取"} ${paper.doi}`);
    } catch (error) {
      records.push({ ...paper, articleUrl, pageError: String(error.message).slice(0, 200), fulltextAvailability: "PAGE_FAILED", excludedReason: "PAGE_FAILED" });
      continue;
    }
    const pdfMatch = html.match(/["']([^"']*front-article\/download\/\d+\/[^"']+\.pdf)["']/i);
    if (!pdfMatch) {
      records.push({ ...paper, articleUrl, fulltextAvailability: "NO_PDF_LINK", excludedReason: "NO_PDF_LINK" });
      continue;
    }
    let pdfUrl = pdfMatch[1];
    if (pdfUrl.startsWith("/")) pdfUrl = `https://www.cjig.cn${pdfUrl}`;
    const pdfName = `${paper.doi.replace(/[/.,]/g, "_")}.pdf`;
    try {
      const { buf, cached } = await cachedFetch(join(pdfDir, pdfName), pdfUrl);
      records.push({
        ...paper,
        articleUrl,
        columnGuess: html.match(/(?:栏目|专栏)[：:]([^<\n]{2,30})/)?.[1]?.trim() ?? null,
        pdfFile: pdfName,
        pdfBytes: buf.length,
        pdfSha256: sha256(buf),
        fulltextAvailability: "OA_OFFICIAL_SITE",
        retrievedAt: new Date().toISOString(),
      });
      console.log(`[m1510]     PDF ${(buf.length / 1024).toFixed(0)}KB${cached ? " (缓存)" : ""}`);
    } catch (error) {
      records.push({ ...paper, articleUrl, pdfError: String(error.message).slice(0, 200), fulltextAvailability: "PDF_FAILED", excludedReason: "PDF_FAILED" });
    }
  }

  const ok = records.filter((r) => r.pdfSha256);
  const manifest = {
    schemaVersion: 1,
    purpose: "M15.10 独立专家标注包 held-out 候选样本（与 M15.9 benchmark 24 族 DOI 严格隔离）",
    journal: "中国图象图形学报 (Journal of Image and Graphics)",
    issn: "1006-8961",
    isolation: {
      rule: "paper family = DOI；M15.9 cjig-manifest-v2.json 全部 24 DOI 确定性排除",
      benchmarkManifest: M159_BENCHMARK_MANIFEST,
      excludedByBenchmark,
    },
    crossrefSnapshot: { path: M159_CROSSREF_CACHE, fetchedAt: crossrefSnapshot.fetchedAt },
    sampling: {
      strategy: "yearBucket × citationTercile(排除后池内重算) × documentType 轮转分层",
      candidatePoolAfterExclusion: candidates.length,
      targetCount: target,
      layerPoolSizes: layerSizes,
    },
    fulltextBasis: ok.length,
    license: "CC BY-NC-ND 4.0（官网 OA；本任务非商业研究标注用途，副本仅存仓库外数据目录）",
    generatedAt: new Date().toISOString(),
    papers: records,
  };
  const manifestPath = join(WORK_DIR, "cjig-fresh-manifest.json");
  await mkdir(rawDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(`[m1510] manifest → ${manifestPath}（fulltext ${ok.length}/${records.length}；失败/无 PDF 不顶替）`);
})().catch((error) => {
  console.error(`[m1510] 失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
