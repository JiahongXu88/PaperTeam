/**
 * M15.1 finding provenance audit：跨单元假缺失与 PDF 转写伪影的确定性诊断（合成夹具，语义对应 M15 的
 * K4C3F05B / KEADC367 两个已知误报；不含原文）。诊断只读：不删 finding、不改 severity。
 */
import { describe, expect, it } from "vitest";
import { auditFindings, flattenedDisplayMath } from "../../src/review/findingAudit.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";

const units = [
  { unitId: "main.tex::frontmatter", file: "main.tex", heading: "摘要与前置部分", text: "\\begin{abstract}Our models reach the best accuracy on seven benchmarks including IJB-S, TinyFace, DeepChange and MSMT17.\\end{abstract}" },
  { unitId: "main.tex::section:Datasets", file: "main.tex", heading: "Datasets", text: "\\section{Datasets}We evaluate on IJB-S, IJB-C, TinyFace, CFP-FP, Market1501, MSMT17 and DeepChange. Thresholds TH and TL are set to 0.8 and 0.5." },
  { unitId: "main.tex::subsection:Fusion", file: "main.tex", heading: "2.3 Fusion", text: "\\subsection{Fusion}TH denotes the pedestrian threshold and TL the background threshold.\n\\[ si iou(M,bi) < NM s∗i= (2) si f(iou(M,bi))iou(M,bi) ≥NM \\]\nThe fused score is then calibrated." },
];

const issue = (overrides: Partial<ReviewIssue>): ReviewIssue => ({
  category: "fact", severity: "major", section: "x", description: "", blocking: false, file: "main.tex", ...overrides,
});

describe("M15.1 finding provenance audit", () => {
  it("缺失型断言 + 断言涉及的术语在其他（非摘要）单元同句出现 → CONTEXT_INCOMPLETE（不删除、不改 severity）", () => {
    const issues = [
      issue({ logicalSection: "frontmatter", description: "The abstract claims seven benchmarks but only lists four (IJB-S, TinyFace, DeepChange, MSMT17); the other three are unspecified.", quote: "seven benchmarks including IJB-S, TinyFace, DeepChange and MSMT17" }),
      issue({ logicalSection: "subsection:Fusion", category: "academic", description: "阈值 TH、TL 在本节没有给出取值与选取方法。", quote: "TH denotes the pedestrian threshold and TL the background threshold" }),
    ];
    const { records, summary } = auditFindings({ issues, units, sourceVerification: "AUTHOR_SOURCE" });
    expect(records.map((record) => record.auditStatus)).toEqual(["CONTEXT_INCOMPLETE", "CONTEXT_INCOMPLETE"]);
    expect(records[0]!.documentLookup.hits[0]).toMatchObject({ unitId: "main.tex::section:Datasets" });
    expect(records[0]!.documentLookup.hits[0]!.matched).toEqual(expect.arrayContaining(["IJB-S", "TinyFace", "MSMT17", "DeepChange"]));
    expect(records[1]!.documentLookup.hits[0]!.excerpt).toContain("0.8");
    expect(records.every((record) => record.severityObserved === "major" && !record.eligibleForTextVerification)).toBe(true);
    expect(summary.criticalMajor.byStatus.CONTEXT_INCOMPLETE).toBe(2);
    // 原 issue 不被改写
    expect(issues[0]!.severity).toBe("major");
  });

  it("摘要 / 引言 / 结论不作为「别处已给出」的来源；术语别处没有 → NO_EVIDENCE_ELSEWHERE，仍是 TEXT_LOCATED", () => {
    const issues = [issue({ logicalSection: "section:Datasets", description: "The paper does not specify how Market1501 queries are split.", quote: "IJB-C, TinyFace, CFP-FP, Market1501" })];
    const { records } = auditFindings({ issues, units: [units[0]!, units[1]!], sourceVerification: "AUTHOR_SOURCE" });
    expect(records[0]!.documentLookup.status).toBe("NO_EVIDENCE_ELSEWHERE");
    expect(records[0]!.auditStatus).toBe("TEXT_LOCATED");
  });

  it("PDF 转写稿上「公式损坏」：拍平的显示公式 → PARSE_ARTIFACT_SUSPECTED，且如实给出无法回看原件；作者源稿上同一 finding 不降级", () => {
    const formula = issue({ category: "build", logicalSection: "subsection:Fusion", description: "式(2)的 LaTeX 源码损坏：分段函数的条件全部错乱。", quote: "\\[ si iou(M,bi) < NM s∗i= (2) si f(iou(M,bi))iou(M,bi) ≥NM \\]" });
    const transcribed = auditFindings({ issues: [formula], units, sourceVerification: "SOURCE_UNVERIFIED" }).records[0]!;
    expect(transcribed.auditStatus).toBe("PARSE_ARTIFACT_SUSPECTED");
    expect(transcribed.parseRisk.signals).toContain("FORMULA_FLATTENED");
    expect(transcribed.parseRisk.originalCheck).toBe("NOT_AVAILABLE");
    expect(transcribed.note).toContain("无法回看原件");
    const author = auditFindings({ issues: [formula], units, sourceVerification: "AUTHOR_SOURCE" }).records[0]!;
    expect(author.parseRisk.status).toBe("NOT_APPLICABLE");
    expect(author.auditStatus).toBe("TEXT_LOCATED");
    expect(flattenedDisplayMath("\\[ s_i^* = \\begin{cases} s_i & x \\end{cases} \\]")).toBe(false);
  });

  it("自声明「需结合其他章节核对」→ CONTEXT_INCOMPLETE；引文找不到 → QUOTE_NOT_LOCATED；无引文 → NO_QUOTE", () => {
    const { records } = auditFindings({
      issues: [
        issue({ logicalSection: "section:Datasets", description: "【需结合其他章节核对】评价协议的数据来源。", quote: "We evaluate on IJB-S, IJB-C" }),
        issue({ logicalSection: "section:Datasets", description: "x", quote: "this sentence does not exist anywhere" }),
        issue({ logicalSection: "section:Datasets", description: "y" }),
      ],
      units, sourceVerification: "AUTHOR_SOURCE",
    });
    expect(records.map((record) => record.auditStatus)).toEqual(["CONTEXT_INCOMPLETE", "QUOTE_NOT_LOCATED", "NO_QUOTE"]);
  });
});
