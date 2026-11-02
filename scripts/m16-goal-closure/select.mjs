#!/usr/bin/env node
/**
 * M16 原始目标收口 · B0：零模型冻结新留出集（PROTOCOL §1；只运行一次，输出只含计数，不打印人类意见文本）。
 *
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 GITHUB_TOKEN=$(gh auth token) node scripts/m16-goal-closure/select.mjs
 *
 * 规则：排除此前任何轮次开封 / 抽样框中的论文（M15 D2、M15.11 抽样框、M16 封存集、M16 收口 held-out），并按 arXiv 基础编号
 * 与规范化题名去重（同一论文的其他版本也排除）；MD 15k–60k 字节；正确性过滤后弱点意见 ≥ 5；SPECIFIC ≥ 3；
 * 按 sha256("m16-goal-closure|id") 升序逐篇检查，长文档模式实际调度单元数 ≤ 16（screen.mjs；成本可控的预注册条件），
 * 每层（accept / reject）取前 6 篇，共 12 篇。被 dry-run 条件跳过的候选逐条记录。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { humanWeaknesses } from "../m16-review-validity/lib.mjs";
import { classifyOpinion, loadCorpus } from "../m16-closure/specificity.mjs";
import { M15, M16, MD_DIR, PREV, ROOT, readJson, sha } from "./lib.mjs";

export const PER_STRATUM = 6;
export const MAX_DRY_UNITS = 16;
const MIN_SPECIFIC = 3;
mkdirSync(MD_DIR, { recursive: true });
mkdirSync(join(ROOT, "B"), { recursive: true });

const corpus = loadCorpus(humanWeaknesses);
const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const tree = new Map(readJson(join(M15, "coco-tree.json")).tree.filter((t) => t.type === "blob").map((t) => [t.path, t]));
const openedIds = new Set([
  ...readJson(join(M15, "D2", "selection.json")).selected.map((p) => p.id),
  ...readJson(join(M16, "B", "m1511-exclusion.json")).noteIds,
  ...readJson(join(M16, "B", "sealed-selection.json")).selected.map((p) => p.id),
  ...readJson(join(PREV, "B", "heldout-selection.json")).selected.map((p) => p.id),
]);
const arxivBase = (record) => /(\d{4}\.\d{4,5})/.exec(record.MD_path ?? "")?.[1] ?? null;
const normTitle = (record) => String(record.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const openedBases = new Set([...openedIds].map((id) => recordById.get(id)).filter(Boolean).map(arxivBase).filter(Boolean));
const openedTitles = new Set([...openedIds].map((id) => recordById.get(id)).filter(Boolean).map(normTitle).filter((t) => t !== ""));

const excluded = { opened: 0, sameArxivOrTitle: 0, size: 0, opinions: 0, specific: 0, dryUnits: 0, dryFailed: 0 };
const pool = [];
for (const r of corpus.records) {
  if (openedIds.has(r.id)) { excluded.opened += 1; continue; }
  if ((arxivBase(r) !== null && openedBases.has(arxivBase(r))) || openedTitles.has(normTitle(r))) { excluded.sameArxivOrTitle += 1; continue; }
  const blob = tree.get(r.MD_path);
  if (blob === undefined || blob.size < 15_000 || blob.size > 60_000) { excluded.size += 1; continue; }
  if (humanWeaknesses(r).length < 5) { excluded.opinions += 1; continue; }
  pool.push({ id: r.id, key: sha(`m16-goal-closure|${r.id}`), stratum: /^Accept/.test(r.decision) ? "accept" : "reject", decision: r.decision, mdPath: r.MD_path, blobSha: blob.sha, mdBytes: blob.size, arxiv: arxivBase(r) });
}
pool.sort((a, b) => a.key.localeCompare(b.key));

const mdFile = (c) => join(MD_DIR, c.mdPath.replace(/^benchmark\/MD\//, ""));
async function fetchMd(c) {
  const file = mdFile(c);
  if (!existsSync(file)) {
    const res = await fetch(`https://api.github.com/repos/hexuandeng/CoCoReviewBench/git/blobs/${c.blobSha}`, { headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "paperteam-m16-goal-closure", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (!res.ok) throw new Error(`${c.id} HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(file);
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== c.blobSha) throw new Error(`${c.id} blob sha 不符`);
  return bytes;
}

/**
 * DEVIATIONS #2：单元数取自 screen.mjs（生产同一函数计算的长文档模式实际调度单元数；对 M16 收口两次真实运行逐个吻合）。
 * 原 scripted dry-run 计数因 scripted 输出解析失败的重试与 22 次截断而虚高，已停用。
 */
const screen = new Map(readJson(join(ROOT, "B", "unit-screen.json")).rows.map((row) => [row.id, row]));
function dryUnits(c) {
  const row = screen.get(c.id);
  if (row === undefined) return { status: "missing_screen", units: null, calls: null };
  return { status: "completed", units: row.reviewableUnits, calls: row.reviewableUnits + 1 };
}

const selected = [];
const skipped = [];
for (const stratum of ["accept", "reject"]) {
  for (const c of pool.filter((p) => p.stratum === stratum)) {
    if (selected.filter((s) => s.stratum === stratum).length >= PER_STRATUM) break;
    const bytes = await fetchMd(c);
    const labels = humanWeaknesses(recordById.get(c.id)).map((o) => classifyOpinion(o.text, c.id, bytes.toString("utf8"), corpus));
    const specific = labels.filter((l) => l.label === "SPECIFIC").length;
    if (specific < MIN_SPECIFIC) { excluded.specific += 1; skipped.push({ id: c.id, stratum, reason: `SPECIFIC ${specific} < ${MIN_SPECIFIC}` }); continue; }
    const dry = dryUnits(c);
    if (dry.status !== "completed") { excluded.dryFailed += 1; skipped.push({ id: c.id, stratum, reason: `dry-run ${dry.status}` }); continue; }
    if (dry.units > MAX_DRY_UNITS) { excluded.dryUnits += 1; skipped.push({ id: c.id, stratum, reason: `dry units ${dry.units} > ${MAX_DRY_UNITS}` }); continue; }
    selected.push({ ...c, mdSha256: createHash("sha256").update(bytes).digest("hex"), humanOpinions: labels.length, specificOpinions: specific, anchoredOpinions: labels.filter((l) => l.anchor).length, dryUnits: dry.units, dryCalls: dry.calls });
    console.log(c.id, stratum, `md=${c.mdBytes}`, `opinions=${labels.length}`, `specific=${specific}`, `dryUnits=${dry.units}`, `dryCalls=${dry.calls}`);
  }
}
const out = {
  schema: "m16-goal-closure-heldout/v1", frozenAt: new Date().toISOString(),
  rule: `exclude opened (M15 D2, M15.11 frame, M16 sealed, M16 closure held-out) + same arXiv base / title; MD 15k-60k bytes; ≥5 weakness opinions; ≥${MIN_SPECIFIC} SPECIFIC; dry-run units ≤ ${MAX_DRY_UNITS}; sha256("m16-goal-closure|id") asc; ${PER_STRATUM}/stratum`,
  openedIds: openedIds.size, poolSize: pool.length, excluded, skipped, selected,
};
writeFileSync(join(ROOT, "B", "heldout-selection.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`pool=${pool.length} excluded=${JSON.stringify(excluded)} selected=${selected.length}`);
