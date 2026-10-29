#!/usr/bin/env node
/**
 * M15.12 Phase E1 — 参考问题提取（解封后运行；仅在 predictions-frozen 之后）。
 *
 * 沿 M15.11 提取纪律：Official_Review weaknesses/questions → 原子问题 →
 * 可判读过滤 → 跨审稿人 Jaccard≥0.6 去重为问题族。
 * 与 M15.11 的差异（预注册 §4.2/§6）：**不做 regex serious typing**——
 * serious/meta 判定由 type-issues.mjs（judge + investigator 复核）单独完成，
 * 提取与 typing 解耦，typing 先于对齐 judge 冻结。
 *
 * 泄漏红线：本脚本只读 M15_11 sequester（新 held-out 族），输出到 M15_12 phase-e/；
 * 必须在四臂输出 SHA256 冻结之后运行（driver 层校验 frozen 文件存在）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1512_ROOT ? resolve(process.env.M1512_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_12");
const M1511_ROOT = process.env.M1511_ROOT ?? "D:\\PaperTeamData\\M15\\M15_11";
const SEQ_DIR = join(M1511_ROOT, "sequester");

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
  : manifest.families.filter((f) => f.role === "HELD-OUT-NEW");

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
];
function judgeable(unit) {
  if (UNJUDGEABLE_PATTERNS.some((re) => re.test(unit))) return { ok: false, reason: "subjective_or_presentation" };
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
  const replies = JSON.parse(await readFile(join(SEQ_DIR, famId, "replies.json"), "utf8"));
  const notes = replies.notes ?? [];
  const sub = notes.find((n) => n.id === (n.forum ?? n.id));
  const all = [sub, ...((sub?.details?.replies) ?? [])].filter(Boolean);
  const reviews = all.filter((r) => (r.invitations ?? []).some((i) => i.endsWith("/-/Official_Review")));
  stats.families += 1;
  stats.reviews += reviews.length;
  const famIssues = [];
  for (const r of reviews) {
    const sig = (r.signatures?.[0] ?? "").split("/").pop() ?? "Reviewer?";
    for (const kind of ["weaknesses", "questions"]) {
      const text = r.content?.[kind]?.value ?? "";
      for (const unit of atomicUnits(text)) {
        const j = judgeable(unit);
        famIssues.push({
          familyId: famId,
          reviewNoteId: r.id,
          reviewerSig: sig,
          issueId: `${famId}-${sig}-${kind[0]}${famIssues.length + 1}`,
          kind,
          excerpt: unit.slice(0, 400),
          judgeable: j.ok,
          unjudgeableReason: j.reason,
        });
      }
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
