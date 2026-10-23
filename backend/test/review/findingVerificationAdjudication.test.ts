/**
 * M15.2 finding 定向复核（findingVerification）+ 四轴裁决（findingAdjudication）：确定性单元测试（合成夹具）。
 */
import { describe, expect, it } from "vitest";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { buildClaimAudit, type ClaimAuditUnitInput } from "../../src/review/claimAudit.js";
import { auditFindings } from "../../src/review/findingAudit.js";
import { applyFindingRecheck, parseFindingRecheckOutput, renderFindingRecheckPrompt, selectFindingRecheckItems } from "../../src/review/findingVerification.js";
import { adjudicateFindings, validateFindingAdjudication } from "../../src/review/findingAdjudication.js";
import { findingFingerprint } from "../../src/review/revisionPlan.js";

const ABSTRACT = "\\title{FastTrack: A Tracker}\n\\begin{abstract}\nThe proposed FastTrack achieves an HOTA of 63.7\\% on the MOT17 dataset.\n\\end{abstract}\n";
const METHOD = "\\section{Method}\nThe association threshold is applied to every detection and tracks are kept for a fixed time.\n";
const SETUP = "\\section{Implementation Details}\nWe set the thresholds TH and TL to 0.8 and 0.5 respectively for all sequences of MOT17.\n";
const RESULTS = [
  "\\section{Results}",
  "\\begin{table}[t]",
  "\\caption{Test results on MOT17.}\\label{tab:main}",
  "\\begin{tabular}{lcc}",
  "\\toprule",
  "Tracker & HOTA & IDF1 \\\\",
  "\\midrule",
  "FastTrack (ours) & 61.7 & 74.4 \\\\",
  "Other & 58.2 & 70.4 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "",
].join("\n");
const FILE = `${ABSTRACT}${METHOD}${SETUP}${RESULTS}`;

function units(): ClaimAuditUnitInput[] {
  const parts: Array<[string, string, string, string]> = [["frontmatter", "frontmatter", "Abstract", ABSTRACT], ["method", "section:Method", "Method", METHOD], ["setup", "section:Implementation Details", "Implementation Details", SETUP], ["results", "section:Results", "Results", RESULTS]];
  let offset = 0;
  return parts.map(([key, spanId, heading, text]) => {
    const unit: ClaimAuditUnitInput = {
      unitId: `main.tex::${spanId}`, file: "main.tex", spanId, heading, contentHash: `h-${key}`, chars: text.length, text, fileOffset: offset,
      reviewStatus: "completed", reused: false,
      extraction: {
        status: "EXTRACTED", contract: "unit-claims/v1", errors: [], repairAttempts: 0,
        claims: key === "frontmatter"
          ? [{ index: 0, quote: "achieves an HOTA of 63.7\\% on the MOT17 dataset", check: "INCONSISTENT", counterpartQuote: "FastTrack (ours) & 61.7 & 74.4", claimValue: "63.7%", counterpartValue: "61.7" }]
          : [],
      },
    };
    offset += text.length;
    return unit;
  });
}

const ISSUES: ReviewIssue[] = [
  { category: "fact", severity: "critical", section: "Abstract", description: "Abstract HOTA 63.7 contradicts Table tab:main (61.7).", quote: "achieves an HOTA of 63.7\\% on the MOT17 dataset", blocking: true, file: "main.tex", logicalSection: "frontmatter", verification: "VERIFIED_IN_TEXT" },
  { category: "fact", severity: "major", section: "Results", description: "The table value 61.7 disagrees with the abstract claim of 63.7.", quote: "FastTrack (ours) & 61.7 & 74.4", blocking: false, file: "main.tex", logicalSection: "section:Results" },
  { category: "academic", severity: "major", section: "Method", description: "The thresholds TH and TL are not specified anywhere in this section.", quote: "The association threshold is applied to every detection", blocking: false, file: "main.tex", logicalSection: "section:Method" },
  { category: "academic", severity: "critical", section: "Method", description: "Tracks are kept for a fixed time, but the paper does not justify this; the authors must clarify.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method", verification: "AUTHOR_CHECK_REQUIRED" },
  { category: "style", severity: "minor", section: "Method", description: "Wording is vague.", quote: "applied to every detection and tracks", blocking: false, file: "main.tex", logicalSection: "section:Method" },
];

