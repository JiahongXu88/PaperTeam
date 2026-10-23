/**
 * M15.2.1 P0-A（N05）：科学核验可靠性修复——单条论断的证书计算异常不拖垮整篇账本。
 * - recomputeDerived 在无行标签数据行上不再崩溃（此前 `.find(...)!` 非空断言 → TypeError → 整篇 claim-audit 消失）；
 * - 证书器异常按条隔离为 CERTIFIER_ERROR（有界诊断，不泄漏论文原文 / 模型原始输出）；
 * - 独立验证来源（预登记复算 / 正式证据）不受证书隔离影响；
 * - 账本如实披露 PARTIAL_AUDIT。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）；确定性零模型。
 */
import { describe, expect, it, vi } from "vitest";

// 故障注入：仅当 claimValue === "12.34"（毒丸）时让 certifyClaim 抛错，其余调用原样透传
vi.mock("../../src/review/claimCertificate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/review/claimCertificate.js")>();
  return {
    ...actual,
    certifyClaim: (document: Parameters<typeof actual.certifyClaim>[0], input: Parameters<typeof actual.certifyClaim>[1]) => {
      if (input.claim.value === "12.34") throw new TypeError("Cannot read properties of undefined (reading 'rowKey')");
      return actual.certifyClaim(document, input);
    },
  };
});

import { buildClaimAudit, validateClaimAudit, type ClaimAuditInput, type ClaimAuditUnitInput, type RawUnitClaim } from "../../src/review/claimAudit.js";
import { buildCertificateDocument, certifyClaim } from "../../src/review/claimCertificate.js";

// 合成论文：摘要含派生论断 + 绝对值矛盾论断；结果表第二行没有行标签（N05 崩溃形态的合成重现）
const ABSTRACT = [
  "\\begin{abstract}",
  "Our tracker improves the HOTA by 3.8 points over the previous best.",
  "The proposed tracker achieves an HOTA of 63.7\\% on the MOT17 benchmark.",
  "The mean joint error of our method is 142.7 mm on the occluded split.",
  "\\end{abstract}",
  "",
].join("\n");
const RESULTS = [
  "\\section{Results}\\label{sec:results}",
  "\\begin{table}[t]",
  "\\caption{Tracking results on MOT17.}\\label{tab:main}",
  "\\begin{tabular}{lcc}",
  "Method & HOTA & IDF1 \\\\",
  "This work & 61.7 & 78.8 \\\\",
  " & 58.2 & 70.4 \\\\",
  "Baseline & 57.9 & 69.1 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "",
].join("\n");
const FILE = `${ABSTRACT}${RESULTS}`;

function unitsOf(extractions: Partial<Record<"abstract" | "results", RawUnitClaim[]>>): ClaimAuditUnitInput[] {
  const parts: Array<[string, string, string]> = [["abstract", "frontmatter", ABSTRACT], ["results", "section:Results", RESULTS]];
  let offset = 0;
  return parts.map(([key, spanId, text]) => {
    const unit: ClaimAuditUnitInput = {
      unitId: `main.tex::${spanId}`, file: "main.tex", spanId, heading: key, contentHash: `h-${key}`, chars: text.length, text, fileOffset: offset,
      reviewStatus: "completed", reused: false,
      extraction: { status: "EXTRACTED" as const, contract: "unit-claims/v1" as const, claims: extractions[key as "abstract" | "results"] ?? [], errors: [], repairAttempts: 0 },
      issues: [{ severity: "major", blocking: false }],
      provenance: { taskId: `t-${key}`, model: "scripted/model" },
    };
    offset += text.length;
    return unit;
  });
}

function input(units: ClaimAuditUnitInput[], overrides: Partial<ClaimAuditInput> = {}): ClaimAuditInput {
  return {
    projectId: "p1", round: 1, sourceRevision: 3, documentFingerprint: "snap-1",
    files: [{ file: "main.tex", content: FILE }], coverageMode: "units", claimAuditMode: "extended", reviewPurpose: "published_paper_assessment",
    unitContextPolicy: "shared_session", units,
    sourceVerification: { level: "AUTHOR_SOURCE", basis: "DECLARED_INPUT_PROVENANCE", note: "test" },
    body: { targetChars: FILE.length, reviewedChars: FILE.length, ratio: 1, complete: true },
    now: () => new Date("2026-10-23T00:00:00Z"),
    ...overrides,
  };
}

const derivedClaim: RawUnitClaim = {
  index: 0, quote: "Our tracker improves the HOTA by 3.8 points over the previous best", claimType: "own_result", linkedRefs: [], check: "CONSISTENT",
  claimValue: "3.8", note: "derived vs unnamed reference",
};
const contradiction: RawUnitClaim = {
  index: 1, quote: "The proposed tracker achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", linkedRefs: [], check: "INCONSISTENT",
  counterpartQuote: "This work & 61.7 & 78.8", claimValue: "63.7%", counterpartValue: "61.7", note: "abstract vs table",
};
const poison: RawUnitClaim = {
  index: 2, quote: "The mean joint error of our method is 142.7 mm on the occluded split", claimType: "own_result", linkedRefs: [], check: "INCONSISTENT",
  counterpartQuote: "Baseline & 57.9 & 69.1", claimValue: "12.34", counterpartValue: "57.9", note: "certifier fault injection",
};

