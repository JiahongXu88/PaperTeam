/**
 * 收敛判定 judgeOutcome 的确定性 fixtures（M4.7，D-0026）。
 *
 * 规格轨迹（PRD §9.5 / D-0026）：
 *   Round1 Major4/blocker3 → Round2 Major2/blocker1   = IMPROVED（实质改善，继续）
 *   Round3 与 Round2 核心问题不变                       = CONVERGED（无实质改善 → HITL）
 *   任何一轮出现新增 Critical                            = REGRESSION（退化 → HITL）
 */

import { describe, expect, it } from "vitest";

import {
  judgeOutcome,
  scorecardOf,
  type IterationScorecard,
} from "../../src/review/revisionOutcome.js";

function scorecard(overrides: Partial<IterationScorecard> = {}): IterationScorecard {
  return {
    gatePassed: false,
    failedRuleIds: ["academic_score_threshold", "open_critical_major_zero"],
    critical: 0,
    major: 4,
    blocking: 3,
    academicScore: 66,
    styleRisk: 68,
    ...overrides,
  };
}

describe("judgeOutcome（收敛判定）", () => {
  it("gate 通过 → PASS（无论上一轮如何）", () => {
    expect(judgeOutcome(scorecard({ gatePassed: true }), scorecard())).toBe("PASS");
    expect(judgeOutcome(scorecard({ gatePassed: true }), null)).toBe("PASS");
  });

  it("首轮（无上一轮）→ null（如实记录，不虚构对比结论）", () => {
    expect(judgeOutcome(scorecard(), null)).toBeNull();
  });

  it("上一轮已通过（无失败可比）→ null", () => {
    expect(judgeOutcome(scorecard(), scorecard({ gatePassed: true }))).toBeNull();
  });

  it("规格轨迹：Round1 Major4/blocker3 → Round2 Major2/blocker1 = IMPROVED", () => {
    const round1 = scorecard({ critical: 0, major: 4, blocking: 3 });
    const round2 = scorecard({ critical: 0, major: 2, blocking: 1 });
    expect(judgeOutcome(round2, round1)).toBe("IMPROVED");
  });

  it("Round3 与 Round2 核心问题不变（同规则集同计数）= CONVERGED", () => {
    const round2 = scorecard({ critical: 0, major: 2, blocking: 1 });
    const round3 = scorecard({ critical: 0, major: 2, blocking: 1 });
    expect(judgeOutcome(round3, round2)).toBe("CONVERGED");
  });

  it("同规则集但 critical+major 下降 = IMPROVED（不是 CONVERGED）", () => {
    const round2 = scorecard({ critical: 1, major: 3, blocking: 1 });
    const round3 = scorecard({ critical: 0, major: 3, blocking: 1 });
    expect(judgeOutcome(round3, round2)).toBe("IMPROVED");
  });

  it("失败规则集缩小（计数不变）= IMPROVED", () => {
    const round1 = scorecard({ failedRuleIds: ["a", "b"] });
    const round2 = scorecard({ failedRuleIds: ["a"] });
    expect(judgeOutcome(round2, round1)).toBe("IMPROVED");
  });

  it("新增 Critical = REGRESSION", () => {
    const round2 = scorecard({ critical: 0, major: 2, blocking: 1 });
    const round3 = scorecard({ critical: 1, major: 0, blocking: 0 });
    expect(judgeOutcome(round3, round2)).toBe("REGRESSION");
  });

  it("blocking 增加 = REGRESSION（即使 critical/major 减少）", () => {
    const round2 = scorecard({ critical: 2, major: 4, blocking: 0 });
    const round3 = scorecard({ critical: 0, major: 0, blocking: 1 });
    expect(judgeOutcome(round3, round2)).toBe("REGRESSION");
  });

  it("blocking 持平但 academicScore 大幅下滑（>10）= REGRESSION", () => {
    const round2 = scorecard({ academicScore: 80 });
    const round3 = scorecard({ academicScore: 66 });
    expect(judgeOutcome(round3, round2)).toBe("REGRESSION");
  });

  it("blocking 持平、学分小幅下滑（≤10）不计为退化", () => {
    const round2 = scorecard({ academicScore: 80 });
    const round3 = scorecard({ academicScore: 72, failedRuleIds: ["academic_score_threshold", "open_critical_major_zero"] });
    // 规则集与计数完全相同 → CONVERGED（学分小幅波动不是退化信号）
    expect(judgeOutcome(round3, round2)).toBe("CONVERGED");
  });
});

describe("scorecardOf（记分卡派生）", () => {
  it("failedRuleIds 确定性排序（与 rules 顺序无关）", () => {
    const gate = {
      passed: false,
      rules: [
        { rule: "zzz_rule", passed: false, detail: "" },
        { rule: "aaa_rule", passed: false, detail: "" },
        { rule: "ok_rule", passed: true, detail: "" },
      ],
    };
    const summary = {
      counts: { critical: 1, major: 2, minor: 3, blocking: 1 },
      scores: { academicScore: 70, styleRisk: 40 },
    };
    const card = scorecardOf(gate as never, summary as never);
    expect(card.failedRuleIds).toEqual(["aaa_rule", "zzz_rule"]);
    expect(card.critical).toBe(1);
    expect(card.major).toBe(2);
    expect(card.blocking).toBe(1);
    expect(card.academicScore).toBe(70);
    expect(card.gatePassed).toBe(false);
  });
});