function audit() {
  const unitInputs = units();
  const artifact = buildClaimAudit({
    projectId: "p", round: 1, sourceRevision: 2, documentFingerprint: "snap", files: [{ file: "main.tex", content: FILE }], coverageMode: "units", claimAuditMode: "extended",
    reviewPurpose: "published_paper_assessment", unitContextPolicy: "shared_session", units: unitInputs,
    sourceVerification: { level: "AUTHOR_SOURCE", basis: "DECLARED_INPUT_PROVENANCE", note: "t" }, body: { targetChars: FILE.length, reviewedChars: FILE.length, ratio: 1, complete: true },
  });
  artifact.findingAudit = auditFindings({ issues: ISSUES, units: unitInputs.map((unit) => ({ unitId: unit.unitId, file: unit.file, heading: unit.heading, text: unit.text })), sourceVerification: "AUTHOR_SOURCE" });
  return { artifact, unitInputs };
}

describe("M15.2 finding 定向复核：确定性队列 + 引文校验", () => {
  it("CONTEXT_INCOMPLETE 的 major 进入队列并带其他单元的候选片段；预算 0 → SKIPPED_BUDGET（不调用、不降级）", () => {
    const { artifact, unitInputs } = audit();
    const record = artifact.findingAudit!.records[2]!;
    expect(record.auditStatus).toBe("CONTEXT_INCOMPLETE");
    const textUnits = unitInputs.map((unit) => ({ unitId: unit.unitId, heading: unit.heading, text: unit.text }));
    const selected = selectFindingRecheckItems({ issues: ISSUES, records: artifact.findingAudit!.records, units: textUnits, maxItems: 6 });
    expect(selected.items.map((item) => item.issueIndex)).toEqual([2]);
    expect(selected.items[0]!.snippets[0]!.text).toContain("TH and TL to 0.8 and 0.5");
    expect(renderFindingRecheckPrompt(selected.items)).toContain("findingId=");
    const none = selectFindingRecheckItems({ issues: ISSUES, records: artifact.findingAudit!.records, units: textUnits, maxItems: 0 });
    expect(none.items).toHaveLength(0);
    expect(none.records.find((entry) => entry.issueIndex === 2)?.outcome).toBe("SKIPPED_BUDGET");
  });
  it("反驳须逐字落在片段中且含被断言缺失的术语；否则 UNRESOLVED；NOT_DETERMINABLE / 失败保持原 finding", () => {
    const { artifact, unitInputs } = audit();
    const textUnits = unitInputs.map((unit) => ({ unitId: unit.unitId, heading: unit.heading, text: unit.text }));
    const { items } = selectFindingRecheckItems({ issues: ISSUES, records: artifact.findingAudit!.records, units: textUnits, maxItems: 6 });
    const id = items[0]!.findingId;
    const run = (results: Array<Record<string, unknown>>, status: "COMPLETED" | "FAILED" = "COMPLETED") =>
      applyFindingRecheck(items, [{ batchId: "FB1", items, status, results: parseFindingRecheckOutput({ results }, new Set([id])) }])[0]!;
    expect(run([{ findingId: id, verdict: "REFUTED", evidenceQuote: "We set the thresholds TH and TL to 0.8 and 0.5", snippetId: "F1" }]).outcome).toBe("REFUTED_BY_DOCUMENT_CONTEXT");
    expect(run([{ findingId: id, verdict: "PARTIALLY_REFUTED", evidenceQuote: "We set the thresholds TH and TL to 0.8 and 0.5", snippetId: "F1" }]).outcome).toBe("PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT");
    expect(run([{ findingId: id, verdict: "REFUTED", evidenceQuote: "The thresholds are listed in the appendix table" }]).outcome).toBe("UNRESOLVED");
    expect(run([{ findingId: id, verdict: "REFUTED", evidenceQuote: "respectively for all sequences of MOT17" }]).outcome).toBe("UNRESOLVED");
    expect(run([{ findingId: id, verdict: "NOT_DETERMINABLE" }]).outcome).toBe("UNRESOLVED");
    expect(run([], "FAILED").outcome).toBe("FAILED");
    expect(parseFindingRecheckOutput({ results: [{ findingId: "forged", verdict: "REFUTED" }] }, new Set([id]))).toHaveLength(0);
  });
  it("转写稿上的公式损坏类 finding：没有页面级原件 → 不调用模型，UNRESOLVABLE_NO_PAGE_PROVENANCE", () => {
    const issue: ReviewIssue = { category: "build", severity: "major", section: "Method", description: "Equation (2) is garbled and unreadable.", quote: "\\[ si iou(M,bi) < NM s∗i= (2) \\]", blocking: false, file: "main.tex", logicalSection: "section:Method" };
    const text = "\\section{Method}\nWe define the score as \\[ si iou(M,bi) < NM s∗i= (2) \\] for each box.\n";
    const unit = { unitId: "main.tex::section:Method", file: "main.tex", heading: "Method", text };
    const records = auditFindings({ issues: [issue], units: [unit], sourceVerification: "SOURCE_UNVERIFIED" }).records;
    expect(records[0]!.auditStatus).toBe("PARSE_ARTIFACT_SUSPECTED");
    const selected = selectFindingRecheckItems({ issues: [issue], records, units: [unit], maxItems: 6 });
    expect(selected.items).toHaveLength(0);
    expect(selected.records[0]!.outcome).toBe("UNRESOLVABLE_NO_PAGE_PROVENANCE");
  });
});

