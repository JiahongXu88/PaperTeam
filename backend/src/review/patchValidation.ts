import { createHash } from "node:crypto";
import type { RevisionSpan } from "./revisionScope.js";

export interface PatchValidationPatch {
  patchId: string;
  planItemIds: string[];
  commentIds: string[];
  span: RevisionSpan;
  addedKeys?: string[];
  removedKeys?: string[];
}

export interface PatchCitationFinding {
  code: "ADDED_CITATION_KEY" | "MISSING_CITATION_KEY" | "REMOVED_CITATION_KEY" | "UNATTRIBUTED_CITATION_VIOLATION" | "AMBIGUOUS_PATCH_ATTRIBUTION";
  key: string;
  location: { file: string; offset: number; logicalSection?: string };
  patchId?: string;
  planItemIds?: string[];
  commentIds?: string[];
}

export interface PatchCitationAttribution {
  findings: PatchCitationFinding[];
  unattributed: PatchCitationFinding[];
}

export interface PatchValidationRecord {
  patchId: string;
  /** Immutable generation/repair lineage; absent on legacy records. */
  attempt?: number;
  parentAttempt?: number;
  repairReasonFindingIds?: string[];
  originalPatchId?: string;
  rootViolationIds?: string[];
  modelRole?: "revision.primary" | "revision.escalation";
  finalStatus?: "accepted" | "rejected" | "exhausted" | "no_progress";
  revisionId: string;
  file: string;
  logicalTarget: string;
  planItemIds: string[];
  commentIds: string[];
  evidenceIds: string[];
  protocolId?: string;
  beforeFileHash: string;
  beforeTargetHash: string;
  proposedReplacementHash: string;
  afterFileHash: string;
  scope: { ok: boolean; violations: string[] };
  workspaceIntegrity: { ok: boolean; directMutationDetected: boolean; recoveryAttempted?: boolean; recoverySucceeded: boolean };
  fact: { ok: boolean; findingIds: string[]; violations: string[] };
  citation: { ok: boolean; findingIds: string[]; addedKeys: string[]; removedKeys: string[]; violations: string[] };
  evidence: { ok: boolean; violations: string[] };
  apply: { ok: boolean; status: "applied" | "rejected" };
  overall: "pass" | "fail";
  failedStage?: string;
}

export interface PatchValidationArtifact {
  revisionId: string;
  revision: number;
  records: PatchValidationRecord[];
  /** Failed and superseded generations retained for audit; summary uses records only. */
  attemptHistory?: PatchValidationRecord[];
  summary: RevisionValidationSummary;
}

export interface RevisionValidationSummary {
  /** Number of logical patch lineages, independent of retries. */
  logicalPatchCount?: number;
  attemptCount?: number;
  acceptedPatchCount?: number;
  failedLogicalPatchCount?: number;
  repairSuccessCount?: number;
  repairExhaustedCount?: number;
  totalPatches: number;
  passedPatches: number;
  failedPatches: number;
  unattributedViolations: string[];
  scopeOk: boolean;
  factOk: boolean;
  citationOk: boolean;
  evidenceOk: boolean;
  publishable: boolean;
  patchFirstPassPassRate?: number;
  patchRepairAttempts?: number;
  patchRepairSuccessRate?: number;
  violationsByType?: Record<string, number>;
  escalationCount?: number;
  finalAcceptedPatchCount?: number;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const CITE = /\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite|nocite)\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g;

function occurrences(source: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  CITE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE.exec(source)) !== null) {
    for (const key of (match[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
      const offsets = result.get(key) ?? [];
      offsets.push(match.index);
      result.set(key, offsets);
    }
  }
  return result;
}

function sectionAt(source: string, offset: number): string | undefined {
  const pattern = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}]*)\}/gm;
  let current: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && match.index <= offset) current = (match[1] ?? "").trim();
  return current;
}

export function attributeCitationChangesToPatches(input: {
  before: string;
  after: string;
  patches: PatchValidationPatch[];
  knownKeys: ReadonlySet<string>;
}): PatchCitationAttribution {
  const before = occurrences(input.before);
  const after = occurrences(input.after);
  const findings: PatchCitationFinding[] = [];
  for (const [key, offsets] of after) {
    const oldCount = before.get(key)?.length ?? 0;
    if (offsets.length > oldCount) {
      const offset = offsets[offsets.length - 1]!;
      findings.push({ code: input.knownKeys.has(key) ? "ADDED_CITATION_KEY" : "MISSING_CITATION_KEY", key, location: { file: "main.tex", offset, logicalSection: sectionAt(input.after, offset) } });
    }
  }
  for (const [key, offsets] of before) {
    const removedCount = offsets.length - (after.get(key)?.length ?? 0);
    if (removedCount > 0) {
      const offset = offsets[offsets.length - 1]!;
      findings.push({ code: "REMOVED_CITATION_KEY", key, location: { file: "main.tex", offset, logicalSection: sectionAt(input.before, offset) } });
    }
  }
  for (const finding of findings) {
    let matching = input.patches.filter((patch) => patch.span.file === finding.location.file &&
      (patch.span.heading === finding.location.logicalSection || patch.span.logicalSection === finding.location.logicalSection ||
        (patch.span.label !== undefined && patch.span.label === finding.location.logicalSection)));
    // Section offsets can shift when a Writer proposal changes headings. The per-proposal
    // key delta is a deterministic fallback tied to the actual patch content.
    if (matching.length === 0) {
      matching = input.patches.filter((patch) => (finding.code === "MISSING_CITATION_KEY" || finding.code === "ADDED_CITATION_KEY"
        ? patch.addedKeys?.includes(finding.key)
        : patch.removedKeys?.includes(finding.key)) ?? false);
    }
    if (matching.length === 1) {
      const patch = matching[0]!;
      Object.assign(finding, { patchId: patch.patchId, planItemIds: patch.planItemIds, commentIds: patch.commentIds });
    } else {
      finding.code = matching.length > 1 ? "AMBIGUOUS_PATCH_ATTRIBUTION" : "UNATTRIBUTED_CITATION_VIOLATION";
    }
  }
  return { findings, unattributed: findings.filter((finding) => finding.patchId === undefined) };
}

