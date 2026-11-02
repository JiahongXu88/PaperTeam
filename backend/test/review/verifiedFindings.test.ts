/**
 * M16 后续 · 审稿 finding 的确定性证书核验（verified-findings/v1）。
 * 正例来自 M16 续期收口独立复算成立的两个根因（DYSPEC「up to 9.4×」不可由所引表复现；SAM-CP 正文 40.6/47.5 vs 表 41.0/47.9），
 * 硬负例为被复算反证的「0.036%」finding；其余为合法差异对照（舍入 / 约数 / 下界 / 无表引用 / 转写来源）。
 */
import { describe, expect, it } from "vitest";

import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { buildCertificateDocument, certifyClaim } from "../../src/review/claimCertificate.js";
import { danglingReferences, readVerifiedFindings, verifyFindings } from "../../src/review/verifiedFindings.js";
import { findingFingerprint } from "../../src/review/revisionPlan.js";
import { DYSPEC_TEX, MECHANISM_TEX, SAMCP_TEX } from "./fixtures/verifiedFindingsFixtures.js";

function issue(partial: Partial<ReviewIssue> & Pick<ReviewIssue, "description">): ReviewIssue {
  return { category: "fact", severity: "major", section: "Results", blocking: false, file: "main.tex", ...partial } as ReviewIssue;
}

function run(content: string, issues: ReviewIssue[], sourceVerification: "AUTHOR_SOURCE" | "SOURCE_UNKNOWN" | "SOURCE_UNVERIFIED" | "SOURCE_ATTESTED" = "AUTHOR_SOURCE") {
  return verifyFindings({ round: 1, sourceRevision: 1, files: [{ file: "main.tex", content }], issues, sourceVerification, findingFingerprint, now: () => new Date("2026-11-02T00:00:00Z") });
}

const SPEEDUP_FINDING = issue({
  description: "The headline '9.4× reduction in latency' cannot be derived from Table 2 (Llama2-70B): Baseline/Ours latency ratios range 5.9–10.4 and none equals 9.4.",
  quote: "DYSPEC achieves a $9.1 \\times$ throughput improvement and $9.4 \\times$ reduction in latency",
  section: "Introduction",
});

const SAMCP_FINDING = issue({
  description: "Text–table numeric mismatch for COCO→Cityscapes: the prose states 40.6 PQ and 47.5 mIoU, but Table 1's SAM-CP row lists PQ 41.0 and mIoU 47.9 (AP 29.3 matches).",
  quote: "SAM-CP achieves a $40.6\\%$ PQ, a $29.3\\%$ AP and a $47.5\\%$ mIoU",
  section: "Experiments",
});

