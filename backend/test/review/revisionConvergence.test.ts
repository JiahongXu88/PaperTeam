/**
 * M11.2.3（D-4）Revision Convergence / Regression Control 单元测试。
 *
 * 覆盖：
 * - judgeConvergence：PROGRESS / STALLED（连续两轮核心指标无改善）/ REGRESSED
 *   （新增 critical / fact / citation 回归）；证据不足（<3 轮）→ null；
 * - scorecardWithConvergenceMetrics：unsupported 口径 + 守卫违规数投影；
 * - scorecardDelta：resolved / newFailedRules / newRegressions 逐项差值；
 * - judgeOutcome 不因守卫违规抢跑 REGRESSION（保留确定性修复轮机会）。
 */

import { describe, expect, it } from "vitest";

import {
  judgeConvergence,
  judgeOutcome,
  scorecardDelta,
  scorecardWithConvergenceMetrics,
  type IterationScorecard,
} from "../../src/review/revisionOutcome.js";
import type { ClaimGroundingReport } from "../../src/review/claimGrounding.js";
import type { FactPreservationSummary } from "../../src/quality/factPreservation.js";
import type { CitationPreservationSummary } from "../../src/quality/citationPreservation.js";

function scorecard(shape: Partial<IterationScorecard> = {}): IterationScorecard {
  return {
    gatePassed: false,
    failedRuleIds: ["academic_score_threshold"],
    critical: 0,
    major: 0,
    blocking: 0,
    academicScore: 72,
    styleRisk: 30,
    ...shape,
  };
}

describe("judgeConvergence（确定性收敛策略）", () => {
  it("证据不足（<2 轮 / 无前轮可比）→ null", () => {
    expect(judgeConvergence([scorecard()])).toBeNull();
    expect(judgeConvergence([scorecard({ gatePassed: true }), scorecard()])).toBeNull();
  });

  it("核心指标改善 → PROGRESS", () => {
    expect(
      judgeConvergence([
        scorecard({ blocking: 2, critical: 2 }),
        scorecard({ blocking: 2, critical: 1 }),
        scorecard({ blocking: 1, critical: 1 }),
      ]),
    ).toBe("PROGRESS");
  });

  it("unsupportedOpaque 下降也是改善（Evidence First 生效的信号）", () => {
    expect(
      judgeConvergence([
        scorecard({ unsupportedOpaque: 13 }),
        scorecard({ unsupportedOpaque: 13 }),
        scorecard({ unsupportedOpaque: 6 }),
      ]),
    ).toBe("PROGRESS");
  });

  it("连续两轮无改善 → STALLED", () => {
    expect(
      judgeConvergence([
        scorecard({ critical: 2, blocking: 1 }),
        scorecard({ critical: 2, blocking: 1 }),
        scorecard({ critical: 2, blocking: 1 }),
      ]),
    ).toBe("STALLED");
  });

  it("单轮无改善但证据不足（无第 3 轮）→ null（不提前终止）", () => {
    expect(
      judgeConvergence([scorecard({ critical: 2 }), scorecard({ critical: 2 })]),
    ).toBeNull();
  });

  it("本轮新增 critical → REGRESSED", () => {
    expect(
      judgeConvergence([
        scorecard({ critical: 0 }),
        scorecard({ critical: 0 }),
        scorecard({ critical: 2 }),
      ]),
    ).toBe("REGRESSED");
  });

  it("fact 违规上升（修 A 破 B）→ REGRESSED", () => {
    expect(
      judgeConvergence([
        scorecard({ factViolations: 0, critical: 1 }),
        scorecard({ factViolations: 0, critical: 1 }),
        scorecard({ factViolations: 3, critical: 1 }),
      ]),
    ).toBe("REGRESSED");
  });

  it("citation 违规上升 → REGRESSED", () => {
    expect(
      judgeConvergence([
        scorecard({ citationViolations: 0 }),
        scorecard({ citationViolations: 0, critical: 1 }),
        scorecard({ citationViolations: 2, critical: 1 }),
      ]),
    ).toBe("REGRESSED");
  });
});

describe("judgeOutcome（守卫违规不抢跑 REGRESSION）", () => {
  it("fact 违规首次出现 → 仍按既有口径判（不 REGRESSION，交修复轮）", () => {
    const outcome = judgeOutcome(
      scorecard({ factViolations: 3, failedRuleIds: ["academic_score_threshold", "fact_preservation"] }),
      scorecard({ factViolations: 0, failedRuleIds: ["academic_score_threshold"] }),
    );
    expect(outcome).toBe("IMPROVED");
  });

  it("新增 critical 仍判 REGRESSION（既有语义不变）", () => {
    expect(judgeOutcome(scorecard({ critical: 2 }), scorecard({ critical: 0 }))).toBe("REGRESSION");
  });
});

describe("scorecardWithConvergenceMetrics", () => {
  const claimGrounding = {
    opaqueUnsupportedClaims: 5,
    transparentUnsupportedClaims: 6,
  } as ClaimGroundingReport;
  const factPreservation = {
    changedFacts: [{}, {}, {}],
    removedFacts: [{}],
    addedUnsupportedFacts: [{}],
    directionalChanges: [],
    formulaChanges: [],
    placeholderRegressions: [],
  } as unknown as FactPreservationSummary;
  const citationPreservation = {
    ok: false,
    unexpectedRemoved: [{ key: "k", files: [] }, { key: "j", files: [] }],
  } as unknown as CitationPreservationSummary;

  it("投影 unsupported 口径与守卫违规数；null 输入缺省（旧产物兼容）", () => {
    const card = scorecardWithConvergenceMetrics(
      scorecard(),
      claimGrounding,
      factPreservation,
      citationPreservation,
    );
    expect(card.unsupportedOpaque).toBe(5);
    expect(card.unsupportedTransparent).toBe(6);
    expect(card.factViolations).toBe(5);
    expect(card.citationViolations).toBe(2);

    const legacy = scorecardWithConvergenceMetrics(scorecard(), null, null, null);
    expect(legacy.unsupportedOpaque).toBeUndefined();
    expect(legacy.factViolations).toBeUndefined();
  });
});

describe("scorecardDelta（轮次质量差）", () => {
  it("resolved / newFailedRules / newRegressions 逐项", () => {
    const previous = scorecard({
      failedRuleIds: ["academic_score_threshold", "style_risk_threshold"],
      critical: 1,
      factViolations: 1,
      citationViolations: 0,
      unsupportedOpaque: 4,
    });
    const current = scorecard({
      failedRuleIds: ["academic_score_threshold", "fact_preservation"],
      critical: 0,
      factViolations: 3,
      citationViolations: 1,
      unsupportedOpaque: 2,
    });
    const delta = scorecardDelta(current, previous);
    expect(delta.resolvedFailedRules).toBe(1);
    expect(delta.newFailedRules).toBe(1);
    expect(delta.criticalDelta).toBe(-1);
    expect(delta.unsupportedDelta).toBe(-2);
    expect(delta.newRegressions).toEqual({ critical: 0, fact: 2, citation: 1 });
  });

  it("previous=null（首轮）→ 全部按 0 基线", () => {
    const delta = scorecardDelta(scorecard({ critical: 2 }), null);
    expect(delta.resolvedFailedRules).toBe(0);
    expect(delta.newRegressions.critical).toBe(2);
    expect(delta.unsupportedDelta).toBeNull();
  });
});