describe("M15.2.1 P0-A（N05）recomputeDerived 无行标签防护", () => {
  it("参照行无行标签：不崩溃，fail-closed 记 DERIVED_ROW_LABEL_MISSING（修复前此处 TypeError）", () => {
    const document = buildCertificateDocument([{ file: "main.tex", content: FILE }], null);
    const sentence = "Our tracker improves the HOTA by 3.8 points over the previous best";
    const start = FILE.indexOf(sentence);
    expect(start).toBeGreaterThan(0);
    // 修复前：recomputeDerived 内 `.find((cell) => cell.rowKey.length > 0)!.rowKey` 抛 TypeError
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + sentence.length, value: "3.8" },
      counterpart: null,
      check: "CONSISTENT",
    });
    expect(certificate.kind).toBe("DERIVED_RECOMPUTE");
    expect(certificate.outcome).toBe("NOT_CERTIFIED");
    expect(certificate.reasons).toContain("DERIVED_ROW_LABEL_MISSING");
    // 复算记录仍完整落盘（供诊断），参照状态如实为 AMBIGUOUS
    expect(certificate.derived?.reference.status).toBe("AMBIGUOUS");
    expect(certificate.derived?.subject.status).toBe("BOUND");
  });

  it("点名参照（有行标签）的派生复算照常出证：SUPPORTED（守卫不得误伤正常路径）", () => {
    const document = buildCertificateDocument([{ file: "main.tex", content: FILE.replace("over the previous best", "over Baseline") }], null);
    const sentence = "Our tracker improves the HOTA by 3.8 points over Baseline";
    const start = document.files[0]!.content.indexOf(sentence);
    expect(start).toBeGreaterThan(0);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + sentence.length, value: "3.8" },
      counterpart: null,
      check: "CONSISTENT",
    });
    expect(certificate.kind).toBe("DERIVED_RECOMPUTE");
    expect(certificate.outcome).toBe("SUPPORTED");
    expect(certificate.reasons).toEqual([]);
  });
});

describe("M15.2.1 P0-A（N05）账本级隔离与诚实披露", () => {
  it("无行标签论断与正常论断同账本：一条 NOT_CERTIFIED（有理由码），另一条照常 VERIFIED_CONTRADICTED", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [derivedClaim, contradiction] })));
    expect(audit.claims).toHaveLength(2);
    const derived = audit.claims.find((claim) => claim.certificate?.kind === "DERIVED_RECOMPUTE")!;
    expect(derived.verificationStatus.startsWith("VERIFIED")).toBe(false);
    expect(derived.certificate?.reasons).toContain("DERIVED_ROW_LABEL_MISSING");
    const atomic = audit.claims.find((claim) => claim.claimId !== derived.claimId)!;
    expect(atomic.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    expect(atomic.basis).toBe("IN_TEXT_CROSS_CHECK");
    // 无证书器异常 → 不出现 PARTIAL_AUDIT（避免误报）
    expect(audit.notes.some((note) => note.includes("PARTIAL_AUDIT"))).toBe(false);
    expect(validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-1", files: [{ file: "main.tex", content: FILE }] }).status).toBe("VALID");
  });

  it("证书器抛错（故障注入）：单条兜底 CERTIFIER_ERROR，整篇账本不丢、其余论断照常 VERIFIED，账本披露 PARTIAL_AUDIT", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [contradiction, poison] })));
    expect(audit.claims).toHaveLength(2);
    const failed = audit.claims.find((claim) => (claim.certificate?.reasons ?? []).some((reason) => reason.startsWith("CERTIFIER_ERROR")))!;
    expect(failed.certificate?.kind).toBe("NONE");
    expect(failed.certificate?.outcome).toBe("NOT_CERTIFIED");
    expect(failed.certificate?.reasons[0]).toMatch(/^CERTIFIER_ERROR:TypeError:/);
    // 有界诊断：不得包含论文原文片段
    expect(failed.certificate?.reasons.join(" ")).not.toContain("142.7");
    expect(failed.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(failed.downgrades).toContain("CERTIFICATE_NOT_ISSUED");
    const healthy = audit.claims.find((claim) => claim.claimId !== failed.claimId)!;
    expect(healthy.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    expect(audit.notes.some((note) => note.includes("PARTIAL_AUDIT") && note.includes("CERTIFIER_ERROR"))).toBe(true);
    expect(validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-1", files: [{ file: "main.tex", content: FILE }] }).status).toBe("VALID");
  });

  it("独立验证来源不受证书隔离影响：预登记复算 CONSISTENT → VERIFIED_SUPPORTED（即使该条证书计算异常）", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [poison] }), {
      claimChecks: [{ id: "cc1", verdict: "CONSISTENT", claimAnchor: { quote: "mean joint error of our method is 142.7 mm" } } as never],
    }));
    const claim = audit.claims[0]!;
    expect(claim.certificate?.reasons[0]).toMatch(/^CERTIFIER_ERROR:TypeError:/);
    expect(claim.verificationStatus).toBe("VERIFIED_SUPPORTED");
    expect(claim.basis).toBe("DETERMINISTIC_RECOMPUTE");
  });
});
