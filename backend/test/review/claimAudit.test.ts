/**
 * M15.1 Review Claim Ledger（纯函数）：原文定位 / 确定性 claimId / 状态判定 / 跨单元任务 / 复核并入 / 读取校验。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）。
 */
import { describe, expect, it } from "vitest";
import {
  applyCrossUnitRecheck,
  buildClaimAudit,
  claimIdOf,
  decideClaimStatus,
  parseUnitClaims,
  resolveClaimAuditMode,
  selectRecheckItems,
  summarizeClaimAudit,
  validateClaimAudit,
  type ClaimAuditInput,
  type ClaimAuditUnitInput,
  type RawUnitClaim,
} from "../../src/review/claimAudit.js";
import { compareValues, locateQuote, parseValue } from "../../src/review/claimAuditText.js";

const ABSTRACT = "\\begin{abstract}\nThe proposed tracker achieves an HOTA of 63.7\\% on the MOT17 benchmark while running at 2242 Hz on a single CPU core.\n\\end{abstract}\n";
const RESULTS = [
  "\\section{Results}\\label{sec:results}",
  "Table~\\ref{tab:main} compares the trackers on MOT17.",
  "\\begin{table}[t]",
  "\\caption{Tracking results on MOT17.}\\label{tab:main}",
  "\\begin{tabular}{lcccc}",
  "Method & HOTA & MOTA & IDF1 & Hz \\\\",
  "Baseline & 58.2 & 71.0 & 70.4 & 331.3 \\\\",
  "This work & 61.7 & 74.4 & 78.8 & 2241.8 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "The mean joint error of our method is 142.7 mm on the occluded split.",
  "",
].join("\n");
const DISCUSSION = "\\section{Discussion}\nOn the occluded split the average absolute joint position error is about 14\\,mm, which is acceptable for robots.\nSee Table 9 for the extended ablation.\n";
const FILE = `${ABSTRACT}${RESULTS}${DISCUSSION}`;

