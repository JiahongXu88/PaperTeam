#!/usr/bin/env node
/**
 * M15.14 Phase E1 — 参考问题提取（M15.13 extract-issues 平移 + DEV 预开阀）。
 *
 * 与 M15.13 相同规则：PeerRead 自由文本 comments → stripLeadingSummary → 块/句
 * 拆分 → 不可判读过滤（同六模式）→ Jaccard≥0.6 问题族。
 *
 * 开封纪律：HELD-OUT（role=PRIMARY）族要求 phase-e/predictions-frozen.json 存在
 * 且 missing=[]；--fam 指定 DEV 族允许在正式冻结前解封（DEV 只做机制 smoke，
 * 不进科学指标——协议预注册）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const SEQ_DIR = join(ROOT, "sequester", "peerread-iclr2017", "reviews_raw");
const SUBSTANTIVE_MIN_CHARS = 600;

const SUMMARY_HEADER = /\b(?:brief\s+)?summary\s*[:\-]?\s*\n/i;
const NEXT_SECTION = /\n\s*(?:strengths|weaknesses?|questions?|comments?|issues?|concerns?|detailed\s+comments?|flaws?)\b[^\n]*\n/i;
function stripLeadingSummary(text) {
  let out = String(text ?? "");
  for (let round = 0; round < 2; round += 1) {
    const head = out.slice(0, 400);
    const m = SUMMARY_HEADER.exec(head);
    if (m === null) break;
    const after = out.slice(m.index + m[0].length);
    const next = NEXT_SECTION.exec(after.slice(0, 4000));
    out = next !== null ? after.slice(next.index) : "";
    if (out.trim() === "") break;
  }
  return out;
}

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const candidateFrame = JSON.parse(await readFile(join(ROOT, "phase-b", "candidate-frame.json"), "utf8"));
const splitByPaperId = new Map(candidateFrame.candidates.map((c) => [c.paperId, c.split]));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const devOnly = process.argv.includes("--dev");
let targets;
if (famArg !== null) {
  targets = projectsInfo.families.filter((f) => f.familyId === famArg);
} else if (devOnly) {
  targets = projectsInfo.families.filter((f) => f.role === "DEV");
} else {
  const frozenPath = join(ROOT, "phase-e", "predictions-frozen.json");
  if (!existsSync(frozenPath)) {
    throw new Error("predictions-frozen.json 不存在：必须先冻结 HELD-OUT 三臂输出再解封评审（泄漏红线）");
  }
  const frozen = JSON.parse(await readFile(frozenPath, "utf8"));
  if ((frozen.missing ?? []).length > 0) throw new Error(`predictions frozen 有缺失：${JSON.stringify(frozen.missing)}`);
  targets = projectsInfo.families.filter((f) => f.role === "PRIMARY");
}
const unsealedDev = targets.filter((f) => f.role !== "PRIMARY");
if (unsealedDev.length > 0) {
  console.log(`[DEV_UNSEALED] ${unsealedDev.map((f) => f.familyId).join(",")} （DEV 机制 smoke，不入科学指标）`);
}

function splitBlocks(text) {
  if (!text) return [];
  const raw = String(text);
  const bullets = raw.split(/\n\s*(?:[-•*]|\d+[.)])\s+/);
  if (bullets.length > 1) return bullets.map((b) => b.trim()).filter(Boolean);
  return [raw.trim()].filter(Boolean);
}
function splitSentences(block) {
  return block.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((p) => p.trim()).filter((p) => p.length > 15);
}
function atomicUnits(text) {
  const out = [];
  for (const block of splitBlocks(text)) {
    if (block.length <= 320) out.push(block);
    else for (const s of splitSentences(block)) out.push(s);
  }
  return out.filter((u) => u.length >= 25);
}
const UNJUDGEABLE_PATTERNS = [
  /^(?:i (?:like|enjoy|appreciate)|great |nice |good |excellent|well[- ]written|interesting)/i,
  /\b(?:personally|i feel|i would (?:prefer|like))\b.*\b(?:prefer|like|style|taste)\b/i,
  /\btypo\b|\btypos\b|grammatical|spelling|formatting of (?:the )?(?:text|table|figure)|minor writing/i,
  /^\s*(?:please see|see my|refer to)\b/i,
  /^(?:this|the) (?:paper|manuscript|work|study|approach|method|article) (?:proposes|presents|introduces|describes|considers|investigates|studies|addresses|focuses|builds|extends|applies|aims|seeks|uses|adopts|provides|reports|shows how|demonstrates how|is based on|can be used)\b/i,
  /^(?:in (?:this|the) (?:paper|manuscript|work|study), )?(?:the (?:authors|paper)) (?:propose|present|introduce|describe|consider|investigate|study|address|focus|build|extend|apply|aim|use|adopt|provide|report|show how|demonstrate how)\b/i,
];
function judgeable(unit) {
  if (UNJUDGEABLE_PATTERNS.some((re) => re.test(unit))) return { ok: false, reason: "subjective_or_presentation_or_summary" };
  if (unit.length < 30) return { ok: false, reason: "too_terse" };
  return { ok: true, reason: null };
}
const normTokens = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
function jaccard(a, b) {
  const A = new Set(normTokens(a));
  const B = new Set(normTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const lines = [];
const stats = { families: 0, reviews: 0, atomicIssues: 0, judgeable: 0, unjudgeable: 0, issueFamilies: 0 };
for (const fam of targets) {
  const famId = fam.familyId;
  const raw = JSON.parse(await readFile(join(SEQ_DIR, `${splitByPaperId.get(fam.paperId) ?? "train"}-${fam.paperId}.json`), "utf8"));
  const reviews = (raw.reviews ?? []).filter(
    (r) => r.is_meta_review !== true && r.IS_META_REVIEW !== true && String(r.comments ?? "").length >= SUBSTANTIVE_MIN_CHARS,
  ).map((r) => ({ ...r, comments: stripLeadingSummary(r.comments) }))
    .filter((r) => String(r.comments ?? "").length >= Math.min(SUBSTANTIVE_MIN_CHARS, 300));
  stats.families += 1;
  stats.reviews += reviews.length;
  const famIssues = [];
  for (const [index, r] of reviews.entries()) {
    const sig = `Reviewer${index + 1}`;
    for (const unit of atomicUnits(String(r.comments ?? ""))) {
      const j = judgeable(unit);
      famIssues.push({
        familyId: famId,
        reviewNoteId: `${famId}-r${index + 1}`,
        reviewerSig: sig,
        issueId: `${famId}-${sig}-i${famIssues.length + 1}`,
        kind: "comments",
        excerpt: unit.slice(0, 400),
        judgeable: j.ok,
        unjudgeableReason: j.reason,
      });
    }
  }
  const groups = [];
  for (const iss of famIssues) {
    let best = null;
    let bestJ = 0;
    for (const g of groups) {
      const j = jaccard(iss.excerpt, g.representative);
      if (j > bestJ) { bestJ = j; best = g; }
    }
    if (best !== null && bestJ >= 0.6) {
      best.members.push(iss.issueId);
      iss.issueFamily = best.id;
    } else {
      const g = { id: `IF-${famId}-${groups.length + 1}`, representative: iss.excerpt, members: [iss.issueId] };
      groups.push(g);
      iss.issueFamily = g.id;
    }
    lines.push(iss);
  }
  stats.atomicIssues += famIssues.length;
  stats.judgeable += famIssues.filter((i) => i.judgeable).length;
  stats.unjudgeable += famIssues.filter((i) => !i.judgeable).length;
  stats.issueFamilies += groups.length;
}
// 合并模式：始终增量（保留先前已提取的其他族问题——DEV 先提取、HELD-OUT 后全量）
const outPath = join(ROOT, "phase-e", "reference-issues.jsonl");
const famLevelPath = join(ROOT, "phase-e", "issue-families.json");
let allLines = lines;
{
  const covered = new Set(lines.map((l) => l.familyId));
  if (existsSync(outPath)) {
    for (const line of (await readFile(outPath, "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const prior = JSON.parse(line);
      if (!covered.has(prior.familyId)) allLines.push(prior);
    }
  }
}
await mkdir(join(ROOT, "phase-e"), { recursive: true });
await writeFile(outPath, allLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
const famLevel = {};
for (const l of allLines) {
  if (!l.judgeable) continue;
  const g = (famLevel[l.issueFamily] ??= { issueFamily: l.issueFamily, familyId: l.familyId, excerpts: [], members: [] });
  g.excerpts.push(l.excerpt);
  g.members.push(l.issueId);
}
await writeFile(famLevelPath, JSON.stringify(Object.values(famLevel), null, 1), "utf8");
console.log(JSON.stringify({ ...stats, totalJudgeableIssueFamilies: Object.keys(famLevel).length, written: allLines.length }, null, 1));
