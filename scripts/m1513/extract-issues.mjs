#!/usr/bin/env node
/**
 * M15.13 Phase E1 — 参考问题提取（解封后运行；仅在 predictions-frozen 之后）。
 *
 * 输入差异（与 M15.11/12 的 OpenReview 结构化 replies 不同，如实登记）：
 * PeerRead reviews_raw 为自由文本 comments（无 weaknesses/questions 字段、无节头）。
 * 冻结规则：非 meta 评审 comments 全文 → 原子问题（块/句拆分，M15.12 同规则）
 * → 不可判读过滤（M15.12 四模式 + 本轮新增"中性概述句"确定性模式——PeerRead
 * 评审常以论文内容复述开头，非批评；过滤对四臂分母对称）→ Jaccard≥0.6 归并问题族。
 * 实质评审资格 = 非 meta 且 ≥600 字符（与选样口径一致）。
 *
 * 泄漏红线：必须先有 phase-e/predictions-frozen.json（12/12 族、missing=[]）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1513_ROOT ? resolve(process.env.M1513_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_13");
const SEQ_DIR = join(ROOT, "sequester", "peerread-iclr2017", "reviews_raw");
const SUBSTANTIVE_MIN_CHARS = 600;

/**
 * deviation v2（2026-10-29，arm-blind 阶段登记）：PeerRead 评审常以
 * "Summary:" 节头开篇复述论文内容——atomicUnits 的块拆分会保留整块，
 * 使中性概述句过滤的 ^ 锚失效（typing 抽查实证）。确定性修复：剥离
 * 评审开头的 summary 节（至下一个实质节头），对应 M15.11/12 只取
 * weaknesses/questions 字段的语义。规则在 typing spot-check 后、对齐
 * judge 之前修正；两次运行的统计均保留在案。
 */
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

const frozenPath = join(ROOT, "phase-e", "predictions-frozen.json");
if (!existsSync(frozenPath)) {
  throw new Error("predictions-frozen.json 不存在：必须先冻结四臂输出再解封评审（泄漏红线）");
}
const frozen = JSON.parse(await readFile(frozenPath, "utf8"));
if ((frozen.missing ?? []).length > 0) throw new Error(`predictions frozen 有缺失：${JSON.stringify(frozen.missing)}`);

const manifest = JSON.parse(await readFile(join(ROOT, "phase-c", "sample-manifest.json"), "utf8"));
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const targets = famArg
  ? manifest.families.filter((f) => f.familyId === famArg)
  : manifest.families.filter((f) => f.role === "HELD-OUT");

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
  // M15.13 新增（PeerRead 自由文本源）：中性概述句——肯定式"论文做了 X"复述，
  // 不含批评语义（否定式 does not/only/lacks 等不会被此模式命中）
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
  const raw = JSON.parse(await readFile(join(SEQ_DIR, `${fam.split}-${fam.paperId}.json`), "utf8"));
  const reviews = (raw.reviews ?? []).filter(
    (r) => r.is_meta_review !== true && r.IS_META_REVIEW !== true && String(r.comments ?? "").length >= SUBSTANTIVE_MIN_CHARS,
  ).map((r) => ({ ...r, comments: stripLeadingSummary(r.comments) }))
    // summary 节剥离后可能低于实质阈值（整篇几乎全是复述）——如实降级剔除
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
await mkdir(join(ROOT, "phase-e"), { recursive: true });
await writeFile(join(ROOT, "phase-e", "reference-issues.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
const famLevel = {};
for (const l of lines) {
  if (!l.judgeable) continue;
  const g = (famLevel[l.issueFamily] ??= { issueFamily: l.issueFamily, familyId: l.familyId, excerpts: [], members: [] });
  g.excerpts.push(l.excerpt);
  g.members.push(l.issueId);
}
await writeFile(join(ROOT, "phase-e", "issue-families.json"), JSON.stringify(Object.values(famLevel), null, 1), "utf8");
console.log(JSON.stringify({ ...stats, judgeableIssueFamilies: Object.keys(famLevel).length }, null, 1));
