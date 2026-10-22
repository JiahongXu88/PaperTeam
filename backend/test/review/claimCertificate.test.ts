/**
 * M15.2 核验证书（claim-certificate/v1）+ 表格解析 + 派生量 AST：确定性单元测试与 property / mutation 测试。
 * 夹具全部为本仓库自写的合成文本（数值结构仿照 M15 DEV 回归样例 C03「七倍」、C06「5.46% vs 7.46%」，不含原文）。
 * 合成夹具只证明算法性质，不代表真实论文检出率。
 */
import { describe, expect, it } from "vitest";
import { parseLatexTables } from "../../src/review/latexTable.js";
import { buildCertificateDocument, certifyClaim, compareAtoms, type CertifyInput } from "../../src/review/claimCertificate.js";
import { evaluateFormula, validateFormula, displayInterval, type FormulaAtom } from "../../src/review/derivedFormula.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

function span(doc: string, quote: string): { file: string; start: number; end: number } {
  const located = locateQuote(doc, quote);
  if (located === null) throw new Error(`fixture quote not found: ${quote}`);
  return { file: "main.tex", start: located.start, end: located.end };
}

function certify(doc: string, claim: string, claimValue: string, counterpart: string | null, counterpartValue: string | undefined, check: CertifyInput["check"]) {
  const document = buildCertificateDocument([{ file: "main.tex", content: doc }]);
  return certifyClaim(document, {
    claim: { ...span(doc, claim), value: claimValue },
    counterpart: counterpart === null ? null : { ...span(doc, counterpart), ...(counterpartValue !== undefined ? { value: counterpartValue } : {}) },
    check,
  });
}

const TRACKER = [
  "\\title{FastTrack: A Lightweight Tracker}",
  "\\begin{abstract}",
  "The proposed FastTrack achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset and an HOTA of 60.9\\% on the MOT20 dataset.",
  "\\end{abstract}",
  "\\section{Results}",
  "\\begin{table}[t]",
  "\\caption{Test results on MOT17 and MOT20.}\\label{tab:results}",
  "\\begin{tabular}{lcccccc}",
  "\\toprule",
  " & \\multicolumn{3}{c}{MOT17} & \\multicolumn{3}{c}{MOT20} \\\\",
  "Tracker & HOTA & IDF1 & Speed (Hz) & HOTA & IDF1 & Speed (Hz) \\\\",
  "\\midrule",
  "FastTrack (ours) & 61.7 & 74.4 & 2241.8 & 60.9 & 73.5 & 304.1 \\\\",
  "ByteTrack & 63.1 & 71.5 & 29.6 & 61.3 & 75.2 & 17.5 \\\\",
  "BaseTrack & 64.5 & 78.6 & 331.3 & 62.0 & 76.1 & 30.8 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "FastTrack is almost seven times faster than the fastest previous tracker on MOT17.",
  "On MOT17, FastTrack improves IDF1 over ByteTrack by 2.9 percentage points.",
  "\\begin{table}[t]",
  "\\caption{Ablation on the MOT17 validation set.}\\label{tab:ablation}",
  "\\begin{tabular}{lcc}",
  "\\toprule",
  "Mode & HOTA & IDF1 \\\\",
  "\\midrule",
  "Default & 75.682 & 83.059 \\\\",
  "Fixed Hyperparameter & 75.606 & 83.193 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\section{Conclusion}",
  "In evaluations on the MOT17 dataset, FastTrack achieved an HOTA of 61.7\\%.",
  "",
].join("\n");

