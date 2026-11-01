#!/usr/bin/env node
/**
 * M15.19 Phase D — 候选级事实守卫的确定性回放（零模型）。
 *
 * 对 M15.18 真实 run（S2 p-724f527d6766）rev-3 的全部 span 候选：从「源修订快照 + 已存候选提案」
 * 重建候选文件集合，用当前 dist 的 computeFactPreservationForCandidate 重新评估，并与当时真实记录的
 * fact.violations 对照——区分「候选自身引入的违规」与「其他文件既有累计漂移被误归因到候选」。
 *
 * 只读源项目：先把项目复制到 --root 下的副本再回放（不触碰 M15.18 证据）。
 *
 * 用法：node scripts/m1519/replay-candidate-facts.mjs --root <副本 projects root> --project p-724f527d6766 [--out <json>]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const ROOT = arg("root");
const PROJECT = arg("project", "p-724f527d6766");
const OUT = arg("out");
if (ROOT === undefined) throw new Error("--root 必填（副本 projects root）");

const dist = (...parts) => pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "dist", ...parts)).href;
const { ProjectStore } = await import(dist("project", "ProjectStore.js"));
const { ManuscriptRevisionStore } = await import(dist("manuscript", "RevisionStore.js"));
const { ReviewArtifactStore } = await import(dist("review", "reviewArtifacts.js"));
const { EvidenceStore } = await import(dist("evidence", "EvidenceStore.js"));
const { computeFactPreservationForCandidate } = await import(dist("quality", "factPreservation.js"));
const { readSnapshotTex } = await import(dist("quality", "citationPreservation.js"));
const { locateFileSpans, partitionSpanIntoUnits, partitionSpanIntoBlockUnits } = await import(dist("review", "logicalSpan.js"));
const { applyRevisionSpan } = await import(dist("review", "revisionScope.js"));

const projects = new ProjectStore({ root: ROOT });
const deps = {
  projects,
  revisions: new ManuscriptRevisionStore({ projects }),
  reviewArtifacts: new ReviewArtifactStore(projects),
  evidence: new EvidenceStore(projects),
};
const projectDir = join(ROOT, PROJECT);
const validation = JSON.parse(await readFile(join(projectDir, "reviews", "patch-validation-rev-2.json"), "utf8"));
const recordedById = new Map(validation.records.map((record) => [record.patchId, record]));

const results = [];
for (const revisionDir of ["rev-3"]) {
  const dir = join(projectDir, "reviews", "patch-candidates", revisionDir);
  for (const name of (await readdir(dir)).sort()) {
    const candidate = JSON.parse(await readFile(join(dir, name), "utf8"));
    const sourceRevision = candidate.sourceRevision;
    const sourceFiles = await readSnapshotTex(deps.revisions.snapshotDir(PROJECT, sourceRevision));
    const sourceFile = sourceFiles.find((file) => file.file === candidate.file);
    const spans = locateFileSpans(candidate.file, sourceFile.content);
    let unit;
    for (const span of spans) {
      const pools = [[span], partitionSpanIntoUnits(span).units, partitionSpanIntoBlockUnits(span).units];
      unit = pools.flat().find((entry) => entry.originalHash === candidate.beforeTargetHash);
      if (unit !== undefined) break;
    }
    const recorded = recordedById.get(candidate.patchId);
    const recordedFact = recorded?.fact ?? null;
    if (unit === undefined) {
      results.push({ patchId: candidate.patchId, file: candidate.file, target: candidate.logicalTarget, replay: "unit-not-located" });
      continue;
    }
    const proposal = candidate.validatedProposal ?? candidate.rawProposal;
    const candidateContent = applyRevisionSpan(sourceFile.content, unit, proposal);
    const candidateFiles = sourceFiles.map((file) => (file.file === candidate.file ? { ...file, content: candidateContent } : file));
    const fact = await computeFactPreservationForCandidate(deps, PROJECT, sourceRevision, candidateFiles);
    const now = fact === null ? [] : [
      ...fact.removedFacts.map((f) => `removed[${f.file}] ${f.before.slice(0, 70)} :: ${f.reason}`),
      ...fact.changedFacts.map((f) => `changed[${f.file}] ${f.before.slice(0, 50)} -> ${f.after.slice(0, 50)} :: ${f.reason}`),
      ...fact.addedUnsupportedFacts.map((f) => `added[${f.file}] ${f.after.slice(0, 70)} :: ${f.reason}`),
      ...fact.directionalChanges.map((f) => `direction[${f.file}] ${f.before.slice(0, 50)} -> ${f.after.slice(0, 50)} :: ${f.reason}`),
      ...fact.formulaChanges.map((f) => `formula[${f.file}] ${f.before.slice(0, 50)} :: ${f.reason}`),
      ...fact.placeholderRegressions.map((f) => `placeholder[${f.file}] ${f.after.slice(0, 50)} :: ${f.reason}`),
    ];
    results.push({
      patchId: candidate.patchId,
      file: candidate.file,
      target: candidate.logicalTarget,
      recorded: recordedFact === null ? null : { ok: recordedFact.ok, violations: recordedFact.violations.length, sample: recordedFact.violations.slice(0, 3) },
      replay: { ok: fact?.ok ?? null, violations: now.length, findings: now.slice(0, 12) },
    });
  }
}
const summary = {
  project: PROJECT,
  candidates: results.length,
  recordedFactFail: results.filter((entry) => entry.recorded?.ok === false).length,
  replayFactFail: results.filter((entry) => entry.replay?.ok === false).length,
  replayFactPass: results.filter((entry) => entry.replay?.ok === true).length,
  unlocated: results.filter((entry) => entry.replay === "unit-not-located").length,
};
console.log(JSON.stringify(summary, null, 1));
for (const entry of results) {
  console.log(`- ${entry.patchId} ${entry.file} ${entry.target}: recorded ${entry.recorded?.ok === false ? `FAIL(${entry.recorded.violations})` : entry.recorded?.ok} → replay ${typeof entry.replay === "string" ? entry.replay : `${entry.replay.ok ? "PASS" : "FAIL"}(${entry.replay.violations})`}`);
  if (typeof entry.replay !== "string") for (const finding of entry.replay.findings) console.log(`    · ${finding}`);
}
if (OUT !== undefined) await writeFile(OUT, JSON.stringify({ summary, results }, null, 1), "utf8");
