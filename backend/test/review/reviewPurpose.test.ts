/**
 * M14.9.3 P0-B：第三方已发表论文只读评估语义（review purpose）。
 *
 * - 缺省 author_manuscript：Reviewer prompt 与 Quality Gate（80 分阈值、规则 4–7）逐字节 / 逐规则不变；
 * - published_paper_assessment：论文自报数值 = PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED，不因「项目没有
 *   原始数据」批量成为科研 finding；但稿内可核对的算术错误、表文矛盾、显著性方向反转仍是科研 finding；
 * - 未执行的 citation.verify / 证据核验 / 可行性 / 实验复现一律 NOT_EVALUATED，不能凭 0 计数冒充 PASS。
 */
import { describe, expect, it } from "vitest";

import { buildReviewPrompt, ReviewerService, type ReviewIssue } from "../../src/agents/ReviewerService.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { buildPublishedAssessmentView, classifyPublishedFinding, readReviewPurpose, renderPublishedAssessmentPolicyLines } from "../../src/review/reviewPurpose.js";

const issue = (category: ReviewIssue["category"], severity: ReviewIssue["severity"], description: string, blocking = false): ReviewIssue => ({ category, severity, section: "2 结果", description, blocking });

/** 形态取自 M14.9.2 冻结全链 Gate 中的意见类型（措辞为合成，不含原论文文本） */
const EVIDENCE_UNAVAILABLE = [
  issue("evidence_gap", "critical", "表1、表2给出了全部样本量和检验统计量，但项目没有导入调查数据，证据库也没有相应记录，这些数值目前无法核验来源。", true),
  issue("evidence_gap", "major", "本项目尚未导入或授权实验数据，本节给出的超参数与表5指标缺少可核验的来源。", true),
  issue("evidence_gap", "major", "摘要列出的患病率与OR值在证据库中没有记录，项目也未导入原始数据。", false),
];
const REAL_ERRORS = [
  issue("academic", "major", "加权求和的算术结果与列出的各项不符：按文中权重复算应为43.0，文中写作42.0。"),
  issue("evidence_gap", "critical", "表2中各分层的患病率均高于对照组，但正文称调整后风险更低，与表2方向相反且未解释；项目也没有原始数据。", true),
  issue("academic", "major", "显著性表述反转：表3中P=0.21，正文却称差异有统计学意义。"),
];
const SUBMISSION = issue("style", "minor", "作者信息与基金号格式不符合期刊投稿格式规范。");
const BUILD = issue("build", "major", "式（1）乱码：分子分母混在一起，读者无法辨认公式。", true);

function summary(issues: ReviewIssue[], academicScore = 59): ReviewSummary {
  return {
    generatedAt: "2026-10-19T00:00:00.000Z",
    round: 1,
    issues,
    counts: {
      critical: issues.filter((entry) => entry.severity === "critical").length,
      major: issues.filter((entry) => entry.severity === "major").length,
      minor: issues.filter((entry) => entry.severity === "minor").length,
      byCategory: {},
      blocking: issues.filter((entry) => entry.blocking).length,
    },
    scores: { academicScore, styleRisk: 12, factVerdicts: null },
    openCritical: issues.filter((entry) => entry.severity === "critical").length,
    openMajor: issues.filter((entry) => entry.severity === "major").length,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
    coverage: { mode: "units", snapshotId: "s".repeat(64), round: 1, targetUnits: 7, completedUnits: 7, failedUnits: 0, reusedUnits: 0, targetChars: 100, reviewedChars: 100, ratio: 1, complete: true, failedUnitIds: [] },
  } as unknown as ReviewSummary;
}

const evidenceStats = { total: 0, byStatus: { verified: 0, unverified: 0, contradictory: 0, not_found: 0, plausible: 0, mismatch: 0, unverifiable: 0 }, contradictory: 0, skippedLines: 0 } as never;

