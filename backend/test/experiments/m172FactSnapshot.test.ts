/**
 * M17.2 实验事实快照 / 单位解析 / 确定性核查的单元回归。全部夹具为人工构造的合成数据（标注 SYNTHETIC），
 * 数值形状参照 TrackEval 输出，但不是任何真实实验结果。每类守卫都配有放行对照，防止守卫过严把合法事实全部挡掉。
 */

import { describe, expect, it } from "vitest";

import { buildFactSnapshotContent, factIdOf, formatDerived, metricKeyOf, type SnapshotInputObservation } from "../../src/experiments/factSnapshot.js";
import { headerUnit, parseMetricCell, toCanonical } from "../../src/experiments/metricUnits.js";
import { mentionedMetrics, renderSnapshotResultsTable, selectResultsSection } from "../../src/experiments/resultsTable.js";
import { auditExperimentFacts } from "../../src/review/experimentFactAudit.js";
import type { FactSnapshot } from "../../src/experiments/factSnapshot.js";
import { workflowComparisons, type ConfirmedExperimentWorkflowContext } from "../../src/experiments/ExperimentPackageService.js";
import { renderExperimentContextLines } from "../../src/writer/WriterService.js";

let seq = 0;
/** SYNTHETIC 观测工厂 */
function obs(overrides: Partial<SnapshotInputObservation>): SnapshotInputObservation {
  seq += 1;
  return {
    packageId: `ep-${"a".repeat(32)}`, packageHash: "a".repeat(64), fileHash: "f".repeat(64), groupId: "main", groupRole: "main", scopeId: "main@unknown",
    sourceId: "S0001", path: `synthetic/${seq}.csv`, blockId: `B${String(seq).padStart(4, "0")}`, row: 2, column: "B",
    method: "ours", dataset: "DS-A", protocol: "TrackEval-v1", metric: "HOTA", value: 49.830, rawText: "49.830", unit: "percentage", unitBasis: "header", direction: "higher",
    ...overrides,
  };
}
const base = (overrides: Partial<SnapshotInputObservation> = {}) => obs({ groupId: "baseline", groupRole: "baseline", method: "base", value: 47.250, rawText: "47.250", ...overrides });
const none = new Map<string, string>();

function snapshotOf(inputs: SnapshotInputObservation[], excluded = none): FactSnapshot {
  const build = buildFactSnapshotContent(inputs, excluded);
  return { schema: "paperteam.experiment-fact-snapshot/v1", snapshotId: "efs-0001", version: 1, createdAt: "2026-11-05T00:00:00.000Z", createdBy: "author", basedOn: [], contentHash: "c".repeat(64), ...build };
}

describe("metricUnits：显式证据才定单位", () => {
  it("区分 0.669 / 66.9% / 小数逗号 / 合并从格 / 无缓存公式", () => {
    expect(parseMetricCell("66.9%")).toMatchObject({ kind: "number", value: 66.9, unit: "percentage", basis: "cell_suffix" });
    expect(parseMetricCell("0.669")).toMatchObject({ kind: "number", value: 0.669, unit: "unknown", basis: "none" });
    expect(parseMetricCell("0.669", { numberFormat: "percent" })).toMatchObject({ kind: "number", value: 0.669, unit: "ratio", basis: "xlsx_percent_format" });
    expect(parseMetricCell("0,669")).toMatchObject({ kind: "issue", issue: "locale_decimal" });
    expect(parseMetricCell("55.1", { mergedFrom: "B2" })).toMatchObject({ kind: "issue", issue: "merged_copy" });
    expect(parseMetricCell("", { formulaNoCachedValue: true })).toMatchObject({ kind: "issue", issue: "formula_no_cached_value" });
    expect(parseMetricCell("n/a")).toEqual({ kind: "skip" });
    // 缺失值不是 0
    expect(parseMetricCell("")).toEqual({ kind: "skip" });
    expect(parseMetricCell("0")).toMatchObject({ kind: "number", value: 0 });
  });

  it("表头单位：(%) / FPS / ms / s per frame / 计数词表；无标注 = unknown（不按数量级猜）", () => {
    expect(headerUnit("HOTA (%)")).toEqual({ metric: "HOTA", unit: "percentage", basis: "header" });
    expect(headerUnit("FPS")).toMatchObject({ unit: "fps" });
    expect(headerUnit("Latency (ms/frame)")).toMatchObject({ metric: "Latency", unit: "milliseconds" });
    expect(headerUnit("Time (s/frame)")).toMatchObject({ metric: "Time", unit: "seconds" });
    expect(headerUnit("IDSW")).toMatchObject({ unit: "count", basis: "metric_vocabulary" });
    expect(headerUnit("HOTA")).toMatchObject({ unit: "unknown", basis: "none" });
    expect(toCanonical(0.669, "ratio")).toEqual({ value: 66.9, unit: "percentage" });
    expect(toCanonical(0.669, "unknown")).toBeNull();
  });
});

