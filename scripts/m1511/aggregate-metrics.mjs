#!/usr/bin/env node
/**
 * M15.11 Phase D2 — metrics aggregation.
 *
 * Inputs: phase-d/issue-families.json, phase-d/issue-alignment.jsonl,
 *         phase-c/out/<fam>/{c0,c1,meta}.json, phase-c/model-calls.jsonl,
 *         phase-c/projects-root/<pid>/paper/parsed/chunks.jsonl
 * Output: phase-d/paired-metrics.json
 *
 * Metrics (per frozen protocol §5):
 *   HRI-Coverage / Serious-Coverage per arm (judge-matched issue families / judgeable),
 *   paired per-family diffs, aggregate + bootstrap 95% CI (family-level, B=2000, seed=1511),
 *   Grounded Finding Ratio (rule anchors), cost/latency per arm.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)

const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-d", "issue-families.json"), "utf8"));
const alignments = (await readFile(join(ROOT, "phase-d", "issue-alignment.jsonl"), "utf8"))
  .trim().split("\n").map((l) => JSON.parse(l));
const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const heldOut = manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId).slice(0, 12);
const callsLog = (await readFile(join(ROOT, "phase-c", "model-calls.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 .,;:()\-–—%]/g, " ").replace(/\s+/g, " ").trim();

async function manuscriptOf(famId) {
  const meta = JSON.parse(await readFile(join(ROOT, "phase-c", "out", famId, "meta.json"), "utf8"));
  const pid = meta.projectId;
  const raw = await readFile(join(ROOT, "phase-c", "projects-root", pid, "paper", "parsed", "chunks.jsonl"), "utf8");
  const chunks = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { text: norm(chunks.map((c) => c.text).join("\n")), pages: Math.max(...chunks.map((c) => c.pageEnd ?? 0)), chunkIds: new Set(chunks.map((c) => c.chunkId)) };
}

// rule anchor for grounded ratio
function grounded(finding, ms) {
  const ct = norm(finding.claimText);
  if (ct.length >= 20) {
    if (ms.text.includes(ct.slice(0, Math.min(ct.length, 120)))) return { grounded: true, via: "claimText" };
    // fuzzy: 6-gram containment
    const words = ct.split(" ");
    for (let i = 0; i + 6 <= words.length; i += 3) {
      const gram = words.slice(i, i + 6).join(" ");
      if (gram.length > 25 && ms.text.includes(gram)) return { grounded: true, via: "claimText-ngram" };
    }
  }
  if (typeof finding.page === "number" && finding.page >= 1 && finding.page <= ms.pages) {
    if (/\b(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?|section|eq\.|table \d|algorithm)\s*\d/i.test(String(finding.message ?? "")) || /\d/.test(String(finding.claimText ?? ""))) {
      return { grounded: true, via: "page+specific" };
    }
  }
  if (finding.chunkId && ms.chunkIds.has(finding.chunkId)) return { grounded: true, via: "chunkId" };
  return { grounded: false, via: null };
}

// deterministic refutation rules (conservative): "missing X" claims where X is plainly present
function refuted(finding, ms) {
  const msg = String(finding.message ?? "");
  const m = msg.match(/\b(?:no|without|lacks?|missing|not (?:report|present|provid|includ|mention))(?:ing)?\b[^.;:]{0,80}?\b((?:ablation|baseline|comparison|error bar|std|deviation|std\.?dev|hyperparameter|code|implementation detail|proof|theorem|lemma|dataset|experiment))\b/i);
  if (!m) return false;
  const term = m[1].toLowerCase();
  if (term === "proof" || term === "theorem" || term === "lemma") return /\b(?:proof|theorem|lemma)\b/i.test(ms.text.slice(0, 0)) ? false : /\bproof\b/i.test(ms.text) && /appendix/i.test(ms.text);
  return ms.text.includes(term);
}

const perFamily = [];
for (const fam of heldOut) {
  const famId = fam.familyId;
  const famIssues = issueFamilies.filter((g) => g.familyId === famId);
  const judgeable = famIssues;
  const serious = famIssues.filter((g) => g.serious);
  let ms = null;
  try { ms = await manuscriptOf(famId); } catch { ms = { text: "", pages: 0, chunkIds: new Set() }; }
  const row = { familyId: famId, judgeableIssueFamilies: judgeable.length, seriousIssueFamilies: serious.length, arms: {} };
  for (const arm of ["c0", "c1"]) {
    const align = alignments.find((a) => a.familyId === famId && a.arm === arm);
    const armData = JSON.parse(await readFile(join(ROOT, "phase-c", "out", famId, `${arm}.json`), "utf8"));
    const findings = arm === "c0"
      ? (armData.findings ?? []).map((f) => ({ ...f, severity: f.severity ?? "minor" }))
      : ((armData.report?.findings ?? []).map((f) => ({ ...f, severity: f.severity ?? "minor" })));
    let matched = [];
    if (align?.pairs) {
      matched = align.pairs.filter((p) => p.b !== null && Number.isInteger(p.b) && p.b >= 1).map((p) => ({ aIdx: p.a, bIdx: p.b, rationale: p.rationale ?? "", confidence: p.confidence ?? "" }));
    }
    const matchedIssueIdx = new Set(matched.map((m) => m.aIdx).filter((i) => i >= 1 && i <= judgeable.length));
    const seriousIdx = new Set(judgeable.map((g, i) => (g.serious ? i + 1 : null)).filter(Boolean));
    const seriousMatched = [...seriousIdx].filter((i) => matchedIssueIdx.has(i)).length;
    const groundedFlags = findings.map((f) => grounded(f, ms));
    const refutedFlags = findings.map((f) => refuted(f, ms));
    const armCalls = callsLog.filter((c) => (arm === "c0" ? c.contextScope.startsWith(`m1511-c0/${famId}`) : (c.contextScope.startsWith("review/") || c.contextScope.startsWith("m1511-judge") === false && false)) && true);
    // per-family call attribution: c0 by scope prefix; c1 by stage-window (approximated from meta wall times is fragile; use scope prefixes review/* during family window — we instead count from armData.calls recorded by runner)
    row.arms[arm] = {
      status: armData.status ?? (armData.report ? "completed" : "unknown"),
      findingCount: findings.length,
      coverage: judgeable.length > 0 ? matchedIssueIdx.size / judgeable.length : null,
      matchedIssueFamilies: matchedIssueIdx.size,
      seriousCoverage: seriousIdx.size > 0 ? seriousMatched / seriousIdx.size : null,
      seriousMatched,
      groundedRatio: findings.length > 0 ? groundedFlags.filter((x) => x.grounded).length / findings.length : null,
      groundedCount: groundedFlags.filter((x) => x.grounded).length,
      refutedCount: refutedFlags.filter(Boolean).length,
      calls: armData.calls ?? null,
      wallMs: armData.wallMs ?? null,
      matchedDetail: matched,
    };
  }
  row.diffCoverage = (row.arms.c1?.coverage ?? null) - (row.arms.c0?.coverage ?? null) ?? null;
  row.diffSerious = row.arms.c1?.seriousCoverage != null && row.arms.c0?.seriousCoverage != null ? row.arms.c1.seriousCoverage - row.arms.c0.seriousCoverage : null;
  perFamily.push(row);
}

// aggregate + bootstrap
const fams = perFamily.filter((r) => r.arms.c0?.coverage != null && r.arms.c1?.coverage != null);
const agg = (get) => fams.map(get);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function bootstrapCI(xs, B = 2000, seed = 1511) {
  if (xs.length < 2) return null;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means = [];
  for (let b = 0; b < B; b += 1) {
    let sum = 0;
    for (let i = 0; i < xs.length; i += 1) sum += xs[Math.floor(rand() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * B)], hi: means[Math.floor(0.975 * B)] };
}
const cov0 = agg((r) => r.arms.c0.coverage);
const cov1 = agg((r) => r.arms.c1.coverage);
const diffs = fams.map((r) => r.arms.c1.coverage - r.arms.c0.coverage);
const ser0 = agg((r) => r.arms.c0.seriousCoverage).filter((x) => x != null);
const ser1 = agg((r) => r.arms.c1.seriousCoverage).filter((x) => x != null);
const g0 = agg((r) => r.arms.c0.groundedRatio);
const g1 = agg((r) => r.arms.c1.groundedRatio);
const summary = {
  familiesWithBothArms: fams.length,
  totalJudgeableIssueFamilies: fams.reduce((a, r) => a + r.judgeableIssueFamilies, 0),
  hriCoverage: { c0: mean(cov0), c1: mean(cov1), diff: mean(diffs), diffCI: bootstrapCI(diffs), perFamilyDiffs: diffs },
  seriousCoverage: { c0: mean(ser0), c1: mean(ser1), n: ser0.length },
  groundedRatio: { c0: mean(g0), c1: mean(g1) },
  refutedTotal: { c0: fams.reduce((a, r) => a + (r.arms.c0?.refutedCount ?? 0), 0), c1: fams.reduce((a, r) => a + (r.arms.c1?.refutedCount ?? 0), 0) },
  findingsTotal: { c0: fams.reduce((a, r) => a + (r.arms.c0?.findingCount ?? 0), 0), c1: fams.reduce((a, r) => a + (r.arms.c1?.findingCount ?? 0), 0) },
  costPerFamily: {
    c0: { calls: mean(agg((r) => r.arms.c0.calls)), wallMs: mean(agg((r) => r.arms.c0.wallMs)) },
    c1: { calls: mean(agg((r) => r.arms.c1.calls)), wallMs: mean(agg((r) => r.arms.c1.wallMs)) },
  },
};
await writeFile(join(ROOT, "phase-d", "paired-metrics.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, perFamily }, null, 1), "utf8");
console.log(JSON.stringify(summary, null, 1));