describe("M15.2 四轴裁决（shadow）", () => {
  it("证书级矛盾：摘要 + 表格两条 finding 合并为一个根因；VERIFIED_BY_CERTIFICATE、触及摘要 → blocking；不改 issues", () => {
    const { artifact } = audit();
    const claim = artifact.claims[0]!;
    expect(claim.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    const before = JSON.stringify(ISSUES);
    const result = adjudicateFindings({
      round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "VALID", findingRecheck: [], sourceVerification: "AUTHOR_SOURCE",
    });
    expect(JSON.stringify(ISSUES)).toBe(before);
    const cause = result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 0))!;
    expect(cause.findings.map((finding) => finding.issueIndex).sort()).toEqual([0, 1]);
    expect(cause.verification.axis).toBe("VERIFIED_BY_CERTIFICATE");
    expect(cause.impact.blocking).toBe(true);
    expect(cause.taskScope.axis).toBe("NOT_APPLICABLE_READ_ONLY");
    // M15.2.1（N03）：作者核对类 critical 不再机械封顶 major——核验等级与严重度解耦，观察值保留
    const author = result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 3))!;
    expect(author.verification.axis).toBe("AUTHOR_CHECK_REQUIRED");
    expect(author.severity).toMatchObject({ observed: "critical", adjudicated: "critical", rules: ["NO_CHANGE"] });
    expect(author.impact.blocking).toBe(false);
    // 词面 CONTEXT_INCOMPLETE 且未复核 → NOT_EVALUATED、severity 不变（不自动降级）
    const context = result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 2))!;
    expect(context.verification.axis).toBe("NOT_EVALUATED");
    expect(context.severity.adjudicated).toBe("major");
    expect(result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 4))!.verification.axis).toBe("NOT_APPLICABLE_STYLE");
    expect(result.summary.criticalMajorFindingsObserved).toBe(4);
    expect(result.summary.criticalMajorRootCausesObserved).toBe(3);
    expect(validateFindingAdjudication(result, { sourceRevision: 2, documentFingerprint: "snap" }).status).toBe("VALID");
    expect(validateFindingAdjudication(result, { sourceRevision: 3, documentFingerprint: "snap" }).status).toBe("STALE");
  });
  it("定向复核有效反驳 → DOCUMENT_CONTEXT_CONTRADICTS（撤回候选，裁决 minor，finding 不删）；账本 STALE → 不用证书", () => {
    const { artifact } = audit();
    const recheck = [{ findingId: artifact.findingAudit!.records[2]!.findingId, issueIndex: 2, reason: "CONTEXT_INCOMPLETE" as const, outcome: "REFUTED_BY_DOCUMENT_CONTEXT" as const, validation: "ok", snippets: [] }];
    const result = adjudicateFindings({
      round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "VALID", findingRecheck: recheck, sourceVerification: "AUTHOR_SOURCE",
    });
    const refuted = result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 2))!;
    expect(refuted.verification.axis).toBe("DOCUMENT_CONTEXT_CONTRADICTS");
    expect(refuted.severity).toMatchObject({ observed: "major", adjudicated: "minor", rules: ["DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE"] });
    // 部分反驳：意见其余部分仍成立 → 不撤回、不改严重度
    const partial = adjudicateFindings({
      round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "VALID", findingRecheck: [{ ...recheck[0]!, outcome: "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT" as const }], sourceVerification: "AUTHOR_SOURCE",
    }).rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 2))!;
    expect(partial.verification.axis).toBe("REVIEWER_GROUNDED_SUSPICION");
    expect(partial.severity.adjudicated).toBe("major");
    const stale = adjudicateFindings({
      round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "STALE", findingRecheck: [], sourceVerification: "AUTHOR_SOURCE",
    });
    expect(stale.rootCauses.every((entry) => entry.verification.axis !== "VERIFIED_BY_CERTIFICATE")).toBe(true);
    expect(stale.summary.blocking).toBe(0);
  });
  it("返修工作流 taskScope：生产归层 revision_introduced / baseline_inherited / 用户意见章节；转写稿损坏类 → INPUT_PARSE_UNRELIABLE", () => {
    const { artifact } = audit();
    const origins = [
      { fingerprint: findingFingerprint(ISSUES[3]!), section: "Method", severity: "critical", blocking: false, origin: "revision_introduced" as const, basis: "t", description: "" },
      { fingerprint: findingFingerprint(ISSUES[1]!), section: "Results", severity: "major", blocking: false, origin: "baseline_inherited" as const, basis: "t", description: "" },
    ];
    const result = adjudicateFindings({
      round: 2, sourceRevision: 4, documentFingerprint: "snap", policy: "revision_task", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "VALID", findingRecheck: [], sourceVerification: "AUTHOR_SOURCE",
      findingOrigins: origins, instructionSections: ["Implementation Details"], findingFingerprint,
    });
    expect(result.rootCauses.find((entry) => entry.findings.some((finding) => finding.issueIndex === 3))!.taskScope.axis).toBe("REVISION_INTRODUCED");
    const transcribed = adjudicateFindings({
      round: 1, sourceRevision: 1, documentFingerprint: "snap", policy: "quick_review",
      issues: [{ category: "build", severity: "major", section: "Method", description: "Equation is garbled.", blocking: false }],
      files: [], claimAudit: null, claimAuditValidation: "ABSENT", findingRecheck: [{ findingId: "x", issueIndex: 0, reason: "PARSE_ARTIFACT_SUSPECTED", outcome: "UNRESOLVABLE_NO_PAGE_PROVENANCE", validation: "", snippets: [] }],
      sourceVerification: "SOURCE_UNVERIFIED",
    });
    expect(transcribed.rootCauses[0]!.verification.axis).toBe("INPUT_PARSE_UNRELIABLE");
    expect(transcribed.rootCauses[0]!.severity.adjudicated).toBe("minor");
  });
  it("一致性契约：blocking 而无证书 → MALFORMED", () => {
    const { artifact } = audit();
    const result = adjudicateFindings({
      round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues: ISSUES, files: [{ file: "main.tex", content: FILE }],
      claimAudit: artifact, claimAuditValidation: "VALID", findingRecheck: [], sourceVerification: "AUTHOR_SOURCE",
    });
    const forged = structuredClone(result);
    forged.rootCauses.find((entry) => entry.verification.axis === "AUTHOR_CHECK_REQUIRED")!.impact.blocking = true;
    expect(validateFindingAdjudication(forged, { sourceRevision: 2, documentFingerprint: "snap" }).status).toBe("MALFORMED");
  });
});
