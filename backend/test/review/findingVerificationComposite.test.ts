/**
 * M15.2.1 P1：复合意见不得凭部分反证整体撤回（N1648BF8 r2 #47）。
 * - 复合意见（≥2 独立子断言）的 REFUTED 须逐子断言给出 refutedPoints（point 逐字取自意见原文、
 *   evidenceQuote 逐字落在候选片段中）；覆盖不全 → 降级 PARTIALLY_REFUTED（fail-closed）；
 * - 单断言意见的既有 REFUTED 路径不受影响；
 * - 裁决侧：根因内每条被复核的 finding 都整条 REFUTED 才是撤回候选；部分反驳 / 未定成员在 → 不整组撤回。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）；确定性零模型（模型输出为固定回放值）。
 */
import { describe, expect, it } from "vitest";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { applyFindingRecheck, findingSubAssertions, parseFindingRecheckOutput, type FindingRecheckItem, type FindingRecheckResult } from "../../src/review/findingVerification.js";
import { adjudicateFindings, validateFindingAdjudication } from "../../src/review/findingAdjudication.js";

const SNIP1_TEXT = "We set the thresholds TH and TL to 0.8 and 0.5 respectively for all sequences of MOT17.";
const SNIP2_TEXT = "The fixed-time policy follows the tracking-by-detection convention established by ByteTrack.";
const COMPOSITE = "The thresholds TH and TL are never specified anywhere, and no justification is given for the fixed-time policy.";
const PART1 = "The thresholds TH and TL are never specified anywhere";
const PART2 = "no justification is given for the fixed-time policy";

function compositeItem(): FindingRecheckItem {
  return {
    findingId: "f1", issueIndex: 0, reason: "CONTEXT_INCOMPLETE", severity: "major", category: "academic",
    section: "Method", description: COMPOSITE, quote: "The association threshold is applied to every detection",
    assertedTerms: ["TH", "TL", "justification", "fixed-time"], absenceAssertion: true,
    snippets: [
      { snippetId: "F1", sourceUnitId: "main.tex::section:Implementation Details", sourceHeading: "Implementation Details", via: "absence_term_sentence", matchedTerms: ["TH", "TL"], text: SNIP1_TEXT, sha256: "a".repeat(64) },
      { snippetId: "F2", sourceUnitId: "main.tex::section:Discussion", sourceHeading: "Discussion", via: "term_sentence", matchedTerms: ["fixed-time"], text: SNIP2_TEXT, sha256: "b".repeat(64) },
    ],
  };
}

const run = (item: FindingRecheckItem, result: Partial<FindingRecheckResult> & Pick<FindingRecheckResult, "verdict">) =>
  applyFindingRecheck([item], [{ batchId: "B1", items: [item], status: "COMPLETED", results: [{ findingId: item.findingId, evidenceQuote: SNIP1_TEXT, snippetId: "F1", ...result } as FindingRecheckResult] }])[0]!;

describe("M15.2.1 P1 复合意见的逐子断言覆盖", () => {
  it("子断言拆分：句界 / 分号 / 独立子句并列连接词；短碎片段过滤；上限 8", () => {
    expect(findingSubAssertions(COMPOSITE)).toEqual([PART1, `${PART2}.`]);
    expect(findingSubAssertions("Part one is missing. Part two is unjustified.")).toEqual(["Part one is missing.", "Part two is unjustified."]);
    expect(findingSubAssertions("First is missing; second is unjustified.")).toEqual(["First is missing", "second is unjustified."]);
    expect(findingSubAssertions("X is missing, but the appendix explains it in full detail")).toHaveLength(2);
    expect(findingSubAssertions("It is missing, and ok.")).toEqual(["It is missing, and ok."]);
    // 不设拆分上限：>8 个子断言时解析侧 refutedPoints ≤8 条 → 整条覆盖不可能 → 天然 fail-closed
    expect(findingSubAssertions(Array.from({ length: 12 }, (_, i) => `point number ${i} is unjustified`).join("; "))).toHaveLength(12);
    expect(findingSubAssertions("Single assertion stands.")).toEqual(["Single assertion stands."]);
  });

  it("N1648BF8 形态：复合意见 REFUTED 而无逐子断言覆盖 → 降级 PARTIALLY_REFUTED（fail-closed，不作撤回候选）", () => {
    const record = run(compositeItem(), { verdict: "REFUTED" });
    expect(record.modelVerdict).toBe("REFUTED");
    expect(record.outcome).toBe("PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT");
    expect(record.coverage).toEqual({ subAssertions: 2, refutedPoints: 0, complete: false });
    expect(record.validation).toContain("覆盖不全");
  });

  it("逐子断言全覆盖（point 逐字取自意见原文、依据逐字落在候选片段）→ 整条 REFUTED 保留", () => {
    const record = run(compositeItem(), {
      verdict: "REFUTED",
      refutedPoints: [
        { point: PART1, evidenceQuote: SNIP1_TEXT, snippetId: "F1" },
        { point: PART2, evidenceQuote: SNIP2_TEXT, snippetId: "F2" },
      ],
    });
    expect(record.outcome).toBe("REFUTED_BY_DOCUMENT_CONTEXT");
    expect(record.coverage).toEqual({ subAssertions: 2, refutedPoints: 2, complete: true });
  });

  it("捏造的 point（不是意见原文的逐字子串）不计入覆盖；依据不在任何候选片段同样不计入", () => {
    const invented = run(compositeItem(), {
      verdict: "REFUTED",
      refutedPoints: [{ point: "the paper includes a full ablation study", evidenceQuote: SNIP1_TEXT }],
    });
    expect(invented.outcome).toBe("PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT");
    expect(invented.coverage).toEqual({ subAssertions: 2, refutedPoints: 0, complete: false });
    const offSnippet = run(compositeItem(), {
      verdict: "REFUTED",
      refutedPoints: [{ point: PART1, evidenceQuote: "The authors write that everything is fine in the supplement" }],
    });
    expect(offSnippet.outcome).toBe("PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT");
    expect(offSnippet.coverage).toEqual({ subAssertions: 2, refutedPoints: 0, complete: false });
  });

  it("只覆盖部分子断言（1/2）→ 仍降级 PARTIALLY_REFUTED", () => {
    const record = run(compositeItem(), {
      verdict: "REFUTED",
      refutedPoints: [{ point: PART1, evidenceQuote: SNIP1_TEXT, snippetId: "F1" }],
    });
    expect(record.outcome).toBe("PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT");
    expect(record.coverage).toEqual({ subAssertions: 2, refutedPoints: 1, complete: false });
  });

  it("单断言意见的 REFUTED 路径不受影响（无 coverage 字段）", () => {
    const item = compositeItem();
    item.description = "The thresholds TH and TL are not specified anywhere.";
    const record = run(item, { verdict: "REFUTED" });
    expect(record.outcome).toBe("REFUTED_BY_DOCUMENT_CONTEXT");
    expect(record.coverage).toBeUndefined();
  });

  it("解析：refutedPoints 有界（≤8 条），缺 point / 依据的条目丢弃", () => {
    const malformed = parseFindingRecheckOutput({
      results: [{ findingId: "f1", verdict: "REFUTED", refutedPoints: [{ point: PART1, evidenceQuote: SNIP1_TEXT }, { evidenceQuote: SNIP1_TEXT }, { point: PART2 }, "not-an-object"] }],
    }, new Set(["f1"]));
    expect(malformed[0]!.refutedPoints).toEqual([{ point: PART1, evidenceQuote: SNIP1_TEXT }]);
    const bounded = parseFindingRecheckOutput({
      results: [{ findingId: "f1", verdict: "REFUTED", refutedPoints: Array.from({ length: 12 }, (_, i) => ({ point: `assertion number ${i} is unjustified here`, evidenceQuote: SNIP2_TEXT })) }],
    }, new Set(["f1"]));
    expect(bounded[0]!.refutedPoints).toHaveLength(8);
    expect(bounded[0]!.refutedPoints![7]).toMatchObject({ point: "assertion number 7 is unjustified here" });
  });
});

