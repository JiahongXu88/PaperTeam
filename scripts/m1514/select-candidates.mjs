#!/usr/bin/env node
/**
 * M15.14 Phase B — PeerRead ICLR 2017 候选构建（元数据-only 选择）。
 *
 * 数据源与 M15.13 相同（PeerRead iclr_2017，公开学术数据集；主源 ICLR 2025
 * OpenReview 仍被 Turnstile 挡住——不绕过）。评审原文先行隔离在
 * M15_14/sequester/；本脚本只消费"计数/长度"结构元数据 + 标题/摘要字符数，
 * 不读评审内容（沿袭 M15.11/13 选样纪律）。
 *
 * 与 M15.13 的差异：
 *   - seed=1514（全新抽样，禁止复用已开封族）
 *   - 排除集 = M15.13 已消费 17 族（dev 529 + primary 12 + reserve 4，
 *     以 paperId 硬排除——即使 M15.13 只"选中未跑"的 reserve 也视为已开封）
 *     + M15.11/12 已消费 34 族标题守卫（跨 venue 理论无重叠，仍守卫）
 *   - DEV=3 + PRIMARY(HELD-OUT)=10 + RESERVE=4
 *
 * 资格规则（结构阈值，无语义挑选）：
 *   - accepted === false（被拒框）
 *   - 非 meta 评审中 ≥600 字符的"实质评审"条数 ∈ [3,5]
 *   - 摘要非空
 *
 * 用法：node scripts/m1514/select-candidates.mjs
 *   输入：M1514_ROOT/sequester/peerread-iclr2017/reviews_raw/*.json（已隔离）
 *   输出：M1514_ROOT/phase-b/candidate-frame.json（元数据选择框）
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const SEQUESTER = join(ROOT, "sequester", "peerread-iclr2017", "reviews_raw");
const OUT = join(ROOT, "phase-b", "candidate-frame.json");

const SEED = 1514;
const TARGET = 10;
const RESERVE = 4;
const DEV = 3;
const SUBSTANTIVE_MIN_CHARS = 600;
const SUBSTANTIVE_MIN_COUNT = 3;
const SUBSTANTIVE_MAX_COUNT = 5;

/** M15.13 已消费 paperId（dev+primary+reserve 全部 17 族——reserve 虽未跑也已开封选中） */
const M1513_CONSUMED_IDS = new Set([
  "529", // dev fam-pr-01
  "695", "721", "648", "626", "781", "612", "584", "609", "736", "507", "542", "614", // primary pr-02..pr-13
  "552", "519", "508", "573", // reserve pr-14..pr-17
]);

/** M15.11/12 已消费族标题（归一化）——防跨轮泄漏守卫 */
async function consumedTitles() {
  const titles = new Set();
  const manifest = "D:\\PaperTeamData\\M15\\M15_11\\phase-b\\SAMPLE_MANIFEST.json";
  try {
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    for (const family of parsed.families ?? []) {
      titles.add(normalizeTitle(family.title ?? ""));
    }
  } catch {
    // 清单不可读时保守放行（跨 venue 年份重叠概率≈0；记录在案）
  }
  return titles;
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** 确定性 seeded shuffle（mulberry32——与 m1511/13 同族实现，跨运行可复现） */
function seededShuffle(list, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

const files = (await readdir(SEQUESTER)).filter((name) => name.endsWith(".json")).sort();
const consumed = await consumedTitles();

const frame = [];
let skippedCount = 0;
for (const name of files) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(SEQUESTER, name), "utf8"));
  } catch {
    skippedCount += 1;
    continue;
  }
  const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  const nonMeta = reviews.filter((r) => r.is_meta_review !== true && r.IS_META_REVIEW !== true);
  const lengths = nonMeta
    .map((r) => String(r.comments ?? "").length)
    .sort((a, b) => b - a);
  const substantive = lengths.filter((n) => n >= SUBSTANTIVE_MIN_CHARS).length;
  const split = String(name.split("-")[0]);
  const paperId = name.replace(/^[a-z]+-/, "").replace(/\.json$/, "");
  const record = {
    file: name,
    paperId,
    split,
    title: parsed.title ?? "",
    titleNorm: normalizeTitle(parsed.title ?? ""),
    accepted: parsed.accepted === true,
    nonMetaReviews: nonMeta.length,
    substantiveReviews: substantive,
    reviewLengths: lengths,
    abstractChars: String(parsed.abstract ?? "").length,
  };
  frame.push(record);
}

const eligible = frame.filter(
  (record) =>
    record.accepted === false &&
    record.substantiveReviews >= SUBSTANTIVE_MIN_COUNT &&
    record.substantiveReviews <= SUBSTANTIVE_MAX_COUNT &&
    record.abstractChars > 0 &&
    !M1513_CONSUMED_IDS.has(record.paperId) &&
    !consumed.has(record.titleNorm),
);
const shuffled = seededShuffle(eligible, SEED);
const chosen = shuffled.slice(0, TARGET + RESERVE + DEV);
const out = {
  generatedAt: new Date().toISOString(),
  source: "PeerRead iclr_2017 (Kang et al. 2018, github.com/allenai/peerread) — same legal backup source as M15.13 (primary ICLR-2025 OpenReview still blocked; not bypassed)",
  seed: SEED,
  selectionRule: {
    accepted: false,
    substantiveReviews: `[${SUBSTANTIVE_MIN_COUNT},${SUBSTANTIVE_MAX_COUNT}]`,
    substantiveMinChars: SUBSTANTIVE_MIN_CHARS,
    excludeM1513Consumed: [...M1513_CONSUMED_IDS].sort(),
    metadataOnly: "title/abstract-chars/counts/lengths（评审内容不进入选择输入）",
  },
  frameSize: frame.length,
  eligibleSize: eligible.length,
  skippedUnparseable: skippedCount,
  roles: {
    dev: chosen.slice(0, DEV).map((r) => r.paperId),
    primary: chosen.slice(DEV, DEV + TARGET).map((r) => r.paperId),
    reserve: chosen.slice(DEV + TARGET).map((r) => r.paperId),
  },
  candidates: chosen.map((record, index) => ({
    candidateId: `q-${String(index + 1).padStart(2, "0")}`,
    role: index < DEV ? "DEV" : index < DEV + TARGET ? "PRIMARY" : "RESERVE",
    ...record,
  })),
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 1), "utf8");
const sha = createHash("sha256").update(JSON.stringify(out)).digest("hex");
console.log(
  JSON.stringify(
    {
      frameSize: out.frameSize,
      eligible: out.eligibleSize,
      dev: out.roles.dev,
      primary: out.roles.primary,
      reserve: out.roles.reserve,
      frameFile: OUT,
      sha256: sha,
    },
    null,
    1,
  ),
);
