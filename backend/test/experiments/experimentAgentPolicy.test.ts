/**
 * M13.6 Agent 实验数据口径一致性（NB-11 收口）回归：
 * - Outline Planner 与 Writer 正文共享同一 Experiment Context（授权观测表 +
 *   数值纪律）——大纲/摘要不再游离于正文纪律之外；
 * - 修订（reviseSection prompt）同样携带授权观测表（修订引入数值的唯一来源）；
 * - Feasibility / Reviewer 共享 Experiment Policy 摘要（范围级授权视图，不含
 *   具体数值）：零授权时「禁写具体数值」的口径与 Writer 一致；
 * - renderExperimentPolicyLines：零数据 / 有授权 / 未授权范围三种口径。
 */

import { describe, expect, it } from "vitest";

import { renderExperimentContextLines, buildOutlinePrompt, buildRevisePrompt, buildSectionPrompt } from "../../src/writer/WriterService.js";
import { buildFeasibilityPrompt } from "../../src/agents/FeasibilityService.js";
import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import { renderExperimentPolicyLines, type ExperimentPolicyView } from "../../src/experiments/experimentPolicy.js";
import type { ConfirmedExperimentWorkflowContext } from "../../src/experiments/ExperimentPackageService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { ResearchReport } from "../../src/agents/ResearcherService.js";

const experimentContext: ConfirmedExperimentWorkflowContext = {
  schemaVersion: 1,
  status: "author_confirmed_not_externally_verified",
  truncated: false,
  observations: [
    {
      packageId: "ep-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", packageHash: "a".repeat(64),
      groupId: "main", sourceId: "S001", blockId: "B0001", path: "main/results.csv",
      metric: "HOTA", value: 60.1, unit: "unknown", direction: "higher", split: "Dev25",
    },
  ],
};

const emptyExperimentContext: ConfirmedExperimentWorkflowContext = {
  schemaVersion: 1,
  status: "author_confirmed_not_externally_verified",
  truncated: false,
  observations: [],
};

const noEvidence: EvidenceRecord[] = [];
const noBibliography: Array<{ key: string; title: string }> = [];
const researchDigest = { domainOverview: "多目标跟踪。", researchGaps: ["身份切换。"], potentialContributions: ["持久身份槽。"] };
const researchReport: ResearchReport = {
  domainOverview: "多目标跟踪。",
  researchGaps: ["身份切换。"],
  potentialContributions: ["持久身份槽。"],
  evidenceCandidates: [],
  bibliography: [],
} as unknown as ResearchReport;
const evidenceStats = { total: 0, byStatus: { verified: 0, unverified: 0, contradictory: 0, not_found: 0, plausible: 0, mismatch: 0, unverifiable: 0 }, contradictory: 0, skippedLines: 0 };
const project = { title: "持久身份槽", documentType: "论文", targetProfile: "核心期刊" } as never;

describe("renderExperimentContextLines（授权观测表）", () => {
  it("undefined 不注入；空上下文显式禁写数值；有授权时逐条列出 + 纪律", () => {
    expect(renderExperimentContextLines(undefined)).toEqual([]);
    const empty = renderExperimentContextLines(emptyExperimentContext);
    expect(empty.some((line) => line.includes("没有任何经作者确认并授权"))).toBe(true);
    expect(empty.some((line) => line.includes("不得出现任何具体实验指标数值"))).toBe(true);
    const lines = renderExperimentContextLines(experimentContext);
    expect(lines.some((line) => line.includes("main/Dev25"))).toBe(true);
    expect(lines.some((line) => line.includes("HOTA=60.1"))).toBe(true);
    expect(lines.some((line) => line.includes("实验数值纪律"))).toBe(true);
  });
});

