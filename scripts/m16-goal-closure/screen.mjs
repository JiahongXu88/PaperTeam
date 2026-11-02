#!/usr/bin/env node
/**
 * M16 原始目标收口 · B0'：零模型单元数筛查（DEVIATIONS #2）。对 select.mjs 同一排除 / 条件后的全部候选，
 * 下载 MD（校验 blob sha1）、经同一保真适配器转 LaTeX，用生产同一函数（buildReviewCoveragePlan + isHeadingOnlyUnit，
 * backend/dist）计算长文档模式下实际会调度的审查单元数。只输出计数，不读人类意见文本。
 *
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 GITHUB_TOKEN=$(gh auth token) node scripts/m16-goal-closure/screen.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { humanWeaknesses } from "../m16-review-validity/lib.mjs";
import { classifyOpinion, loadCorpus } from "../m16-closure/specificity.mjs";
import { markdownToLatexFidelity } from "../m16-closure/md-to-tex-fidelity.mjs";
import { M15, M16, MD_DIR, PREV, REPO, ROOT, readJson, sha } from "./lib.mjs";

const dist = (p) => pathToFileURL(join(REPO, "backend", "dist", p)).href;
const { buildReviewCoveragePlan, digestIsLossy, reviewSourceSpans } = await import(dist("review/coverageLedger.js"));
const { partitionSpanIntoUnits, DEFAULT_REVISION_UNIT_MAX_CHARS } = await import(dist("review/logicalSpan.js"));
const { isHeadingOnlyUnit } = await import(dist("workflow/definitions.js"));

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

const rows = [];
for (const r of corpus.records) {
  if (openedIds.has(r.id)) continue;
  if ((arxivBase(r) !== null && openedBases.has(arxivBase(r))) || openedTitles.has(normTitle(r))) continue;
  const blob = tree.get(r.MD_path);
  if (blob === undefined || blob.size < 15_000 || blob.size > 60_000) continue;
  if (humanWeaknesses(r).length < 5) continue;
  const file = join(MD_DIR, r.MD_path.replace(/^benchmark\/MD\//, ""));
  if (!existsSync(file)) {
    const res = await fetch(`https://api.github.com/repos/hexuandeng/CoCoReviewBench/git/blobs/${blob.sha}`, { headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "paperteam-m16-goal-closure", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (!res.ok) throw new Error(`${r.id} HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(file);
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob.sha) throw new Error(`${r.id} blob sha 不符`);
  const md = bytes.toString("utf8");
  const specific = humanWeaknesses(r).map((o) => classifyOpinion(o.text, r.id, md, corpus)).filter((l) => l.label === "SPECIFIC").length;
  const tex = markdownToLatexFidelity(md, "en").tex;
  const source = { file: "main.tex", content: tex };
  const plan = buildReviewCoveragePlan([source], DEFAULT_REVISION_UNIT_MAX_CHARS);
  const textById = new Map();
  for (const span of reviewSourceSpans(source)) for (const unit of partitionSpanIntoUnits(span, DEFAULT_REVISION_UNIT_MAX_CHARS).units) textById.set(`main.tex::${unit.logicalSection}`, unit.content);
  const reviewable = plan.units.filter((u) => !isHeadingOnlyUnit(textById.get(u.unitId) ?? "")).length;
  rows.push({ id: r.id, key: sha(`m16-goal-closure|${r.id}`), stratum: /^Accept/.test(r.decision) ? "accept" : "reject", mdBytes: blob.size, specific, planUnits: plan.units.length, reviewableUnits: reviewable, longDocumentMode: digestIsLossy([{ content: tex }]) });
}
rows.sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(join(ROOT, "B", "unit-screen.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), n: rows.length, rows }, null, 1)}\n`);
const hist = new Map();
for (const row of rows) hist.set(row.reviewableUnits, (hist.get(row.reviewableUnits) ?? 0) + 1);
console.log(`candidates=${rows.length}`);
console.log([...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" "));
for (const cut of [16, 18, 20, 22]) console.log(`≤${cut}: accept ${rows.filter((r) => r.reviewableUnits <= cut && r.specific >= 3 && r.stratum === "accept").length} reject ${rows.filter((r) => r.reviewableUnits <= cut && r.specific >= 3 && r.stratum === "reject").length}`);
