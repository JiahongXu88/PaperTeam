#!/usr/bin/env node
/**
 * M15.11 Phase A/B — build the sampling frame from collected OpenReview listings.
 *
 * Eligibility (deterministic, metadata-only — no review text is read here):
 *  E1 venueid in {ICLR.cc/2024/Conference/Rejected_Submission, ICLR.cc/2025/Conference/Rejected_Submission}
 *     (guest-verifiable version alignment is only possible when the note was never
 *      revised: accepted papers always carry Camera_Ready_Revision, so the frame
 *      is rejected-submission-only; recorded as a protocol limitation)
 *  E2 no Revision / Rebuttal_Revision / Camera_Ready_Revision invitations on the note
 *     (⇒ content.pdf is the version the reviewers saw)
 *  E3 content.pdf present
 *  E4 not withdrawn / desk-rejected
 * Output: phase-a/sampling-frame.json with per-note minimal metadata + counts.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const collectDir = resolve(here, "tools", "collect-out");
const outPath = resolve(here, "phase-a", "sampling-frame.json");

const REVISION_INVITES = ["Revision", "Rebuttal_Revision", "Camera_Ready_Revision", "PC_Revision"];
const ELIGIBLE_VENUEIDS = new Set([
  "ICLR.cc/2024/Conference/Rejected_Submission",
  "ICLR.cc/2025/Conference/Rejected_Submission",
]);

const files = (await readdir(collectDir)).filter((f) => f.startsWith("list-") && f.endsWith(".json")).sort();
const notes = new Map();
let parseFailures = 0;
for (const f of files) {
  let j;
  try {
    j = JSON.parse(await readFile(resolve(collectDir, f), "utf8"));
  } catch {
    parseFailures += 1;
    continue;
  }
  for (const n of j.notes ?? []) notes.set(n.id, n);
}

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const all = [];
const stats = {
  listingFiles: files.length,
  uniqueNotes: notes.size,
  parseFailures,
  byVenue: {},
  eligible: 0,
  ineligibleReasons: { acceptedOrOtherVenue: 0, revisionInvitation: 0, noPdf: 0 },
};
for (const n of notes.values()) {
  const venueid = n.content?.venueid?.value ?? "";
  stats.byVenue[venueid] = (stats.byVenue[venueid] ?? 0) + 1;
  const invSuffixes = (n.invitations ?? []).map((i) => i.split("/-/").pop());
  const hasRevision = invSuffixes.some((s) => REVISION_INVITES.includes(s));
  const pdf = n.content?.pdf?.value ?? null;
  let reason = null;
  if (!ELIGIBLE_VENUEIDS.has(venueid)) reason = "acceptedOrOtherVenue";
  else if (hasRevision) reason = "revisionInvitation";
  else if (!pdf) reason = "noPdf";
  const rec = {
    id: n.id,
    number: n.number ?? null,
    title: n.content?.title?.value ?? "",
    titleNorm: norm(n.content?.title?.value ?? ""),
    keywords: (n.content?.keywords?.value ?? []).slice(0, 8),
    primaryArea: n.content?.primary_area?.value ?? null,
    venue: n.content?.venue?.value ?? "",
    venueid,
    tcdate: n.tcdate ?? null,
    pdf,
    license: n.content?.license?.value ?? null,
    invSuffixes,
    eligible: reason === null,
    excludeReason: reason,
  };
  all.push(rec);
  if (reason === null) stats.eligible += 1;
  else stats.ineligibleReasons[reason] += 1;
}

// cross-year family dedup by normalized title (resubmissions 2024→2025)
const seen = new Map();
const families = [];
for (const r of all.filter((x) => x.eligible)) {
  const key = r.titleNorm;
  if (seen.has(key)) {
    seen.get(key).duplicates.push({ id: r.id, year: r.venueid.includes("2024") ? 2024 : 2025 });
    continue;
  }
  const fam = { ...r, duplicates: [] };
  seen.set(key, fam);
  families.push(fam);
}

// strata summary
const strata = {};
for (const f of families) {
  const k = `${f.venueid.includes("2024") ? 2024 : 2025}|${f.primaryArea ?? "none"}`;
  strata[k] = (strata[k] ?? 0) + 1;
}

await writeFile(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), stats, strata, families: families.map(({ duplicates, ...f }) => ({ ...f, duplicateCount: duplicates.length })) },
    null,
    1,
  ),
  "utf8",
);
console.log(JSON.stringify({ stats, familyCount: families.length, strataCount: Object.keys(strata).length }, null, 1));
