/** Typed, deterministic policies used by the validation-aware revision harness. */
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";

export type RevisionViolationCode =
  | "metric_direction_flip" | "unsupported_claim" | "fact_direction_drift"
  | "citation_missing" | "citation_hallucinated" | "citation_removed"
  | "evidence_protocol_mismatch" | "scope_violation" | "unattributed_fact_violation"
  | "unauthorized_fact_removal" | "unauthorized_fact_change" | "placeholder_regression" | "unauthorized_formula_change"
  | "revision_meta_text"
  | "AUTHOR_DECISION_REQUIRED";

export interface StructuredPlanItem {
  actionType: "modify" | "noop" | "author_decision_required" | "evidence_only";
  logicalTarget?: string;
  target?: string;
  relatedEvidenceIds?: string[];
  mustPreserve?: string[];
  reason?: string;
  coverageQuote?: string;
  verificationBasis?: string;
  commentId?: string;
  requiredEvidence?: boolean;
  protocolId?: string;
  expectedOutcome?: string;
}

export interface StructuredPlanFailure { field: string; code: string; message: string }

/** 合法 typed action（与 StructuredPlanItem.actionType / externalInstructions 契约一致） */
const LEGAL_ACTION_TYPES: ReadonlySet<string> = new Set([
  "modify", "noop", "author_decision_required", "evidence_only",
]);

export function validateStructuredPlanItem(item: StructuredPlanItem, evidence: readonly EvidenceRecord[]): StructuredPlanFailure[] {
  const failures: StructuredPlanFailure[] = [];
  const fail = (field: string, code: string, message: string): void => { failures.push({ field, code, message }); };
  /**
   * M11.4 Attempt 8 修复（实证：clean run p-85d7749054b9，R1/R3 两条计划条目
   * 的 action 文本写着「作者决策必需：」但 actionType 字段缺失）——旧校验只
   * 检查各类型自己的约束，actionType 缺失/未识别时静默通过，派发侧
   * （collectRevisionDirectives）按未识别类型跳过并把意见记成 unresolved，
   * 而不是走合法的 author_decision 闭环或结构化修复通道。字段级 fail 让
   * bounded structured repair 把 actionType 补齐（repair prompt 已含原始条目）。
   */
  if (!LEGAL_ACTION_TYPES.has(String(item.actionType ?? ""))) {
    fail("actionType", "ACTION_TYPE_REQUIRED", "actionType must be one of modify / noop / author_decision_required / evidence_only");
  }
  if (!item.commentId?.trim()) fail("commentId", "COMMENT_LINK_REQUIRED", "comment linkage is required");
  if (!item.expectedOutcome?.trim()) fail("expectedOutcome", "EXPECTED_OUTCOME_REQUIRED", "expected outcome is required");
  if (item.actionType === "modify" && !(item.logicalTarget ?? item.target)?.trim()) fail("logicalTarget", "TARGET_REQUIRED", "modify requires a logical target");
  if (item.actionType === "noop") {
    if (!item.coverageQuote?.trim()) fail("coverageQuote", "NOOP_COVERAGE_REQUIRED", "noop requires a coverage quote");
    if (!(item.logicalTarget ?? item.target)?.trim()) fail("logicalTarget", "TARGET_REQUIRED", "noop requires a target");
    if (!item.verificationBasis?.trim()) fail("verificationBasis", "NOOP_VERIFICATION_REQUIRED", "noop requires a verification basis");
  }
  if (item.actionType === "author_decision_required" && !item.reason?.trim()) fail("reason", "DECISION_REASON_REQUIRED", "author decision requires a reason");
  if (item.actionType === "evidence_only" && !item.requiredEvidence) fail("requiredEvidence", "EVIDENCE_SEMANTICS_REQUIRED", "evidence_only requires explicit evidence semantics");
  if (item.requiredEvidence && (!item.relatedEvidenceIds || item.relatedEvidenceIds.length === 0)) fail("relatedEvidenceIds", "EVIDENCE_LINK_REQUIRED", "evidence-required action needs linked evidence");
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  for (const id of item.relatedEvidenceIds ?? []) {
    const record = byId.get(id);
    if (record === undefined) fail("relatedEvidenceIds", "INVALID_EVIDENCE_ID", `${id} is not in the project EvidenceStore`);
    else if (record.verificationStatus !== "verified") fail("relatedEvidenceIds", "EVIDENCE_NOT_VERIFIED", `${id} is not verified`);
    else if (record.protocolScope?.status === "superseded") fail("relatedEvidenceIds", "EVIDENCE_SUPERSEDED", `${id} is superseded`);
    else if (item.protocolId !== undefined && (record.protocolScope?.status !== "current" || record.protocolScope.protocolId !== item.protocolId)) fail("relatedEvidenceIds", "EVIDENCE_PROTOCOL_MISMATCH", `${id} is not current evidence for ${item.protocolId}`);
  }
  return failures;
}