describe("factSnapshot：确定性对比", () => {
  it("HOTA 47.250 → 49.830：绝对差 +2.58 pp 与相对 +5.46% 分开给出，带操作数 / 公式 / 舍入", () => {
    const main = obs({});
    const reference = base();
    const build = buildFactSnapshotContent([main, reference], none);
    expect(build.conflicts).toEqual([]);
    const comparison = build.comparisons.find((entry) => entry.context.metricKey === "HOTA")!;
    expect(comparison.kind).toBe("vs_baseline");
    expect(comparison.absoluteDifference.unitLabel).toBe("pp");
    expect(comparison.absoluteDifference.value).toBeCloseTo(2.58, 9);
    expect(comparison.absoluteDifference.formulaText).toBe(`percentage_point_difference([${factIdOf(main)}], [${factIdOf(reference)}])`);
    expect(comparison.relativeChange!.value).toBeCloseTo((2.58 / 47.25) * 100, 9);
    expect(formatDerived(comparison.absoluteDifference)).toBe("+2.580 个百分点（pp）");
    expect(formatDerived(comparison.relativeChange!)).toBe("+5.46%（相对变化）");
    expect(comparison.outcome).toBe("subject_better");
    expect(comparison.operandRefs).toEqual([factIdOf(main), factIdOf(reference)]);
    expect(comparison.limitations.join("")).toContain("无统计检验");
    expect(build.statisticalTests).toEqual([]);
  });

  it("越低越好的计数指标（IDSW 820 → 778）：差 −42，判主方法更优", () => {
    const build = buildFactSnapshotContent([
      obs({ metric: "IDSW", value: 778, rawText: "778", unit: "count", direction: "lower" }),
      base({ metric: "IDSW", value: 820, rawText: "820", unit: "count", direction: "lower" }),
    ], none);
    const comparison = build.comparisons[0]!;
    expect(comparison.absoluteDifference.unitLabel).toBe("count");
    expect(comparison.absoluteDifference.value).toBe(-42);
    expect(comparison.outcome).toBe("subject_better");
  });

  it("差异在显示精度内 → tie_within_rounding（不得写成提升）", () => {
    const build = buildFactSnapshotContent([obs({ value: 50.9, rawText: "50.9" }), base({ value: 50.88, rawText: "50.88" })], none);
    expect(build.comparisons[0]!.outcome).toBe("tie_within_rounding");
  });

  it("消融对主方法单独配对（ablation_vs_main）", () => {
    const build = buildFactSnapshotContent([
      obs({}), base(), obs({ groupId: "ablation-lite", groupRole: "ablation", method: "ours-lite", value: 49.970, rawText: "49.970" }),
    ], none);
    const ablation = build.comparisons.find((entry) => entry.kind === "ablation_vs_main")!;
    expect(ablation.subject.method).toBe("ours-lite");
    expect(ablation.reference.method).toBe("ours");
    expect(ablation.absoluteDifference.value).toBeCloseTo(0.14, 9);
  });

  it("不同数据集 / 协议缺失 / 单位未声明 / 量纲不同 → 不生成对比并说明原因；对照：同条件正常配对", () => {
    const build = buildFactSnapshotContent([
      obs({ dataset: "DS-B", value: 70.5, rawText: "70.5" }),
      base(),
    ], none);
    expect(build.comparisons).toEqual([]);
    expect(build.notComparable[0]).toMatchObject({ code: "PROTOCOL_NOT_COMPARABLE" });
    const noProtocol = buildFactSnapshotContent([obs({ protocol: undefined }), base({ protocol: undefined })], none);
    expect(noProtocol.comparisons).toEqual([]);
    expect(noProtocol.notComparable[0]!.detail).toContain("protocol");
    const unknownUnit = buildFactSnapshotContent([obs({ unit: "unknown" }), base({ unit: "unknown" })], none);
    expect(unknownUnit.comparisons).toEqual([]);
    expect(unknownUnit.notComparable[0]!.detail).toContain("单位未声明");
    // 0.669 FPS 与 0.669 s/frame：量纲不同，不配对、不判同值
    const fpsVsSeconds = buildFactSnapshotContent([
      obs({ metric: "Speed", value: 0.669, rawText: "0.669", unit: "fps", direction: "unknown" }),
      base({ metric: "Speed", value: 0.669, rawText: "0.669", unit: "seconds", direction: "unknown" }),
    ], none);
    expect(fpsVsSeconds.comparisons).toEqual([]);
    expect(fpsVsSeconds.notComparable[0]).toMatchObject({ code: "UNIT_NOT_COMPARABLE" });
  });
});

