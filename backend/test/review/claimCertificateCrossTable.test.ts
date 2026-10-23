/**
 * M15.2.1 P0-B（N09）：跨表假唯一性——同名词行（复现表 vs 公平对比表）的数值竞争。
 * - 复现表用缩写列名（MF1）时其单元格不进候选集，论断数值逐字出现在该表表格体内却绑定到
 *   公平对比表的同名行 → 数值不一致且跨表归属不可证 → 拒绝出证（VALUE_APPEARS_IN_OTHER_TABLE）；
 * - 「复现 / 公平 / 原文」限定词家族须由绑定候选的表格语境解释（UNEXPLAINED_QUALIFIER）；
 * - 显式 \ref 不豁免：指向的表内绑定仍须过跨表竞争与限定词检查；
 * - 正判控制不受影响：数值一致的法务绑定（含 \ref）、不在他表出现的注入矛盾仍照常出证。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）；确定性零模型。
 */
import { describe, expect, it } from "vitest";

import { buildClaimAudit, validateClaimAudit, type ClaimAuditInput, type ClaimAuditUnitInput, type RawUnitClaim } from "../../src/review/claimAudit.js";
import { buildCertificateDocument, bindTextAtom, certifyClaim, locateAtom } from "../../src/review/claimCertificate.js";

// 合成论文：摘要里放论断句；结果节放两张表——公平对比表（全名列头）与复现表（缩写列名 MF1/IF1，
// 列维匹配不到「Macro F1」→ 其单元格不进候选集，但 84.78 逐字出现在它的表格体内）
const ABSTRACT = [
  "\\begin{abstract}",
  "We re-examine GNN baselines on citation graphs.",
  "For instance, on ACM the reproduced GX attains only 84.78 Macro F1, far below its reported 93.1.",
  "As listed in Table~\\ref{tab:fair}, the reproduced GX attains only 84.78 Macro F1.",
  "On ACM, GX attains 92.20 Macro F1 under the unified protocol.",
  "Under the fair protocol of Table~\\ref{tab:fair}, GX reaches 92.2 Macro F1.",
  "On ACM, GX attains only 90.5 Macro F1.",
  "\\end{abstract}",
  "",
].join("\n");
const RESULTS = [
  "\\section{Results}\\label{sec:results}",
  "\\begin{table}[t]",
  "\\caption{Fair comparison of GNN baselines on the ACM benchmark under unified splits.}\\label{tab:fair}",
  "\\begin{tabular}{lcc}",
  "Model & Macro-F1 & Micro-F1 \\\\",
  "GX & 92.20 & 92.10 \\\\",
  "HY & 91.40 & 90.90 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "\\begin{table}[t]",
  "\\caption{Reproduction results of GNN baselines; * denotes our reproduction; MF1 = Macro F1, IF1 = Micro F1.}\\label{tab:repro}",
  "\\begin{tabular}{lcc}",
  "Model & MF1 & IF1 \\\\",
  "GX* & 84.78 & 85.62 \\\\",
  "HY* & 83.10 & 84.00 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "",
].join("\n");
const FILE = `${ABSTRACT}${RESULTS}`;

const document = buildCertificateDocument([{ file: "main.tex", content: FILE }], null);
const fairTable = document.files[0]!.tables.find((table) => table.label === "tab:fair")!;
const reproTable = document.files[0]!.tables.find((table) => table.label === "tab:repro")!;

function claimAtomOf(sentence: string, value: string) {
  const start = FILE.indexOf(sentence);
  expect(start).toBeGreaterThan(0);
  const located = locateAtom(document, "main.tex", start, start + sentence.length, value);
  expect(located.atom).not.toBeNull();
  return located.atom!;
}
const counterpartSpan = () => {
  const start = FILE.indexOf("GX & 92.20 & 92.10");
  expect(start).toBeGreaterThan(0);
  return { file: "main.tex", start, end: start + "GX & 92.20 & 92.10".length, value: "92.20" };
};