/** Repair only named fields; prose mentions are deliberately not parsed for IDs. */
export function buildPlannerStructuredRepair(input: { original: StructuredPlanItem; failures: readonly StructuredPlanFailure[]; allowedEvidenceIds: readonly string[] }): string {
  return ["Repair only these invalid structured fields.", `Original structured output: ${JSON.stringify(input.original)}`, `Validation errors: ${JSON.stringify(input.failures)}`, `Allowed Evidence IDs: ${input.allowedEvidenceIds.join(", ") || "(none)"}`, "Only repair the invalid structured fields. Do not change scientific intent. Do not invent Evidence IDs. Return structured output only."].join("\n");
}

export interface PatchRepairDirective {
  patchId: string; planItemIds: string[]; commentIds: string[]; logicalTarget: string;
  originalText: string; proposedText?: string; mustPreserve: string[]; evidenceIds: string[];
  protocolId?: string; validationFailures: { code: RevisionViolationCode; detail: string; evidenceId?: string; metric?: string }[];
  forbiddenChanges: string[]; repairAttempt: number;
}

export function buildPatchRepairPrompt(directive: PatchRepairDirective): string {
  const failures = directive.validationFailures.map((failure) => `- ${failure.code}: ${failure.detail}${failure.metric ? ` (metric ${failure.metric})` : ""}${failure.evidenceId ? ` [${failure.evidenceId}]` : ""}`);
  return ["Revise only the patch identified below.", `Target: ${directive.logicalTarget}; patch: ${directive.patchId}; attempt: ${directive.repairAttempt}`, "Original verified text:", directive.originalText, "Previous invalid proposal:", directive.proposedText ?? "(none)", "Validation failures:", ...failures, `Verified evidence IDs: ${directive.evidenceIds.join(", ") || "none"}`, ...(directive.protocolId ? [`Required current protocol: ${directive.protocolId}`] : []), "Must preserve:", ...directive.mustPreserve.map((value) => `- ${value}`), "Forbidden changes:", ...directive.forbiddenChanges.map((value) => `- ${value}`), "For unsupported details, remove or weaken the detail; bind evidence only when an allowed verified record supports it.", "Return only the replacement text for this patch."].join("\n");
}

export interface RepairAttempt { attempt: number; rootViolationIds: string[]; resultPatchId?: string; passed: boolean }
export type RepairDecision = "accepted" | "retry" | "no_progress" | "exhausted" | "escalate" | "author_decision_required";
export function decidePatchRepair(attempts: readonly RepairAttempt[], options: { maxRepairs?: number; escalationModelConfigured: boolean; modelCorrectable: boolean }): RepairDecision {
  if (attempts.some((attempt) => attempt.passed)) return "accepted";
  if (!options.modelCorrectable || attempts.some((attempt) => attempt.rootViolationIds.includes("AUTHOR_DECISION_REQUIRED"))) return "author_decision_required";
  if (attempts.length >= 2 && attempts.at(-1)!.rootViolationIds.join("|") === attempts.at(-2)!.rootViolationIds.join("|")) return "no_progress";
  const limit = options.maxRepairs ?? 2;
  if (attempts.length < limit) return "retry";
  return options.escalationModelConfigured ? "escalate" : "exhausted";
}

export function selectFinalPatchRecords<T extends { patchId: string; overall: "pass" | "fail"; attempt?: number }>(records: readonly T[]): T[] {
  const byPatch = new Map<string, T>();
  for (const record of records) {
    const key = (record as T & { originalPatchId?: string }).originalPatchId ?? record.patchId;
    const current = byPatch.get(key);
    if (current === undefined || (record.overall === "pass" && current.overall !== "pass") || (record.overall === current.overall && (record.attempt ?? 0) >= (current.attempt ?? 0))) byPatch.set(key, record);
  }
  return [...byPatch.values()];
}

export function canReadHeldOutEvaluation(frozen: boolean): boolean { return frozen; }
