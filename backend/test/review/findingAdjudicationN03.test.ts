/**
 * M15.2.1 P0-C（N03）：核验等级 ≠ 严重度 ≠ 阻断——三轴解耦。
 * - 无证书的观察 Critical 不再被机械封顶 major（N03-V01 真实注入缺陷曾被 CRITICAL_REQUIRES_VERIFICATION /
 *   AUTHOR_OR_EXTERNAL_CAPPED_AT_MAJOR 压级）；核验状态单独记录在 verification 轴；
 * - 严重度只允许确定性上调（证书证实的核心矛盾）与有反证 / 可证转写损坏的下调；
 * - 读取方契约同步：上调须证书规则码、下调须反证 / 转写规则码，critical 裁决允许出现在未核验轴。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）；确定性零模型。
 */
import { describe, expect, it } from "vitest";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { buildClaimAudit, type ClaimAuditUnitInput } from "../../src/review/claimAudit.js";
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
  "Tracker & HOTA & IDF1 \\\\",
  "FastTrack (ours) & 61.7 & 74.4 \\\\",
  "Other & 58.2 & 70.4 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "",
].join("\n");
const FILE = `${ABSTRACT}${METHOD}${SETUP}${RESULTS}`;

function unitsWithContradiction(): ClaimAuditUnitInput[] {
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

const base = (issues: ReviewIssue[], overrides: Partial<Parameters<typeof adjudicateFindings>[0]> = {}) => adjudicateFindings({
  round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues,
  files: [{ file: "main.tex", content: FILE }], claimAudit: null, claimAuditValidation: "ABSENT", findingRecheck: [], sourceVerification: "AUTHOR_SOURCE",
  ...overrides,
});

describe("M15.2.1 P0-C（N03）核验等级与严重度解耦", () => {
  it("无证书的观察 Critical 保留：模型有依据的怀疑（REVIEWER_GROUNDED_SUSPICION）不再封顶 major", () => {
    // N03-V01 形态：真实注入的 Critical 缺陷，无证书、无作者声明——修复前被 CRITICAL_REQUIRES_VERIFICATION 压成 major
    const issue: ReviewIssue = { category: "academic", severity: "critical", section: "Method", description: "The evaluation protocol is inconsistent with the stated metric definition.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method" };
    const result = base([issue]);
    const cause = result.rootCauses[0]!;
    expect(cause.verification.axis).toBe("REVIEWER_GROUNDED_SUSPICION");
    expect(cause.severity).toMatchObject({ observed: "critical", adjudicated: "critical", changed: false, rules: ["NO_CHANGE"] });
    // 核验状态如实为「未核验」；阻断语义不变（blocking 只看证书 + 核心结论）
    expect(cause.impact.blocking).toBe(false);
    expect(validateFindingAdjudication(result, { sourceRevision: 2, documentFingerprint: "snap" }).status).toBe("VALID");
  });

  it("需作者核对 / 需外部数据的 major 与 critical 均保留观察严重度（未核验 ≠ 反证）", () => {
    const issues: ReviewIssue[] = [
      { category: "academic", severity: "major", section: "Implementation Details", description: "The threshold choice is not justified by any cited protocol.", quote: "We set the thresholds TH and TL to 0.8 and 0.5", blocking: false, file: "main.tex", logicalSection: "section:Implementation Details", verification: "EXTERNAL_DATA_REQUIRED" },
      { category: "academic", severity: "critical", section: "Method", description: "The authors must clarify the fixed-time policy; it contradicts the online setting.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method", verification: "AUTHOR_CHECK_REQUIRED" },
    ];
    const result = base(issues);
    expect(result.rootCauses).toHaveLength(2);
    const external = result.rootCauses.find((cause) => cause.verification.axis === "EXTERNAL_DATA_REQUIRED")!;
    expect(external.severity).toMatchObject({ observed: "major", adjudicated: "major", rules: ["NO_CHANGE"] });
    const author = result.rootCauses.find((cause) => cause.verification.axis === "AUTHOR_CHECK_REQUIRED")!;
    expect(author.severity).toMatchObject({ observed: "critical", adjudicated: "critical", rules: ["NO_CHANGE"] });
    // 未核验的 critical 计入裁决统计，不再被裁决值隐藏
    expect(result.summary.criticalMajorRootCausesAdjudicated).toBe(2);
  });

  it("证书证实的核心矛盾照常上调（CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR）并阻断", () => {
    const artifact = buildClaimAudit({
      projectId: "p", round: 1, sourceRevision: 2, documentFingerprint: "snap", files: [{ file: "main.tex", content: FILE }], coverageMode: "units", claimAuditMode: "extended",
      reviewPurpose: "published_paper_assessment", unitContextPolicy: "shared_session", units: unitsWithContradiction(),
      sourceVerification: { level: "AUTHOR_SOURCE", basis: "DECLARED_INPUT_PROVENANCE", note: "t" }, body: { targetChars: FILE.length, reviewedChars: FILE.length, ratio: 1, complete: true },
    });
    expect(artifact.claims[0]!.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    // 观察值只有 minor（审稿模型低估），证书证实矛盾触及摘要 → 裁决上调 major + blocking
    const issue: ReviewIssue = { category: "fact", severity: "minor", section: "Abstract", description: "Abstract HOTA 63.7 disagrees with Table tab:main (61.7).", quote: "achieves an HOTA of 63.7\\% on the MOT17 dataset", blocking: false, file: "main.tex", logicalSection: "frontmatter" };
    const result = base([issue], { claimAudit: artifact, claimAuditValidation: "VALID" });
    const cause = result.rootCauses[0]!;
    expect(cause.verification.axis).toBe("VERIFIED_BY_CERTIFICATE");
    expect(cause.severity).toMatchObject({ observed: "minor", adjudicated: "major", changed: true, rules: ["CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR"] });
    expect(cause.impact.blocking).toBe(true);
    expect(validateFindingAdjudication(result, { sourceRevision: 2, documentFingerprint: "snap" }).status).toBe("VALID");
  });

  it("可证转写损坏照常降级 minor（INPUT_PARSE_UNRELIABLE）；规则口径 v2", () => {
    const issue: ReviewIssue = { category: "build", severity: "major", section: "Method", description: "Equation (2) is garbled and unreadable.", quote: "\\[ si iou(M,bi) < NM s∗i= (2) \\]", blocking: false, file: "main.tex", logicalSection: "section:Method" };
    const result = base([issue], {
      policy: "quick_review", sourceVerification: "SOURCE_UNVERIFIED",
      findingRecheck: [{ findingId: "x", issueIndex: 0, reason: "PARSE_ARTIFACT_SUSPECTED", outcome: "UNRESOLVABLE_NO_PAGE_PROVENANCE", validation: "", snippets: [] }],
    });
    expect(result.rootCauses[0]!.verification.axis).toBe("INPUT_PARSE_UNRELIABLE");
    expect(result.rootCauses[0]!.severity).toMatchObject({ observed: "major", adjudicated: "minor", rules: ["PARSE_UNRELIABLE_CAPPED_AT_MINOR"] });
    expect(result.rules).toBe("finding-adjudication-rules/v2");
    expect(result.notes.some((note) => note.includes("M15.2.1"))).toBe(true);
  });

  it("读取方契约：无规则码的下调 / 上调 → MALFORMED；未核验轴上的 critical 裁决合法", () => {
    const issue: ReviewIssue = { category: "academic", severity: "critical", section: "Method", description: "Protocol inconsistency.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method" };
    const result = base([issue]);
    const expected = { sourceRevision: 2, documentFingerprint: "snap" } as const;
    // 未核验轴 + critical 裁决 = 合法（观察值保留；旧契约会误报「critical 裁决缺少核验依据」）
    expect(validateFindingAdjudication(result, expected).status).toBe("VALID");
    const lowered = structuredClone(result);
    lowered.rootCauses[0]!.severity.adjudicated = "minor";
    expect(validateFindingAdjudication(lowered, expected).status).toBe("MALFORMED");
    const raised = structuredClone(result);
    raised.rootCauses[0]!.severity.observed = "major";
    expect(validateFindingAdjudication(raised, expected).status).toBe("MALFORMED");
    const certifiedRaise = structuredClone(result);
    certifiedRaise.rootCauses[0]!.severity = { observed: "minor", adjudicated: "major", changed: true, rules: ["CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR"], rationale: "t" };
    certifiedRaise.rootCauses[0]!.verification.axis = "VERIFIED_BY_CERTIFICATE";
    expect(validateFindingAdjudication(certifiedRaise, expected).status).toBe("VALID");
  });

  it("taskScope 边界：只读评估 NOT_APPLICABLE_READ_ONLY；返修工作流按生产归层（revision_introduced）", () => {
    const issue: ReviewIssue = { category: "academic", severity: "critical", section: "Method", description: "Protocol inconsistency.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method" };
    const readOnly = base([issue]);
    expect(readOnly.rootCauses[0]!.taskScope.axis).toBe("NOT_APPLICABLE_READ_ONLY");
    const revision = base([issue], {
      policy: "revision_task",
      findingOrigins: [{ fingerprint: findingFingerprint(issue), section: "Method", severity: "critical", blocking: false, origin: "revision_introduced" as const, basis: "t", description: "" }],
      findingFingerprint,
    });
    expect(revision.rootCauses[0]!.taskScope.axis).toBe("REVISION_INTRODUCED");
  });
});
