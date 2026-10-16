/**
 * M14.4 单元测试：最佳合法版本选择 / 恶化恢复判定 / judgeOutcome 重问题净上升回归。
 */
import { describe, expect, it } from "vitest";
import {
  compareBestRevision,
  selectBestRevision,
  shouldRestoreBest,
  terminalScorecardForRun,
  type BestRevisionArtifact,
  type BestRevisionCandidate,
} from "../../src/review/bestRevision.js";
import { judgeOutcome, type IterationScorecard } from "../../src/review/revisionOutcome.js";
import { budgetExhausted, type RunBudgetSnapshot } from "../../src/runtime/runBudget.js";

function scorecard(partial: Partial<IterationScorecard>): IterationScorecard {
  return {
    gatePassed: false,
    failedRuleIds: ["academic_score_threshold"],
    critical: 3,
    major: 74,
    blocking: 0,
    academicScore: 63,
    styleRisk: 10,
    ...partial,
  };
}

const candidate = (revision: number, partial: Partial<IterationScorecard>, runId = "w-1"): BestRevisionCandidate => ({
  revision,
  gateRound: revision,
  runId,
  scorecard: scorecard(partial),
});

describe("judgeOutcome M14.4：重问题净上升且失败规则未减少 → REGRESSION（R3 反馈环回归）", () => {
  it("major 大涨 + failedRuleIds 变化（旧逻辑误判 IMPROVED 的形态）→ REGRESSION", () => {
    const previous = scorecard({ failedRuleIds: ["a", "b"], critical: 3, major: 74, academicScore: 63 });
    const current = scorecard({ failedRuleIds: ["a", "c"], critical: 3, major: 300, academicScore: 54 });
    expect(judgeOutcome(current, previous)).toBe("REGRESSION");
  });

  it("critical+major 上升但失败规则数下降 → 允许 IMPROVED（规则解决是实质进展）", () => {
    const previous = scorecard({ failedRuleIds: ["a", "b", "c"], critical: 3, major: 74 });
    const current = scorecard({ failedRuleIds: ["a"], critical: 3, major: 80 });
    expect(judgeOutcome(current, previous)).toBe("IMPROVED");
  });

  it("同规则 + 重问题持平 → 仍 CONVERGED（既有语义保持）", () => {
    const previous = scorecard({ critical: 3, major: 74 });
    const current = scorecard({ critical: 3, major: 74 });
    expect(judgeOutcome(current, previous)).toBe("CONVERGED");
  });

  it("学分暴跌 >10（blocking 持平）→ REGRESSION（既有语义保持）", () => {
    const previous = scorecard({ critical: 3, major: 74, academicScore: 63 });
    const current = scorecard({ critical: 3, major: 74, academicScore: 50 });
    expect(judgeOutcome(current, previous)).toBe("REGRESSION");
  });
});

describe("compareBestRevision：守卫干净 > blocking > critical > 分数带宽", () => {
  it("守卫脏的版本不可选（即使分数更高）", () => {
    const dirty = candidate(5, { academicScore: 90, factViolations: 2 });
    const clean = candidate(3, { academicScore: 60, factViolations: 0, citationViolations: 0 });
    expect(compareBestRevision(dirty, clean)).toBeLessThan(0);
  });

  it("blocking 更少优先于分数更高", () => {
    const fewer = candidate(5, { blocking: 0, academicScore: 55 });
    const more = candidate(3, { blocking: 2, academicScore: 95 });
    expect(compareBestRevision(fewer, more)).toBeGreaterThan(0);
  });

  it("分数带内差异（62 vs 66）不构成更好（INCONCLUSIVE → 保留既有）", () => {
    const a = candidate(3, { academicScore: 62 });
    const b = candidate(5, { academicScore: 66 });
    expect(compareBestRevision(b, a)).toBe(0);
  });

  it("跨带宽（62 vs 71）才构成更好", () => {
    const a = candidate(3, { academicScore: 62 });
    const b = candidate(5, { academicScore: 71 });
    expect(compareBestRevision(b, a)).toBeGreaterThan(0);
  });
});