describe("M15.2 latexTable 结构解析", () => {
  it("多级表头（multicolumn 展开）、行键、caption / label、表头单位", () => {
    const tables = parseLatexTables(TRACKER);
    expect(tables).toHaveLength(2);
    const main = tables[0]!;
    expect(main.label).toBe("tab:results");
    expect(main.headerRowCount).toBe(2);
    const cell = main.cells.find((entry) => entry.value?.raw === "60.9")!;
    expect(cell.headerPath).toEqual(["MOT20", "HOTA"]);
    expect(cell.rowKey).toEqual(["FastTrack (ours)"]);
    expect(main.cells.find((entry) => entry.value?.raw === "2241.8")!.unit).toBe("hz");
    expect(TRACKER.slice(cell.valueStart!, cell.valueEnd!)).toBe("60.9");
  });
  it("数字表头（1\\% / 10\\%）在横线前不被当成数据行；整行单格是行组", () => {
    const doc = [
      "\\begin{tabular}{lcccc}", "\\hline", "\\multicolumn{5}{c}{Long-range set} \\\\", "\\hline",
      "Method & Rank-1 & Rank-5 & 1\\% & 10\\% \\\\", "\\hline", "\\multicolumn{5}{c}{Small models} \\\\",
      "Alpha & 47.42 & 57.26 & 55.95 & 69.32 \\\\", "Beta (ours) & 56.93 & 67.02 & 63.67 & 75.98 \\\\", "\\hline", "\\end{tabular}",
    ].join("\n");
    const table = parseLatexTables(doc)[0]!;
    expect(table.headerRowCount).toBe(2);
    const beta = table.cells.find((cell) => cell.value?.raw === "63.67")!;
    expect(beta.headerPath).toEqual(["Long-range set", "1%"]);
    expect(beta.rowGroup).toBe("Small models");
  });
  it("multirow 行键下延；\\cite 键不进入行标签", () => {
    const doc = ["\\begin{tabular}{llcc}", "\\toprule", "Data & Method & AP & AR \\\\", "\\midrule",
      "\\multirow{2}{*}{SetA} & Alpha~\\cite{alpha2020} & 30.1 & 40.2 \\\\", " & Beta & 31.5 & 41.0 \\\\", "\\bottomrule", "\\end{tabular}"].join("\n");
    const table = parseLatexTables(doc)[0]!;
    expect(table.cells.find((cell) => cell.value?.raw === "31.5")!.rowKey).toEqual(["SetA", "Beta"]);
    expect(table.cells.find((cell) => cell.value?.raw === "30.1")!.rowKey).toEqual(["SetA", "Alpha"]);
  });
});

describe("M15.2 derivedFormula 受控 AST + 区间算术", () => {
  const atoms = new Map<string, FormulaAtom>([
    ["a", { ref: "a", value: 94.86, decimals: 2, unit: null }],
    ["b", { ref: "b", value: 89.31, decimals: 2, unit: null }],
    ["c", { ref: "c", value: 89.74, decimals: 2, unit: null }],
    ["d", { ref: "d", value: 83.14, decimals: 2, unit: null }],
  ]);
  it("C06 结构回归：mean(三行) 的绝对差 7.46、相对差 8.54% —— 都不等于 5.46", () => {
    const mean = { op: "mean" as const, args: [{ op: "atom" as const, ref: "b" }, { op: "atom" as const, ref: "c" }, { op: "atom" as const, ref: "d" }] };
    const abs = evaluateFormula({ op: "percentage_point_difference", args: [{ op: "atom", ref: "a" }, mean] }, atoms)!;
    const rel = evaluateFormula({ op: "relative_change_percent", args: [{ op: "atom", ref: "a" }, mean] }, atoms)!;
    expect(abs.lo).toBeGreaterThan(7.45);
    expect(abs.hi).toBeLessThan(7.48);
    expect(rel.lo).toBeGreaterThan(8.5);
    expect(rel.hi).toBeLessThan(8.58);
    const claim = displayInterval(5.46, 2);
    expect(claim.hi < abs.lo && claim.hi < rel.lo).toBe(true);
  });
  it("拒绝未知操作 / 未绑定原子 / 参数个数非法 / 不可换算单位；不执行任意表达式", () => {
    expect(validateFormula({ op: "eval", args: ["1+1"] }, atoms).ok).toBe(false);
    expect(validateFormula({ op: "subtract", args: [{ op: "atom", ref: "zzz" }, { op: "atom", ref: "a" }] }, atoms).ok).toBe(false);
    expect(validateFormula({ op: "subtract", args: [{ op: "atom", ref: "a" }] }, atoms).ok).toBe(false);
    expect(validateFormula({ op: "unit_convert", from: "mm", to: "hz", arg: { op: "atom", ref: "a" } }, atoms).ok).toBe(false);
    expect(validateFormula({ op: "unit_convert", from: "mm", to: "cm", arg: { op: "atom", ref: "a" } }, atoms).ok).toBe(true);
  });
  it("除数区间含 0 → 不可算（null），不返回伪精确值", () => {
    const zero = new Map<string, FormulaAtom>([["z", { ref: "z", value: 0, decimals: 1, unit: null }], ["a", atoms.get("a")!]]);
    expect(evaluateFormula({ op: "ratio", args: [{ op: "atom", ref: "a" }, { op: "atom", ref: "z" }] }, zero)).toBeNull();
  });
});

