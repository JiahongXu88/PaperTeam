#!/usr/bin/env node
/**
 * M13 Final Closure: replay revision.validate on a real project's revision snapshots with the current dist
 * (read-only). Shows what the deterministic validation would decide for sourceRevision → revision today,
 * next to the validation artifact that was persisted at the time.
 *
 * Usage: node scripts/acceptance/revision-validation-replay.mjs <projectDir> <sourceRevision> <revision> [--repo ROOT]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    flags[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [projectDirArg, sourceArg, revisionArg] = positional;
if (!projectDirArg || !sourceArg || !revisionArg) {
  console.error("usage: revision-validation-replay.mjs <projectDir> <sourceRevision> <revision> [--repo ROOT]");
  process.exit(2);
}
const projectDir = resolve(projectDirArg);
const repo = resolve(flags.repo ?? join(import.meta.dirname, "..", ".."));
const load = (file) => import(pathToFileURL(join(repo, "backend", "dist", file)).href);
const { evaluateRevisionValidation } = await load("review/revisionValidation.js");
const { buildReferenceVocabulary } = await load("review/namedReferenceGuard.js");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function readSnapshot(revision) {
  const dir = join(projectDir, "build", "revisions", `rev-${revision}`);
  const files = [];
  const walk = (base, rel) => {
    for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(base, next);
      else if (next.endsWith(".tex")) files.push({ file: next, content: readFileSync(join(base, next), "utf8") });
    }
  };
  walk(dir, "");
  return files;
}
const bibKeys = [...readFileSync(join(projectDir, "manuscript", "references.bib"), "utf8").matchAll(/@\w+\{([^,\s]+),/g)].map((m) => m[1]);
const evidence = existsSync(join(projectDir, "evidence", "evidence.jsonl"))
  ? readFileSync(join(projectDir, "evidence", "evidence.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];
const sourceRevision = Number(sourceArg);
const revision = Number(revisionArg);
const plans = readdirSync(join(projectDir, "reviews")).filter((f) => /^revision-plan-r\d+\.json$/.test(f)).map((f) => readJson(join(projectDir, "reviews", f)));
const plan = plans.find((p) => p.sourceRevision === sourceRevision) ?? null;
const stored = readdirSync(join(projectDir, "reviews"))
  .filter((f) => /^revision-validation-r\d+\.json$/.test(f))
  .map((f) => readJson(join(projectDir, "reviews", f)))
  .find((v) => v.sourceRevision === sourceRevision && v.revision === revision) ?? null;
// 条目状态按产物中的 applied 口径重放：plan 文件里的条目可能已被转为 validated；这里把 planned/applied/validated 都视为 applied
const replayPlan = plan === null ? null : { ...plan, items: plan.items.map((item) => (["validated", "applied", "planned", "rejected", "approved", "needs_review"].includes(item.status) ? { ...item, status: "applied" } : item)) };
const result = evaluateRevisionValidation({
  projectId: "replay",
  reviewRound: plan?.reviewRound ?? 0,
  sourceRevision,
  revision,
  plan: replayPlan,
  previousFiles: readSnapshot(sourceRevision),
  currentFiles: readSnapshot(revision),
  factPreservation: stored?.factPreservation ?? null,
  citationPreservation: stored?.citationPreservation ?? null,
  evidenceRecords: evidence,
  referenceVocabulary: buildReferenceVocabulary({ evidence, bibEntries: bibKeys.map((key) => ({ key })) }),
  knownBibKeys: bibKeys,
});
console.log(
  JSON.stringify(
    {
      projectDir,
      sourceRevision,
      revision,
      bibKeys: bibKeys.length,
      stored: stored === null ? null : { ok: stored.ok, blocked: stored.blocked, rejected: stored.items.filter((i) => i.status === "rejected").length, uncoveredAddedKeys: stored.uncoveredAddedKeys },
      replay: {
        ok: result.ok,
        blocked: result.blocked,
        items: result.items.map((i) => ({ id: i.id.slice(0, 14), section: i.section.slice(0, 60), status: i.status, category: i.category ?? null, reasonCodes: i.reasonCodes })),
        unknownAddedKeys: result.unknownAddedKeys ?? null,
        namedReferences: (result.namedReferences ?? []).map((n) => `${n.file}:${n.surface}`),
        uncoveredAddedKeys: result.uncoveredAddedKeys,
      },
    },
    null,
    2,
  ),
);
