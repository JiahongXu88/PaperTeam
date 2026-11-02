#!/usr/bin/env node
/**
 * M16 后续 · 零模型冻结新留出集（PROTOCOL §1；只运行一次；输出只含计数，不打印人类意见文本）。
 *
 * 候选池 = 上一轮 B0' 零模型筛查表（OriginalQualityGateGoalClosure\B\unit-screen.json：已排除此前任何轮次开封 / 抽样框论文及其
 * 同 arXiv 编号 / 同题名版本，MD 15k–60k 字节，弱点意见 ≥ 5）中 SPECIFIC ≥ 3 且未被上一轮选中的论文。这些论文此前只被
 * 计数（单元数 / SPECIFIC 数），从未生成任何模型输出、从未进入裁判，也未用于本轮开发。
 * 顺序：sha256("m16-verified-findings|id") 升序；逐篇用 md-to-tex v2 + 生产同一函数重算长文档实际单元数（≤ 16 才入选），
 * 每层（accept / reject）取前 6 篇。MD 从上一轮本地副本复制并按 blob sha1 校验。
 *
 *   node scripts/m16-verified-findings/select.mjs
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { humanWeaknesses } from "../m16-review-validity/lib.mjs";
import { loadCorpus } from "../m16-closure/specificity.mjs";
import { markdownToLatexFidelity } from "./md-to-tex-v2.mjs";
import { M15, MD_DIR, PREV, REPO, ROOT, readJson, sha } from "./lib.mjs";

const PER_STRATUM = 6;
const MAX_UNITS = 16;
const dist = (p) => pathToFileURL(join(REPO, "backend", "dist", p)).href;
const { buildReviewCoveragePlan, reviewSourceSpans } = await import(dist("review/coverageLedger.js"));
const { partitionSpanIntoUnits, DEFAULT_REVISION_UNIT_MAX_CHARS } = await import(dist("review/logicalSpan.js"));
const { isHeadingOnlyUnit } = await import(dist("workflow/definitions.js"));

const out = join(ROOT, "B", "heldout-selection.json");
if (existsSync(out)) throw new Error("选篇已冻结（只运行一次）");
mkdirSync(MD_DIR, { recursive: true });
mkdirSync(join(ROOT, "B"), { recursive: true });

const corpus = loadCorpus(humanWeaknesses);
const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const tree = new Map(readJson(join(M15, "coco-tree.json")).tree.filter((t) => t.type === "blob").map((t) => [t.path, t]));
const prevSelected = new Set(readJson(join(PREV, "B", "heldout-selection.json")).selected.map((p) => p.id));
const prevOpened = new Set(readJson(join(PREV, "B", "heldout-selection.json")).openedIds ?? []);
const screen = readJson(join(PREV, "B", "unit-screen.json")).rows;
const pool = screen
  .filter((row) => row.specific >= 3 && !prevSelected.has(row.id) && !prevOpened.has(row.id))
  .map((row) => ({ ...row, key: sha(`m16-verified-findings|${row.id}`) }))
  .sort((a, b) => a.key.localeCompare(b.key));

const selected = [];
const skipped = [];
for (const row of pool) {
  if (selected.filter((p) => p.stratum === row.stratum).length >= PER_STRATUM) continue;
  const record = recordById.get(row.id);
  const rel = record.MD_path.replace(/^benchmark\/MD\//, "");
  const blob = tree.get(record.MD_path);
  const target = join(MD_DIR, rel);
  if (!existsSync(target)) copyFileSync(join(PREV, "external", "cocoreviewbench-md", rel), target);
  const bytes = readFileSync(target);
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob.sha) throw new Error(`${row.id} blob sha 不符`);
  const { tex, report } = markdownToLatexFidelity(bytes.toString("utf8"), "en");
  const source = { file: "main.tex", content: tex };
  const plan = buildReviewCoveragePlan([source], DEFAULT_REVISION_UNIT_MAX_CHARS);
  const textById = new Map();
  for (const span of reviewSourceSpans(source)) for (const unit of partitionSpanIntoUnits(span, DEFAULT_REVISION_UNIT_MAX_CHARS).units) textById.set(`main.tex::${unit.logicalSection}`, unit.content);
  const units = plan.units.filter((u) => !isHeadingOnlyUnit(textById.get(u.unitId) ?? "")).length;
  if (units > MAX_UNITS) { skipped.push({ id: row.id, stratum: row.stratum, units }); continue; }
  selected.push({ id: row.id, key: row.key, stratum: row.stratum, mdPath: record.MD_path, blobSha: blob.sha, mdBytes: bytes.length, units, specific: row.specific, texSha256: sha(tex), v2Notes: report.notes });
}
writeFileSync(out, `${JSON.stringify({ schema: "m16-verified-findings-selection/v1", frozenAt: new Date().toISOString(), rule: "PROTOCOL §1", poolSize: pool.length, openedIds: [...prevSelected, ...prevOpened], skipped, selected }, null, 1)}\n`);
console.log(`pool=${pool.length} selected=${selected.length} (accept ${selected.filter((p) => p.stratum === "accept").length} / reject ${selected.filter((p) => p.stratum === "reject").length}) skipped=${skipped.length}`);
console.log(selected.map((p) => `${p.id}(${p.stratum[0]},${p.units}u,captions=${p.v2Notes.TABLE_CAPTIONS_ATTACHED ? "y" : "n"})`).join(" "));