describe("selectBestRevision：严格更好才替换；跨 run 重置基线", () => {
  it("首轮成为基线", () => {
    const decision = selectBestRevision(candidate(3, { critical: 3, major: 74 }), null);
    expect(decision.changed).toBe(true);
    expect(decision.best.revision).toBe(3);
  });

  it("同 run 更差轮次不替换（R3：劣化轮不成为最佳）", () => {
    const incumbent: BestRevisionArtifact = {
      revision: 3, gateRound: 1, runId: "w-1",
      scorecard: scorecard({ critical: 3, major: 74, academicScore: 63 }),
      basis: [], updatedAt: new Date().toISOString(),
    };
    const decision = selectBestRevision(candidate(5, { critical: 5, major: 300, academicScore: 54 }), incumbent);
    expect(decision.changed).toBe(false);
    expect(decision.best.revision).toBe(3);
  });

  it("同 run 更好轮次替换", () => {
    const incumbent: BestRevisionArtifact = {
      revision: 3, gateRound: 1, runId: "w-1",
      scorecard: scorecard({ critical: 3, major: 74, academicScore: 63 }),
      basis: [], updatedAt: new Date().toISOString(),
    };
    const decision = selectBestRevision(candidate(6, { critical: 1, major: 40, academicScore: 68 }), incumbent);
    expect(decision.changed).toBe(true);
    expect(decision.best.revision).toBe(6);
  });

  it("新 run 的首轮成为新基线（跨 run 不比较）", () => {
    const incumbent: BestRevisionArtifact = {
      revision: 8, gateRound: 4, runId: "w-old",
      scorecard: scorecard({ critical: 0, major: 10, academicScore: 90 }),
      basis: [], updatedAt: new Date().toISOString(),
    };
    const decision = selectBestRevision(candidate(9, { critical: 4, major: 100, academicScore: 55 }, "w-new"), incumbent);
    expect(decision.changed).toBe(true);
    expect(decision.best.revision).toBe(9);
    expect(decision.best.basis.join(" ")).toContain("新 run");
  });
});

describe("shouldRestoreBest：仅当前可证明更差才恢复", () => {
  const best: BestRevisionArtifact = {
    revision: 3, gateRound: 1, runId: "w-1",
    scorecard: scorecard({ critical: 3, major: 74, academicScore: 63 }),
    basis: [], updatedAt: new Date().toISOString(),
  };

  it("R3 终局形态（critical/blocking 恶化）→ 恢复", () => {
    const verdict = shouldRestoreBest(scorecard({ critical: 12, major: 532, academicScore: 54 }), best);
    expect(verdict.restore).toBe(true);
  });

  it("分数带内更低但确定性指标不差 → 不恢复（不追 reviewer 噪声）", () => {
    const verdict = shouldRestoreBest(scorecard({ critical: 3, major: 74, academicScore: 60 }), best);
    expect(verdict.restore).toBe(false);
  });

  it("守卫变脏 → 恢复", () => {
    const verdict = shouldRestoreBest(scorecard({ critical: 3, major: 74, factViolations: 2 }), best);
    expect(verdict.restore).toBe(true);
  });
});

describe("terminalScorecardForRun / budgetExhausted", () => {
  it("取本 run 最后一条未通过记录", () => {
    const history = [
      { runId: "w-1", gateRound: 1, scorecard: scorecard({ critical: 3 }) },
      { runId: "w-1", gateRound: 2, scorecard: scorecard({ critical: 8 }) },
      { runId: "w-2", gateRound: 3, scorecard: scorecard({ critical: 1 }) },
    ];
    expect(terminalScorecardForRun(history, "w-1")?.critical).toBe(8);
  });

  it("预算耗尽判定：calls 达上限即耗尽（不等超限）", () => {
    const base = { runId: "w-1", tokens: 0, limits: { maxModelCallsPerRun: 5, maxRunTokensPerRun: 0 } };
    expect(budgetExhausted({ ...base, calls: 4, exceeded: false } as RunBudgetSnapshot)).toBe(false);
    expect(budgetExhausted({ ...base, calls: 5, exceeded: false } as RunBudgetSnapshot)).toBe(true);
    expect(budgetExhausted({ ...base, calls: 6, exceeded: true, exceededReason: "超限" } as RunBudgetSnapshot)).toBe(true);
  });

  it("上限 0 = 不限制", () => {
    expect(budgetExhausted({ runId: "w-1", calls: 10_000, tokens: 10_000_000, limits: { maxModelCallsPerRun: 0, maxRunTokensPerRun: 0 }, exceeded: false } as RunBudgetSnapshot)).toBe(false);
  });
});
