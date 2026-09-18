/**
 * M6.8 Evaluation 测试二：metric calculation（纯函数口径钉死）。
 */

import { describe, expect, it } from "vitest";

import { aggregateFromOutcomes, computeGroundingMetrics, groundTruthOf } from "../../src/evaluation/metrics/grounding.js";
import { computeRevisionSafetyMetrics, isSafetyGateRule } from "../../src/evaluation/metrics/revision.js";
import { aggregateWorkflowMetrics, computeWorkflowMetrics } from "../../src/evaluation/metrics/workflow.js";
import { computeHumanPreference, parseCalibrationRecords, summarizeCalibration } from "../../src/evaluation/metrics/calibration.js";
import type {
  CalibrationRecord,
  GroundingProposalOutcome,
  RevisionScenarioRunRecord,
} from "../../src/evaluation/types.js";

function outcome(partial: Partial<GroundingProposalOutcome>): GroundingProposalOutcome {
  return {
    key: "k",
    claim: "c",
    claimSupported: true,
    quoteVerbatim: true,
    metadataCorrect: true,
    faultClass: null,
    disposition: "accepted",
    ...partial,
  };
}

describe("Experiment 1 指标", () => {
  it("unsupported / fabricated / coverage 基本口径", () => {
    const outcomes: GroundingProposalOutcome[] = [
      outcome({ key: "ok-1" }),
      outcome({ key: "f1", claimSupported: false, faultClass: "unsupported_claim", disposition: "accepted" }),
      outcome({ key: "f2", quoteVerbatim: false, faultClass: "fabricated_quote", disposition: "accepted" }),
      outcome({ key: "f3", metadataCorrect: false, faultClass: "metadata_mismatch", disposition: "rejected_metadata_mismatch" }),
    ];
    const metrics = computeGroundingMetrics(outcomes, 2);
    expect(metrics.accepted).toBe(3);
    // 3 个 accepted 里 1 个 unsupported
    expect(metrics.unsupportedClaimRate).toBeCloseTo(1 / 3);
    // fabricated = quote 不逐字 或 元数据错（f2；f3 已被拒不算）
    expect(metrics.fabricatedCitationRate).toBeCloseTo(1 / 3);
    // 2 个正例命中 1 个
    expect(metrics.evidenceCoverage).toBeCloseTo(1 / 2);
    expect(metrics.dispositions).toEqual({ accepted: 3, rejected_metadata_mismatch: 1 });
  });

  it("全拒收臂：accepted=0 时不除零，coverage 按正例总数计 0", () => {
    const outcomes: GroundingProposalOutcome[] = [
      outcome({ key: "f1", disposition: "rejected_quote_mismatch" }),
    ];
    const metrics = computeGroundingMetrics(outcomes, 3);
    expect(metrics.accepted).toBe(0);
    expect(metrics.unsupportedClaimRate).toBe(0);
    expect(metrics.fabricatedCitationRate).toBe(0);
    expect(metrics.evidenceCoverage).toBe(0);
  });

  it("groundTruthOf：faultClass → 布尔三元组派生", () => {
    expect(groundTruthOf(null)).toEqual({ claimSupported: true, quoteVerbatim: true, metadataCorrect: true });
    expect(groundTruthOf("fabricated_quote").quoteVerbatim).toBe(false);
    expect(groundTruthOf("unsupported_claim").claimSupported).toBe(false);
    expect(groundTruthOf("metadata_mismatch").metadataCorrect).toBe(false);
  });

  it("aggregateFromOutcomes：跨场景按提案数加权", () => {
    const a = {
      supportableTotal: 1,
      outcomes: [outcome({ key: "ok-1" })],
    };
    const b = {
      supportableTotal: 1,
      outcomes: [
        outcome({ key: "ok-2" }),
        outcome({ key: "f1", claimSupported: false, faultClass: "unsupported_claim" }),
        outcome({ key: "f2", quoteVerbatim: false, faultClass: "fabricated_quote" }),
      ],
    };
    const metrics = aggregateFromOutcomes([a, b]);
    expect(metrics.accepted).toBe(4);
    expect(metrics.unsupportedClaimRate).toBeCloseTo(1 / 4);
    expect(metrics.fabricatedCitationRate).toBeCloseTo(1 / 4);
    expect(metrics.evidenceCoverage).toBe(1);
  });
});

describe("Experiment 2 指标", () => {
  const record = (partial: Partial<RevisionScenarioRunRecord>): RevisionScenarioRunRecord => ({
    scenarioId: "s",
    arm: "baseline",
    injectedViolations: [],
    expectedClean: false,
    factSurvived: null,
    citationSurvived: null,
    strengthSurvived: null,
    flagged: false,
    flagChannels: [],
    runOutcome: null,
    validationRounds: [],
    gateRounds: [],
    hitlStages: [],
    ...partial,
  });

  it("存活率 / false acceptance / false rejection 口径", () => {
    const metrics = computeRevisionSafetyMetrics([
      // fact 注入：存活 + 无信号（baseline 形态）
      record({ injectedViolations: ["fact"], factSurvived: true, flagged: false }),
      // strength 注入：被拦（未存活 + 有信号）
      record({ injectedViolations: ["strength"], strengthSurvived: false, flagged: true }),
      // citation 注入：未存活 + 有信号
      record({ injectedViolations: ["citation"], citationSurvived: false, flagged: true }),
      // 干净对照：未误拦
      record({ expectedClean: true, flagged: false }),
    ]);
    expect(metrics.factViolationRate).toBe(1);
    expect(metrics.claimEscalationRate).toBe(0);
    expect(metrics.citationLossRate).toBe(0);
    expect(metrics.falseAcceptanceRate).toBeCloseTo(1 / 3);
    expect(metrics.falseRejectionRate).toBe(0);
    expect(metrics.cleanScenarios).toBe(1);
  });

  it("无该类样本时返回 null（不伪造 0）", () => {
    const metrics = computeRevisionSafetyMetrics([
      record({ injectedViolations: ["fact"], factSurvived: true }),
      record({ expectedClean: true }),
    ]);
    expect(metrics.citationLossRate).toBeNull();
    expect(metrics.claimEscalationRate).toBeNull();
  });

  it("falseRejection 分母为 0（无干净对照）→ null；isSafetyGateRule 只认安全类规则", () => {
    const metrics = computeRevisionSafetyMetrics([record({ injectedViolations: ["fact"] })]);
    expect(metrics.falseRejectionRate).toBeNull();
    expect(isSafetyGateRule("fact_preservation")).toBe(true);
    expect(isSafetyGateRule("citation_keys_preserved_r1")).toBe(true);
    expect(isSafetyGateRule("claim_strength_guard")).toBe(true);
    expect(isSafetyGateRule("academic_score")).toBe(false);
  });
});