describe("renderExperimentPolicyLines（范围级口径，无数值）", () => {
  it("零数据：声明没有实验数据 + 待补实验口径", () => {
    const lines = renderExperimentPolicyLines({ entries: [], legacyConfirmedGroupIds: [] });
    expect(lines.some((line) => line.includes("没有已导入的实验数据"))).toBe(true);
    expect(lines.some((line) => line.includes("待补实验"))).toBe(true);
  });
  it("有授权与未授权范围：逐范围列出授权状态（不出现具体数值）", () => {
    const policy: ExperimentPolicyView = {
      entries: [
        { packageId: "ep-a", groupId: "main", scopeId: "main@Dev25", split: "Dev25", status: "confirmed", workflowUse: "allowed", observationCount: 8, metricCount: 2 },
        { packageId: "ep-a", groupId: "main", scopeId: "main@Confirmation13", split: "Confirmation13", status: "confirmed", workflowUse: "undecided", observationCount: 8, metricCount: 2 },
      ],
      legacyConfirmedGroupIds: [],
    };
    const joined = renderExperimentPolicyLines(policy).join("\n");
    expect(joined).toContain("Dev25");
    expect(joined).toContain("Confirmation13");
    expect(joined).toContain("已授权进入工作流");
    expect(joined).toContain("未授权");
    expect(joined).not.toContain("60.1"); // 不出现具体数值
  });
});

describe("Outline / Writer / Revision 共享 Experiment Context", () => {
  it("buildOutlinePrompt：注入授权观测表与数值纪律（缺省不注入，行为与旧版一致）", () => {
    const base = buildOutlinePrompt({ researchDigest, evidence: noEvidence, bibliography: noBibliography });
    expect(base).not.toContain("Experiment Context");
    const withContext = buildOutlinePrompt({ researchDigest, evidence: noEvidence, bibliography: noBibliography, experimentContext });
    expect(withContext).toContain("作者已确认并授权的实验观测");
    expect(withContext).toContain("HOTA=60.1");
    expect(withContext).toContain("摘要与 keyPoints 的实验数值纪律");
    // 零授权：摘要禁写具体数值的口径与正文一致（NB-11）
    const empty = buildOutlinePrompt({ researchDigest, evidence: noEvidence, bibliography: noBibliography, experimentContext: emptyExperimentContext });
    expect(empty).toContain("没有任何经作者确认并授权");
  });

  it("buildSectionPrompt：既有行为保持（experimentContext 注入正文纪律）", () => {
    const prompt = buildSectionPrompt({
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      evidence: noEvidence,
      bibliography: noBibliography,
      experimentContext,
    });
    expect(prompt).toContain("HOTA=60.1");
  });

  it("buildRevisePrompt：修订同样携带授权观测表（修订引入数值时的唯一来源）", () => {
    const base = buildRevisePrompt({
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: "\\section{实验} 旧内容。",
      issues: [{ severity: "major", blocking: false, description: "表述不清", category: "academic", section: "experiments" }],
      evidence: noEvidence,
      bibliography: noBibliography,
    });
    expect(base).not.toContain("HOTA=60.1");
    const withContext = buildRevisePrompt({
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: "\\section{实验} 旧内容。",
      issues: [{ severity: "major", blocking: false, description: "表述不清", category: "academic", section: "experiments" }],
      evidence: noEvidence,
      bibliography: noBibliography,
      experimentContext,
    });
    expect(withContext).toContain("HOTA=60.1");
    expect(withContext).toContain("实验数值纪律");
  });
});

describe("Feasibility / Reviewer 共享 Experiment Policy 摘要", () => {
  it("buildFeasibilityPrompt：注入范围级口径（缺省不注入）", () => {
    const base = buildFeasibilityPrompt(project, researchReport, evidenceStats, "idea");
    expect(base).not.toContain("Experiment Policy");
    const policyLines = renderExperimentPolicyLines({ entries: [], legacyConfirmedGroupIds: [] });
    const withPolicy = buildFeasibilityPrompt(project, researchReport, evidenceStats, "idea", undefined, policyLines);
    expect(withPolicy).toContain("Experiment Policy");
    expect(withPolicy).toContain("待补实验");
  });

  it("buildReviewPrompt：三路模式共享同一政策块（审稿对实验数据可用性判断与写作层一致）", () => {
    const policyLines = renderExperimentPolicyLines({
      entries: [
        { packageId: "ep-a", groupId: "main", scopeId: "main@Dev25", split: "Dev25", status: "confirmed", workflowUse: "allowed", observationCount: 8, metricCount: 2 },
      ],
      legacyConfirmedGroupIds: [],
    });
    for (const mode of ["fact", "academic", "style"] as const) {
      const prompt = buildReviewPrompt({
        projectId: "p-test",
        mode,
        manuscriptDigest: "…",
        evidence: noEvidence,
        experimentPolicyLines: policyLines,
      });
      expect(prompt).toContain("Experiment Policy");
      expect(prompt).toContain("实验支撑缺口");
    }
  });
});
