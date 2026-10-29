#!/usr/bin/env node
/**
 * M15.11 Phase D2 — investigator audit sampler.
 * Picks matched/unmatched samples with full evidence (human excerpt + AI finding text)
 * for manual review by the investigator (Claude main context) — explicitly NOT an
 * independent human expert review.
 * Output: phase-d/audit-samples.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-d", "issue-families.json"), "utf8"));
const alignments = (await readFile(join(ROOT, "phase-d", "issue-alignment.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const heldOut = manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId).slice(0, 12);

async function findingsOf(famId, arm) {
  const d = JSON.parse(await readFile(join(ROOT, "phase-c", "out", famId, `${arm}.json`), "utf8"));
  return arm === "c0" ? (d.findings ?? []) : (d.report?.findings ?? []);
}

const matchedSamples = [];
const unmatchedSamples = [];
for (const fam of heldOut) {
  const famId = fam.familyId;
  const famIssues = issueFamilies.filter((g) => g.familyId === famId);
  for (const arm of ["c0", "c1"]) {
    const align = alignments.find((a) => a.familyId === famId && a.arm === arm);
    if (!align?.pairs) continue;
    const findings = await findingsOf(famId, arm);
    for (const p of align.pairs) {
      const issue = famIssues[p.a - 1];
      if (!issue) continue;
      if (p.b !== null && matchedSamples.filter((x) => x.arm === arm).length < 20) {
        const f = findings[p.b - 1];
        matchedSamples.push({ familyId: famId, arm, aIdx: p.a, bIdx: p.b, confidence: p.confidence ?? "", rationale: p.rationale ?? "", humanExcerpt: issue.excerpts[0].slice(0, 400), aiFinding: { message: String(f?.message ?? "").slice(0, 400), claimText: String(f?.claimText ?? "").slice(0, 200), severity: f?.severity } });
      }
      if (p.b === null && unmatchedSamples.filter((x) => x.arm === arm).length < 20) {
        unmatchedSamples.push({ familyId: famId, arm, aIdx: p.a, rationale: p.rationale ?? "", humanExcerpt: issue.excerpts[0].slice(0, 400) });
      }
    }
  }
}
// deterministic spread: pick 5 matched + 5 unmatched per arm
function spread(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i += 1) out.push(arr[Math.floor(i * step)]);
  return out;
}
const picked = {
  matched: { c0: spread(matchedSamples.filter((s) => s.arm === "c0"), 5), c1: spread(matchedSamples.filter((s) => s.arm === "c1"), 5) },
  unmatched: { c0: spread(unmatchedSamples.filter((s) => s.arm === "c0"), 5), c1: spread(unmatchedSamples.filter((s) => s.arm === "c1"), 5) },
  poolSizes: { matchedTotal: matchedSamples.length, unmatchedTotal: unmatchedSamples.length },
};
await writeFile(join(ROOT, "phase-d", "audit-samples.json"), JSON.stringify(picked, null, 1), "utf8");
console.log(JSON.stringify(picked.poolSizes, null, 1));