// ---- 裁决侧：撤回条件收紧 ----

const FILE = "\\section{Method}\nThe association threshold is applied to every detection and tracks are kept for a fixed time.\n";
const ISSUE_A: ReviewIssue = { category: "academic", severity: "major", section: "Method", description: COMPOSITE, quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method" };
const ISSUE_B: ReviewIssue = { category: "academic", severity: "major", section: "Method", description: "The fixed-time policy lacks any justification.", quote: "tracks are kept for a fixed time", blocking: false, file: "main.tex", logicalSection: "section:Method" };

const recheckOf = (issueIndex: number, outcome: "REFUTED_BY_DOCUMENT_CONTEXT" | "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT" | "UNRESOLVED") => ({
  findingId: `f${issueIndex}`, issueIndex, reason: "CONTEXT_INCOMPLETE" as const, outcome, validation: "t", snippets: [],
});

const adjudicate = (issues: ReviewIssue[], findingRecheck: ReturnType<typeof recheckOf>[]) => adjudicateFindings({
  round: 1, sourceRevision: 2, documentFingerprint: "snap", policy: "quick_review", issues,
  files: [{ file: "main.tex", content: FILE }], claimAudit: null, claimAuditValidation: "ABSENT", findingRecheck, sourceVerification: "AUTHOR_SOURCE",
});

describe("M15.2.1 P1 裁决撤回条件", () => {
  it("同一根因内一条整条 REFUTED + 一条 UNRESOLVED → 不整组撤回（修复前会整体 minor）", () => {
    const result = adjudicate([ISSUE_A, ISSUE_B], [recheckOf(0, "REFUTED_BY_DOCUMENT_CONTEXT"), recheckOf(1, "UNRESOLVED")]);
    expect(result.rootCauses).toHaveLength(1);
    const cause = result.rootCauses[0]!;
    expect(cause.verification.axis).not.toBe("DOCUMENT_CONTEXT_CONTRADICTS");
    expect(cause.severity.adjudicated).toBe("major");
    expect(validateFindingAdjudication(result, { sourceRevision: 2, documentFingerprint: "snap" }).status).toBe("VALID");
  });

  it("部分反驳的复合意见：不撤回、严重度不变；单断言整条 REFUTED 的合法撤回候选保留", () => {
    const partial = adjudicate([ISSUE_A], [recheckOf(0, "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT")]);
    expect(partial.rootCauses[0]!.verification.axis).toBe("REVIEWER_GROUNDED_SUSPICION");
    expect(partial.rootCauses[0]!.severity.adjudicated).toBe("major");
    const single: ReviewIssue = { ...ISSUE_B, description: "The fixed-time policy lacks any justification." };
    const withdrawn = adjudicate([single], [recheckOf(0, "REFUTED_BY_DOCUMENT_CONTEXT")]);
    expect(withdrawn.rootCauses[0]!.verification.axis).toBe("DOCUMENT_CONTEXT_CONTRADICTS");
    expect(withdrawn.rootCauses[0]!.severity).toMatchObject({ observed: "major", adjudicated: "minor", rules: ["DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE"] });
  });
});
