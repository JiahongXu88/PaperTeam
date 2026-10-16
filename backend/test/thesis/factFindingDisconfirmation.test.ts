/**
 * M14.6（F5）：Finding ↔ 已确认研究输入事实的确定性反证 + 删除检测 + 授权观测映射。
 * 语料来自 M14.5 案例 B 真实 reviewer 输出（去标识化改写）。
 */
import { describe, expect, it } from "vitest";

import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import {
  detectConfirmedFactRemoval,
  disconfirmFactFindingsAgainstResearchFacts,
  matchFindingNumbersToFacts,
  researchFactsAsAuthorizedObservations,
} from "../../src/thesis/factFindingDisconfirmation.js";
import type { FactView } from "../../src/thesis/researchInputTypes.js";

function fact(factId: string, surface: string, metric: string, unit?: string): FactView {
  const numeric = Number(surface.replace(/[%‰]$/, ""));
  return {
    factId,
    researchInputId: "ri-be699de35f19",
    kind: "numeric_result",
    key: { metric },
    surface,
    value: { raw: surface, numeric, ...(unit !== undefined ? { unit } : {}) },
    verification: "author_confirmed",
    sourceCheck: "verified",
    conflictStatus: "none",
    location: "S001 p1 B0004",
  };
}

const FACTS: FactView[] = [fact("Fe3a22903bd650e6b", "75.37%", "error", "%"), fact("Fb1", "20,000", "epoch"), fact("Fb2", "1e-4", "learning_rate")];

function issue(partial: Partial<ReviewIssue> & Pick<ReviewIssue, "description">): ReviewIssue {
  return { category: "fact", severity: "critical", section: "sections/exp-tracking-results.tex", blocking: true, ...partial };
}

describe("M14.6 F5 — 事实 finding 确定性反证", () => {
  it("M14.5 真实失败形态：以『无实验数据 / 未授权』为由要求删除 75.37% → 反证成立", () => {
    const issues = [
      issue({
        description: "高度跟踪误差降低 75.37% 的核心实验结论无任何已核验证据支撑，且项目当前没有已导入的实验数据，该数值不在授权范围内。",
        suggestedAction: "删除或弱化具体数值表述（如改为定性描述'高度跟踪误差显著降低'）；若后续有已核验实验证据可再恢复数值。",
      }),
      issue({
        category: "evidence_gap",
        description: "正文多处给出具体实验统计值『高度跟踪误差降低 75.37%』，但当前工作流没有任何已导入或授权的实验数据。",
        suggestedAction: "在获得授权实验数据前，删除或以定性表述替换该数值（如『高度跟踪误差显著降低』）。",
      }),
    ];
    const result = disconfirmFactFindingsAgainstResearchFacts(issues, FACTS);
    expect(result.disconfirmedCount).toBe(2);
    expect(result.disconfirmed[0]!.matchedFacts).toEqual([{ factId: "Fe3a22903bd650e6b", surface: "75.37%" }]);
    expect(result.reasonFor(issues[0]!)).toContain("Fe3a22903bd650e6b");
    expect(result.isDisconfirmed(issues[1]!)).toBe(true);
  });

  it("反例：无来源数值（62.4% / 3.8 ms）不反证，照常派发", () => {
    const issues = [
      issue({ description: "横向跟踪误差降低 62.4% 无任何已核验证据支撑，项目无授权实验数据。", suggestedAction: "删除该数值或改为定性表述。" }),
      issue({ description: "正文给出 75.37% 与 62.4% 两个统计量，均无实验数据支撑。", suggestedAction: "删除无来源数值。" }),
    ];
    const result = disconfirmFactFindingsAgainstResearchFacts(issues, FACTS);
    expect(result.disconfirmedCount).toBe(0);
  });

  it("承认数值合法、只质疑机理归因的 finding（M14.6 基线真实输出）不反证", () => {
    const result = disconfirmFactFindingsAgainstResearchFacts(
      [
        issue({
          severity: "major",
          blocking: false,
          description: "对 75.37% 误差降低的机理归因均为无证据支撑的因果与定量比较论断；75.37% 本身属授权数值，但机理解释未经核验。",
          suggestedAction: "保留 75.37% 数值与适用边界的谨慎表述；机理归因部分应删除或改为「推测/可能原因」性质的非断言表述。",
        }),
      ],
      FACTS,
    );
    expect(result.disconfirmedCount).toBe(0);
  });

  it("指标口径类 finding（不以来源缺失为由）不反证；只要求补充说明的不反证", () => {
    const result = disconfirmFactFindingsAgainstResearchFacts(
      [
        issue({ description: "75.37% 的原始口径为跟踪 RMSE 降低，与正文『高度跟踪误差』指标名不符。", suggestedAction: "核对指标名并统一为原文口径。" }),
        issue({ description: "75.37% 无实验数据支撑。", suggestedAction: "请在实验设置中补充该结果的测量条件与重复次数。" }),
      ],
      FACTS,
    );
    expect(result.disconfirmedCount).toBe(0);
  });

  it("style / citation 类 finding 不参与；无已确认事实时恒不反证", () => {
    const styleIssue = issue({ category: "style", description: "75.37% 无数据支撑，删除。", suggestedAction: "删除该数值" });
    expect(disconfirmFactFindingsAgainstResearchFacts([styleIssue], FACTS).disconfirmedCount).toBe(0);
    expect(disconfirmFactFindingsAgainstResearchFacts([issue({ description: "75.37% 无实验数据", suggestedAction: "删除数值" })], []).disconfirmedCount).toBe(0);
  });

  it("matchFindingNumbersToFacts：百分数 token 只匹配百分数事实；年份 / 小整数不算特征数值", () => {
    expect(matchFindingNumbersToFacts("2023 年两架四旋翼的 75.37%", FACTS)).toEqual([{ factId: "Fe3a22903bd650e6b", surface: "75.37%" }]);
    expect(matchFindingNumbersToFacts("第 5 章", FACTS)).toBeNull();
    expect(matchFindingNumbersToFacts("20000 与 1e-4", FACTS)).toEqual([{ factId: "Fb1", surface: "20,000" }]); // 1e-4 不是数值 token 形态（不参与），20000 ↔ 20,000 千分位等价
    expect(matchFindingNumbersToFacts("轮次 20,000", FACTS)).toEqual([{ factId: "Fb1", surface: "20,000" }]);
  });

  it("researchFactsAsAuthorizedObservations：数值事实 → metric/value/groupId", () => {
    const observations = researchFactsAsAuthorizedObservations(FACTS);
    expect(observations[0]).toEqual({ value: 75.37, metric: "error", groupId: "research-input:ri-be699de35f19" });
    expect(observations).toHaveLength(3);
  });

  it("detectConfirmedFactRemoval：删除 / 弱化为定性 → 命中；\\% 转义形态等价；改值不算删除（交给 drift）", () => {
    const before = "高度跟踪误差降低了 75.37\\%。轮次 20,000。";
    expect(detectConfirmedFactRemoval(before, "高度跟踪误差显著降低。轮次 20,000。", FACTS)).toEqual([{ factId: "Fe3a22903bd650e6b", surface: "75.37%" }]);
    expect(detectConfirmedFactRemoval(before, "高度跟踪误差降低了 75.37%。轮次 20,000。", FACTS)).toEqual([]);
    expect(detectConfirmedFactRemoval(before, "高度跟踪误差降低了 75.37 \\%。轮次 20,000。", FACTS)).toEqual([]);
    expect(detectConfirmedFactRemoval("无数值正文", "仍无数值", FACTS)).toEqual([]);
  });
});