describe("factSnapshot：冲突分类", () => {
  it("同键同 seed 不同值 → SAME_KEY_DIFFERENT_VALUE；作者排除一方后解除；对照：等值重复来源不冲突", () => {
    const a = base();
    const b = base({ value: 48.250, rawText: "48.250", path: "synthetic/rerun.csv" });
    const build = buildFactSnapshotContent([a, b, obs({})], none);
    expect(build.conflicts.map((entry) => entry.code)).toEqual(["SAME_KEY_DIFFERENT_VALUE"]);
    expect(build.conflicts[0]!.sides.map((side) => side.rawText)).toEqual(["47.250", "48.250"]);
    // 冲突涉及的事实不进入对比（不能用未裁决的事实生成提升幅度）
    expect(build.comparisons).toEqual([]);
    const resolved = buildFactSnapshotContent([a, b, obs({})], new Map([[factIdOf(b), "作者选择原始运行"]]));
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.excluded).toEqual([{ factId: factIdOf(b), reason: "作者选择原始运行" }]);
    expect(resolved.comparisons).toHaveLength(1);
    // 对照：summary.txt 47.250 与 detailed.csv 0.4725（作者已声明 ratio）是同一结果
    const same = buildFactSnapshotContent([a, base({ value: 0.4725, rawText: "0.4725", unit: "ratio", path: "synthetic/detailed.csv", subset: "COMBINED" })], none);
    expect(same.conflicts).toEqual([]);
  });

  it("单位未声明且恰差 100 倍 → UNIT_SCALE_UNRESOLVED（不判同值也不判矛盾）", () => {
    const build = buildFactSnapshotContent([base({ unit: "unknown" }), base({ unit: "unknown", value: 0.4725, rawText: "0.4725", path: "synthetic/detailed.csv", subset: "COMBINED" })], none);
    expect(build.conflicts.map((entry) => entry.code)).toEqual(["UNIT_SCALE_UNRESOLVED"]);
  });

  it("版本标签不同 → VERSION_CONFLICT", () => {
    const build = buildFactSnapshotContent([base({ version: "v1" }), base({ version: "v2", value: 52.0, rawText: "52.0", path: "synthetic/v2.csv" })], none);
    expect(build.conflicts.map((entry) => entry.code)).toEqual(["VERSION_CONFLICT"]);
  });

  it("多 seed：不同 seed 不是冲突；系统复算均值 / 样本标准差；作者汇总值不符 → AGGREGATE_VS_RUN_MISMATCH；对照：一致则无冲突", () => {
    const runs = [obs({ seed: "1", value: 55.0, rawText: "55.0" }), obs({ seed: "2", value: 56.0, rawText: "56.0" }), obs({ seed: "3", value: 57.0, rawText: "57.0" })];
    const ok = buildFactSnapshotContent([...runs, obs({ value: 56.0, rawText: "56.0" })], none);
    expect(ok.conflicts).toEqual([]);
    expect(ok.seedAggregates[0]).toMatchObject({ n: 3, mean: 56, sampleStd: 1 });
    const mismatch = buildFactSnapshotContent([...runs, obs({ value: 58.0, rawText: "58.0" })], none);
    expect(mismatch.conflicts.map((entry) => entry.code)).toEqual(["AGGREGATE_VS_RUN_MISMATCH"]);
    // 单 seed 的 run 不参与基线对比（只用汇总行）；不会伪造方差或 p 值
    expect(mismatch.statisticalTests).toEqual([]);
  });

  it("TrackEval detailed 列名 HOTA___AUC 归一为 HOTA；逐 α 列保持原名", () => {
    expect(metricKeyOf("HOTA___AUC")).toBe("HOTA");
    expect(metricKeyOf("HOTA___50")).toBe("HOTA___50");
  });
});