describe("readReviewPurpose", () => {
  it("缺省 / 历史 run / 非法值都是 author_manuscript；只有显式值才进入只读评估", () => {
    expect(readReviewPurpose(undefined)).toBe("author_manuscript");
    expect(readReviewPurpose({})).toBe("author_manuscript");
    expect(readReviewPurpose({ reviewPurpose: "anything" })).toBe("author_manuscript");
    expect(readReviewPurpose({ reviewPurpose: "published_paper_assessment" })).toBe("published_paper_assessment");
  });
});

describe("classifyPublishedFinding", () => {
  it("「项目没有原始数据 / 证据库无记录」→ 证据可得性限制（不是论文缺陷）", () => {
    for (const entry of EVIDENCE_UNAVAILABLE) expect(classifyPublishedFinding(entry)).toBe("EVIDENCE_LIMITATION");
  });
  it("算术错误、表文方向矛盾、显著性反转 → 科研 finding（即使同时提到缺原始数据，也不以已发表为由豁免）", () => {
    for (const entry of REAL_ERRORS) expect(classifyPublishedFinding(entry)).toBe("SCIENTIFIC_FINDING");
  });
  it("投稿元数据 → 投稿清单；build → 转写伪影", () => {
    expect(classifyPublishedFinding(SUBMISSION)).toBe("SUBMISSION_CHECKLIST");
    expect(classifyPublishedFinding(BUILD)).toBe("CONVERSION_ARTIFACT");
  });
});

describe("buildPublishedAssessmentView（生产 Gate 不变 + 只读评估视图）", () => {
  const review = summary([...EVIDENCE_UNAVAILABLE, ...REAL_ERRORS, SUBMISSION, BUILD]);
  const gate = evaluateQualityGate({ review, citation: null, evidence: evidenceStats, feasibility: null });

  it("生产 Gate 原样执行：80 分阈值、blocking / critical-major 规则判定与作者稿件口径一致", () => {
    expect(DEFAULT_QUALITY_THRESHOLDS.academicPassScore).toBe(80);
    expect(gate.passed).toBe(false);
    const failed = gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule);
    expect(failed).toEqual(expect.arrayContaining(["blocking_issues_zero", "open_critical_major_zero", "academic_score_threshold"]));
  });

  it("论文自报数值的证据可得性限制单列，不计入科研 finding；真实稿内错误仍计入", () => {
    const view = buildPublishedAssessmentView({ gate, review, citationReportAvailable: false, evidenceRecords: 0, feasibilityEvaluated: false });
    expect(view.publicationGate).toBe("PUBLICATION_GATE_NOT_APPLICABLE");
    expect(view.evidenceLimitations.total).toBe(3);
    expect(view.evidenceLimitations.label).toBe("PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED");
    expect(view.scientificFindings.total).toBe(3);
    expect(view.scientificFindings.critical).toBe(1);
    expect(view.scientificFindings.blocking).toBe(1);
    expect(view.conversionArtifacts.total).toBe(1);
    expect(view.submissionChecklist.total).toBe(1);
    expect(view.productionGate.passed).toBe(gate.passed);
    expect(view.productionGate.reasons).toEqual(gate.reasons);
  });

  it("没有引用核验 / 证据库 / claims 核验 / 可行性评估时，对应规则是 NOT_EVALUATED，不是 PASS", () => {
    const view = buildPublishedAssessmentView({ gate, review, citationReportAvailable: false, evidenceRecords: 0, feasibilityEvaluated: false });
    const byRule = new Map(view.ruleApplicability.map((entry) => [entry.rule, entry]));
    for (const rule of ["hallucinated_citations_zero", "citation_structure_valid", "no_contradictory_evidence", "unsupported_critical_claims_zero", "target_feasibility"]) {
      expect(byRule.get(rule)?.productionPassed).toBe(true);
      expect(byRule.get(rule)?.applicability).toBe("NOT_EVALUATED");
    }
    expect(byRule.get("academic_score_threshold")?.applicability).toBe("REPORTED_ONLY");
    expect(view.notEvaluated.map((entry) => entry.item)).toEqual(expect.arrayContaining(["citation_verification", "experiment_reproduction", "target_feasibility", "build_gate", "evidence_grounding"]));
  });

  it("执行过引用核验 / 有证据库时，相应规则按 APPLICABLE 呈现", () => {
    const view = buildPublishedAssessmentView({ gate, review, citationReportAvailable: true, evidenceRecords: 5, feasibilityEvaluated: true });
    const byRule = new Map(view.ruleApplicability.map((entry) => [entry.rule, entry]));
    expect(byRule.get("hallucinated_citations_zero")?.applicability).toBe("APPLICABLE");
    expect(byRule.get("no_contradictory_evidence")?.applicability).toBe("APPLICABLE");
    expect(view.notEvaluated.map((entry) => entry.item)).not.toContain("citation_verification");
  });
});

