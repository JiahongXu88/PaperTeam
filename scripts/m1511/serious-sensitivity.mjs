#!/usr/bin/env node
/**
 * M15.11 — POST-HOC investigator-audited sensitivity: serious-coverage after
 * removing 7 mis-typed items (clarity/wording flagged by the surface regex as
 * method_correctness). Clearly labeled post-hoc; the frozen-typing number stays primary.
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

// investigator audit 2026-10-29: mis-typed serious items (clarity/wording, not substance)
const MIS_TYPED = new Set([
  "IF-fam-cand-09-*", // placeholder replaced below by matching on excerpt text
]);
const notSeriousExcerptPrefixes = [
  "There are some writing errors in the paper.",
  "Line 50: \"LLMs *irregularly* obtain unexpected fragmented decision boundaries",
  "There may be a writing error in Table 5",
  "- the paper is hard to follow: (1) it's rare the say a model is a \"1GB\" classifier",
  "Clarity : there are a few unclear points or mistakes developed in the questions.",
  "Overall, I very much like this work, and I believe the authors will be able to address",
  "Are there any identifiable patterns in the prediction errors?",
];
const isMisTyped = (g) => notSeriousExcerptPrefixes.some((p) => g.excerpts[0].startsWith(p));

const result = { total: 0, c0: 0, c1: 0, dropped: [] };
for (const fam of heldOut) {
  const famId = fam.familyId;
  const famIssues = issueFamilies.filter((g) => g.familyId === famId);
  const seriousIdx = famIssues.map((g, i) => (g.serious ? i + 1 : null)).filter(Boolean);
  const serious = seriousIdx.map((i) => famIssues[i - 1]);
  const keep = serious.filter((g) => !isMisTyped(g));
  result.dropped.push(...serious.filter((g) => isMisTyped(g)).map((g) => g.issueFamily));
  for (const arm of ["c0", "c1"]) {
    const align = alignments.find((a) => a.familyId === famId && a.arm === arm);
    if (!align?.pairs) continue;
    for (const g of keep) {
      const idx = famIssues.indexOf(g) + 1;
      const m = align.pairs.find((p) => p.a === idx && p.b !== null);
      if (arm === "c0") result.total += 1; // same issue set for both arms; count once
      if (m) result[arm] += 1;
    }
  }
}
const out = {
  label: "POST_HOC_INVESTIGATOR_AUDIT_SENSITIVITY (not the frozen primary; frozen serious-typing result reported separately with regex-false-positive caveat)",
  droppedMisTyped: result.dropped.length,
  trueSeriousIssueFamilies: result.total,
  c0Matched: result.c0,
  c1Matched: result.c1,
  c0Coverage: result.c0 / result.total,
  c1Coverage: result.c1 / result.total,
};
await writeFile(join(ROOT, "phase-d", "serious-sensitivity.json"), JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify(out, null, 1));
