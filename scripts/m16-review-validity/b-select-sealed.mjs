#!/usr/bin/env node
/**
 * M16 · B：封存评测集抽样（零模型；只输出元数据，不打印任何人类评审文本）。
 *
 *   node scripts/m16-review-validity/b-select-sealed.mjs select     # → B/sealed-selection.json
 *   node scripts/m16-review-validity/b-select-sealed.mjs download   # 经 GitHub git blobs API 取入选论文 MD（CC BY 4.0 仓库）
 *
 * 规则（PROTOCOL §3 冻结）：CoCoReviewBench ICLR 2025 记录，排除 M15 TJA D2 已开 12 篇与 M15.11 抽样框 34 篇；
 * MD 15,000–60,000 字节；正确性过滤后的人类弱点意见 ≥ 5 条；按 sha256("m16-sealed|" + id) 升序，
 * Accept / Reject 各取 4 篇；每层排序最前 1 篇（共 2 篇）指派给生产链路臂（完整 workflow 上限 2 次）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const M15 = "D:\\PaperTeamData\\M15\\TargetJournalAssessment";
const EXT = join(M15, "external", "cocoreviewbench-2580687");
const ROOT = "D:\\PaperTeamData\\M16\\AcademicReviewValidity";
const OUT = join(ROOT, "B");
const MD_DIR = join(ROOT, "external", "cocoreviewbench-md");
mkdirSync(OUT, { recursive: true });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const PER_STRATUM = 4;

/** 正确性过滤后的弱点意见（与 M15 D2 同一口径：conflicts / rebuttal 校验为 incorrect 的剔除） */
export function weaknessOpinions(record) {
  const weaknessIds = new Set();
  for (const thread of record.reviews) {
    for (const turn of thread) {
      if (!/^Reviewer/.test(turn.role)) continue;
      const value = turn.sentence_ids?.value;
      const parsed = typeof value === "string" ? JSON.parse(value.replace(/'/g, '"')) : value;
      for (const id of parsed?.weaknesses ?? []) weaknessIds.add(`${turn.role}|${id}`);
    }
  }
  const opinions = [];
  record.opinions.forEach((opinion, index) => {
    if (record.conflicts_validation?.[index] === "incorrect" || record.rebuttal_validation?.[index] === "incorrect") return;
    const parts = opinion.data.filter((d) => /^Reviewer/.test(d.role));
    if (!parts.some((d) => d.sentence_ids.some((id) => weaknessIds.has(`${d.role}|${id}`)))) return;
    opinions.push({ index, category: opinion.category.filter((c) => c !== "N/A"), parts: parts.map((d) => ({ role: d.role, sentenceIds: d.sentence_ids })) });
  });
  return opinions;
}

const mode = process.argv[2];
if (mode === "select") {
  const tree = readJson(join(M15, "coco-tree.json")).tree;
  const blobs = new Map(tree.filter((t) => t.type === "blob").map((t) => [t.path, t]));
  const d2 = new Set(readJson(join(M15, "D2", "selection.json")).selected.map((p) => p.id));
  const m1511 = new Set(readJson(join(OUT, "m1511-exclusion.json")).noteIds);
  const records = readFileSync(join(EXT, "benchmark_ICLR_2025.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const excluded = { d2: 0, m1511: 0, size: 0, opinions: 0 };
  const candidates = [];
  for (const r of records) {
    if (d2.has(r.id)) { excluded.d2 += 1; continue; }
    if (m1511.has(r.id)) { excluded.m1511 += 1; continue; }
    const blob = blobs.get(r.MD_path);
    if (blob === undefined || blob.size < 15_000 || blob.size > 60_000) { excluded.size += 1; continue; }
    const opinions = weaknessOpinions(r);
    if (opinions.length < 5) { excluded.opinions += 1; continue; }
    candidates.push({ id: r.id, key: sha(`m16-sealed|${r.id}`), stratum: /^Accept/.test(r.decision) ? "accept" : "reject", decision: r.decision, mdPath: r.MD_path, mdBytes: blob.size, blobSha: blob.sha, weaknessOpinions: opinions.length });
  }
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  const selected = [];
  for (const stratum of ["accept", "reject"]) {
    candidates.filter((c) => c.stratum === stratum).slice(0, PER_STRATUM).forEach((c, i) => selected.push({ ...c, productionArm: i === 0 }));
  }
  writeFileSync(join(OUT, "sealed-selection.json"), `${JSON.stringify({ frozenAt: new Date().toISOString(), records: records.length, excluded, candidates: candidates.length, selected }, null, 2)}\n`);
  console.log(`records=${records.length} excluded=${JSON.stringify(excluded)} candidates=${candidates.length}`);
  for (const s of selected) console.log(`${s.id} ${s.stratum} md=${s.mdBytes} opinions=${s.weaknessOpinions} production=${s.productionArm}`);
} else if (mode === "download") {
  const selection = readJson(join(OUT, "sealed-selection.json"));
  mkdirSync(MD_DIR, { recursive: true });
  const sums = [];
  for (const s of selection.selected) {
    const file = join(MD_DIR, s.mdPath.replace(/^benchmark\/MD\//, ""));
    if (!existsSync(file)) {
      const res = await fetch(`https://api.github.com/repos/hexuandeng/CoCoReviewBench/git/blobs/${s.blobSha}`, { headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "paperteam-m16" } });
      if (!res.ok) throw new Error(`${s.id} HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const bytes = readFileSync(file);
    // git blob sha1 校验：确保与冻结 tree 一致
    const gitSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (gitSha !== s.blobSha) throw new Error(`${s.id} blob sha 不符`);
    sums.push(`${createHash("sha256").update(bytes).digest("hex")} *${s.mdPath}`);
    console.log(`ok ${s.id} ${bytes.length}`);
  }
  writeFileSync(join(MD_DIR, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
} else {
  throw new Error("mode: select | download");
}
