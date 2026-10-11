import { describe, expect, it } from "vitest";
import { classifyCitationIntent, isOwnResultClaim } from "../../src/citation/citationIntent.js";
import { buildJudgePrompt, classifyPriority, parseJudgeOutput } from "../../src/citation/semanticVerifier.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import { EvidenceSelectionService } from "../../src/evidence/EvidenceSelectionService.js";
import { computeClaimGroundingReport, findEvidenceCandidates } from "../../src/review/claimGrounding.js";
import { checkStyleInvariants } from "../../src/review/styleInvariants.js";
import { scanStyleSignals } from "../../src/review/styleSignals.js";
import { buildSectionPrompt, partitionEvidenceBackedKeys } from "../../src/writer/WriterService.js";
import { computeEvidenceCitationCoverage } from "../../src/quality/evidenceCitationCoverage.js";
import { readStylePolicy } from "../../src/review/stylePolicy.js";

const evidence: EvidenceRecord = {
  id: "E001", claim: "模型不依赖循环与卷积，使用注意力建立依赖。",
  quote: "The model dispenses with recurrence and relies on attention.",
  verificationStatus: "verified", supportStrength: "partial", verificationLevel: "fulltext",
  source: { sourceId: "S001", title: "Attention architecture", year: 2020 },
  location: { chunk: "S001:SEC01:0001:fixture" }, createdBy: "test", createdAt: "2026-01-01T00:00:00Z",
};
const bib = [{ key: "attention2020", type: "article", title: "Attention architecture", year: 2020, sourceId: "S001" }];
const abstract = [{ source: "fixture:1", text: "Prior work reports that attention does not improve accuracy on small datasets.", evidenceLevel: "abstract" as const, retrievedAt: "2026-01-01T00:00:00Z" }];