describe("Writer 上下文与结果表", () => {
  const snapshot = snapshotOf([obs({}), base(), obs({ metric: "IDSW", value: 778, rawText: "778", unit: "count", direction: "lower" }), base({ metric: "IDSW", value: 820, rawText: "820", unit: "count", direction: "lower" })]);
  const context: ConfirmedExperimentWorkflowContext = {
    schemaVersion: 1, status: "author_confirmed_not_externally_verified", truncated: false,
    snapshot: { snapshotId: "efs-0001", version: 1, contentHash: snapshot.contentHash, createdAt: snapshot.createdAt, status: "valid", factCount: snapshot.facts.length, comparisonCount: snapshot.comparisons.length },
    comparisons: workflowComparisons(snapshot),
    observations: snapshot.facts.map((fact) => ({ packageId: fact.packageId, packageHash: fact.packageHash, groupId: fact.groupId, sourceId: fact.sourceId, blockId: fact.blockId, path: fact.path, metric: fact.metric, value: fact.value, unit: fact.unit, direction: fact.direction, method: fact.method, dataset: fact.dataset, protocol: fact.protocol })),
  };

  it("快照模式渲染确定性对比、pp/% 纪律与禁显著性；失效快照禁写数值", () => {
    const text = renderExperimentContextLines(context).join("\n");
    expect(text).toContain("efs-0001");
    expect(text).toContain("+2.580 个百分点（pp）");
    expect(text).toContain("+5.46%（相对变化）");
    expect(text).toContain("百分点差不得写成 %");
    expect(text).toContain("不得写「显著」");
    expect(text).toContain("\\label{tab:exp-efs-0001}");
    const stale = renderExperimentContextLines({ ...context, snapshot: { ...context.snapshot!, status: "stale", staleReasons: ["源文件变化"] }, comparisons: [], observations: [] }).join("\n");
    expect(stale).toContain("已失效");
    expect(stale).toContain("不得出现任何具体实验指标数值");
  });

  it("无快照时 Writer 上下文与 M17.1 逐字一致（兼容）", () => {
    const legacy = renderExperimentContextLines({ schemaVersion: 1, status: "author_confirmed_not_externally_verified", truncated: false, observations: [] }).join("\n");
    expect(legacy).not.toContain("快照");
    expect(legacy).toContain("当前没有任何经作者确认并授权进入工作流的实验观测");
  });

  it("结果表：确定性、带快照版本 / 哈希、基线标注；无对比 → 无表决定", () => {
    const rendered = renderSnapshotResultsTable(context);
    expect(rendered.table).not.toBeNull();
    const latex = rendered.table!.latex;
    expect(latex).toContain("\\label{tab:exp-efs-0001}");
    expect(latex).toContain("efs-0001");
    expect(latex).toContain("47.25");
    expect(latex).toContain("49.83");
    expect(latex).toMatch(/base（基线）/);
    expect(renderSnapshotResultsTable(context).table!.latex).toBe(latex);
    const none = renderSnapshotResultsTable({ ...context, comparisons: [] });
    expect(none.table).toBeNull();
    expect(selectResultsSection([{ id: "intro", title: "Introduction" }, { id: "exp", title: "实验" }, { id: "results", title: "Results" }])!.id).toBe("results");
    expect(selectResultsSection([{ id: "intro", title: "Introduction" }])).toBeNull();
  });
});

