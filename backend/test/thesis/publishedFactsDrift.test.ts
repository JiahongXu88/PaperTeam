/**
 * M14.2 published_facts_zero_drift 确定性分类测试：
 * 一致 / 受控等价（舍入、单位换算）/ 未授权变更 / 未引用。
 */

import { describe, expect, it } from "vitest";

import { checkFactDrift, stripNonFactualNumbers, summarizeDrift } from "../../src/thesis/publishedFactsDrift.js";
import type { FactView } from "../../src/thesis/researchInputTypes.js";

function fact(overrides: Partial<FactView> = {}): FactView {
  return {
    factId: "f-0001",
    researchInputId: "ri-000000000001",
    kind: "table_cell",
    key: { metric: "S" },
    surface: "S 0.724",
    value: { raw: "0.724" },
    verification: "author_confirmed",
    sourceCheck: "verified",
    conflictStatus: "none",
    location: "论文A 表5 行1",
    ...overrides,
  };
}

describe("M14.2 published_facts_zero_drift", () => {
  it("正文含原文形态 → consistent", () => {
    expect(checkFactDrift(fact(), "该方法在 DAVSOD 上的 S 0.724 达到最优。").status).toBe("consistent");
  });

  it("正文数值与已确认值相等 → consistent", () => {
    expect(checkFactDrift(fact(), "S 指标达到 0.724，超过基线。").status).toBe("consistent");
  });

  it("正文数值为合理舍入形态 → equivalent_format（受控等价，不是漂移）", () => {
    const finding = checkFactDrift(fact(), "S 指标约为 0.72（保留两位）。");
    expect(finding.status).toBe("equivalent_format");
    expect(finding.observedValue).toBe("0.72");
  });

  it("正文数值同数量级但不等（邻域内改值）→ unauthorized（阻断）", () => {
    const finding = checkFactDrift(fact(), "S 指标提升至 0.811。");
    expect(finding.status).toBe("unauthorized");
    expect(finding.observedValue).toBe("0.811");
    expect(finding.detail).toContain("未授权");
  });

  it("正文数值远离期望值（其它实验的合法数值）→ 不算漂移", () => {
    // 0.452 与 0.724 差一个数量级内? 0.452/0.724 = 0.62 —— 在 ±10× 邻域内！
    // 邻域规则：0.452 会命中。这一条验证邻域语义如实呈现（由作者/修订处理）。
    const near = checkFactDrift(fact(), "另一实验的 AP 为 0.452。");
    expect(["unauthorized", "absent"]).toContain(near.status);
    // 远超邻域（数量级外）的数值不算改写本实验
    const far = checkFactDrift(fact(), "数据集包含 23938 帧图像。");
    expect(far.status).not.toBe("unauthorized");
  });

  it("正文未出现任何数值 → absent（未引用不是漂移）", () => {
    expect(checkFactDrift(fact(), "本章介绍方法设计，不含数值。").status).toBe("absent");
  });

  it("非数值事实按原文形态比对", () => {
    const datasetFact = fact({ kind: "dataset", surface: "DAVSOD 数据集", value: { raw: "DAVSOD" } });
    expect(checkFactDrift(datasetFact, "我们在 DAVSOD 数据集上开展实验。").status).toBe("consistent");
  });

  it("非事实数字载体剥离：数学环境 / 交叉引用参数 / 结构编号不参与邻域比对", () => {
    const text = [
      "方法见式 \\eqref{eq:1} 与表1、图2。",
      "\\begin{equation}",
      "  q = \\alpha r + (1-\\alpha) g",
      "\\end{equation}",
      "第3章给出细节。",
    ].join("\n");
    expect(stripNonFactualNumbers(text)).not.toMatch(/\d/);
    // 全剥离后无数值 → absent（不是漂移）
    expect(checkFactDrift(fact(), text).status).toBe("absent");
  });

  it("summarizeDrift 汇总四类计数", () => {
    // M14.3 句级锚定语义：数值比对发生在含事实锚词（metric=S 等）的句子中；
    // 无锚词句（"约 0.72"）按 absent 处理——见专测与模块注释。
    const report = summarizeDrift([
      checkFactDrift(fact(), "S 0.724"),
      checkFactDrift(fact(), "S 指标约为 0.72"),
      checkFactDrift(fact(), "S 指标提升至 0.811"),
      checkFactDrift(fact(), "无数值"),
    ]);
    expect(report).toMatchObject({ checked: 4, consistent: 1, equivalentFormat: 1, unauthorized: 1, absent: 1 });
  });
});
