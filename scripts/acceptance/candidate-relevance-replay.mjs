/** M13.8 Phase 4 — read-only replay of the survey candidate relevance ranker over REAL retrieval artefacts.
 *
 * Usage: node candidate-relevance-replay.mjs REPO_ROOT PROJECT_DIR OUTPUT_DIR [--top 14]
 *   PROJECT_DIR = an existing PaperTeam project directory (sources/candidates.json + research/research.json + project.json)
 *
 * Compares the legacy recommendation (paper-like → year desc) with the M13.8 topic-relevance selection on the same real
 * candidates; writes a JSON + Markdown table. Never writes into the project. No model calls.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, projectArg, outputArg, ...rest] = process.argv.slice(2);
if (!repoArg || !projectArg || !outputArg) throw new Error("usage: node candidate-relevance-replay.mjs REPO_ROOT PROJECT_DIR OUTPUT_DIR [--top N]");
const topIndex = rest.indexOf("--top");
const top = topIndex >= 0 ? Number(rest[topIndex + 1]) : 14;
const repo = resolve(repoArg);
const projectDir = resolve(projectArg);
const output = resolve(outputArg);
await mkdir(output, { recursive: true });
const load = (p) => import(pathToFileURL(join(repo, "backend", "dist", p)).href);
const { rankSurveyCandidates, selectRecommendedCandidates, legacyRecencyOrder, buildQueryHitCounts } = await load("survey/candidateRelevance.js");
const { readPlanChain } = await load("agents/researchPlan.js");

const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8"));
const candidatesFile = JSON.parse(await readFile(join(projectDir, "sources", "candidates.json"), "utf8"));
const candidates = (candidatesFile.items ?? candidatesFile.candidates ?? candidatesFile).filter((item) => item && typeof item === "object");
const research = JSON.parse(await readFile(join(projectDir, "research", "research.json"), "utf8"));
const chain = readPlanChain(research);
const plan = chain.plans.find((entry) => entry.planId === chain.activePlanId) ?? chain.plans[chain.plans.length - 1];
const pending = candidates.filter((candidate) => candidate.status === "pending_review" || candidate.status === "accepted");

const context = {
  topic: project.title,
  queries: (plan?.queries ?? []).map((query) => ({ query: query.query, kind: query.kind })),
  ...(research.surveyProfile?.taxonomy !== undefined ? { taxonomyFamilies: research.surveyProfile.taxonomy.families } : {}),
  queryHits: buildQueryHitCounts(research.executionHistory ?? [], plan?.planId),
};
const ranked = rankSurveyCandidates(pending, context);
const selection = selectRecommendedCandidates(pending, ranked, {
  familyOrder: context.taxonomyFamilies?.map((family) => family.label),
});
const legacy = legacyRecencyOrder(pending).slice(0, 25).map((candidate) => candidate.candidateId);
const byId = new Map(pending.map((candidate) => [candidate.candidateId, candidate]));
const rankedById = new Map(ranked.map((entry) => [entry.candidateId, entry]));

const row = (id) => {
  const candidate = byId.get(id);
  const entry = rankedById.get(id);
  return {
    candidateId: id,
    title: candidate?.title ?? "(untitled)",
    year: candidate?.year ?? null,
    arxivId: candidate?.arxivId ?? null,
    relevance: entry?.relevance ?? null,
    score: entry?.score ?? null,
    queryHits: entry?.signals.queryHits ?? null,
    familyMatches: entry?.signals.familyMatches ?? [],
    matchedPhrases: entry?.signals.matchedPhrases ?? [],
    reasons: entry?.reasons ?? [],
    previouslySelected: candidate?.status === "accepted",
  };
};
const result = {
  project: { id: project.id, title: project.title, dir: projectDir },
  candidates: pending.length,
  context: { queries: context.queries.length, families: context.taxonomyFamilies?.map((family) => family.label) ?? [], identitiesWithHits: context.queryHits.size },
  counts: selection.counts,
  basis: selection.basis,
  familyCoverage: selection.familyCoverage,
  nearDuplicatesSuppressed: selection.nearDuplicatesSuppressed,
  legacyTop: legacy.slice(0, top).map(row),
  relevanceTop: selection.candidateIds.slice(0, top).map(row),
  allRanked: ranked.map((entry) => row(entry.candidateId)),
  overlapTop: legacy.slice(0, top).filter((id) => selection.candidateIds.slice(0, top).includes(id)).length,
};
await writeFile(join(output, "candidate-relevance-replay.json"), JSON.stringify(result, null, 2));
const md = [
  `# Candidate relevance replay — ${project.title} (${project.id})`,
  "",
  `candidates=${pending.length} · queries=${result.context.queries} · families=${result.context.families.join(", ")} · identities with multi-query hits=${result.context.identitiesWithHits}`,
  `counts: ${JSON.stringify(selection.counts)} · basis=${selection.basis} · near-duplicates suppressed=${selection.nearDuplicatesSuppressed} · overlap of top-${top}: ${result.overlapTop}/${top}`,
  `family coverage (recommended set): ${JSON.stringify(selection.familyCoverage)}`,
  "",
  `## Legacy top-${top} (paper-like → year desc)`,
  "| # | id | year | relevance | hits | title |",
  "|---|---|---|---|---|---|",
  ...result.legacyTop.map((entry, index) => `| ${index + 1} | ${entry.candidateId} | ${entry.year ?? ""} | ${entry.relevance} | ${entry.queryHits} | ${entry.title.replace(/\|/g, "/")} |`),
  "",
  `## M13.8 topic-relevance top-${top}`,
  "| # | id | year | relevance | score | hits | families | title |",
  "|---|---|---|---|---|---|---|---|",
  ...result.relevanceTop.map((entry, index) => `| ${index + 1} | ${entry.candidateId} | ${entry.year ?? ""} | ${entry.relevance} | ${entry.score} | ${entry.queryHits} | ${entry.familyMatches.join(" ")} | ${entry.title.replace(/\|/g, "/")} |`),
  "",
  "## Bottom of the ranking (low / uncertain)",
  ...result.allRanked.filter((entry) => entry.relevance === "low" || entry.relevance === "uncertain").slice(-10).map((entry) => `- ${entry.candidateId} [${entry.relevance}] ${entry.title} — ${entry.reasons.join("；")}`),
].join("\n");
await writeFile(join(output, "candidate-relevance-replay.md"), md);
console.log(md);