describe("experimentFactAudit：稿件幅度 / 显著性核查", () => {
  const snapshot = snapshotOf([obs({}), base(), obs({ metric: "IDF1", value: 57.940, rawText: "57.940" }), obs({ metric: "MOTA", value: -0.150, rawText: "-0.150", direction: "higher" })]);
  const audit = (text: string) => auditExperimentFacts([{ file: "sections/results.tex", content: text }], snapshot, "valid");

  it("pp 写成 % → EXP_PP_PERCENT_CONFUSION（带对比 id 与源定位）；对照：正确的 pp / 相对 % 一致", () => {
    const wrong = audit("与基线 base 相比，ours 的 HOTA 提升了 2.6\\%。\n");
    expect(wrong.findings.map((entry) => entry.code)).toEqual(["EXP_PP_PERCENT_CONFUSION"]);
    expect(wrong.findings[0]!.operandLocators[0]).toContain("sha256:ffffffffffffffff");
    expect(wrong.findings[0]!.line).toBe(1);
    const right = audit("与基线 base 相比，ours 的 HOTA 提高 2.58 个百分点，相对提升 5.46\\%。\n");
    expect(right.findings).toEqual([]);
    expect(right.consistent.map((entry) => entry.claimedKind).sort()).toEqual(["percent", "pp"]);
    // 反向混淆：把相对变化写成百分点
    expect(audit("HOTA 提升 5.46 个百分点。").findings[0]!.code).toBe("EXP_PP_PERCENT_CONFUSION");
  });

  it("幅度与快照不符 → EXP_DELTA_NOT_IN_SNAPSHOT；无可比较对给幅度 → EXP_DELTA_WITHOUT_COMPARISON", () => {
    expect(audit("HOTA improves by 5.2 percentage points over the baseline.").findings[0]!.code).toBe("EXP_DELTA_NOT_IN_SNAPSHOT");
    // IDF1 / MOTA 没有基线事实 → 没有可比较对
    expect(audit("IDF1 提升了 4.5 个百分点。").findings[0]!.code).toBe("EXP_DELTA_WITHOUT_COMPARISON");
    // 对照：水平值（HOTA 达到 49.830%）不是幅度
    expect(audit("ours 的 HOTA 提升至 49.830\\%。").findings).toEqual([]);
  });

  it("无统计检验的显著性 / p 值 → EXP_UNTESTED_SIGNIFICANCE；对照：否定表述与非实验语境不报", () => {
    expect(audit("ours 在 HOTA 上显著优于 base。").findings.map((entry) => entry.code)).toEqual(["EXP_UNTESTED_SIGNIFICANCE"]);
    expect(audit("The HOTA gain is statistically significant (p < 0.05).").findings.map((entry) => entry.code)).toContain("EXP_UNTESTED_SIGNIFICANCE");
    expect(audit("Prior work reports significantly better tracking on crowded scenes.").findings).toEqual([]);
    expect(audit("ours 与 base 的 HOTA 差异并非显著提升，仅为单次运行结果。").findings).toEqual([]);
  });

  it("快照失效 → 单条 EXP_SNAPSHOT_STALE，不做数值判定", () => {
    const stale = auditExperimentFacts([{ file: "a.tex", content: "HOTA 提升 3.6\\%。" }], snapshot, "stale");
    expect(stale.findings.map((entry) => entry.code)).toEqual(["EXP_SNAPSHOT_STALE"]);
  });
});