export function summarizePatchValidation(records: readonly PatchValidationRecord[], unattributedViolations: string[] = [], attempts: readonly PatchValidationRecord[] = records): RevisionValidationSummary {
  const firstByPatch = new Map<string, PatchValidationRecord>();
  const finalByPatch = new Map<string, PatchValidationRecord>();
  for (const record of attempts) {
    const key = record.originalPatchId ?? record.patchId.replace(/\.a\d+$/, "");
    const first = firstByPatch.get(key);
    if (first === undefined || (record.attempt ?? 0) < (first.attempt ?? 0)) firstByPatch.set(key, record);
    const final = finalByPatch.get(key);
    if (final === undefined || (record.overall === "pass" && final.overall !== "pass") ||
      (record.overall === final.overall && (record.attempt ?? 0) >= (final.attempt ?? 0))) finalByPatch.set(key, record);
  }
  const finalRecords = [...finalByPatch.values()];
  const allPass = finalRecords.every((record) => record.overall === "pass");
  const repairAttempts = attempts.filter((record) => (record.attempt ?? 0) > 0);
  const repairedPatches = [...finalByPatch].filter(([key]) => attempts.some((record) => (record.originalPatchId ?? record.patchId.replace(/\.a\d+$/, "")) === key && (record.attempt ?? 0) > 0));
  const violationsByType: Record<string, number> = {};
  for (const record of attempts) for (const violation of record.rootViolationIds ?? []) violationsByType[violation] = (violationsByType[violation] ?? 0) + 1;
  return {
    totalPatches: finalRecords.length,
    passedPatches: finalRecords.filter((record) => record.overall === "pass").length,
    failedPatches: finalRecords.filter((record) => record.overall === "fail").length,
    logicalPatchCount: finalRecords.length,
    attemptCount: attempts.length,
    acceptedPatchCount: finalRecords.filter((record) => record.overall === "pass" && record.finalStatus !== "rejected" && record.finalStatus !== "exhausted" && record.finalStatus !== "no_progress").length,
    failedLogicalPatchCount: finalRecords.filter((record) => record.overall !== "pass").length,
    repairSuccessCount: repairedPatches.filter(([, record]) => record.overall === "pass").length,
    repairExhaustedCount: finalRecords.filter((record) => record.finalStatus === "exhausted" || record.finalStatus === "no_progress").length,
    unattributedViolations: [...unattributedViolations],
    scopeOk: finalRecords.every((record) => record.scope.ok),
    factOk: finalRecords.every((record) => record.fact.ok),
    citationOk: finalRecords.every((record) => record.citation.ok),
    evidenceOk: finalRecords.every((record) => record.evidence.ok),
    publishable: allPass && unattributedViolations.length === 0,
    patchFirstPassPassRate: firstByPatch.size === 0 ? 1 : [...firstByPatch.values()].filter((record) => record.overall === "pass").length / firstByPatch.size,
    patchRepairAttempts: repairAttempts.length,
    patchRepairSuccessRate: repairedPatches.length === 0 ? 1 : repairedPatches.filter(([, record]) => record.overall === "pass").length / repairedPatches.length,
    violationsByType,
    escalationCount: attempts.filter((record) => record.modelRole === "revision.escalation").length,
    finalAcceptedPatchCount: finalRecords.filter((record) => record.overall === "pass").length,
  };
}

export function validationForComment(records: readonly PatchValidationRecord[], commentId: string): {
  fact: boolean; citation: boolean; evidence: boolean; overall: boolean;
} | null {
  const owned = records.filter((record) => record.commentIds.includes(commentId));
  if (owned.length === 0) return null;
  const final = new Map<string, PatchValidationRecord>();
  for (const record of owned) {
    const key = record.originalPatchId ?? record.patchId;
    const previous = final.get(key);
    if (previous === undefined || (record.overall === "pass" && previous.overall !== "pass") || (record.overall === previous.overall && (record.attempt ?? 0) >= (previous.attempt ?? 0))) final.set(key, record);
  }
  const selected = [...final.values()];
  return {
    fact: selected.every((record) => record.fact.ok),
    citation: selected.every((record) => record.citation.ok),
    evidence: selected.every((record) => record.evidence.ok),
    overall: selected.every((record) => record.overall === "pass"),
  };
}

export const patchValidationHash = hash;
