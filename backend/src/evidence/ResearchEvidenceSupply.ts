/** Bounded supply; Source identity is never evidence of claim support. */
import { createHash } from "node:crypto";
import type { WorkflowServices } from "../workflow/definitions.js";
import type { ResearchArtifact } from "../agents/ResearcherService.js";
import { tokenizeText } from "../retrieval/tokenize.js";
import { identityKey } from "../sources/identity.js";
export const RESEARCH_SUPPLY_LIMITS = { candidates: 12, sources: 6, claims: 6 } as const;
type Services = Pick<WorkflowServices, "projects" | "candidates" | "sourceImport" | "sources" | "ingestion" | "targetedGrounding" | "evidenceGrounding" | "evidenceSelection">;
export async function supplyResearchEvidence(services: Services, projectId: string, artifact: ResearchArtifact, options: { signal?: AbortSignal; progress?: (phase: string, counts: Record<string, number>) => void } = {}) {
  const project = await services.projects.getRequired(projectId);
  const before = await services.evidenceGrounding.candidateStats(projectId);
  const summary = { reviewed: 0, selected: 0, deduplicated: 0, promoted: 0, alreadyExists: 0, promoteFailed: 0,
    fulltext: 0, chunkedSources: 0, chunks: 0, proposed: 0, verified: 0, rejected: 0, unverifiable: 0,
    candidateSourcesPending: 0, evidenceCandidatesBefore: before.total, evidenceCandidatesAfter: before.total, formalEvidence: 0,
    failures: {} as Record<string, number>, mappings: [] as { claimId: string; sourceId: string; chunkId: string; outcome: string }[] };
  const fail = (reason: string) => { summary.failures[reason] = (summary.failures[reason] ?? 0) + 1; };
  const check = () => options.signal?.throwIfAborted();
  check();
  const stopWords = new Set(["the", "and", "for", "with", "from", "this", "that", "of", "in", "to", "a", "an", "is", "are", "on", "by", "as"]);
  const terms = (text: string) => tokenizeText(text).filter((term) => term.length >= 2 && !stopWords.has(term));
  const topic = new Set(terms(`${project.title} ${project.researchIdea ?? ""} ${artifact.report.relatedWorkDirections.join(" ")}`));
  const relevance = (text: string) => new Set(terms(text).filter((term) => topic.has(term))).size;
  // Assertions already supplied by Researcher; never manufacture quotes or turn goals/questions into assertions.
  const claims = [...new Set([...artifact.evidence.map((entry) => entry.claim),
    ...artifact.report.domainOverview.split(/(?<=[。！？.!?])\s+|\n+/)]
    .map((claim) => claim.trim()).filter((claim) => claim.length >= 20 && claim.length <= 4000))].slice(0, RESEARCH_SUPPLY_LIMITS.claims);
  if (!claims.length) fail("no_explicit_claim");
  const candidates = (await services.candidates.list(projectId)).filter((c) => c.origin === "academic_search" && c.status !== "rejected").slice(0, RESEARCH_SUPPLY_LIMITS.candidates);
  summary.reviewed = candidates.length;
  const identities = new Set<string>();
  const selected = candidates.filter((c) => {
    const key = identityKey(c.identity);
    if (!key || !c.title || !c.authors?.length || !c.year || !(c.identity.doi || c.identity.arxivId || c.identity.pmid)) { fail("metadata_insufficient"); return false; }
    if (relevance(`${c.title} ${c.snippetOrAbstract ?? ""}`) < 2) { fail("topic_mismatch"); return false; }
    if (identities.has(key)) { summary.deduplicated++; return false; }
    identities.add(key); return true;
  }).sort((a, b) => relevance(`${b.title} ${b.snippetOrAbstract ?? ""}`) - relevance(`${a.title} ${a.snippetOrAbstract ?? ""}`)).slice(0, RESEARCH_SUPPLY_LIMITS.sources);
  summary.selected = selected.length;
  options.progress?.("selection", { reviewed: summary.reviewed, selected: summary.selected, deduplicated: summary.deduplicated });
  const sourceIds: string[] = [];
  if (claims.length) for (const c of selected) {
    check();
    try {
      const r = await services.sourceImport.promoteCandidate(projectId, c.candidateId, { sourceRole: "evidence", deferFullText: true,
        selectionReason: "research-evidence-supply/v1: academic identity, complete metadata, topic overlap >=2; claim support unverified" });
      if (r.created) summary.promoted++; else summary.alreadyExists++;
      if (r.source.sourceRole !== "reference" && r.source.status !== "rejected") sourceIds.push(r.source.sourceId); else fail("source_ineligible");
    } catch { check(); summary.promoteFailed++; fail("promote_failed"); }
  }
  if (claims.length) for (const source of await services.sources.list(projectId)) {
    if (sourceIds.length >= RESEARCH_SUPPLY_LIMITS.sources) break;
    if (sourceIds.includes(source.sourceId) || source.sourceRole === "reference" || source.status === "rejected") continue;
    if (!(source.metadata.doi || source.metadata.arxivId) || relevance(source.metadata.title ?? "") < 2) continue;
    sourceIds.push(source.sourceId);
  }
  options.progress?.("promotion", { promoted: summary.promoted, alreadyExists: summary.alreadyExists, failed: summary.promoteFailed });
  const usable: string[] = [];
  for (const sourceId of sourceIds) {
    check();
    try {
      const r = await services.sourceImport.tryResolveFullText(projectId, sourceId, options);
      check();
      if (r.outcome !== "resolved" && r.outcome !== "skipped_has_file") {
        fail(`fulltext_${r.outcome}`);
        if (/429|rate.limit/i.test(r.note ?? "")) { fail("rate_limited_stop"); break; }
        continue;
      }
      const source = await services.sources.getRequired(projectId, sourceId);
      if (!source.fileName || source.status === "metadata_only") { fail("fulltext_unavailable"); continue; }
      summary.fulltext++;
      if ((await services.ingestion.getDocument(projectId, sourceId)) === null) {
        try { await services.ingestion.ingest(projectId, sourceId); } catch { check(); fail("ingestion_failed"); }
      }
      check();
      const indexed = await services.targetedGrounding.prepareSource(projectId, sourceId);
      if (indexed.status === "indexed" && indexed.chunkCount > 0) { summary.chunkedSources++; summary.chunks += indexed.chunkCount; usable.push(sourceId); }
      else fail(`chunks_${indexed.reason ?? "unavailable"}`);
    } catch { check(); fail("source_prepare_failed"); }
  }
  options.progress?.("retrieval", { fulltext: summary.fulltext, chunkedSources: summary.chunkedSources, chunks: summary.chunks });
  if (usable.length) {
    const grounded = await services.targetedGrounding.groundClaims(projectId, claims.map((claim) => ({
      claimId: `research-${createHash("sha256").update(claim).digest("hex").slice(0, 12)}`, claim, section: "related_work", sourceIds: usable,
    })), options);
    for (const outcome of grounded.outcomes) {
      if (!outcome.attempts.length) fail("no_relevant_chunk");
      for (const attempt of outcome.attempts) {
        summary.mappings.push({ claimId: outcome.claimId, sourceId: attempt.sourceId, chunkId: attempt.chunkId, outcome: attempt.outcome });
        if (attempt.outcome === "verified") summary.verified++; else if (attempt.outcome === "rejected" || attempt.outcome === "mismatch") summary.rejected++; else summary.unverifiable++;
        if (attempt.outcome !== "verified") fail(/quote_not_found/.test(attempt.reason ?? "") ? "quote_mismatch"
          : /metadata_mismatch/.test(attempt.reason ?? "") ? "metadata_mismatch"
          : /judge_unsupported/.test(attempt.reason ?? "") ? "judge_unsupported"
          : /judge_failed|judge_unavailable/.test(attempt.reason ?? "") ? "judge_unavailable_or_failed"
          : attempt.outcome);
      }
    }
  }
  check();
  const after = await services.evidenceGrounding.candidateStats(projectId);
  summary.proposed = after.total - before.total;
  summary.evidenceCandidatesAfter = after.total;
  summary.candidateSourcesPending = (await services.candidates.list(projectId, "pending_review")).length;
  summary.formalEvidence = (await services.evidenceSelection.selectForWriting(projectId)).formal.length;
  options.progress?.("grounding", { proposed: summary.proposed, verified: summary.verified, rejected: summary.rejected, unverifiable: summary.unverifiable, formalEvidence: summary.formalEvidence });
  return summary;
}
