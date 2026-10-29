#!/usr/bin/env node
/**
 * M15.11 Phase D1 — reference atomic-issue extraction (post-freeze only).
 *
 * Parses sequestered Official_Reviews for the HELD-OUT families into atomic
 * review issues. MUST be run only after C0/C1 prediction hashes are frozen.
 *
 * Output: phase-d/reference-issues.jsonl — one line per atomic issue:
 *   { familyId, reviewNoteId, reviewerSig(anonymized role), issueId, excerpt(<=60 words),
 *     kind: weaknesses|questions|summary, serious: boolean, seriousType, judgeable: boolean,
 *     unjudgeableReason?, issueFamily: <dedup group id> }
 *
 * Judgeability typing (deterministic-ish, investigator-assisted): issues that state a
 * concrete checkable concern are JUDGEABLE; pure taste/preference/no-locatable-content
 * or explicitly confidence-limited remarks are SUBJECTIVE_OR_UNJUDGEABLE.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const SEQ_DIR = join(ROOT, "sequester");
const OUT = join(ROOT, process.argv.includes("--fam") ? "phase-d" : "phase-d", process.argv.includes("--fam") ? `reference-issues-${famArg2()}.jsonl` : "reference-issues.jsonl");
function famArg2() { return process.argv[process.argv.indexOf("--fam") + 1]; }

const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const heldOut = manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId);
const famArg = process.argv.includes("--fam") ? process.argv[process.argv.indexOf("--fam") + 1] : null;
const runFirst12 = famArg ? [famArg] : heldOut.slice(0, 12).map((f) => f.familyId);

// --- extraction ---
// Atomic issues = individual bullet/sentence-level concerns from weaknesses & questions.
// Splitting: sentences are too fine; bullets ("- ", "1.", newline-separated) first,
// then long paragraphs split on sentence boundaries when >2 sentences.
function splitBlocks(text) {
  if (!text) return [];
  const raw = String(text);
  const bullets = raw.split(/\n\s*(?:[-•*]|\d+[.)])\s+/);
  if (bullets.length > 1) return bullets.map((b) => b.trim()).filter(Boolean);
  return [raw.trim()].filter(Boolean);
}
function splitSentences(block) {
  const parts = block.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 15);
}
function atomicUnits(text) {
  const out = [];
  for (const block of splitBlocks(text)) {
    if (block.length <= 320) {
      out.push(block);
    } else {
      for (const s of splitSentences(block)) out.push(s);
    }
  }
  return out.filter((u) => u.length >= 25);
}

// deterministic seriousness typing by surface cues (final typing reviewed by investigator)
const SERIOUS_PATTERNS = [
  { type: "method_correctness", re: /(incorrect|wrong|error|mistake|flawed|mathematical(?:ly)? (?:error|incorrect)|derivation (?:is|seems) (?:wrong|incorrect)|not (?:mathematically )?valid|unsound|inconsistent (?:notation|definition|equation|formulation)|ill[- ]defined|contradict|not reasonable|i doubt|it is (?:hard|difficult) to (?:see|understand)|questionable (?:design|choice|assumption)|may not (?:work|be able to)|cannot (?:distinguish|learn|capture|handle|converge))/i },
  { type: "missing_experiments", re: /(missing (?:key |important |crucial )?(?:experiment|baseline|comparison|ablation|evaluation)|lack[s]? of (?:experiments?|baselines?|comparisons?|ablation|evaluation)|need[s]? (?:more|additional) experiments|insufficient experiment|without (?:any )?(?:baseline|comparison|ablation)|not (?:compared|evaluated)|(?:experiment|baseline|comparison|ablation|evaluation)[s]? (?:is|are|were) (?:missing|absent)|results? (?:are|is) not significant|improvements? (?:are|is) (?:marginal|trivial|insignificant|minimal)|performance gain[s]? (?:is|are) (?:marginal|small|insignificant))/i },
  { type: "overclaiming", re: /(overclaim|over-claim|too strong|stronger than (?:what|supported)|not (?:sufficient|enough) (?:evidence|justification) (?:to support|for)|claims? (?:are|is) (?:not|unsupported)|unsupported (?:claim|conclusion)|exaggerat|novelty (?:is|are)? (?:trivial|limited|marginal|incremental)|trivial novelty|incremental (?:contribution|novelty|extension)|limited novelty|not novel|insufficiently novel)/i },
  { type: "related_work", re: /(missing (?:important |key |recent |importance )?(?:related|prior|relevant) (?:work|literature|references|papers|reference)|fail[s]? to (?:cite|mention|discuss|compare with)|not (?:cited|discussed)|lack[s]? (?:of )?(?:related|prior) work|omit(?:s|ted)? (?:important|key|relevant)|(?:reference|citation)[s]? (?:is|are) (?:missing|absent))/i },
];
const UNJUDGEABLE_PATTERNS = [
  /^(?:i (?:like|enjoy|appreciate)|great |nice |good |excellent|well[- ]written|interesting)/i,
  /\b(?:personally|i feel|i would (?:prefer|like))\b.*\b(?:prefer|like|style|taste)\b/i,
  /\btypo\b|\btypos\b|grammatical|spelling|formatting of (?:the )?(?:text|table|figure)|minor writing/i,
  /^\s*(?:please see|see my|refer to)\b/i,
];
function seriousTypeOf(unit) {
  for (const { type, re } of SERIOUS_PATTERNS) if (re.test(unit)) return type;
  return null;
}
function judgeable(unit) {
  if (UNJUDGEABLE_PATTERNS.some((re) => re.test(unit))) return { ok: false, reason: "subjective_or_presentation" };
  if (unit.length < 30) return { ok: false, reason: "too_terse" };
  return { ok: true, reason: null };
}

// cross-reviewer dedup within family: normalized token-overlap Jaccard >= 0.6
const normTokens = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
function jaccard(a, b) {
  const A = new Set(normTokens(a));
  const B = new Set(normTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const lines = [];
const stats = { families: 0, reviews: 0, atomicIssues: 0, judgeable: 0, unjudgeable: 0, serious: 0, issueFamilies: 0 };
for (const famId of runFirst12) {
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
        const st = seriousTypeOf(unit);
        famIssues.push({
          familyId: famId,
          reviewNoteId: r.id,
          reviewerSig: sig,
          issueId: `${famId}-${sig}-${kind[0]}${famIssues.length + 1}`,
          kind,
          excerpt: unit.slice(0, 400),
          serious: st !== null,
          seriousType: st,
          judgeable: j.ok,
          unjudgeableReason: j.reason,
        });
      }
    }
  }
  // dedup into issue families (greedy, review order)
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
  stats.serious += famIssues.filter((i) => i.serious).length;
  stats.issueFamilies += groups.length;
}
await mkdir(join(ROOT, "phase-d"), { recursive: true });
await writeFile(OUT, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
// aggregate to issue-family level for matching (dedup groups with any judgeable member)
const famLevel = {};
for (const l of lines) {
  if (!l.judgeable) continue;
  const g = (famLevel[l.issueFamily] ??= { issueFamily: l.issueFamily, familyId: l.familyId, excerpts: [], serious: l.serious, seriousType: l.seriousType, members: [] });
  g.excerpts.push(l.excerpt);
  g.members.push(l.issueId);
  if (l.serious) { g.serious = true; g.seriousType = g.seriousType ?? l.seriousType; }
}
await writeFile(join(ROOT, "phase-d", "issue-families.json"), JSON.stringify(Object.values(famLevel), null, 1), "utf8");
console.log(JSON.stringify({ ...stats, judgeableIssueFamilies: Object.keys(famLevel).length }, null, 1));