describe("M13.7.2 citation intent and writing boundaries", () => {
  it.each([
    ["注意力模型是本文的研究背景。", "background"],
    ["模型通过注意力计算全局依赖。", "method"],
    ["准确率达到 93.2%。", "result"],
    ["与本文不同，相关文献认为注意力没有改善小样本泛化。", "comparison"],
    ["与本文采用循环结构不同，被引文献提出完全依赖注意力的模型。", "comparison"],
    ["研究背景：模型通过损失函数计算权重。", "method"],
    ["研究背景：准确率达到 93.2%。", "result"],
  ])("routes %s conservatively", (text, intent) => expect(classifyCitationIntent(text)).toBe(intent));

  it("relevant background does not become a supported factual claim", () => {
    const out = parseJudgeOutput(JSON.stringify({ verdict: "SUPPORTED", citationIntent: "background", relevance: "relevant", reason: "相关背景" }), [], "full", "注意力模型是研究背景。");
    expect(out).toMatchObject({ verdict: "INSUFFICIENT_EVIDENCE", claimSupported: false, relevance: "relevant" });
  });
  it("genuine but irrelevant references cannot pass via metadata identity", () => {
    const raw = JSON.stringify({ verdict: "SUPPORTED", relevance: "irrelevant", reason: "地质学来源与注意力无关" });
    expect(parseJudgeOutput(raw, abstract).verdict).toBe("UNSUPPORTED");
    expect(parseJudgeOutput(raw.replace("SUPPORTED", "NO_CONTRADICTION_DETECTED"), abstract, "contradiction_only").verdict).toBe("INSUFFICIENT_EVIDENCE");
  });
  it("external literature cannot establish our experimental result", () => {
    const claim = "本文实验准确率达到 93.2%。";
    expect(isOwnResultClaim(claim)).toBe(true);
    expect(parseJudgeOutput('{"verdict":"SUPPORTED","reason":"相关"}', abstract, "full", claim).verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(findEvidenceCandidates(claim, [{ ...evidence, supportStrength: "direct", claim, quote: claim }])).toEqual([]);
  });
  it("opposing literature is checked against attributed viewpoint with original context", () => {
    const claim = "Prior work reports that attention does not improve accuracy on small datasets.";
    const out = parseJudgeOutput(JSON.stringify({ verdict: "SUPPORTED", citationIntent: "comparison", relevance: "relevant", keyQuote: claim }), abstract, "full", claim);
    expect(out).toMatchObject({ verdict: "SUPPORTED", claimSupported: true });
    const prompt = buildJudgePrompt({ claimText: claim, sourceSentence: "Unlike our findings, " + claim, referenceIds: [], references: [], metadataRecords: new Map(), groupRawText: "[1]", evidence: abstract });
    expect(prompt).toContain("Unlike our findings");
    expect(prompt).toContain("不是要求被引论文赞同本文");
  });
  it("keeps semantic mode and old judge-output contracts", () => {
    expect(parseJudgeOutput('{"verdict":"NO_CONTRADICTION_DETECTED"}', abstract, "contradiction_only").claimSupported).toBe(false);
    expect(parseJudgeOutput('{"verdict":"SUPPORTED"}', abstract).verdict).toBe("SUPPORTED");
    expect(classifyPriority("实验结果")).toBe("obligatory");
    expect(readStylePolicy({})).toBe("suggest_only");
  });
  it("partial binding is never counted as complete support", () => {
    const report = computeClaimGroundingReport({ projectId: "test", round: 1,
      factClaims: [{ section: "method", claim: evidence.claim, verdict: "SUPPORTED", evidenceId: evidence.id }], formalEvidence: [evidence], bibEntries: bib });
    expect(report.supportedClaims).toBe(0);
    expect(report.partiallySupportedClaims).toBe(1);
    expect(report.claims[0]).toMatchObject({ reviewerVerdict: "SUPPORTED", verdict: "PARTIALLY_SUPPORTED" });
    const numeric = computeClaimGroundingReport({ projectId: "test", round: 1, factClaims: [{ section: "results", claim: "准确率为 93.2%", verdict: "SUPPORTED", evidenceId: evidence.id }], formalEvidence: [evidence], bibEntries: bib });
    expect(numeric.evidenceBoundClaims).toBe(0);
    expect(numeric.unsupportedClaims).toBe(1);
  });
  it("numeric repair requires every distinctive number, not one matching number or substring", () => {
    const record = { ...evidence, supportStrength: "direct" as const, claim: "注意力模型准确率 93.2，召回率 80.1", quote: "" };
    expect(findEvidenceCandidates("注意力模型准确率 93.2，召回率 99.1", [record])).toEqual([]);
    expect(findEvidenceCandidates("注意力模型准确率 3.2", [record])).toEqual([]);
    expect(findEvidenceCandidates("注意力模型准确率 93.2，召回率 80.1", [record])).toHaveLength(1);
  });
  it("Writer receives strength, quote boundary and manuscript rules; metadata-only keys are not A", () => {
    const section = { id: "method", file: "method.tex", title: "方法" };
    const prompt = buildSectionPrompt({ section, outline: { title: "test", sections: [section] }, evidence: [evidence], bibliography: bib });
    expect(prompt).toContain("support=partial");
    expect(prompt).toContain(evidence.quote);
    expect(prompt).toContain("partial Evidence 的 claim 是待核验命题");
    expect(prompt).toContain("科学限制必须保留");
    expect(partitionEvidenceBackedKeys([{ ...evidence, verificationLevel: "metadata" }], bib).backedKeys).toEqual([]);
    const coverage = computeEvidenceCitationCoverage({ citedKeys: [bib[0]!.key], bibEntries: bib, evidenceRecords: [evidence] });
    expect(coverage.supportByKey?.attention2020).toEqual({ direct: 0, partial: 1, other: 0 });
  });
  it("balances source supply before bounded truncation without changing eligibility", async () => {
    const records = [evidence, { ...evidence, id: "E002", supportStrength: "direct" as const }, { ...evidence, id: "E003", supportStrength: "direct" as const }, { ...evidence, id: "E004", source: { sourceId: "S002" } }];
    const selector = new EvidenceSelectionService({ list: async () => records, query: async () => records });
    const selected = await selector.selectForWriting("test", { limit: 2 });
    expect(selected.formal.map((record) => record.source!.sourceId)).toEqual(["S001", "S002"]);
    expect(selected.formal[0]!.supportStrength).toBe("direct");
  });
  it("flags workflow notes and leaves concrete scientific limitations unflagged", () => {
    expect(scanStyleSignals("本轮检索未发现更多文献。待补实验。作者确认、尚未核验。").byKind.workflow_note).toBe(3);
    expect(scanStyleSignals("实验仅覆盖小样本数据，尚缺跨域评测。负结果限制了泛化结论。").byKind.workflow_note).toBe(0);
  });
  it.each([
    ["实验仅覆盖小样本，尚缺跨域评测。", "实验覆盖小样本。"],
    ["据摘要报告，该方法获得部分支持。", "该方法获得支持。"],
    ["结果为 93.2%。", "结果为 93.3%。"],
    ["公式 $x=y+z$。", "公式 $x=y-z$。"],
    ["相关工作\\cite{a}。", "相关工作\\cite{b}。"],
    ["方法优于基线。", "方法低于基线。"],
  ])("rejects scientific changes during style polish: %s", (before, after) => expect(checkStyleInvariants(before, after).ok).toBe(false));
  it("permits expression improvement while retaining limitations and facts", () => {
    const before = "该方法在测试集上的准确率为 93.2%，仅覆盖小样本，尚缺跨域评测。\\cite{a} 公式 $x=y+z$。";
    const after = "在测试集上，该方法的准确率为 93.2%，仅覆盖小样本，尚缺跨域评测。\\cite{a} 公式 $x=y+z$。";
    expect(checkStyleInvariants(before, after).ok).toBe(true);
  });
});
