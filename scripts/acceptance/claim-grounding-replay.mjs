#!/usr/bin/env node
/**
 * M13 Final Closure（A1）：用历史真实项目数据重放 Claim Grounding / Resolution 的判定
 * （修复前 = 磁盘上落盘的 claim-grounding-r{N}.json / claim-resolution-r{N}.json；
 * 修复后 = 当前 backend/dist 对同一输入重算）。只读；不写项目目录。
 *
 * 用法：
 *   node scripts/acceptance/claim-grounding-replay.mjs <projectDir> [--out <file.json>] [--repo <repoRoot>]
 *
 * 输入（项目目录内既有产物）：
 *   reviews/review-r{N}-fact.json      → Fact Reviewer 逐 claim verdict（claims[]）
 *   evidence/evidence.jsonl            → 证据池（formal 过滤与生产一致：isFormalEvidence）
 *   reviews/citation-report.json       → bibEntries（citation key 解析）
 *   reviews/claim-grounding-r{N}.json  → 修复前报告（对照）
 *   reviews/claim-resolution-r{N}.json → 修复前 resolution（对照；可缺）
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    flags[arg.slice(2)] = args[i + 1];
    i += 1;
  } else {
    positional.push(arg);
  }
}
const projectDir = resolve(positional[0] ?? "");
if (!existsSync(join(projectDir, "reviews"))) {
  console.error("usage: claim-grounding-replay.mjs <projectDir> [--out file] [--repo root]");
  process.exit(2);
}
const repo = resolve(flags.repo ?? join(import.meta.dirname, "..", ".."));
const load = (file) => import(pathToFileURL(join(repo, "backend", "dist", file)).href);
const { computeClaimGroundingReport } = await load("review/claimGrounding.js");
const { computeClaimResolutions } = await load("review/claimResolution.js");
const { isFormalEvidence } = await load("evidence/EvidenceSelectionService.js");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const evidenceAll = readFileSync(join(projectDir, "evidence", "evidence.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const formal = evidenceAll.filter((record) => isFormalEvidence(record));
const citationReport = existsSync(join(projectDir, "reviews", "citation-report.json"))
  ? readJson(join(projectDir, "reviews", "citation-report.json"))
  : null;
const bibEntries = citationReport?.static?.bibEntries ?? [];

const rounds = readdirSync(join(projectDir, "reviews"))
  .map((name) => /^review-r(\d+)-fact\.json$/.exec(name)?.[1])
  .filter((value) => value !== undefined)
  .map(Number)
  .sort((a, b) => a - b);

const summary = { projectDir, formalEvidence: formal.length, rounds: [] };
for (const round of rounds) {
  const fact = readJson(join(projectDir, "reviews", `review-r${round}-fact.json`));
  const beforePath = join(projectDir, "reviews", `claim-grounding-r${round}.json`);
  const before = existsSync(beforePath) ? readJson(beforePath) : null;
  const after = computeClaimGroundingReport({
    projectId: before?.projectId ?? "replay",
    round,
    factClaims: fact.claims ?? [],
    formalEvidence: formal,
    bibEntries,
  });
  const afterResolution = computeClaimResolutions(
    after.claims.filter((entry) => entry.verdict === "UNSUPPORTED" || entry.verdict === "CONTRADICTED"),
    { sources: [], formalEvidence: formal },
    { projectId: after.projectId, round },
  );
  const beforeResPath = join(projectDir, "reviews", `claim-resolution-r${round}.json`);
  const beforeResolution = existsSync(beforeResPath) ? readJson(beforeResPath) : null;
  const beforeById = new Map((before?.claims ?? []).map((entry) => [entry.claimId, entry]));
  const changed = [];
  for (const entry of after.claims) {
    const prior = beforeById.get(entry.claimId);
    if (prior !== undefined && prior.verdict !== entry.verdict) {
      changed.push({
        claimId: entry.claimId,
        claim: entry.claim,
        evidenceId: entry.evidenceId ?? null,
        reviewerVerdict: prior.reviewerVerdict ?? prior.verdict,
        before: prior.verdict,
        after: entry.verdict,
        stance: entry.stance ?? null,
        numbersAnchored: entry.numbersAnchored ?? null,
        supportBoundary: entry.supportBoundary ?? null,
      });
    }
  }
  const row = {
    round,
    claims: after.totalClaims,
    before: before
      ? {
          supported: before.supportedClaims,
          partial: before.partiallySupportedClaims,
          unsupported: before.unsupportedClaims,
          opaque: before.opaqueUnsupportedClaims,
          resolutionCounts: beforeResolution?.counts ?? null,
        }
      : null,
    after: {
      supported: after.supportedClaims,
      partial: after.partiallySupportedClaims,
      unsupported: after.unsupportedClaims,
      opaque: after.opaqueUnsupportedClaims,
      resolutionCounts: afterResolution.counts,
    },
    changedVerdicts: changed,
    unchangedUnsupported: after.claims
      .filter((entry) => (entry.verdict === "UNSUPPORTED" || entry.verdict === "CONTRADICTED") && !changed.some((c) => c.claimId === entry.claimId))
      .map((entry) => ({ claim: entry.claim, evidenceId: entry.evidenceId ?? null, stance: entry.stance ?? null })),
  };
  summary.rounds.push(row);
  console.log(
    `r${round}: claims=${row.claims} before[sup/part/unsup/opaque]=${row.before ? `${row.before.supported}/${row.before.partial}/${row.before.unsupported}/${row.before.opaque}` : "n/a"} after=${row.after.supported}/${row.after.partial}/${row.after.unsupported}/${row.after.opaque} changed=${changed.length}`,
  );
  for (const change of changed) {
    console.log(`   ${change.before} -> ${change.after} [${change.evidenceId}] stance=${change.stance} anchored=${change.numbersAnchored}\n      ${change.claim}`);
  }
}
if (flags.out) {
  writeFileSync(flags.out, JSON.stringify(summary, null, 2));
  console.log(`written ${flags.out}`);
}