describe("真实数据暴露的缺陷回归（M17.2 real-data dry run）", () => {
  it("同一对比的 summary（百分数）与 detailed（比例）两份来源：保留无需标度换算的一份；对照：只有一份时照常保留", () => {
    const build = buildFactSnapshotContent([
      obs({ value: 0.4983, rawText: "0.4983", unit: "ratio", subset: "COMBINED", path: "main/detailed.csv" }),
      base({ value: 0.4725, rawText: "0.4725", unit: "ratio", subset: "COMBINED", path: "base/detailed.csv" }),
      obs({ path: "main/summary.txt" }),
      base({ path: "base/summary.txt" }),
    ], none);
    const hota = build.comparisons.filter((entry) => entry.context.metricKey === "HOTA");
    expect(hota).toHaveLength(1);
    expect(hota[0]!.absoluteDifference.value).toBeCloseTo(2.58, 9);
    expect(build.facts.find((fact) => fact.factId === hota[0]!.subject.factId)!.path).toBe("main/summary.txt");
  });

  it("写作上下文对比排序：主指标先于 TrackEval 逐阈值分量（DetA___10 等）", () => {
    const inputs = [
      obs({ metric: "DetA___10", value: 48.68, rawText: "48.68" }), base({ metric: "DetA___10", value: 48.69, rawText: "48.69" }),
      obs({}), base(),
    ];
    const ranked = workflowComparisons(snapshotOf(inputs));
    expect(ranked[0]!.metric).toBe("HOTA");
  });
});

describe("metricObservations（M17.2）", () => {
  it("TrackEval detailed：HOTA___AUC 方向 = higher；seq 作为子集；作者 metadata 只填补缺失字段；66.9% 后缀单位", async () => {
    const { metricObservations } = await import("../../src/experiments/ExperimentPackageService.js");
    const file = { path: "main/detailed.csv", hash: "h", bytes: 1, compressedBytes: 1, kind: "csv", parseStatus: "ok" as const, sourceId: "S1", role: "main_result" as const, roleBasis: "", roleConfidence: "high" as const, groupId: "main", metadata: { method: "ours", dataset: "DS-A", units: { "*": "ratio" as const } } };
    const document = {
      sourceId: "S1", status: "ok", parser: { id: "csv" }, mode: "structured", quality: "full", notes: [],
      blocks: [{ blockId: "B0001", type: "structured_record", provenance: { fileName: "detailed.csv", row: 3 }, cells: [{ letter: "A", header: "seq", value: "COMBINED" }, { letter: "B", header: "HOTA___AUC", value: "0.4983" }, { letter: "C", header: "IDF1", value: "62.5%" }, { letter: "D", header: "method", value: "ours-file" }] }],
    } as never;
    const extraction = metricObservations(file as never, document);
    const hota = extraction.observations.find((entry) => entry.metric === "HOTA___AUC")!;
    expect(hota).toMatchObject({ direction: "higher", subset: "COMBINED", unit: "ratio", unitBasis: "author_metadata", dataset: "DS-A", method: "ours-file", authorFilled: ["dataset"] });
    expect(extraction.observations.find((entry) => entry.metric === "IDF1")).toMatchObject({ unit: "percentage", unitBasis: "cell_suffix", rawText: "62.5%" });
    // 文件内 method 与作者 metadata 矛盾 → 冲突登记（不覆盖）
    expect(extraction.conflicts.join("")).toContain("文件内为「ours-file」，作者 metadata 为「ours」");
    // "*" 不与显式单位（62.5%）冲突；逐指标声明矛盾才冲突
    expect(extraction.conflicts.some((entry) => entry.includes("IDF1"))).toBe(false);
    const specific = metricObservations({ ...file, metadata: { units: { IDF1: "ratio" as const } } } as never, document);
    expect(specific.conflicts.some((entry) => entry.includes("IDF1") && entry.includes("矛盾"))).toBe(true);
  });
});