describe("M15.2 claim-certificate/v1：唯一绑定 + 证书", () => {
  it("摘要被改 63.7 vs 主表 61.7（同方法 / 同指标 / 同数据集）→ CONTRADICTED；对应关系由模型提出（provenance 记 model）", () => {
    const doc = TRACKER.replace("achieves an HOTA of 61.7\\%", "achieves an HOTA of 63.7\\%");
    const cert = certify(doc, "achieves an HOTA of 63.7\\% with a speed of 2242 Hz on the MOT17 dataset", "63.7%", "FastTrack (ours) & 61.7 & 74.4", "61.7", "INCONSISTENT");
    expect(cert.outcome).toBe("CONTRADICTED");
    expect(cert.comparisonType).toBe("SAME_OBSERVABLE");
    expect(cert.binding?.bound?.headerPath).toEqual(["MOT17", "HOTA"]);
    expect(cert.provenance.correspondenceProposedBy).toBe("model");
    expect(cert.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("原稿一致（61.7 vs 61.7；2242 Hz vs 2241.8 合法舍入）→ SUPPORTED", () => {
    expect(certify(TRACKER, "achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset", "61.7%", "FastTrack (ours) & 61.7 & 74.4", "61.7", "CONSISTENT").outcome).toBe("SUPPORTED");
    expect(certify(TRACKER, "achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset", "2242 Hz", "FastTrack (ours) & 61.7 & 74.4 & 2241.8", "2241.8", "CONSISTENT").outcome).toBe("SUPPORTED");
  });
  it("错表 / 错行：把 MOT17 的论断配到 MOT20 列或 ByteTrack 行 → 不出证书（DIFFERENT_VARIANT）", () => {
    const wrongColumn = certify(TRACKER, "achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset", "61.7%", "FastTrack (ours) & 61.7 & 74.4 & 2241.8 & 60.9", "60.9", "INCONSISTENT");
    expect(wrongColumn.outcome).toBe("NOT_CERTIFIED");
    expect(wrongColumn.comparisonType).toBe("DIFFERENT_VARIANT");
    const wrongRow = certify(TRACKER, "achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset", "61.7%", "ByteTrack & 63.1 & 71.5", "63.1", "INCONSISTENT");
    expect(wrongRow.outcome).toBe("NOT_CERTIFIED");
  });
  it("M15.1 误报回归：消融表 Default 行 vs Fixed Hyperparameter 行（单元格对单元格）→ 不出证书", () => {
    const cert = certify(TRACKER, "Fixed Hyperparameter & 75.606 & 83.193", "83.193", "Default & 75.682 & 83.059", "83.059", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons).toContain("CELL_CELL_CORRESPONDENCE_NOT_CERTIFIABLE");
  });
  it("C03 结构回归：「almost seven times faster than the fastest previous tracker」——倍数解释不唯一 + 约数 → 只记复算，不出证书；改成 twelve 也不出证书", () => {
    const original = certify(TRACKER, "almost seven times faster than the fastest previous tracker on MOT17", "seven", null, undefined, "CONSISTENT");
    expect(original.outcome).toBe("NOT_CERTIFIED");
    const doc = TRACKER.replace("almost seven times faster", "almost 12 times faster");
    const mutated = certify(doc, "almost 12 times faster than the fastest previous tracker on MOT17", "12", null, undefined, "INCONSISTENT");
    expect(mutated.outcome).toBe("NOT_CERTIFIED");
    expect(mutated.kind).toBe("DERIVED_RECOMPUTE");
    expect(mutated.reasons.join(" ")).toMatch(/AMBIGUOUS|APPROX/);
  });
  it("百分点措辞 + 点名参照行 + 唯一列 → 派生量证书（2.9 pp 一致；改成 3.9 pp 矛盾）", () => {
    const ok = certify(TRACKER, "FastTrack improves IDF1 over ByteTrack by 2.9 percentage points", "2.9", null, undefined, "CONSISTENT");
    expect(ok.kind).toBe("DERIVED_RECOMPUTE");
    expect(ok.outcome).toBe("SUPPORTED");
    const doc = TRACKER.replace("by 2.9 percentage points", "by 3.9 percentage points");
    const bad = certify(doc, "FastTrack improves IDF1 over ByteTrack by 3.9 percentage points", "3.9", null, undefined, "INCONSISTENT");
    expect(bad.outcome).toBe("CONTRADICTED");
    expect(bad.derived?.interpretations.some((entry) => entry.name.startsWith("absolute_difference") && entry.consistent === false)).toBe(true);
  });
  it("「提升 2.9%」（百分比措辞、操作数是百分比指标）：相对 vs 百分点不唯一 → 不出证书", () => {
    const doc = TRACKER.replace("by 2.9 percentage points", "by 2.9\\%");
    const cert = certify(doc, "FastTrack improves IDF1 over ByteTrack by 2.9\\%", "2.9%", null, undefined, "CONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons).toContain("DERIVED_PERCENT_RELATIVE_OR_ABSOLUTE_AMBIGUOUS");
  });
  it("论断带表格语境解释不了的限定词（validation / post-processing）→ 不出证书", () => {
    const doc = TRACKER.replace("In evaluations on the MOT17 dataset, FastTrack achieved an HOTA of 61.7\\%.", "With post-processing on the MOT17 dataset, FastTrack achieved an HOTA of 63.2\\%.");
    const cert = certify(doc, "FastTrack achieved an HOTA of 63.2\\%", "63.2%", "FastTrack (ours) & 61.7 & 74.4", "61.7", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons.join(" ")).toContain("post-processing");
  });
  it("量纲：14 cm vs 140 mm 一致；裸数差 10 倍 → 量纲歧义；约数 about 14 mm vs 142.7 mm（≥2 倍）→ 可证矛盾", () => {
    expect(compareAtoms({ value: 14, decimals: 0, unit: "cm" }, { value: 140, decimals: 0, unit: "mm" }).relation).toBe("OVERLAP");
    expect(compareAtoms({ value: 14, decimals: 0, unit: null }, { value: 140, decimals: 0, unit: "mm" }).relation).toBe("SCALE_AMBIGUOUS");
    const doc = [
      "\\begin{table}\\caption{Absolute MPJPE on the workcell sequences.}\\label{tab:workcell-abs}",
      "\\begin{tabular}{lcc}", "\\toprule", "\\multicolumn{3}{c}{MPJPE absolute, mm} \\\\", "Methods & Seq 1 & Avg \\\\", "\\midrule",
      "Other & 900.1 & 905.2 \\\\", "Ours & 140.9 & 142.7 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
      "\\section{Workcell results}", "Our framework obtains an average absolute error of about 14\\,mm on the workcell sequences.",
    ].join("\n");
    const cert = certify(doc, "obtains an average absolute error of about 14\\,mm on the workcell sequences", "about 14 mm", "Ours & 140.9 & 142.7", "142.7", "INCONSISTENT");
    expect(cert.outcome).toBe("CONTRADICTED");
    expect(cert.valueRelation?.relation).toBe("APPROX_FAR");
  });
  it("文本对文本：两句都唯一绑定到同一单元格才可比；只写「2242 Hz」不点数据集 → 绑定不唯一", () => {
    const doc = TRACKER.replace("The proposed FastTrack achieves an HOTA of 61.7\\%", "The proposed FastTrack achieves an HOTA of 63.7\\%");
    const cert = certify(doc, "achieves an HOTA of 63.7\\% with a speed of 2242 Hz on the MOT17 dataset", "63.7%", "In evaluations on the MOT17 dataset, FastTrack achieved an HOTA of 61.7\\%", "61.7%", "INCONSISTENT");
    expect(cert.outcome).toBe("CONTRADICTED");
    const speed = TRACKER.replace("\\section{Conclusion}", "\\section{Conclusion}\nFastTrack runs at 2242 Hz on a single CPU core.");
    const tie = certify(speed, "FastTrack runs at 2242 Hz on a single CPU core", "2242 Hz", "FastTrack (ours) & 61.7 & 74.4 & 2241.8", "2241.8", "CONSISTENT");
    expect(tie.outcome).toBe("NOT_CERTIFIED");
  });
  it("模型结论与证书相反（模型说 INCONSISTENT、数值其实一致）→ 不升级", () => {
    const cert = certify(TRACKER, "achieves an HOTA of 61.7\\% with a speed of 2242 Hz on the MOT17 dataset", "61.7%", "FastTrack (ours) & 61.7 & 74.4", "61.7", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons).toContain("MODEL_CHECK_DISAGREES_WITH_VALUES");
  });
});

describe("M15.2 DEV_NEW 绑定改进（合成结构）", () => {
  const CD = [
    "\\begin{table}\\caption{Comparison on the SetA benchmark.}\\label{tab:cmp}",
    "\\begin{tabular}{lcc}", "\\toprule", "Method & IoU & F1 \\\\", "\\midrule",
    "AlphaNet & 80.68 & 88.1 \\\\", "BetaNet & 81.92 & 89.0 \\\\", "GammaNet & 82.48 & 89.4 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
    "\\section{Results}",
    "Tab.~\\ref{tab:cmp} shows that AlphaNet \\cite{a}, BetaNet \\cite{b}, and GammaNet \\cite{c} achieve IoU scores of 80.68\\%, 81.92\\% and 82.48\\% respectively on SetA.",
    "We set the IoU and F1 thresholds of 0.5 and 0.7 for the evaluation.",
    "",
  ].join("\n");
  it("「A, B, and C achieve … respectively」按位置对齐；改掉第二个数 → 可证矛盾（对齐到 BetaNet 行）", () => {
    expect(certify(CD, "81.92\\% and 82.48\\% respectively", "81.92%", "BetaNet & 81.92 & 89.0", "81.92", "CONSISTENT").outcome).toBe("SUPPORTED");
    const doc = CD.replace("81.92\\% and 82.48\\%", "83.92\\% and 82.48\\%");
    const cert = certify(doc, "83.92\\% and 82.48\\% respectively", "83.92%", "BetaNet & 81.92 & 89.0", "81.92", "INCONSISTENT");
    expect(cert.outcome).toBe("CONTRADICTED");
    expect(cert.binding?.bound?.rowKey).toEqual(["BetaNet"]);
  });
  it("多指标并列（「IoU and F1 thresholds of 0.5 and 0.7」）：列归属不唯一 → 不出证书", () => {
    const cert = certify(CD, "IoU and F1 thresholds of 0.5 and 0.7 for the evaluation", "0.7", "BetaNet & 81.92 & 89.0", "89.0", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
  });
  it("转置表（指标在行、方法在列）：「NeST achieves the best SMAPE of 11.840」绑到 SMAPE 行 × NeST 列", () => {
    const doc = [
      "\\title{NeST: Synthetic}",
      "\\begin{table}\\caption{Short-term forecasting.}\\label{tab:m4}", "\\begin{tabular}{lcc}", "\\toprule", "Metric & NeST (Ours) & Other \\\\", "\\midrule[1.0pt]",
      "SMAPE & 11.840 & 11.979 \\\\", "MASE & 1.578 & 1.600 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
      "\\section{Results}", "NeST achieves the best SMAPE of 12.840 on the M4 benchmark.", "",
    ].join("\n");
    const cert = certify(doc, "NeST achieves the best SMAPE of 12.840 on the M4 benchmark", "12.840", "SMAPE & 11.840 & 11.979", "11.840", "INCONSISTENT");
    expect(cert.binding?.bound?.headerPath).toEqual(["NeST (Ours)"]);
    expect(cert.outcome).toBe("CONTRADICTED");
  });
});

describe("M15.2 旧 DEV 重放误报回归（合成结构）", () => {
  const RADAR = [
    "\\title{RadarNet: Synthetic}",
    "\\begin{table}\\caption{Evaluation on the city dataset.}\\label{tab:eval}",
    "\\begin{tabular}{lcc}", "\\toprule", "Models & mAP & mAR \\\\", "\\midrule",
    "RadarNet (ours) & 94.86 & 95.95 \\\\", "BaseNet-CDC & 89.31 & 92.87 \\\\", "BaseNet-HG & 89.74 & 95.26 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
    "\\section{Results}",
    "RadarNet achieves relative improvements of 6.22\\% in mAP and 3.31\\% in mAR over BaseNet-CDC, demonstrating robust detection.",
    "",
  ].join("\n");
  it("「relative improvements of 6.22% in mAP and 3.31% in mAR over BaseNet-CDC」：两个数都是派生量，不能当原子值绑到 BaseNet 行（KA90F129 r2 误报）", () => {
    for (const [value, quote] of [["6.22%", "RadarNet achieves relative improvements of 6.22\\% in mAP"], ["3.31%", "and 3.31\\% in mAR over BaseNet-CDC"]] as const) {
      const cert = certify(RADAR, quote, value, "BaseNet-CDC & 89.31 & 92.87", value === "6.22%" ? "89.31" : "92.87", "INCONSISTENT");
      expect(cert.outcome).toBe("NOT_CERTIFIED");
      expect(cert.claimAtom?.qualifiers).toContain("DERIVED");
    }
  });
  it("行维只认论断主语：「RadarNet reaches an mAP of 94.86 compared with BaseNet-CDC」绑到 RadarNet 行，不绑比较对象", () => {
    const doc = RADAR.replace("\\section{Results}", "\\section{Results}\nRadarNet reaches an mAP of 94.86 compared with BaseNet-CDC on the city dataset.");
    const cert = certify(doc, "RadarNet reaches an mAP of 94.86 compared with BaseNet-CDC", "94.86", "BaseNet-CDC & 89.31 & 92.87", "89.31", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.binding?.bound?.rowKey).toEqual(["RadarNet (ours)"]);
  });
});

// ---- property / mutation 测试（合成；种子固定） ----

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const METHODS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const METRICS = ["mAP", "Recall", "F1"];
const DATASETS = ["KITTI", "Waymo", "NuScenes"];

function syntheticPaper(random: () => number, options: { datasetsInClaim: boolean }) {
  const datasetCount = 2 + Math.floor(random() * 2);
  const datasets = DATASETS.slice(0, datasetCount);
  const values: Record<string, Record<string, Record<string, string>>> = {};
  const lines = ["\\title{OmniDet: Synthetic}", "\\section{Results}"];
  for (const dataset of datasets) {
    values[dataset] = {};
    lines.push("\\begin{table}", `\\caption{Results on the ${dataset} benchmark.}\\label{tab:${dataset.toLowerCase()}}`, "\\begin{tabular}{lccc}", "\\toprule", `Method & ${METRICS.join(" & ")} \\\\`, "\\midrule");
    for (const method of ["OmniDet (ours)", ...METHODS.slice(0, 3)]) {
      values[dataset]![method] = {};
      const row = METRICS.map((metric) => {
        const value = (20 + random() * 70).toFixed(1);
        values[dataset]![method]![metric] = value;
        return value;
      });
      lines.push(`${method} & ${row.join(" & ")} \\\\`);
    }
    lines.push("\\bottomrule", "\\end{tabular}", "\\end{table}");
  }
  const dataset = datasets[Math.floor(random() * datasets.length)]!;
  const metric = METRICS[Math.floor(random() * METRICS.length)]!;
  const truth = values[dataset]!["OmniDet (ours)"]![metric]!;
  const claimText = options.datasetsInClaim ? `On the ${dataset} benchmark, OmniDet reaches a ${metric} of CLAIM.` : `OmniDet reaches a ${metric} of CLAIM.`;
  return { lines, dataset, metric, truth, claimText, values, datasets };
}

function build(lines: string[], claimSentence: string) {
  return [...lines, "\\section{Discussion}", claimSentence, ""].join("\n");
}

describe("M15.2 property：证书在合成表格变异上不产生错误强判", () => {
  it("P1 正确对应 + 数值一致 → 从不 CONTRADICTED；P2 数值改动超出显示精度 → 从不 SUPPORTED", () => {
    const random = rng(7);
    let supported = 0;
    let contradicted = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const paper = syntheticPaper(random, { datasetsInClaim: true });
      const rowQuote = (value: string) => `OmniDet (ours) & ${Object.values(paper.values[paper.dataset]!["OmniDet (ours)"]!).join(" & ")}`.includes(value) ? `OmniDet (ours) & ${Object.values(paper.values[paper.dataset]!["OmniDet (ours)"]!).join(" & ")}` : "";
      const counterpart = rowQuote(paper.truth);
      const goodDoc = build(paper.lines, paper.claimText.replace("CLAIM", paper.truth));
      const claimQuote = paper.claimText.replace("CLAIM", paper.truth);
      // 同一行内同值重复出现时证书本应拒绝（VALUE_AMBIGUOUS_IN_SPAN），不计入
      const good = certify(goodDoc, claimQuote, paper.truth, counterpart, paper.truth, "CONSISTENT");
      expect(good.outcome).not.toBe("CONTRADICTED");
      if (good.outcome === "SUPPORTED") supported += 1;
      const mutatedValue = (Number(paper.truth) + 1.3).toFixed(1);
      const badClaim = paper.claimText.replace("CLAIM", mutatedValue);
      const badDoc = build(paper.lines, badClaim);
      const bad = certify(badDoc, badClaim, mutatedValue, counterpart, paper.truth, "INCONSISTENT");
      expect(bad.outcome).not.toBe("SUPPORTED");
      if (bad.outcome === "CONTRADICTED") contradicted += 1;
    }
    // 正确输入上证书应当大多数能出（召回不是 0），否则就是空洞地「安全」
    expect(supported).toBeGreaterThan(30);
    expect(contradicted).toBeGreaterThan(30);
  });
  it("P3 错误对应（同方法另一数据集的表 / 同表另一方法行）→ 从不出证书", () => {
    const random = rng(11);
    for (let trial = 0; trial < 60; trial += 1) {
      const paper = syntheticPaper(random, { datasetsInClaim: true });
      const otherDataset = paper.datasets.find((dataset) => dataset !== paper.dataset)!;
      const claim = paper.claimText.replace("CLAIM", paper.truth);
      const doc = build(paper.lines, claim);
      const wrongTable = `OmniDet (ours) & ${Object.values(paper.values[otherDataset]!["OmniDet (ours)"]!).join(" & ")}`;
      const otherValue = paper.values[otherDataset]!["OmniDet (ours)"]![paper.metric]!;
      if (locateQuote(doc, wrongTable)?.occurrences !== 1) continue;
      const cert = certify(doc, claim, paper.truth, wrongTable, otherValue, otherValue === paper.truth ? "CONSISTENT" : "INCONSISTENT");
      expect(cert.outcome).toBe("NOT_CERTIFIED");
      const baseline = METHODS[0]!;
      const wrongRow = `${baseline} & ${Object.values(paper.values[paper.dataset]![baseline]!).join(" & ")}`;
      const rowValue = paper.values[paper.dataset]![baseline]![paper.metric]!;
      if (locateQuote(doc, wrongRow)?.occurrences !== 1) continue;
      expect(certify(doc, claim, paper.truth, wrongRow, rowValue, rowValue === paper.truth ? "CONSISTENT" : "INCONSISTENT").outcome).toBe("NOT_CERTIFIED");
    }
  });
  it("P4 论断不点数据集（多张表有同方法同指标）→ 从不出证书", () => {
    const random = rng(23);
    for (let trial = 0; trial < 40; trial += 1) {
      const paper = syntheticPaper(random, { datasetsInClaim: false });
      const claim = paper.claimText.replace("CLAIM", paper.truth);
      const doc = build(paper.lines, claim);
      const counterpart = `OmniDet (ours) & ${Object.values(paper.values[paper.dataset]!["OmniDet (ours)"]!).join(" & ")}`;
      if (locateQuote(doc, counterpart)?.occurrences !== 1) continue;
      expect(certify(doc, claim, paper.truth, counterpart, paper.truth, "CONSISTENT").outcome).toBe("NOT_CERTIFIED");
      const bad = (Number(paper.truth) + 2).toFixed(1);
      const badClaim = paper.claimText.replace("CLAIM", bad);
      expect(certify(build(paper.lines, badClaim), badClaim, bad, counterpart, paper.truth, "INCONSISTENT").outcome).toBe("NOT_CERTIFIED");
    }
  });
  it("P5 合法舍入（论断少写一位小数）→ 从不 CONTRADICTED", () => {
    const random = rng(31);
    for (let trial = 0; trial < 40; trial += 1) {
      const paper = syntheticPaper(random, { datasetsInClaim: true });
      const rounded = String(Math.round(Number(paper.truth)));
      const claim = paper.claimText.replace("CLAIM", rounded);
      const doc = build(paper.lines, claim);
      const counterpart = `OmniDet (ours) & ${Object.values(paper.values[paper.dataset]!["OmniDet (ours)"]!).join(" & ")}`;
      if (locateQuote(doc, counterpart)?.occurrences !== 1) continue;
      expect(certify(doc, claim, rounded, counterpart, paper.truth, "INCONSISTENT").outcome).not.toBe("CONTRADICTED");
    }
  });
  it("P6 指标名改成表里没有的指标 → 不出证书", () => {
    const random = rng(41);
    for (let trial = 0; trial < 30; trial += 1) {
      const paper = syntheticPaper(random, { datasetsInClaim: true });
      const claim = paper.claimText.replace(paper.metric, "Precision").replace("CLAIM", paper.truth);
      const doc = build(paper.lines, claim);
      const counterpart = `OmniDet (ours) & ${Object.values(paper.values[paper.dataset]!["OmniDet (ours)"]!).join(" & ")}`;
      if (locateQuote(doc, counterpart)?.occurrences !== 1) continue;
      expect(certify(doc, claim, paper.truth, counterpart, paper.truth, "CONSISTENT").outcome).toBe("NOT_CERTIFIED");
    }
  });
});
