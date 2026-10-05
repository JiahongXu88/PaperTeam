import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import { buildPatchRepairPrompt, buildPlannerStructuredRepair, canReadHeldOutEvaluation, decidePatchRepair, selectFinalPatchRecords, validateStructuredPlanItem, type RepairAttempt } from "../../src/review/revisionHarness.js";

const evidence = (id: string, status: "current" | "superseded" = "current"): EvidenceRecord => ({
  id, claim: "metric X decreases from 8 to 5", verificationStatus: "verified", verificationLevel: "fulltext",
  protocolScope: { protocolId: "protocol-current", status }, createdBy: "test", createdAt: "2026-01-01",
});
const plan = (overrides: Record<string, unknown> = {}) => ({ actionType: "modify" as const, commentId: "c1", expectedOutcome: "preserve verified result", target: "results", requiredEvidence: true, relatedEvidenceIds: ["E003"], protocolId: "protocol-current", ...overrides });

describe("validation-aware revision harness policies", () => {
  it("validates missing evidence links and emits narrow structured repair prompt", () => {
    const item = plan({ relatedEvidenceIds: [] });
    const failures = validateStructuredPlanItem(item, [evidence("E003")]);
    expect(failures.map((failure) => failure.code)).toContain("EVIDENCE_LINK_REQUIRED");
    expect(buildPlannerStructuredRepair({ original: item, failures, allowedEvidenceIds: ["E003"] })).toContain("Only repair the invalid structured fields");
  });
  it("rejects invented and superseded evidence IDs", () => {
    expect(validateStructuredPlanItem(plan({ relatedEvidenceIds: ["E999"] }), [evidence("E003")]).map((x) => x.code)).toContain("INVALID_EVIDENCE_ID");
    expect(validateStructuredPlanItem(plan({ relatedEvidenceIds: ["E004"] }), [evidence("E004", "superseded")]).map((x) => x.code)).toContain("EVIDENCE_SUPERSEDED");
  });
  it("enforces action-specific contracts and comment linkage", () => {
    expect(validateStructuredPlanItem(plan({ actionType: "noop", target: undefined, coverageQuote: "", verificationBasis: "", relatedEvidenceIds: [] }), []).map((x) => x.code)).toEqual(expect.arrayContaining(["TARGET_REQUIRED", "NOOP_COVERAGE_REQUIRED", "NOOP_VERIFICATION_REQUIRED", "EVIDENCE_LINK_REQUIRED"]));
    expect(validateStructuredPlanItem(plan({ actionType: "author_decision_required", reason: "" }), []).map((x) => x.code)).toContain("DECISION_REASON_REQUIRED");
    expect(validateStructuredPlanItem(plan({ commentId: "" }), [evidence("E003")]).map((x) => x.code)).toContain("COMMENT_LINK_REQUIRED");
  });
  it("builds patch-local direction repair with explicit evidence and boundaries", () => {
    const prompt = buildPatchRepairPrompt({ patchId: "P3", planItemIds: ["i3"], commentIds: ["c3"], logicalTarget: "Results", originalText: "X decreases 8 to 5", proposedText: "X improves", mustPreserve: ["X decreases from 8 to 5"], evidenceIds: ["E005"], protocolId: "current", validationFailures: [{ code: "metric_direction_flip", detail: "direction changed", metric: "X", evidenceId: "E005" }], forbiddenChanges: ["change metric direction", "edit other patches"], repairAttempt: 1 });
    expect(prompt).toContain("metric_direction_flip"); expect(prompt).toContain("E005"); expect(prompt).toContain("only the patch");
  });
  it("bounds retries, stops same-root-cause loops, and escalates only when configured", () => {
    const repeated: RepairAttempt[] = [{ attempt: 1, rootViolationIds: ["metric_direction_flip"], passed: false }, { attempt: 2, rootViolationIds: ["metric_direction_flip"], passed: false }];
    expect(decidePatchRepair(repeated, { escalationModelConfigured: true, modelCorrectable: true })).toBe("no_progress");
    expect(decidePatchRepair([{ attempt: 1, rootViolationIds: ["citation_missing"], passed: false }, { attempt: 2, rootViolationIds: ["unsupported_claim"], passed: false }], { escalationModelConfigured: true, modelCorrectable: true })).toBe("escalate");
    expect(decidePatchRepair([{ attempt: 1, rootViolationIds: ["citation_missing"], passed: false }, { attempt: 2, rootViolationIds: ["unsupported_claim"], passed: false }], { escalationModelConfigured: false, modelCorrectable: true })).toBe("exhausted");
    expect(decidePatchRepair([], { escalationModelConfigured: true, modelCorrectable: false })).toBe("author_decision_required");
  });
  it("selects final accepted patch versions while retaining attempt history in source records", () => {
    const records = [{ patchId: "P1", overall: "pass" as const, attempt: 0 }, { patchId: "P2", overall: "fail" as const, attempt: 0 }, { patchId: "P2", overall: "pass" as const, attempt: 1 }];
    expect(selectFinalPatchRecords(records)).toEqual([records[0], records[2]]);
    expect(records).toHaveLength(3);
  });
  it("blocks held-out reads before freeze and permits them after freeze", () => {
    expect(canReadHeldOutEvaluation(false)).toBe(false);
    expect(canReadHeldOutEvaluation(true)).toBe(true);
  });
});