describe("Reviewer prompt：缺省逐字节不变，只读评估替换 Experiment Policy", () => {
  const policy = ["===== Experiment Policy（实验数据使用口径；全体角色一致）=====", "- 当前项目没有已导入的实验数据。"];
  const base = { projectId: "p", mode: "academic" as const, manuscriptDigest: "稿件", evidence: [] };

  it("作者稿件：注入 Experiment Policy 与「按实验支撑缺口如实报告」；没有只读评估口径", () => {
    const prompt = buildReviewPrompt({ ...base, experimentPolicyLines: policy });
    expect(prompt).toContain("按实验支撑缺口如实报告");
    expect(prompt).not.toContain("published_paper_assessment");
    expect(buildReviewPrompt({ ...base, experimentPolicyLines: policy, publishedAssessmentLines: undefined })).toBe(prompt);
  });

  it("只读评估：论文自报数值口径进入 prompt，作者稿件的实验支撑缺口口径不出现；fact 模式不要求把自报结果判 UNSUPPORTED", () => {
    const lines = renderPublishedAssessmentPolicyLines();
    const prompt = buildReviewPrompt({ ...base, publishedAssessmentLines: lines });
    expect(prompt).toContain("PAPER_REPORTED");
    expect(prompt).toContain("不因论文已发表而豁免");
    expect(prompt).not.toContain("按实验支撑缺口如实报告");
    const fact = buildReviewPrompt({ ...base, mode: "fact", publishedAssessmentLines: lines });
    expect(fact).not.toContain("正文中所有强论断都应标记 UNSUPPORTED");
    expect(buildReviewPrompt({ ...base, mode: "fact" })).toContain("正文中所有强论断都应标记 UNSUPPORTED");
  });

  it("单元审稿 prompt 同样替换（且缺省不变）", async () => {
    const prompts: string[] = [];
    const runtime = {
      runAgent: async (input: { task: string }) => {
        prompts.push(input.task);
        return { taskId: "t", status: "completed", output: JSON.stringify({ summary: "s", issues: [], academicScore: 70, riskScore: 10 }) };
      },
    };
    const reviewer = new ReviewerService({ runtime: runtime as never, agentId: "reviewer", projects: {} as never });
    const unit = { unitId: "u1", file: "main.tex", heading: "2 结果", unitIndex: 1, unitCount: 1, text: "共纳入 5 642 名研究对象。" };
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["2 结果"], experimentPolicyLines: policy });
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["2 结果"], publishedAssessmentLines: renderPublishedAssessmentPolicyLines() });
    expect(prompts[0]).toContain("其余具体数值按实验支撑缺口如实报告");
    expect(prompts[0]).not.toContain("PAPER_REPORTED");
    expect(prompts[1]).toContain("PAPER_REPORTED");
    expect(prompts[1]).not.toContain("实验支撑缺口如实报告");
  });
});
