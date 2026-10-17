/**
 * M14.8-MOT：已有论文返修的稿件锚定观测选择（合成数据）。
 * 真实论文：34,244 条授权观测 / 预算 100 条——纯覆盖面选择几乎选不到稿件里实际写出的
 * 数值，Writer 的数值表与 review.run 的作者数据披露都与稿件脱节。锚定阶段先选数值在
 * 稿件正文出现的观测（有效数字 ≥3 位），剩余预算回到原覆盖面选择；不传锚点时行为不变。
 */

import { describe, expect, it } from "vitest";

import {
  manuscriptNumberAnchors,
  selectWorkflowObservations,
  type MetricObservation,
  type WorkflowObservationCandidate,
} from "../../src/experiments/ExperimentPackageService.js";

let seq = 0;
function candidate(groupId: string, value: number, jsonPath: string, metric = "IDSW"): WorkflowObservationCandidate {
  seq += 1;
  const observation: MetricObservation = {
    sourceId: "S0001", path: "results/metrics.json", blockId: `B${String(seq).padStart(4, "0")}`,
    metric, value, unit: "unknown", direction: "unknown", groupId, jsonPath,
  };
  return { packageId: `ep-${"b".repeat(32)}`, packageHash: "b".repeat(64), observation };
}

const TEX = String.raw`官方整段协议上 IDSW 由 700 降至 497，HOTA 为 57.97；输出框数 597{,}152；
共 38 个片段，比例 0.669 帧/秒，组均差 $-1.78$，阈值 0.6/0.1/0.6，宽度 0.92\linewidth。
\begin{thebibliography}{9}\bibitem{A} Wen L. UA-DETRAC[J]. CVIU, 2020, 193: 102907.\end{thebibliography}`;

describe("manuscriptNumberAnchors", () => {
  it("提取正文数值（≥3 位有效数字或两位整数），还原千分位，排除参考文献 / 年份 / 长度参数 / 一位数", () => {
    const anchors = manuscriptNumberAnchors(TEX);
    for (const token of ["700", "497", "57.97", "597152", "0.669", "1.78", "38"]) expect(anchors.has(token)).toBe(true);
    for (const token of ["2020", "193", "102907", "0.92", "0.6", "0.1"]) expect(anchors.has(token)).toBe(false);
  });
});

describe("selectWorkflowObservations：稿件锚定", () => {
  const noise = Array.from({ length: 300 }, (_, index) => candidate("main", 1000 + index, `$.per_seq.arm.S${index}.IDSW`));
  const paper = [
    candidate("main", 700, "$.overall.base.IDSW"),
    candidate("main", 497, "$.overall.h1h4.IDSW"),
    candidate("main", 0.5797, "$.overall.base.HOTA", "HOTA"),
    candidate("baselines", 597152, "$.output_volume.bytetrack.total_boxes", "total_boxes"),
    candidate("main", 0.669, "$.rdk.fps", "fps"),
    // 与稿件数值相同但层级更深的逐序列观测：排在聚合观测之后
    candidate("main", 700, "$.per_seq.base.MVI_1.extra.IDSW"),
  ];
  const all = [...noise, ...paper];

  it("不传锚点：行为与原选择完全一致", () => {
    expect(selectWorkflowObservations(all)).toEqual(selectWorkflowObservations(all, {}));
  });

  it("传入稿件锚点：每个稿件数值先取一条最佳观测（聚合层级优先），再回到覆盖面选择", () => {
    const selected = selectWorkflowObservations(all, { anchorNumbers: manuscriptNumberAnchors(TEX) });
    expect(selected).toHaveLength(100);
    const aggregates = paper.slice(0, 5).map((entry) => entry.observation.jsonPath);
    const head = selected.slice(0, aggregates.length).map((entry) => entry.observation.jsonPath);
    expect([...head].sort()).toEqual([...aggregates].sort());
    // 同值的逐序列观测不挤占锚定阶段
    expect(head).not.toContain("$.per_seq.base.MVI_1.extra.IDSW");
    // 无锚定时这些稿件数值大多被噪声挤出
    const plain = new Set(selectWorkflowObservations(all).map((entry) => entry.observation.jsonPath));
    expect(aggregates.filter((path) => plain.has(path)).length).toBeLessThan(aggregates.length);
  });

  it("百分数尺度：0.5797 由正文 57.97 锚定；同层级下两位整数锚点排在精确锚点之后", () => {
    const small = candidate("main", 38, "$.overall.n_clips", "n_clips");
    const selected = selectWorkflowObservations([small, ...paper], { anchorNumbers: manuscriptNumberAnchors(TEX) });
    const order = selected.map((entry) => entry.observation.jsonPath);
    expect(order).toContain("$.overall.base.HOTA");
    // 同为 depth=2 的聚合观测：精确锚点（700 / 497 / 57.97）先于两位整数锚点 38
    expect(order.indexOf("$.overall.n_clips")).toBeGreaterThan(order.indexOf("$.overall.base.IDSW"));
    expect(order.indexOf("$.overall.n_clips")).toBeGreaterThan(order.indexOf("$.overall.base.HOTA"));
  });

  it("确定性：候选顺序打乱不改变选择", () => {
    const anchors = manuscriptNumberAnchors(TEX);
    const a = selectWorkflowObservations(all, { anchorNumbers: anchors }).map((entry) => entry.observation.blockId);
    const b = selectWorkflowObservations([...all].reverse(), { anchorNumbers: anchors }).map((entry) => entry.observation.blockId);
    expect(a).toEqual(b);
  });
});
