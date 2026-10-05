import { createHash } from "node:crypto";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";

export interface RevisionSpan {
  file: string;
  logicalSection: string;
  heading: string;
  label?: string;
  start: number;
  end: number;
  originalHash: string;
  content: string;
}

export interface RevisionScopeDiff {
  allowed: boolean;
  outsideScopeChanges: number;
  reason?: string;
}

export interface NoopCoverageCheck {
  logicalSection?: string;
  coverageQuote?: string;
  evidenceIds: string[];
  protocolId?: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Lightweight structural locator for single-file LaTeX manuscripts. */
export function locateLatexSections(file: string, source: string): RevisionSpan[] {
  const headings: Array<{ start: number; command: string; title: string; label?: string }> = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const rest = source.slice(start + match[0].length, start + match[0].length + 400);
    const label = /^\s*\\label\{([^}]+)\}/.exec(rest)?.[1];
    headings.push({ start, command: match[1] ?? "section", title: (match[2] ?? "").trim(), ...(label ? { label } : {}) });
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? source.length;
    const content = source.slice(heading.start, end);
    const logicalSection = heading.label ?? `${heading.command}:${heading.title}`;
    return {
      file,
      logicalSection,
      heading: heading.title,
      ...(heading.label ? { label: heading.label } : {}),
      start: heading.start,
      end,
      originalHash: hash(content),
      content,
    };
  });
}

export function applyRevisionSpan(source: string, span: RevisionSpan, replacement: string): string {
  const current = source.slice(span.start, span.end);
  if (hash(current) !== span.originalHash) {
    throw new Error(`REVISION_TARGET_STALE: ${span.logicalSection}`);
  }
  return source.slice(0, span.start) + replacement + source.slice(span.end);
}

/** Exact prefix/suffix boundary check: all changed text must fit the authorized span. */
export function checkRevisionScope(
  baseline: string,
  candidate: string,
  allowed: Pick<RevisionSpan, "start" | "end" | "originalHash">,
): RevisionScopeDiff {
  if (hash(baseline.slice(allowed.start, allowed.end)) !== allowed.originalHash) {
    return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_TARGET_STALE" };
  }
  let prefix = 0;
  while (prefix < baseline.length && prefix < candidate.length && baseline[prefix] === candidate[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < baseline.length - prefix &&
    suffix < candidate.length - prefix &&
    baseline[baseline.length - 1 - suffix] === candidate[candidate.length - 1 - suffix]
  ) suffix += 1;
  const oldEnd = baseline.length - suffix;
  const within = prefix >= allowed.start && oldEnd <= allowed.end;
  return within
    ? { allowed: true, outsideScopeChanges: 0 }
    : { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" };
}

export function revisionSpansOverlap(a: RevisionSpan, b: RevisionSpan): boolean {
  return a.file === b.file && a.start < b.end && b.start < a.end;
}

export function hasNewContentAfterDocumentEnd(baseline: string, candidate: string): boolean {
  const tail = (value: string): string => {
    const end = value.lastIndexOf("\\end{document}");
    return end < 0 ? "" : value.slice(end + "\\end{document}".length);
  };
  const oldTail = tail(baseline);
  const newTail = tail(candidate);
  return newTail !== oldTail && newTail.trim() !== "";
}

export function verifyNoopCoverage(
  item: NoopCoverageCheck,
  spans: readonly RevisionSpan[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
): { verified: boolean; reason?: string; span?: RevisionSpan } {
  const span = spans.find((candidate) => candidate.logicalSection === item.logicalSection);
  if (span === undefined) return { verified: false, reason: "NOOP_TARGET_UNRESOLVED" };
  const quote = item.coverageQuote?.trim();
  if (!quote || !span.content.includes(quote)) return { verified: false, reason: "NOOP_COVERAGE_QUOTE_MISSING" };
  if (item.evidenceIds.length === 0) return { verified: false, reason: "NOOP_EVIDENCE_REQUIRED" };
  for (const id of item.evidenceIds) {
    const record = evidenceById.get(id);
    if (record === undefined || (record.verificationStatus !== "verified" && record.verificationLevel !== "user_confirmed")) {
      return { verified: false, reason: "NOOP_EVIDENCE_UNVERIFIED" };
    }
    if (item.protocolId !== undefined && (record.protocolScope?.protocolId !== item.protocolId || record.protocolScope.status !== "current")) {
      return { verified: false, reason: "NOOP_PROTOCOL_MISMATCH" };
    }
    if (item.protocolId === undefined && record.protocolScope !== undefined && record.protocolScope.status !== "current") {
      return { verified: false, reason: "NOOP_PROTOCOL_HISTORICAL" };
    }
  }
  return { verified: true, span };
}
