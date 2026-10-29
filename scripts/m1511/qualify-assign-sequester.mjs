#!/usr/bin/env node
/**
 * M15.11 Phase B — qualification check, DEV/HELD-OUT assignment, sequester.
 *
 * Qualification (deterministic, structure/length thresholds — no semantic reading,
 * no review text printed):
 *   - count Official_Review notes in forum replies (guest-visible)
 *   - a review is SUBSTANTIVE iff len(strengths)+len(weaknesses)+len(questions) >= 400 chars
 *     OR len(weaknesses)+len(questions) >= 250 chars
 *   - family QUALIFIES iff >=2 substantive official reviews
 *
 * Assignment: qualified families in candidateId order → first 8 = DEV, next 16 = HELD-OUT,
 * remainder = RESERVE (not used unless a selected family fails later gates).
 *
 * Sequester: full replies JSON moved to sequester/<family>/replies.json (HELD-OUT:
 * unreadable-by-main-context until predictions frozen; DEV: readable for bring-up).
 * PDFs copied to manuscripts/<family>.pdf. sha256 recorded for everything.
 * Output: phase-b/SAMPLE_MANIFEST.json (no review text).
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const collectDir = resolve(here, "tools", "collect-out");
const cands = JSON.parse(await readFile(resolve(here, "phase-b", "candidate-list.json"), "utf8")).candidates;
const sha256File = async (p) => createHash("sha256").update(await readFile(p)).digest("hex");

const DEV_TARGET = 8;
const HELD_TARGET = 16;

const results = [];
for (const c of cands) {
  const repliesPath = resolve(collectDir, `replies-${c.candidateId}.json`);
  const pdfPath = resolve(collectDir, `pdf-${c.candidateId}.pdf`);
  const entry = { candidateId: c.candidateId, noteId: c.noteId, number: c.number, title: c.title, bucket: c.bucket, primaryArea: c.primaryArea, pdfPath: c.pdfPath };
  if (!existsSync(repliesPath)) {
    results.push({ ...entry, qualified: false, reason: "repliesMissing" });
    continue;
  }
  if (!existsSync(pdfPath)) {
    results.push({ ...entry, qualified: false, reason: "pdfMissing" });
    continue;
  }
  const pdfStat = (await readFile(pdfPath)).subarray(0, 5).toString("latin1");
  if (!pdfStat.startsWith("%PDF")) {
    results.push({ ...entry, qualified: false, reason: "pdfNotPdf" });
    continue;
  }
  let j;
  try {
    j = JSON.parse(await readFile(repliesPath, "utf8"));
  } catch {
    results.push({ ...entry, qualified: false, reason: "repliesUnparseable" });
    continue;
  }
  const note = (j.notes ?? []).find((n) => n.id === c.noteId);
  const replies = note?.details?.replies ?? [];
  const officialReviews = replies.filter((r) => (r.invitations ?? []).some((i) => i.endsWith("/-/Official_Review")));
  const substantive = officialReviews.filter((r) => {
    const len = (k) => String(r.content?.[k]?.value ?? "").length;
    const swq = len("strengths") + len("weaknesses") + len("questions");
    const wq = len("weaknesses") + len("questions");
    return swq >= 400 || wq >= 250;
  });
  const hasDecision = replies.some((r) => (r.invitations ?? []).some((i) => i.endsWith("/-/Decision")));
  const hasMeta = replies.some((r) => (r.invitations ?? []).some((i) => i.endsWith("/-/Meta_Review")));
  results.push({
    ...entry,
    officialReviewCount: officialReviews.length,
    substantiveReviewCount: substantive.length,
    totalReplyCount: replies.length,
    hasDecision,
    hasMeta,
    qualified: substantive.length >= 2,
    reason: substantive.length >= 2 ? null : "tooFewSubstantiveReviews",
  });
}

// assignment in candidateId order
let devCount = 0;
let heldCount = 0;
for (const r of results) {
  if (!r.qualified) {
    r.role = "EXCLUDED";
    continue;
  }
  if (devCount < DEV_TARGET) {
    r.role = "DEV";
    devCount += 1;
  } else if (heldCount < HELD_TARGET) {
    r.role = "HELD-OUT";
    heldCount += 1;
  } else {
    r.role = "RESERVE";
  }
}

// sequester + manuscripts
const manifest = { generatedAt: new Date().toISOString(), devTarget: DEV_TARGET, heldTarget: HELD_TARGET, families: [] };
for (const r of results) {
  if (r.role === "EXCLUDED") {
    manifest.families.push(r);
    continue;
  }
  const famId = `fam-${r.candidateId}`;
  const famDir = resolve(here, "sequester", famId);
  await mkdir(famDir, { recursive: true });
  await copyFile(resolve(collectDir, `replies-${r.candidateId}.json`), resolve(famDir, "replies.json"));
  await mkdir(resolve(here, "manuscripts"), { recursive: true });
  await copyFile(resolve(collectDir, `pdf-${r.candidateId}.pdf`), resolve(here, "manuscripts", `${famId}.pdf`));
  manifest.families.push({
    ...r,
    familyId: famId,
    manuscriptPdfSha256: await sha256File(resolve(here, "manuscripts", `${famId}.pdf`)),
    repliesJsonSha256: await sha256File(resolve(famDir, "replies.json")),
  });
}
await writeFile(resolve(here, "phase-b", "SAMPLE_MANIFEST.json"), JSON.stringify(manifest, null, 1), "utf8");

const summary = {
  total: results.length,
  qualified: results.filter((r) => r.qualified).length,
  dev: devCount,
  heldOut: heldCount,
  reserve: results.filter((r) => r.role === "RESERVE").length,
  excluded: results.filter((r) => r.role === "EXCLUDED").map((r) => ({ id: r.candidateId, reason: r.reason })),
  reviewCountDist: results.map((r) => r.officialReviewCount ?? 0).sort((a, b) => a - b),
};
console.log(JSON.stringify(summary, null, 1));
