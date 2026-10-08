/**
 * M12.3 C6：caption ↔ dataset 真实性守卫（figures/truthfulness.ts）单元测试。
 *
 * 核心场景（任务书 §14）：
 * - 数据 62.1 → 63.4，caption "improves by 5 points" → violation（实际差 1.3）；
 * - "by 1.3 points" → pass；"2 points"（diff 1.9 按精度舍入）→ pass；
 * - 百分点 / 相对百分比 混淆（跨桶命中）→ violation；
 * - 纯定性 caption → pass（不误杀无数值声明）；
 * - 计数声明 / 全称量词 / 单位冲突 → unverified（AUTHOR_REVIEW，不阻断也不放行）；
 * - Figure/Table/epoch 编号数字不当作声明。
 */

import { describe, expect, it } from "vitest";

import { validateCaptionAgainstDataset } from "../../src/figures/truthfulness.js";
import { computeDatasetHash, validatePlotSpec, type NormalizedPlotSpec } from "../../src/figures/spec.js";

function plotSpecOf(
  columns: string[],
  rows: (number | string | null)[][],
  options: { x?: string; series?: Array<{ name: string; column: string }>; caption?: string; xLabel?: string; yLabel?: string; missingPolicy?: "reject" | "skip_row" } = {},
): NormalizedPlotSpec {
  const dataset = { columns, rows };
  const spec = {
    plotType: "bar" as const,
    ...(options.caption !== undefined ? { caption: options.caption } : {}),
    data: {
      origin: { origin: "manual", note: "test" },
      datasetHash: "", // 由校验器重算（下方先算）
      x: [options.x ?? columns[0]!],
      series: options.series ?? columns.slice(1).map((column) => ({ name: column, column })),
      ...(options.missingPolicy !== undefined ? { missingPolicy: options.missingPolicy } : {}),
      inlineDataset: dataset,
    },
    axis: {
      ...(options.xLabel !== undefined ? { xLabel: options.xLabel } : {}),
      ...(options.yLabel !== undefined ? { yLabel: options.yLabel } : {}),
    },
  };
  // datasetHash 必须真实一致——直接用被测模块同源函数计算
  spec.data.datasetHash = computeDatasetHash(dataset);
  const result = validatePlotSpec(spec);
  if (!result.ok || result.spec === undefined) {
    throw new Error(`fixture spec 非法：${result.errors.join("；")}`);
  }
  return result.spec;
}

function verdictOf(caption: string, spec: NormalizedPlotSpec) {
  return validateCaptionAgainstDataset(caption, spec);
}

/** 经典实验数据：method / HOTA 两行（62.1 vs 63.4） */
function hotaSpec(): NormalizedPlotSpec {
  return plotSpecOf(
    ["method", "HOTA"],
    [
      ["Baseline", 62.1],
      ["Ours", 63.4],
    ],
    { caption: "fixture", yLabel: "HOTA (%)" },
  );
}

describe("数值支撑（value / delta / relative 三桶）", () => {
  it("任务书核心反例：by 5 points（实际差 1.3）→ violation", () => {
    const result = verdictOf("Ours improves HOTA by 5 points over the baseline.", hotaSpec());
    expect(result.verdict).toBe("violation");
    expect(result.issues.some((issue) => issue.level === "violation" && issue.claim === "5")).toBe(true);
  });

  it("by 1.3 points（真实差值）→ pass", () => {
    expect(verdictOf("Ours improves HOTA by 1.3 points over the baseline.", hotaSpec()).verdict).toBe("pass");
  });

  it("中文形态：提升1.3个百分点 → pass；提升了5个百分点 → violation", () => {
    expect(verdictOf("本方法将 HOTA 提升1.3个百分点。", hotaSpec()).verdict).toBe("pass");
    expect(verdictOf("本方法将 HOTA 提升了5个百分点。", hotaSpec()).verdict).toBe("violation");
  });

  it("声明精度舍入：2 points（diff 1.9）→ pass；2 points（diff 1.4）→ violation", () => {
    const spec19 = plotSpecOf(
      ["method", "HOTA"],
      [
        ["A", 61.0],
        ["B", 62.9],
      ],
    );
    expect(verdictOf("B improves HOTA by 2 points.", spec19).verdict).toBe("pass");
    const spec14 = plotSpecOf(
      ["method", "HOTA"],
      [
        ["A", 61.0],
        ["B", 62.4],
      ],
    );
    expect(verdictOf("B improves HOTA by 2 points.", spec14).verdict).toBe("violation");
  });

  it("相对百分比：2.09%（真实相对差）→ pass；5%（编造）→ violation", () => {
    expect(verdictOf("Ours improves HOTA by 2.09% relative to the baseline.", hotaSpec()).verdict).toBe("pass");
    const result = verdictOf("Ours improves HOTA by 5% relative to the baseline.", hotaSpec());
    expect(result.verdict).toBe("violation");
  });

  it("跨桶混淆：百分点形态命中相对差 → violation；百分比形态命中绝对差 → violation", () => {
    // 数据：50 → 75（绝对差 25；相对差 50%）
    const spec = plotSpecOf(
      ["method", "metric"],
      [
        ["A", 50],
        ["B", 75],
      ],
    );
    // 50 points：绝对差不匹配（25），相对差匹配（50%）→ 混淆
    const delta = verdictOf("B improves the metric by 50 points.", spec);
    expect(delta.verdict).toBe("violation");
    expect(delta.issues.some((issue) => issue.message.includes("相对"))).toBe(true);
    // 25%：相对差不匹配（50%），绝对差匹配（25）→ 混淆
    const relative = verdictOf("B improves the metric by 25%.", spec);
    expect(relative.verdict).toBe("violation");
  });

  it("裸数值声明：62.1 在数据中 → pass；62.9 不在 → violation（小数=测量值）", () => {
    expect(verdictOf("Baseline achieves 62.1 HOTA.", hotaSpec()).verdict).toBe("pass");
    expect(verdictOf("Baseline achieves 62.9 HOTA.", hotaSpec()).verdict).toBe("violation");
  });

  it("行内差值（同 row 跨 series）：Ours 比 Baseline 高 1.3 → pass", () => {
    const spec = plotSpecOf(
      ["dataset", "Baseline", "Ours"],
      [
        ["MOT17", 62.1, 63.4],
        ["MOT20", 58.2, 59.5],
      ],
      { series: [{ name: "Baseline", column: "Baseline" }, { name: "Ours", column: "Ours" }] },
    );
    expect(verdictOf("Ours outperforms the baseline by 1.3 on MOT17.", spec).verdict).toBe("pass");
    expect(verdictOf("Ours outperforms the baseline by 1.4 on MOT17.", spec).verdict).toBe("violation");
  });
});