describe("对比上限下整体结果优先（M17.2 真实数据回归）", () => {
  it("大量逐序列事实不会挤掉排在后面的指标的整体对比", () => {
    const inputs: SnapshotInputObservation[] = [];
    for (let index = 0; index < 400; index += 1) {
      for (const metric of ["AAA", "AAB", "AAC"]) {
        inputs.push(obs({ metric, subset: `seq-${index}`, value: 50 + index / 1000, rawText: (50 + index / 1000).toFixed(3) }));
        inputs.push(base({ metric, subset: `seq-${index}`, value: 49, rawText: "49.000" }));
        inputs.push(obs({ groupId: "ablation", groupRole: "ablation", method: "ours-lite", metric, subset: `seq-${index}`, value: 50, rawText: "50.000" }));
      }
    }
    inputs.push(obs({ metric: "ZZZ" }), base({ metric: "ZZZ" }));
    const build = buildFactSnapshotContent(inputs, none);
    expect(build.limitations.join("")).toContain("超过上限");
    expect(build.comparisons.some((entry) => entry.context.metricKey === "ZZZ")).toBe(true);
  });
});

describe("结果表列与正文一致（M17.2 真实数据回归）", () => {
  it("正文提及的指标优先成列；未提及的按对比数补足", () => {
    const inputs = [obs({}), base(), obs({ metric: "AssA", value: 70.440, rawText: "70.440" }), base({ metric: "AssA", value: 63.870, rawText: "63.870" }), obs({ metric: "IDF1", value: 57.940, rawText: "57.940" }), base({ metric: "IDF1", value: 52.600, rawText: "52.600" })];
    const snapshot = snapshotOf(inputs);
    const context: ConfirmedExperimentWorkflowContext = {
      schemaVersion: 1, status: "author_confirmed_not_externally_verified", truncated: false,
      snapshot: { snapshotId: "efs-0001", version: 1, contentHash: snapshot.contentHash, createdAt: "", status: "valid", factCount: 6, comparisonCount: 3 },
      comparisons: workflowComparisons(snapshot), observations: [],
    };
    expect(mentionedMetrics("IDF1 从 52.600 提升到 57.940，HOTA 亦提高；IDF1 增益最大。\\textbf{HOTA}", ["HOTA", "IDF1", "ASSA"])).toEqual(["IDF1", "HOTA"]);
    const table = renderSnapshotResultsTable(context, { preferMetrics: ["IDF1", "HOTA"] });
    expect(table.table!.metrics.slice(0, 2)).toEqual(["IDF1", "HOTA"]);
    // 列名用原始指标名（AssA），不是规范键（ASSA）
    expect(table.table!.latex).toContain("AssA (\\%)");
    expect(table.table!.latex).not.toContain("ASSA");
  });
});

describe("结果表追加（M17.2 真实运行缺陷回归）", () => {
  it("正文里的 Table~ref 引用不阻止追加；只有同名 label 才视为已存在", async () => {
    const { appendResultsTable } = await import("../../src/experiments/resultsTable.js");
    const table = { label: "tab:exp-efs-0001", latex: "\\begin{table}\\label{tab:exp-efs-0001}\\end{table}" };
    const referenced = appendResultsTable("结果汇总于 Table~\\ref{tab:exp-efs-0001}。\n", table);
    expect(referenced.appended).toBe(true);
    expect(referenced.latex).toContain("\\label{tab:exp-efs-0001}");
    expect(referenced.latex.startsWith("结果汇总于 Table~\\ref{tab:exp-efs-0001}。")).toBe(true);
    const own = appendResultsTable(table.latex, table);
    expect(own).toEqual({ latex: table.latex, appended: false });
  });
});