describe("verified-findings/v1 · positive cases (historical M16 root causes)", () => {
  it("baseline: the pre-existing derived certifier cannot certify the 'up to 9.4×' claim (red)", () => {
    const doc = buildCertificateDocument([{ file: "main.tex", content: DYSPEC_TEX }]);
    const at = DYSPEC_TEX.indexOf("9.4x");
    const certificate = certifyClaim(doc, { claim: { file: "main.tex", start: at, end: at + 3, value: "9.4" }, counterpart: null, check: "INCONSISTENT" });
    expect(certificate.outcome).toBe("NOT_CERTIFIED");
  });

  it("TABLE_MULTIPLIER: 9.4× is not reproducible from the referenced table → L1 VERIFIED_CONTRADICTED with recompute provenance", () => {
    const artifact = run(DYSPEC_TEX, [SPEEDUP_FINDING]);
    const record = artifact.records[0]!;
    expect(record.anchor.status).toBe("LOCATED");
    expect(record.status).toBe("VERIFIED_CONTRADICTED");
    const check = record.checks.find((entry) => entry.claim.raw === "9.4")!;
    expect(check.kind).toBe("TABLE_MULTIPLIER");
    expect(check.outcome).toBe("CONTRADICTED");
    expect(check.recompute?.table.label).toBe("tab:70b");
    expect(check.recompute?.table.resolvedVia).toContain("restatement");
    expect(check.recompute?.candidates).toBeGreaterThan(50);
    // 最接近的候选是括号内的接受 token 数 9.10，且不落在 [9.35, 9.45]
    expect(check.recompute?.nearest?.value).toBeCloseTo(9.1, 2);
    expect(check.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.statement).toContain("无法由");
    // 9.1× 恰好等于表中括号内的接受 token 数 9.10 → 有候选可复现 → 不判（候选超集的保守性）
    const both = run(DYSPEC_TEX, [{ ...SPEEDUP_FINDING, description: `${SPEEDUP_FINDING.description} The 9.1× throughput gain is likewise unsupported.` }]).records[0]!;
    expect(both.checks.find((entry) => entry.claim.raw === "9.1")?.outcome).toBe("CONSISTENT");
    expect(both.checks.find((entry) => entry.claim.raw === "9.4")?.outcome).toBe("CONTRADICTED");
    expect(artifact.summary.verifiedContradicted).toBe(1);
  });

  it("TEXT_TABLE_VALUE: prose 40.6 / 47.5 vs uniquely bound cells 41.0 / 47.9 → VERIFIED; the matching AP 29.3 is CONSISTENT", () => {
    const artifact = run(SAMCP_TEX, [SAMCP_FINDING]);
    const record = artifact.records[0]!;
    expect(record.status).toBe("VERIFIED_CONTRADICTED");
    const outcomes = Object.fromEntries(record.checks.map((check) => [check.claim.raw, check.outcome]));
    expect(outcomes).toMatchObject({ "40.6": "CONTRADICTED", "47.5": "CONTRADICTED", "29.3": "CONSISTENT" });
    const pq = record.checks.find((check) => check.claim.raw === "40.6")!;
    expect(pq.counterpart?.headerPath).toEqual(["COCO→Cityscapes", "PQ"]);
    expect(pq.counterpart?.raw).toBe("41.0");
  });

  it("is deterministic: same input → identical records and fingerprints", () => {
    const a = run(SAMCP_TEX, [SAMCP_FINDING]);
    const b = run(SAMCP_TEX, [SAMCP_FINDING]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("verified-findings/v1 · fail-closed negatives", () => {
  it("hard negative: the refuted 0.036% finding is never promoted (no table to bind)", () => {
    const artifact = run(MECHANISM_TEX, [issue({ description: "The 0.036% probability cannot be reproduced from the stated assumptions.", quote: "0.036\\% probability for $k = 4$ and equal class probabilities" })]);
    expect(artifact.records[0]!.status).not.toBe("VERIFIED_CONTRADICTED");
    expect(artifact.summary.verifiedContradicted).toBe(0);
  });

  it("transcript / unknown source: certificate holds on the text but stays CERTIFIED_ON_TRANSCRIPT (not L1)", () => {
    for (const level of ["SOURCE_UNKNOWN", "SOURCE_UNVERIFIED"] as const) {
      const artifact = run(SAMCP_TEX, [SAMCP_FINDING], level);
      expect(artifact.records[0]!.status).toBe("CERTIFIED_ON_TRANSCRIPT");
      expect(artifact.summary.verifiedContradicted).toBe(0);
    }
    expect(run(SAMCP_TEX, [SAMCP_FINDING], "SOURCE_ATTESTED").records[0]!.status).toBe("VERIFIED_CONTRADICTED");
  });

  it("flattened (lossy) table header → binding not unique → NOT_CERTIFIED", () => {
    const flattened = SAMCP_TEX.replace(/\\multirow\{2\}\{\*\}\{Method\} & \\multirow\{2\}\{\*\}\{Backbone\} & \\multicolumn\{5\}\{c\}\{COCO→ADE20K\} & \\multicolumn\{5\}\{c\}\{ADE20K→COCO\} & \\multicolumn\{3\}\{c\}\{COCO→Cityscapes\} \\\\\n &  & /, "Method & Backbone & COCO→ADE20K & ADE20K→COCO & COCO→Cityscapes &  &  &  &  &  &  &  &  &  &  \\\\\n");
    expect(flattened).not.toBe(SAMCP_TEX);
    expect(run(flattened, [SAMCP_FINDING]).records[0]!.status).not.toBe("VERIFIED_CONTRADICTED");
  });

  it("rounding-compatible value is CONSISTENT, not a contradiction (prose 41.0 vs cell 41.04)", () => {
    const rounded = SAMCP_TEX.replace("& 41.0 & 29.3 & 47.9", "& 41.04 & 29.3 & 47.9").replace("$40.6\\%$ PQ", "$41.0\\%$ PQ");
    const artifact = run(rounded, [issue({ description: "Prose 41.0 PQ vs Table 1 41.04.", quote: "SAM-CP achieves a $41.0\\%$ PQ, a $29.3\\%$ AP" })]);
    const check = artifact.records[0]!.checks.find((entry) => entry.claim.raw === "41.0")!;
    expect(check.kind).toBe("TEXT_TABLE_VALUE");
    expect(check.outcome).toBe("CONSISTENT");
    expect(artifact.records[0]!.status).toBe("NOT_CERTIFIED");
  });

  it("documents the post-hoc factor-column rule: with fewer than 4 rows the Temp column stays an operand", () => {
    const threeRows = DYSPEC_TEX.replace(/OWT & 0 & 0\.78106[^\n]*\n/, "").replace(/OWT & 0\.6 & 0\.87547[^\n]*\n/, "").replace(/CNN & 0 & 0\.81716[^\n]*\n/, "");
    const check = run(threeRows, [SPEEDUP_FINDING]).records[0]!.checks.find((entry) => entry.claim.raw === "9.4")!;
    expect(check.outcome).toBe("CONSISTENT");
  });

  it("finding that does not cite the bound cell value is not linked (double key)", () => {
    const artifact = run(SAMCP_TEX, [issue({ description: "The 40.6 PQ claim is overstated relative to FCCLIP.", quote: SAMCP_FINDING.quote! })]);
    expect(artifact.records[0]!.status).toBe("NOT_CERTIFIED");
    expect(artifact.records[0]!.checks[0]!.reasons).toContain("FINDING_DOES_NOT_CITE_BOUND_CELL");
  });

  it("approximate / lower-bound multipliers and sentences without a table reference are not certified", () => {
    const approx = DYSPEC_TEX.replaceAll("$9.4 \\times$ reduction", "roughly $9.4 \\times$ reduction").replace("a 9.4x reduction", "roughly a 9.4x reduction");
    expect(run(approx, [{ ...SPEEDUP_FINDING, quote: "and roughly $9.4 \\times$ reduction in latency" }]).records[0]!.status).not.toBe("VERIFIED_CONTRADICTED");
    const lower = DYSPEC_TEX.replaceAll("$9.4 \\times$ reduction", "over $9.4 \\times$ reduction").replace("a 9.4x reduction", "over a 9.4x reduction");
    expect(run(lower, [{ ...SPEEDUP_FINDING, quote: "and over $9.4 \\times$ reduction in latency" }]).records[0]!.status).not.toBe("VERIFIED_CONTRADICTED");
    const noRef = DYSPEC_TEX.replace(", as demonstrated in Table~\\ref{tab:70b}", "");
    const record = run(noRef, [SPEEDUP_FINDING]).records[0]!;
    expect(record.status).toBe("NOT_CERTIFIED");
    expect(record.checks.find((check) => check.claim.raw === "9.4")?.reasons).toContain("NO_TABLE_REFERENCE");
  });

  it("a multiplier that IS reproducible (10.4× = 5.59650/0.53696) is CONSISTENT", () => {
    const ok = DYSPEC_TEX.replaceAll("9.4", "10.4");
    const record = run(ok, [{ ...SPEEDUP_FINDING, description: "The 10.4× latency reduction cannot be derived.", quote: "DYSPEC achieves a $9.1 \\times$ throughput improvement and $10.4 \\times$ reduction in latency" }]).records[0]!;
    expect(record.checks.find((check) => check.claim.raw === "10.4")?.outcome).toBe("CONSISTENT");
    expect(record.status).toBe("NOT_CERTIFIED");
  });

  it("style findings, unlocatable quotes and deterministically disconfirmed findings are NOT_APPLICABLE", () => {
    const artifact = run(SAMCP_TEX, [
      { ...SAMCP_FINDING, category: "style" },
      { ...SAMCP_FINDING, quote: "this sentence does not exist in the paper at all" },
      { ...SAMCP_FINDING, deterministicDisconfirmed: true },
    ]);
    expect(artifact.records.map((record) => record.status)).toEqual(["NOT_APPLICABLE", "NOT_APPLICABLE", "NOT_APPLICABLE"]);
    expect(artifact.records[1]!.anchor.status).toBe("QUOTE_NOT_LOCATED");
  });
});

describe("verified-findings/v1 · correction after real-text replay", () => {
  const COMPETING = SAMCP_TEX.replace("\\end{document}", String.raw`
\begin{table}[htbp]\centering
\caption{Accuracy (\%) in closed-domain segmentation.}\label{tab:closed}
\begin{tabular}{lllll}
\hline
Method & Backbone & PQ & AP & mIoU \\ \hline
SAM-CP & CN-L & 40.6 & 29.3 & 47.5 \\
SAM-CP & R50 & 38.5 & 25.1 & 42.4 \\
\hline
\end{tabular}
\end{table}
\end{document}`);

  it("value that also appears in a competing table: never certified as a contradiction when bindings disagree", () => {
    const uncited = run(COMPETING, [{ ...SAMCP_FINDING, description: "Text–table mismatch: prose 40.6 PQ and 47.5 mIoU vs SAM-CP row 41.0 and 47.9." }]).records[0]!;
    expect(uncited.status).not.toBe("VERIFIED_CONTRADICTED");
    const cited = run(COMPETING, [SAMCP_FINDING]).records[0]!;
    expect(cited.status).not.toBe("VERIFIED_CONTRADICTED");
    expect(cited.checks.filter((check) => check.outcome === "CONTRADICTED")).toHaveLength(0);
    expect(cited.checks.find((check) => check.claim.raw === "47.5")!.reasons).toContain("CITED_TABLE_CONFLICTS_WITH_GLOBAL_BINDING");
  });

  it("citing the table where the prose value matches is CONSISTENT, not a contradiction", () => {
    const record = run(COMPETING, [{ ...SAMCP_FINDING, description: "Prose 40.6 PQ and 47.5 mIoU vs Table 2 SAM-CP row." }]).records[0]!;
    expect(record.status).not.toBe("VERIFIED_CONTRADICTED");
  });

  it("false link found on real text: a finding about a missing qualifier does not inherit the multiplier certificate", () => {
    const record = run(DYSPEC_TEX, [{ ...SPEEDUP_FINDING, description: "The Introduction states 9.4x without qualification, whereas the abstract says up to." }]).records[0]!;
    expect(record.status).toBe("NOT_CERTIFIED");
    expect(record.checks.find((check) => check.claim.raw === "9.4")?.reasons).toContain("FINDING_DOES_NOT_CITE_TABLE");
  });
});

describe("verified-findings/v1 · anchor quality and compatibility", () => {
  it("flags references to tables / equations / citations that do not exist, without changing the finding status", () => {
    const doc = buildCertificateDocument([{ file: "main.tex", content: SAMCP_TEX }]);
    expect(danglingReferences("Table 1 and Table 7 disagree; see Eq. (12) and [99].", doc)).toEqual(["Table 7", "Eq. (12)", "[99]"]);
    expect(danglingReferences("Table 1 lists FCCLIP [56].", doc)).toEqual([]);
    const artifact = run(SAMCP_TEX, [{ ...SAMCP_FINDING, description: `${SAMCP_FINDING.description} See also Table 9.` }]);
    expect(artifact.records[0]!.anchor.danglingReferences).toEqual(["Table 9"]);
    expect(artifact.records[0]!.status).toBe("VERIFIED_CONTRADICTED");
    expect(artifact.summary.danglingReferences).toBe(1);
  });

  it("old reports without the artifact are not upgraded (reader returns null)", () => {
    expect(readVerifiedFindings(undefined)).toBeNull();
    expect(readVerifiedFindings({ schema: "paperteam.finding-adjudication/v1", records: [] })).toBeNull();
    expect(readVerifiedFindings(run(SAMCP_TEX, [SAMCP_FINDING]))).not.toBeNull();
  });
});