describe("M15.2.1 P0-B（N09）跨表假唯一性", () => {
  it("复现限定词 + 数值不一致 + 该数值逐字出现在另一张表：绑定 AMBIGUOUS（VALUE_APPEARS_IN_OTHER_TABLE + UNEXPLAINED_QUALIFIER）", () => {
    const sentence = "on ACM the reproduced GX attains only 84.78 Macro F1";
    const binding = bindTextAtom(document, claimAtomOf(sentence, "84.78"));
    // 修复前：复现表单元格列维不可见 → 公平表唯一候选 → 假 UNIQUE → 错误 VERIFIED_CONTRADICTED
    expect(binding.status).toBe("AMBIGUOUS");
    expect(binding.rule).toBe("UNEXPLAINED_CONTEXT");
    expect(binding.bound?.tableId).toBe(fairTable.tableId);
    expect(binding.rejections.some((reason) => reason.startsWith(`VALUE_APPEARS_IN_OTHER_TABLE:${reproTable.tableId}`))).toBe(true);
    expect(binding.rejections).toContain("UNEXPLAINED_QUALIFIER:reproduced");
  });

  it("端到端：该论断 NOT_CERTIFIED（BINDING_AMBIGUOUS），不再是 SAME_OBSERVABLE 的强判", () => {
    const sentence = "on ACM the reproduced GX attains only 84.78 Macro F1";
    const start = FILE.indexOf(sentence);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + sentence.length, value: "84.78" },
      counterpart: counterpartSpan(),
      check: "INCONSISTENT",
    });
    expect(certificate.kind).toBe("ATOMIC_COMPARISON");
    expect(certificate.outcome).toBe("NOT_CERTIFIED");
    expect(certificate.reasons[0]).toBe("BINDING_AMBIGUOUS:UNEXPLAINED_CONTEXT");
    expect(certificate.reasons.some((reason) => reason.startsWith("VALUE_APPEARS_IN_OTHER_TABLE:"))).toBe(true);
    expect(certificate.reasons).toContain("UNEXPLAINED_QUALIFIER:reproduced");
    expect(certificate.comparisonType).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("显式 \\ref 不豁免：指向公平表的论断仍须过跨表竞争检查", () => {
    const sentence = "the reproduced GX attains only 84.78 Macro F1";
    const start = FILE.indexOf(`Table~\\ref{tab:fair}, ${sentence}`);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + (`Table~\\ref{tab:fair}, ${sentence}`).length, value: "84.78" },
      counterpart: counterpartSpan(),
      check: "INCONSISTENT",
    });
    expect(certificate.outcome).toBe("NOT_CERTIFIED");
    expect(certificate.reasons.some((reason) => reason.startsWith("VALUE_APPEARS_IN_OTHER_TABLE:"))).toBe(true);
    expect(certificate.reasons).toContain("UNEXPLAINED_QUALIFIER:reproduced");
  });

  it("正判控制 A：数值一致的法务唯一绑定（无限定词）仍 SUPPORTED", () => {
    const sentence = "GX attains 92.20 Macro F1 under the unified protocol";
    const start = FILE.indexOf(sentence);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + sentence.length, value: "92.20" },
      counterpart: counterpartSpan(),
      check: "CONSISTENT",
    });
    expect(certificate.outcome).toBe("SUPPORTED");
    expect(certificate.binding?.status).toBe("UNIQUE");
    expect(certificate.reasons).toEqual([]);
  });

  it("正判控制 B：显式 \\ref + 限定词被 caption 解释（fair）+ 数值一致（92.2 vs 92.20）仍 SUPPORTED", () => {
    const lead = "Under the fair protocol of Table~\\ref{tab:fair}, GX reaches 92.2 Macro F1";
    const start = FILE.indexOf(lead);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + lead.length, value: "92.2" },
      counterpart: counterpartSpan(),
      check: "CONSISTENT",
    });
    expect(certificate.outcome).toBe("SUPPORTED");
    expect(certificate.binding?.status).toBe("UNIQUE");
    expect(certificate.reasons).toEqual([]);
  });

  it("正判控制 C：注入矛盾（论断值不出现在任何其他表）仍 CONTRADICTED——跨表检查只拦归属不明的差异", () => {
    const sentence = "GX attains only 90.5 Macro F1";
    const start = FILE.indexOf(sentence);
    const certificate = certifyClaim(document, {
      claim: { file: "main.tex", start, end: start + sentence.length, value: "90.5" },
      counterpart: counterpartSpan(),
      check: "INCONSISTENT",
    });
    expect(certificate.outcome).toBe("CONTRADICTED");
    expect(certificate.comparisonType).toBe("SAME_OBSERVABLE");
    expect(certificate.reasons).toEqual([]);
  });
});

// ---- 账本级：错误强判被消除，论断降级 REVIEWER_SUSPECTED（fail-closed），账本结构完好 ----

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

describe("M15.2.1 P0-B（N09）账本级 fail-closed", () => {
  it("N09 形论断不再 VERIFIED_CONTRADICTED：REVIEWER_SUSPECTED + CERTIFICATE_NOT_ISSUED，账本可校验", () => {
    const crossTable: RawUnitClaim = {
      index: 0,
      quote: "on ACM the reproduced GX attains only 84.78 Macro F1, far below its reported 93.1",
      claimType: "own_result", linkedRefs: [], check: "INCONSISTENT",
      counterpartQuote: "GX & 92.20 & 92.10", claimValue: "84.78", counterpartValue: "92.20", note: "cross-table false uniqueness",
    };
    const audit = buildClaimAudit(input(unitsOf({ abstract: [crossTable] })));
    expect(audit.claims).toHaveLength(1);
    const claim = audit.claims[0]!;
    expect(claim.verificationStatus.startsWith("VERIFIED")).toBe(false);
    expect(claim.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(claim.downgrades).toContain("CERTIFICATE_NOT_ISSUED");
    expect(claim.certificate?.reasons.some((reason) => reason.startsWith("VALUE_APPEARS_IN_OTHER_TABLE:"))).toBe(true);
    expect(validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-1", files: [{ file: "main.tex", content: FILE }] }).status).toBe("VALID");
  });
});