describe("不误杀", () => {
  it("纯定性 caption → pass", () => {
    const result = verdictOf("本图展示所提方法的整体架构与数据流向。", hotaSpec());
    expect(result.verdict).toBe("pass");
  });

  it("Figure 3 / Table 2 / epoch 100 编号不当作声明", () => {
    const result = verdictOf("如图 Figure 3 所示（另见 Table 2）；训练在 epoch 100 收敛。", hotaSpec());
    expect(result.verdict).toBe("pass");
  });

  it("skip_row 缺失值披露为 info（不改变 verdict）", () => {
    const skip = plotSpecOf(
      ["epoch", "loss"],
      [
        [1, 0.5],
        [2, null],
      ],
      { missingPolicy: "skip_row" },
    );
    const result = verdictOf("loss 曲线随 epoch 收敛。", skip);
    expect(result.verdict).toBe("pass");
    expect(result.issues.some((issue) => issue.level === "info" && issue.message.includes("skip_row"))).toBe(true);
  });
});

describe("UNVERIFIED（AUTHOR_REVIEW_REQUIRED）", () => {
  it("计数声明不匹配行/列/series 数 → unverified", () => {
    const result = verdictOf("We evaluate on 3 datasets.", hotaSpec());
    expect(result.verdict).toBe("unverified");
    expect(result.issues.some((issue) => issue.level === "unverified" && issue.claim === "3")).toBe(true);
  });

  it("计数声明匹配行数 → pass", () => {
    expect(verdictOf("We evaluate on 2 methods.", hotaSpec()).verdict).toBe("pass");
  });

  it("全称量词 → unverified", () => {
    const result = verdictOf("本方法在所有数据集上均优于基线。", hotaSpec());
    expect(result.verdict).toBe("unverified");
    expect(result.issues.some((issue) => issue.claim === "全称量词")).toBe(true);
  });

  it("caption 与轴标签单位不兼容（ms vs %）→ unverified；百分点族与 % 兼容 → 不触发", () => {
    // 5 ms：数值匹配差值（10-5=5）→ 数值 pass；单位 ms 与轴 % 不兼容 → unverified
    const mismatch = verdictOf("本方法将延迟降低了 5 ms。", plotSpecOf(
      ["method", "score"],
      [
        ["A", 10],
        ["B", 5],
      ],
      { yLabel: "HOTA (%)" },
    ));
    expect(mismatch.verdict).toBe("unverified");
    expect(mismatch.issues.some((issue) => issue.claim === "单位")).toBe(true);
    // 百分点（points）与 % 是兼容族（百分比指标的标准表述）→ 不触发单位 issue
    const compatible = verdictOf("本方法将 HOTA 提升了 5 points。", plotSpecOf(
      ["method", "HOTA"],
      [
        ["A", 10],
        ["B", 5],
      ],
      { yLabel: "HOTA (%)" },
    ));
    expect(compatible.issues.some((issue) => issue.claim === "单位")).toBe(false);
  });
});

describe("大数据集防御", () => {
  it("超过 100 行 → 差值声明转 unverified（不误判 violation）", () => {
    const rows: (number | string | null)[][] = [];
    for (let index = 0; index < 120; index += 1) {
      rows.push([index, index % 10]);
    }
    const spec = plotSpecOf(["epoch", "loss"], rows);
    const result = verdictOf("loss 相比初始下降了 3 points。", spec);
    expect(result.verdict).toBe("unverified");
    expect(result.issues.some((issue) => issue.level === "unverified" && issue.message.includes("未校验"))).toBe(true);
  });
});
