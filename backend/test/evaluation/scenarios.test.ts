/**
 * M6.8 Evaluation 测试一：scenario loading（数据集结构校验与选择）。
 */

import { describe, expect, it } from "vitest";

import {
  GROUNDING_SCENARIOS,
  REVISION_SCENARIOS,
  WORKFLOW_SCENARIOS,
  selectScenarios,
  validateAllScenarios,
  validateGroundingScenario,
} from "../../src/evaluation/datasets/index.js";
import type { GroundingScenario } from "../../src/evaluation/types.js";

describe("M6.8 scenario loading", () => {
  it("全量数据集结构校验通过（id 唯一 / needle 逐字 / 故障标注一致）", () => {
    expect(validateAllScenarios()).toEqual([]);
  });

  it("三个实验各 5-10 个场景（高质量小数据纪律）", () => {
    expect(GROUNDING_SCENARIOS.length).toBeGreaterThanOrEqual(5);
    expect(GROUNDING_SCENARIOS.length).toBeLessThanOrEqual(10);
    expect(REVISION_SCENARIOS.length).toBeGreaterThanOrEqual(5);
    expect(REVISION_SCENARIOS.length).toBeLessThanOrEqual(10);
    expect(WORKFLOW_SCENARIOS.length).toBeGreaterThanOrEqual(5);
    expect(WORKFLOW_SCENARIOS.length).toBeLessThanOrEqual(10);
  });

  it("场景 id 跨数据集唯一（报告可无歧义引用）", () => {
    const ids = [
      ...GROUNDING_SCENARIOS.map((scenario) => scenario.id),
      ...REVISION_SCENARIOS.map((scenario) => scenario.id),
      ...WORKFLOW_SCENARIOS.map((scenario) => scenario.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个 grounding 场景覆盖全部三类故障或至少两类，且含正例", () => {
    for (const scenario of GROUNDING_SCENARIOS) {
      expect(scenario.supportable.length).toBeGreaterThanOrEqual(2);
      const classes = new Set(scenario.faults.map((fault) => fault.faultClass));
      expect(classes.size).toBeGreaterThanOrEqual(1);
      expect(scenario.faults.length).toBeGreaterThanOrEqual(1);
    }
    // 三类故障在数据集层面都有样本
    const allClasses = new Set(GROUNDING_SCENARIOS.flatMap((scenario) => scenario.faults.map((fault) => fault.faultClass)));
    expect(allClasses).toEqual(new Set(["fabricated_quote", "unsupported_claim", "metadata_mismatch"]));
  });

  it("revision 数据集三类注入 + 干净对照齐备", () => {
    const markers = new Set(REVISION_SCENARIOS.filter((s) => s.marker !== null).map((s) => s.marker));
    expect(markers).toEqual(new Set(["fact:mutate", "cite:drop", "strength:escalate"]));
    expect(REVISION_SCENARIOS.filter((scenario) => scenario.expectedClean).length).toBeGreaterThanOrEqual(2);
  });

  it("校验器能抓住典型数据错误（needle 非逐字 / fabricated 引文在语料中）", () => {
    const base = GROUNDING_SCENARIOS[0]!;
    const brokenNeedle: GroundingScenario = {
      ...base,
      supportable: [{ claim: "x", locator: { fileName: base.corpus[0]!.fileName, needle: "这句原文不存在 zzqqxx" } }],
      faults: [],
    };
    expect(validateGroundingScenario(brokenNeedle).length).toBeGreaterThan(0);

    const fabricatedInCorpus: GroundingScenario = {
      ...base,
      supportable: [],
      faults: [
        {
          id: "bad-f1",
          faultClass: "fabricated_quote",
          claim: "c",
          quote: base.corpus[0]!.content.slice(0, 60),
          locator: { fileName: base.corpus[0]!.fileName, needle: base.corpus[0]!.content.slice(0, 40) },
        },
      ],
    };
    const issues = validateGroundingScenario(fabricatedInCorpus);
    expect(issues.some((issue) => issue.problem.includes("意外存在"))).toBe(true);
  });

  it("selectScenarios：按 id 过滤；未知 id 抛错不静默", () => {
    const first = GROUNDING_SCENARIOS[0]!;
    expect(selectScenarios(GROUNDING_SCENARIOS, [first.id]).map((scenario) => scenario.id)).toEqual([first.id]);
    expect(selectScenarios(GROUNDING_SCENARIOS, []).length).toBe(GROUNDING_SCENARIOS.length);
    expect(() => selectScenarios(GROUNDING_SCENARIOS, ["g1-rag-survey", "no-such-id"])).toThrow(/no-such-id/);
  });
});