describe("Experiment 3 指标", () => {
  const inputs = {
    citationsInOutput: ["gao2023survey", "zhao2024nonexistent"],
    validCitationKeys: ["gao2023survey"],
    expectedCitationKeys: ["gao2023survey"],
    expectedStages: ["research.idea", "build.final"],
    stagesCompleted: ["research.idea"],
    expectedSections: ["sections/introduction.tex", "sections/conclusion.tex"],
    sectionsWritten: ["sections/introduction.tex"],
    expectedClaimNeedles: ["核心观点"],
    outputText: "本节阐述核心观点。",
    traceableClaims: 1,
    totalCitedClaims: 2,
    humanPreference: null,
  };

  it("四项 completeness 平均与 claim/citation correctness", () => {
    const metrics = computeWorkflowMetrics(inputs);
    expect(metrics.claimCorrectness).toBeCloseTo(1 / 2);
    expect(metrics.citationCorrectness).toBeCloseTo(1 / 2);
    // stage 1/2、section 1/2、citation 1/1、claim needle 1/1 → (0.5+0.5+1+1)/4
    expect(metrics.completeness).toBeCloseTo(3 / 4);
    expect(metrics.humanPreference).toBeNull();
  });

  it("聚合：humanPreference 只对非 null 取均值；无记录保持 null", () => {
    const aggregated = aggregateWorkflowMetrics([
      { metrics: { claimCorrectness: 0, citationCorrectness: 1, completeness: 0.5, humanPreference: null } },
      { metrics: { claimCorrectness: 1, citationCorrectness: 0.5, completeness: 0.75, humanPreference: 1 } },
    ]);
    expect(aggregated.claimCorrectness).toBeCloseTo(0.5);
    expect(aggregated.humanPreference).toBe(1);
    expect(aggregateWorkflowMetrics([
      { metrics: { claimCorrectness: 0, citationCorrectness: 0, completeness: 0, humanPreference: null } },
    ]).humanPreference).toBeNull();
  });
});

describe("Human Calibration 指标", () => {
  it("解析 + 一致率 + 逐 prediction 分组；脏行如实计数", () => {
    const text = [
      JSON.stringify({ experiment: 1, scenarioId: "g1", arm: "plain-llm", claim: "c1", prediction: "unsupported", humanLabel: "unsupported", reason: "r" }),
      JSON.stringify({ experiment: 1, scenarioId: "g1", arm: "rag", claim: "c2", prediction: "unsupported", humanLabel: "supported", reason: "r" }),
      "{ not json",
      JSON.stringify({ experiment: 1, scenarioId: "g1", arm: "rag", claim: "c3", prediction: "supported", humanLabel: "supported", reason: "r", recordedAt: "2026-09-18T00:00:00Z" }),
    ].join("\n");
    const { records, parseErrors } = parseCalibrationRecords(text);
    expect(records).toHaveLength(3);
    expect(parseErrors).toHaveLength(1);
    const summary = summarizeCalibration(records, parseErrors);
    expect(summary.valid).toBe(3);
    expect(summary.malformed).toBe(1);
    expect(summary.agreementRate).toBeCloseTo(2 / 3);
    expect(summary.perPrediction.find((entry) => entry.prediction === "unsupported")).toEqual({
      prediction: "unsupported",
      total: 2,
      agreed: 1,
    });
  });

  it("空记录 → agreementRate null；computeHumanPreference 无记录 → null", () => {
    const summary = summarizeCalibration([]);
    expect(summary.agreementRate).toBeNull();
    const records: CalibrationRecord[] = [];
    expect(computeHumanPreference(records, 3, "w1", "paperteam")).toBeNull();
  });

  it("computeHumanPreference：prefer-<arm> 占比", () => {
    const records: CalibrationRecord[] = [
      { experiment: 3, scenarioId: "w1", arm: "plain-llm", claim: "产出对比", prediction: "x", humanLabel: "prefer-paperteam", reason: "r" },
      { experiment: 3, scenarioId: "w1", arm: "plain-llm", claim: "产出对比", prediction: "x", humanLabel: "prefer-plain-llm", reason: "r" },
      { experiment: 3, scenarioId: "w1", arm: "plain-llm", claim: "产出对比", prediction: "x", humanLabel: "prefer-paperteam", reason: "r" },
    ];
    expect(computeHumanPreference(records, 3, "w1", "paperteam")).toBeCloseTo(2 / 3);
    expect(computeHumanPreference(records, 3, "w1", "plain-llm")).toBeCloseTo(1 / 3);
    // 其他场景的记录不串台
    expect(computeHumanPreference(records, 3, "w2", "paperteam")).toBeNull();
  });
});