function unitsOf(extractions: Partial<Record<"abstract" | "results" | "discussion", RawUnitClaim[]>>, options: { omit?: boolean } = {}): ClaimAuditUnitInput[] {
  const parts: Array<[string, string, string]> = [["abstract", "frontmatter", ABSTRACT], ["results", "section:Results", RESULTS], ["discussion", "section:Discussion", DISCUSSION]];
  let offset = 0;
  return parts.map(([key, spanId, text]) => {
    const unit: ClaimAuditUnitInput = {
      unitId: `main.tex::${spanId}`, file: "main.tex", spanId, heading: key, contentHash: `h-${key}`, chars: text.length, text, fileOffset: offset,
      reviewStatus: "completed", reused: false,
      ...(options.omit === true ? {} : { extraction: { status: "EXTRACTED" as const, contract: "unit-claims/v1" as const, claims: extractions[key as "abstract"] ?? [], errors: [], repairAttempts: 0 } }),
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
    now: () => new Date("2026-10-22T00:00:00Z"),
    ...overrides,
  };
}

const contradiction: RawUnitClaim = {
  index: 0, quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", linkedRefs: [], check: "INCONSISTENT",
  counterpartQuote: "This work & 61.7 & 74.4 & 78.8 & 2241.8", claimValue: "63.7%", counterpartValue: "61.7", issueIndex: 0, note: "abstract vs table",
};

describe("M15.1 claimAuditText 确定性工具", () => {
  it("逐字定位只做空白折叠 + NFKC，找不到就是 null", () => {
    expect(locateQuote(FILE, "achieves  an\nHOTA of 63.7\\%")).not.toBeNull();
    expect(locateQuote(FILE, "achieves a HOTA of 63.7")).toBeNull();
  });
  it("数值比较：同量纲换算、量纲不可判定 → SCALE_AMBIGUOUS、显示精度容差", () => {
    expect(compareValues(parseValue("14 cm")!, parseValue("140 mm")!)).toBe("EQUAL");
    expect(compareValues(parseValue("about 14\\,mm")!, parseValue("142.7")!)).toBe("SCALE_AMBIGUOUS");
    expect(compareValues(parseValue("63.7\\%")!, parseValue("61.7")!)).toBe("DIFFERENT");
    expect(compareValues(parseValue("2242 Hz")!, parseValue("2241.8")!)).toBe("EQUAL");
  });
});

describe("M15.1 Review Claim Ledger", () => {
  it("模式：auto = 只读评估 extended / 作者稿件 shadow", () => {
    expect(resolveClaimAuditMode(undefined, true)).toBe("extended");
    expect(resolveClaimAuditMode("auto", false)).toBe("shadow");
    expect(resolveClaimAuditMode("off", true)).toBe("off");
  });

  it("parseUnitClaims：缺失 = ABSENT、非数组 = INVALID、缺 quote 的条目记错跳过", () => {
    expect(parseUnitClaims({}).status).toBe("ABSENT");
    expect(parseUnitClaims({ claims: "x" }).status).toBe("INVALID");
    const parsed = parseUnitClaims({ claims: [{ quote: "a long enough quote here" }, { note: "no quote" }, 3] });
    expect(parsed.status).toBe("EXTRACTED");
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.errors).toHaveLength(2);
  });

  it("原文内跨处核对：双引文逐字定位 + 写出的数值不同 + 作者源稿 → VERIFIED_CONTRADICTED（IN_TEXT_CROSS_CHECK），claimId 确定性", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [contradiction] })));
    expect(audit.claims).toHaveLength(1);
    const claim = audit.claims[0]!;
    expect(claim.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    expect(claim.basis).toBe("IN_TEXT_CROSS_CHECK");
    expect(claim.verifier.kind).toBe("model+deterministic");
    expect(claim.counterpart?.located).toBe("OTHER_UNIT");
    expect(claim.counterpart?.location?.unitId).toBe("main.tex::section:Results");
    expect(FILE.slice(claim.location.start!, claim.location.end!)).toBe(claim.quote);
    expect(claim.claimId).toBe(claimIdOf("main.tex", claim.quote, "0"));
    expect(claim.assessment).toMatchObject({ severityObserved: "major", decision: "RESERVED_M15_2" });
    // 同一输入重建 → 同一 id 与状态
    const again = buildClaimAudit(input(unitsOf({ abstract: [contradiction] })));
    expect(again.claims[0]!.claimId).toBe(claim.claimId);
    expect(again.claims[0]!.verificationStatus).toBe("VERIFIED_CONTRADICTED");
  });

  it("来源未核验（PDF 转写）：同一矛盾只能是 REVIEWER_SUSPECTED + PARSE_ARTIFACT_SUSPECTED（对照处是表格行）", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [contradiction] }), { sourceVerification: { level: "SOURCE_UNVERIFIED", basis: "DECLARED_INPUT_PROVENANCE", note: "pdf" } }));
    expect(audit.claims[0]!.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(audit.claims[0]!.downgrades).toContain("PARSE_ARTIFACT_SUSPECTED");
  });

  it("对照引文定位不到 / 数值与判定相反 / 量纲不可判定：都不得 VERIFIED", () => {
    const audit = buildClaimAudit(input(unitsOf({
      abstract: [{ ...contradiction, counterpartQuote: "This work & 60.0 & 74.4 & 78.8" }],
      results: [{ index: 0, quote: "This work & 61.7 & 74.4 & 78.8 & 2241.8", check: "INCONSISTENT", counterpartQuote: "running at 2242 Hz on a single CPU core", claimValue: "2241.8", counterpartValue: "2242 Hz" }],
      discussion: [{ index: 0, quote: "average absolute joint position error is about 14\\,mm", check: "INCONSISTENT", counterpartQuote: "The mean joint error of our method is 142.7 mm", claimValue: "14 mm", counterpartValue: "142.7" }],
    })));
    const byUnit = (unitId: string) => audit.claims.find((claim) => claim.unitId === unitId)!;
    expect(byUnit("main.tex::frontmatter").verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(byUnit("main.tex::frontmatter").downgrades).toContain("COUNTERPART_NOT_LOCATED");
    expect(byUnit("main.tex::section:Results").downgrades).toContain("VALUE_CHECK_DISAGREES");
    expect(byUnit("main.tex::section:Results").verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(byUnit("main.tex::section:Discussion").downgrades).toContain("VALUE_NOT_COMPARABLE");
    expect(audit.claims.every((claim) => !claim.verificationStatus.startsWith("VERIFIED"))).toBe(true);
  });

  it("不同种量的数值（描述词互不包含：「7-fold」vs「4 videos」、Fixed 行 vs Default 行）→ VALUE_NOT_COMPARABLE，不得 VERIFIED（真实 smoke 误报回归）", () => {
    const audit = buildClaimAudit(input(unitsOf({
      results: [{ index: 0, quote: "Baseline & 58.2 & 71.0 & 70.4 & 331.3", check: "INCONSISTENT", counterpartQuote: "This work & 61.7 & 74.4 & 78.8 & 2241.8", claimValue: "Fixed IDF1 70.4", counterpartValue: "Default IDF1 78.8" }],
      discussion: [{ index: 0, quote: "average absolute joint position error is about 14\\,mm", check: "INCONSISTENT", counterpartQuote: "The mean joint error of our method is 142.7 mm", claimValue: "7-fold", counterpartValue: "4 videos" }],
    })));
    expect(audit.claims).toHaveLength(2);
    for (const claim of audit.claims) {
      expect(claim.verificationStatus).toBe("REVIEWER_SUSPECTED");
      expect(claim.downgrades).toContain("VALUE_NOT_COMPARABLE");
      expect(claim.valueCheck?.descriptorsComparable).toBe(false);
    }
    // 同种量但不同表格行（Baseline 行 vs This work 行）：数值本来就不该相等，不同 ≠ 矛盾
    const rows = buildClaimAudit(input(unitsOf({
      results: [{ index: 0, quote: "Baseline & 58.2 & 71.0 & 70.4 & 331.3", check: "INCONSISTENT", counterpartQuote: "This work & 61.7 & 74.4 & 78.8 & 2241.8", claimValue: "IDF1 70.4", counterpartValue: "IDF1 78.8" }],
    })));
    expect(rows.claims[0]!.valueCheck).toMatchObject({ descriptorsComparable: true, sameQuantityPremise: false });
    expect(rows.claims[0]!.verificationStatus).toBe("REVIEWER_SUSPECTED");
    // 派生量（求和 / 比例）：确定性比较不替模型做算术
    const derived = buildClaimAudit(input(unitsOf({
      discussion: [{ index: 0, quote: "average absolute joint position error is about 14\\,mm", check: "INCONSISTENT", counterpartQuote: "The mean joint error of our method is 142.7 mm", claimValue: "38800 + 5300 (+ 18700)", counterpartValue: "54K" }],
    })));
    expect(derived.claims[0]!.valueCheck?.derived).toBe(true);
    expect(derived.claims[0]!.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(compareValues(parseValue("54K")!, parseValue("54000")!)).toBe("EQUAL");
  });

  it("依赖缺口（全文没有 Table 9）→ contextCompleteness=INCOMPLETE，矛盾不得确认", () => {
    const audit = buildClaimAudit(input(unitsOf({
      discussion: [{ index: 0, quote: "See Table 9 for the extended ablation", linkedRefs: ["Table 9"], check: "INCONSISTENT", counterpartQuote: "Baseline & 58.2 & 71.0 & 70.4 & 331.3", claimValue: "9", counterpartValue: "58.2" }],
    })));
    const claim = audit.claims[0]!;
    expect(claim.contextCompleteness).toBe("INCOMPLETE");
    expect(claim.linkedRefs.some((ref) => ref.resolution === "UNRESOLVED")).toBe(true);
    expect(claim.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(claim.downgrades).toContain("CONTEXT_INCOMPLETE");
  });

  it("引文不在本单元：拒收（QUOTE_IN_OTHER_UNIT / QUOTE_NOT_IN_UNIT），不进账本；跨单元重复按 claimId 合并", () => {
    const audit = buildClaimAudit(input(unitsOf({
      abstract: [{ index: 0, quote: "The mean joint error of our method is 142.7 mm", check: "CONSISTENT" }, { index: 1, quote: "a sentence that is not in this paper at all", check: "CONSISTENT" }, { index: 2, quote: "short" }],
    })));
    expect(audit.claims).toHaveLength(0);
    expect(audit.rejected.map((entry) => entry.reason).sort()).toEqual(["QUOTE_IN_OTHER_UNIT", "QUOTE_NOT_IN_UNIT", "QUOTE_TOO_SHORT"].sort());
    expect(audit.coverage.claims.rejected).toBe(3);
  });

  it("NEEDS_OTHER_SECTION → NOT_EVALUATED + 有界查找任务；复核结果须逐字落在候选片段中，同一判定函数，模型不能自封 VERIFIED", () => {
    const needs: RawUnitClaim = { index: 0, quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", check: "NEEDS_OTHER_SECTION" };
    const audit = buildClaimAudit(input(unitsOf({ abstract: [needs] })));
    const claim = audit.claims[0]!;
    expect(claim.verificationStatus).toBe("NOT_EVALUATED");
    expect(claim.downgrades).toContain("CONTEXT_INCOMPLETE");
    expect(audit.crossUnitTasks).toHaveLength(1);
    const task = audit.crossUnitTasks[0]!;
    expect(task.status).toBe("CANDIDATES_FOUND");
    expect(task.snippets.some((snippet) => snippet.text.includes("This work & 61.7"))).toBe(true);
    const items = selectRecheckItems(audit, 8);
    expect(items).toHaveLength(1);
    // 1) 引文落在片段里、数值不同、证书唯一绑定（M15.2：需传入文件内容出具证书）→ VERIFIED_CONTRADICTED
    const recheck = [{ batchId: "B1", items, status: "COMPLETED" as const, attempts: 1, results: [{ claimId: claim.claimId, check: "INCONSISTENT" as const, counterpartQuote: "This work & 61.7 & 74.4", claimValue: "63.7%", counterpartValue: "61.7" }] }];
    const ok = applyCrossUnitRecheck(structuredClone(audit), recheck, { files: [{ file: "main.tex", content: FILE }] });
    expect(ok.claims[0]!.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    expect(ok.claims[0]!.certificate?.outcome).toBe("CONTRADICTED");
    expect(ok.claims[0]!.reviewer.origin).toBe("cross_unit_recheck");
    expect(ok.crossUnitTasks[0]!.recheck?.status).toBe("COMPLETED");
    expect(ok.coverage.crossUnitTasks.recheckCompleted).toBe(1);
    // 1b) 旧调用方不给文件内容 → 无证书 → 最高 REVIEWER_SUSPECTED（不再凭写出的两个数确认）
    const noFiles = applyCrossUnitRecheck(structuredClone(audit), recheck);
    expect(noFiles.claims[0]!.verificationStatus).toBe("REVIEWER_SUSPECTED");
    expect(noFiles.claims[0]!.downgrades).toContain("CERTIFICATE_NOT_ISSUED");
    // 2) 引文不在片段里 → 只能 REVIEWER_SUSPECTED
    const fabricated = applyCrossUnitRecheck(structuredClone(audit), [{ batchId: "B1", items, status: "COMPLETED", attempts: 1, results: [{ claimId: claim.claimId, check: "INCONSISTENT", counterpartQuote: "This work reaches 59.9 HOTA", claimValue: "63.7%", counterpartValue: "59.9" }] }]);
    expect(fabricated.claims[0]!.verificationStatus).toBe("REVIEWER_SUSPECTED");
    // 3) NOT_DETERMINABLE / 调用失败 → 保持 NOT_EVALUATED
    const undetermined = applyCrossUnitRecheck(structuredClone(audit), [{ batchId: "B1", items, status: "COMPLETED", attempts: 1, results: [{ claimId: claim.claimId, check: "NOT_DETERMINABLE" }] }]);
    expect(undetermined.claims[0]!.verificationStatus).toBe("NOT_EVALUATED");
    const failed = applyCrossUnitRecheck(structuredClone(audit), [{ batchId: "B1", items, status: "FAILED", attempts: 2, error: "timeout", results: [] }]);
    expect(failed.claims[0]!.verificationStatus).toBe("NOT_EVALUATED");
    expect(failed.crossUnitTasks[0]!.recheck?.status).toBe("FAILED");
  });

  it("复核预算：超出上限的任务记 SKIPPED_BUDGET（不丢、不冒充已核）", () => {
    const many = [0, 1].map((index) => ({ index, quote: index === 0 ? "achieves an HOTA of 63.7\\% on the MOT17 benchmark" : "running at 2242 Hz on a single CPU core", check: "NEEDS_OTHER_SECTION" }));
    const audit = buildClaimAudit(input(unitsOf({ abstract: many })));
    const items = selectRecheckItems(audit, 1);
    expect(items).toHaveLength(1);
    expect(audit.crossUnitTasks.filter((task) => task.recheck?.status === "SKIPPED_BUDGET").length).toBe(audit.crossUnitTasks.filter((task) => task.status === "CANDIDATES_FOUND").length - 1);
  });

  it("shadow：单元没有请求论断账本 → NOT_REQUESTED、零论断——空账本不代表论断都已核验", () => {
    const audit = buildClaimAudit(input(unitsOf({}, { omit: true }), { claimAuditMode: "shadow" }));
    expect(audit.claims).toHaveLength(0);
    expect(audit.units.every((unit) => unit.extraction.status === "NOT_REQUESTED")).toBe(true);
    expect(audit.coverage.scientificClaimCoverage).toBe("NOT_MEASURABLE");
    expect(audit.evaluationPolicy.promptContract).toBe("legacy-unit-no-claims");
    expect(audit.notes.join("")).toContain("不是「论断都有支撑」");
    expect(audit.evaluationPolicy.productionGateImpact).toBe("NONE_SHADOW");
  });

  it("digest fact 路：UNSUPPORTED = 无已核验证据（AUTHOR_CHECK_REQUIRED，不是证伪）；SUPPORTED 只有命中正式证据才 VERIFIED；复述型 claim 定位不到则拒收", () => {
    const audit = buildClaimAudit(input(unitsOf({}, { omit: true }), {
      coverageMode: "digest",
      digestClaims: [
        { section: "Abstract", claim: "The proposed tracker achieves an HOTA of 63.7\\% on the MOT17 benchmark", verdict: "UNSUPPORTED" },
        { section: "Results", claim: "Table~\\ref{tab:main} compares the trackers on MOT17.", verdict: "SUPPORTED", evidenceId: "E-formal" },
        { section: "Results", claim: "The mean joint error of our method is 142.7 mm on the occluded split.", verdict: "SUPPORTED", evidenceId: "E-unverified" },
        { section: "Results", claim: "The method is roughly seven times faster than prior work (paraphrase)", verdict: "CONTRADICTED" },
      ],
      formalEvidenceIds: new Set(["E-formal"]),
    }));
    const status = (needle: string) => audit.claims.find((claim) => claim.quote.includes(needle))?.verificationStatus;
    expect(status("63.7")).toBe("AUTHOR_CHECK_REQUIRED");
    expect(status("compares the trackers")).toBe("VERIFIED_SUPPORTED");
    expect(audit.claims.find((claim) => claim.quote.includes("compares"))!.evidenceIds).toEqual(["E-formal"]);
    expect(status("142.7")).toBe("REVIEWER_CONSISTENT");
    expect(audit.rejected.some((entry) => entry.reason === "QUOTE_NOT_LOCATED")).toBe(true);
    expect(audit.claims.every((claim) => claim.provenance.legacyClaimFingerprint?.startsWith("c-"))).toBe(true);
  });

  it("预登记复算 CONTRADICTED → VERIFIED_CONTRADICTED（DETERMINISTIC_RECOMPUTE）", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [{ index: 0, quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", check: "NOT_CHECKED" }] }), {
      reviewPurpose: "author_manuscript",
      claimChecks: [{ id: "cc1", verdict: "CONTRADICTED", claimAnchor: { quote: "HOTA of 63.7\\% on the MOT17" } } as never],
    }));
    expect(audit.claims[0]).toMatchObject({ verificationStatus: "VERIFIED_CONTRADICTED", basis: "DETERMINISTIC_RECOMPUTE" });
  });

  it("状态只由单条论断决定：汇总不改写 VERIFIED_CONTRADICTED / REVIEWER_SUSPECTED / AUTHOR_CHECK_REQUIRED", () => {
    const audit = buildClaimAudit(input(unitsOf({
      abstract: [contradiction],
      results: [{ index: 0, quote: "Table~\\ref{tab:main} compares the trackers on MOT17", check: "INCONSISTENT" }],
      discussion: [{ index: 0, quote: "which is acceptable for robots", check: "NEEDS_AUTHOR_DATA" }],
    })));
    const before = audit.claims.map((claim) => claim.verificationStatus);
    expect(before.sort()).toEqual(["AUTHOR_CHECK_REQUIRED", "REVIEWER_SUSPECTED", "VERIFIED_CONTRADICTED"]);
    const summary = summarizeClaimAudit(audit);
    expect(summary.claims.byStatus).toMatchObject({ VERIFIED_CONTRADICTED: 1, REVIEWER_SUSPECTED: 1, AUTHOR_CHECK_REQUIRED: 1 });
    expect(audit.claims.map((claim) => claim.verificationStatus).sort()).toEqual(before);
    expect(decideClaimStatus({ check: "INCONSISTENT", claimType: "UNKNOWN", evidenceVerified: false, counterpartLocated: false, counterpartRisk: [], quoteRisk: [], sourceLevel: "AUTHOR_SOURCE", contextCompleteness: "UNKNOWN", conversionHit: false, origin: "unit_claims" }).verificationStatus).toBe("REVIEWER_SUSPECTED");
  });

  it("读取校验：错误修订 / 文档指纹 / 原文已变 → STALE，摘要不再给出已核实矛盾", () => {
    const audit = buildClaimAudit(input(unitsOf({ abstract: [contradiction] })));
    const files = [{ file: "main.tex", content: FILE }];
    expect(validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-1", files }).status).toBe("VALID");
    expect(validateClaimAudit(audit, { sourceRevision: 4, documentFingerprint: "snap-1", files }).status).toBe("STALE");
    expect(validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-2", files }).status).toBe("STALE");
    const edited = validateClaimAudit(audit, { sourceRevision: 3, documentFingerprint: "snap-1", files: [{ file: "main.tex", content: FILE.replace("63.7", "61.7") }] });
    expect(edited.status).toBe("STALE");
    expect(edited.invalidClaimIds).toEqual([audit.claims[0]!.claimId]);
    expect(summarizeClaimAudit(audit, edited).verifiedContradicted).toEqual([]);
    expect(validateClaimAudit({ schema: "other" }, { sourceRevision: 3, documentFingerprint: "snap-1", files }).status).toBe("MALFORMED");
  });

  it("单元失败 / 仅标题 / 抽取缺失 如实进入覆盖账本", () => {
    const units = unitsOf({ abstract: [contradiction] });
    units[1] = { ...units[1]!, reviewStatus: "failed" };
    units[2] = { ...units[2]!, extraction: { status: "ABSENT", contract: "unit-claims/v1", claims: [], errors: ["claims 字段缺失"], repairAttempts: 1 } };
    const audit = buildClaimAudit(input(units));
    expect(audit.units.map((unit) => unit.extraction.status)).toEqual(["EXTRACTED", "UNIT_FAILED", "ABSENT"]);
    expect(audit.coverage.units).toMatchObject({ extractionRequested: 2, extractionCompleted: 1, extractionMissing: 1, failed: 1 });
    expect(audit.units[2]!.extraction.repairAttempts).toBe(1);
  });
});