describe("核查指标归属（M17.2 真实运行误报回归）", () => {
  it("数字前没有指标名时不猜归属：与任一对比一致即判一致；都不一致记 unbound 不报；对照：有指标名照常报", () => {
    const snapshot = snapshotOf([
      obs({ metric: "IDSW", value: 778, rawText: "778", unit: "count", direction: "lower" }), base({ metric: "IDSW", value: 820, rawText: "820", unit: "count", direction: "lower" }),
      obs({ metric: "AssA", value: 70.440, rawText: "70.440" }), base({ metric: "AssA", value: 63.870, rawText: "63.870" }),
    ]);
    const real = auditExperimentFacts([{ file: "intro.tex", content: "身份切换次数由 820 降至 778（相对减少 5.1\\%），AssA 提高 6.570 个百分点。" }], snapshot, "valid");
    expect(real.findings).toEqual([]);
    expect(real.consistent).toHaveLength(2);
    const wrong = auditExperimentFacts([{ file: "intro.tex", content: "身份切换次数相对减少 30.5\\%，AssA 提高 6.570 个百分点。" }], snapshot, "valid");
    // 未归属且与任何对比都不一致：不出 finding，记 unbound 供人工复核（不误报）
    expect(wrong.findings).toEqual([]);
    expect(wrong.unbound.map((entry) => entry.claimedValue)).toEqual([30.5]);
    // 对照：数字前有指标名时照常报 finding
    const named = auditExperimentFacts([{ file: "intro.tex", content: "IDSW 相对减少 30.5\\%。" }], snapshot, "valid");
    expect(named.findings.map((entry) => entry.code)).toEqual(["EXP_DELTA_NOT_IN_SNAPSHOT"]);
  });

  it("并列枚举「X、Y 与 Z 分别为 +a、+b 个百分点」：只在枚举的指标内核对，不按位置归到最后一个指标；对照：不在枚举指标内的幅度记 unbound、单指标句照常报", () => {
    const snapshot = snapshotOf([
      obs({ metric: "IDP", value: 44.100, rawText: "44.100" }), base({ metric: "IDP", value: 40.300, rawText: "40.300" }),
      obs({ metric: "IDR", value: 71.250, rawText: "71.250" }), base({ metric: "IDR", value: 64.050, rawText: "64.050" }),
      obs({ metric: "IDTP", value: 9120, rawText: "9120", unit: "count" }), base({ metric: "IDTP", value: 8410, rawText: "8410", unit: "count" }),
    ]);
    const listed = auditExperimentFacts([{ file: "exp.tex", content: "IDP、IDR 与 IDTP 亦同步提高（分别为 +3.800、+7.200 个百分点与 +710 个计数）。" }], snapshot, "valid");
    expect(listed.findings).toEqual([]);
    expect(listed.consistent.map((entry) => entry.metric)).toEqual(["IDR"]);
    const off = auditExperimentFacts([{ file: "exp.tex", content: "IDP、IDR 与 IDTP 分别提高 +3.800、+9.900 个百分点。" }], snapshot, "valid");
    expect(off.findings).toEqual([]);
    expect(off.unbound.map((entry) => entry.claimedValue)).toEqual([9.9]);
    const single = auditExperimentFacts([{ file: "exp.tex", content: "IDR 提高 9.900 个百分点。" }], snapshot, "valid");
    expect(single.findings.map((entry) => entry.code)).toEqual(["EXP_DELTA_NOT_IN_SNAPSHOT"]);
  });
});

describe("核查对比绑定（M17.2 真实数据负例重放回归）", () => {
  it("句中点名两个方法时绑定到这两个方法之间的对比", () => {
    const snapshot = snapshotOf([obs({ method: "ma_x" }), base(), obs({ groupId: "ablation", groupRole: "ablation", method: "mb_x", value: 49.970, rawText: "49.970" })]);
    const audit = auditExperimentFacts([{ file: "r.tex", content: "ma_x 的 HOTA 比 base 提升了 2.6\\%。" }], snapshot, "valid");
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]!.detail).toContain("ma_x 对 base");
  });
});
