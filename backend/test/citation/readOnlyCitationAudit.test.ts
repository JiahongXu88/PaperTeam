/**
 * M15.1 只读引用审计：四层分开（attempted / adequate / matched / external），不伪造 bib key，不以「没有发现虚构」推导真实性。
 */
import { describe, expect, it } from "vitest";
import { buildReadOnlyCitationAudit, summarizeCitationAudit } from "../../src/citation/readOnlyCitationAudit.js";

const base = { round: 1, sourceRevision: 1, documentFingerprint: "fp", reviewPurpose: "published_paper_assessment" };

describe("M15.1 readOnlyCitationAudit", () => {
  it("LaTeX + .bib：\\cite key ↔ 条目确定性对照；缺 key = 结构问题；未做元数据 → 真实性 NOT_EVALUATED", () => {
    const audit = buildReadOnlyCitationAudit({
      ...base,
      files: [{ file: "main.tex", content: "Prior work \\cite{alpha,beta} and \\citep{gamma}.\n\\bibliography{refs}" }],
      bibContent: "@article{alpha, title={Alpha Paper on Tracking Systems}, year={2020}, doi={10.1000/alpha}}\n@inproceedings{beta, title={Beta Study}, year={2021}}",
      bibPath: "refs.bib",
    });
    expect(audit.referenceList.source).toBe("bib");
    expect(audit.layers.inputAdequacy.status).toBe("ADEQUATE");
    expect(audit.layers.referenceMatching).toMatchObject({ status: "EVALUATED", labels: 3, matched: 2, unmatched: 1 });
    expect(audit.findings.find((finding) => finding.code === "CITE_KEY_WITHOUT_ENTRY")).toMatchObject({ severity: "structural" });
    expect(audit.verdict).toMatchObject({ structure: "STRUCTURAL_PROBLEMS_FOUND", authenticity: "NOT_EVALUATED" });
    expect(audit.layers.externalMetadata.status).toBe("NOT_EVALUATED");
  });

  it("thebibliography + \\cite（作者 LaTeX 常见，无 .bib）：按 \\bibitem key 对照，不报假 missing", () => {
    const tex = "Text \\cite{fasterrcnn} and \\cite{iou}.\n\\begin{thebibliography}{1}\n\\bibitem{fasterrcnn} S. Ren, K. He, R. Girshick and J. Sun, {\\it Faster R-CNN: Towards Real-Time Object Detection}, TPAMI, 2017.\n\\bibitem{iou} B. Jiang, Acquisition of localization confidence, ECCV, 2018.\n\\end{thebibliography}";
    const audit = buildReadOnlyCitationAudit({ ...base, files: [{ file: "main.tex", content: tex }], bibContent: null, bibPath: null });
    expect(audit.referenceList).toMatchObject({ source: "thebibliography", entries: 2 });
    expect(audit.layers.referenceMatching.matchRate).toBe(1);
    expect(audit.verdict.structure).toBe("NO_STRUCTURAL_PROBLEM_FOUND");
  });

  it("PDF 转写稿（无 \\cite）：数字制 [n] 与中文作者-年份引文映射到文后条目；数学区间 [0,1] 不当引文", () => {
    const tex = [
      "方法 [1] 与 [2-3] 已有研究，阈值在 $[0,1]$ 与 [0,1] 中选取。Adaptive NMS(Liu 等,2019b)提出利用密度图（Brazil 等，2017；Dalal 和 Triggs，2005）。",
      "\\begin{thebibliography}{99}",
      "\\bibitem{ref1} Brazil G, Yin X and Liu X M. 2017. Illuminating pedestrians via simultaneous detection and segmentation // ICCV [DOI: 10.1109 / ICCV. 2017.530]",
      "\\bibitem{ref2} Dalal N and Triggs B. 2005. Histograms of oriented gradients for human detection // CVPR",
      "\\bibitem{ref3} Liu S T, Huang D and Wang Y H. 2019b. Adaptive NMS: refining pedestrian detection in a crowd // CVPR",
      "\\end{thebibliography}",
    ].join("\n");
    const audit = buildReadOnlyCitationAudit({ ...base, files: [{ file: "main.tex", content: tex }], bibContent: null, bibPath: null });
    expect(audit.mentionStyles.numeric).toBe(2);
    expect(audit.mentionStyles.author_year).toBe(2);
    expect(audit.layers.referenceMatching).toMatchObject({ labels: 6, matched: 6 });
    expect(audit.entries[0]).toMatchObject({ firstAuthorSurname: "Brazil", year: 2017, doi: "10.1109/iccv.2017.530" });
    expect(audit.entries[2]!.yearLabel).toBe("2019b");
  });

  it("没有参考文献列表：INSUFFICIENT_EVIDENCE / 结构 NOT_EVALUATED，不逐条报「无对应条目」", () => {
    const audit = buildReadOnlyCitationAudit({ ...base, files: [{ file: "main.tex", content: "Body \\cite{a,b,c}." }], bibContent: null, bibPath: null });
    expect(audit.layers.inputAdequacy.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(audit.layers.referenceMatching.status).toBe("NOT_EVALUATED");
    expect(audit.verdict.structure).toBe("NOT_EVALUATED");
    expect(audit.findings.filter((finding) => finding.severity === "structural")).toHaveLength(0);
  });

  it("外部元数据：只有执行过才有真实性结论；not_found / mismatch → METADATA_PROBLEMS_FOUND；部分核验 = PARTIAL", () => {
    const tex = "X \\cite{a}.\n\\begin{thebibliography}{1}\n\\bibitem{a} A. Author. A long enough title about tracking. CVPR, 2020.\n\\end{thebibliography}";
    const ok = buildReadOnlyCitationAudit({ ...base, files: [{ file: "main.tex", content: tex }], bibContent: null, bibPath: null, metadata: { results: [{ provider: "crossref", entryKey: "a", status: "verified" }], providers: ["crossref"], eligible: 1 } });
    expect(ok.verdict.authenticity).toBe("NO_FABRICATION_FOUND_IN_CHECKED_SUBSET");
    const bad = buildReadOnlyCitationAudit({ ...base, files: [{ file: "main.tex", content: tex }], bibContent: null, bibPath: null, metadata: { results: [{ provider: "crossref+openalex", entryKey: "a", status: "not_found" }], providers: ["crossref"], eligible: 3 } });
    expect(bad.verdict.authenticity).toBe("METADATA_PROBLEMS_FOUND");
    expect(bad.layers.externalMetadata.status).toBe("PARTIAL");
    expect(summarizeCitationAudit(bad).externalMetadata.status).toBe("PARTIAL");
  });
});
