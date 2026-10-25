/**
 * M15.6 阶段 B 测试：跨节数值一致性（摘要/结论 ↔ 结果表）。
 *
 * 覆盖预登记状态表（PRE_REGISTERED_PROTOCOL.md §1）的跨节分支：
 *  - VERIFIED_CONTRADICTION：唯一绑定 + DISJOINT + 跨表疑义消解（CE1 注入形态）
 *  - SUSPECTED_ISSUE：唯一绑定 + DISJOINT 但值在其他表存在可信参照格
 *  - CONSISTENT：唯一绑定 + OVERLAP
 *  - NOT_EVALUATED：聚合措辞 / 整数 / 绑定不唯一 / 约数 / 不等式 / 派生量不可复算
 *  - 增量（差值名词）修复回归：f1 结论「延迟增量为 594.1 ms(65.9%)」不得按原子值误判矛盾
 *  - 反例保护：干净论文（摘要数值与表一致）零矛盾签发
 */

import { describe, expect, it } from "vitest";
import { atomQualifiers, textScopes } from "../../src/review/claimCertificate.js";
import { computeCrossSectionConsistency, locateCoreSections } from "../../src/review/crossSectionConsistency.js";

const TABLE_MOT17 = `
\\begin{table}[t]
\\caption{State-of-the-art results on the MOT17 test set.}
\\label{tab:mot17}
\\begin{tabular}{lcccc}
Tracker & HOTA$\\uparrow$ & MOTA$\\uparrow$ & IDF1$\\uparrow$ & IDs$\\downarrow$ \\\\
\\hline
ByteTrack & 63.1 & 77.3 & 76.6 & 2,056 \\\\
\\rowcolor{babyblue!20}OC-SORT & \\textbf{63.2} & 78.0 & \\textbf{77.5} & 1,950 \\\\
\\end{tabular}
\\end{table}
`;

const TABLE_MOT20 = `
\\begin{table}[t]
\\caption{State-of-the-art results on the MOT20 test set.}
\\label{tab:mot20}
\\begin{tabular}{lcccc}
Tracker & HOTA$\\uparrow$ & MOTA$\\uparrow$ & IDF1$\\uparrow$ & IDs$\\downarrow$ \\\\
\\hline
ByteTrack & 60.3 & 73.8 & 74.7 & 2,762 \\\\
\\rowcolor{babyblue!20}OC-SORT & \\textbf{62.1} & 75.5 & \\textbf{75.9} & 913 \\\\
\\end{tabular}
\\end{table}
`;

/** 含 65.9（GPR 消融行，DanceTrack 语境）的第三张表——CE1 注入值的跨表陷阱 */
const TABLE_ABLATION = `
\\begin{table}[t]
\\caption{Ablation of interpolation on the DanceTrack test set.}
\\label{tab:ablation-dt}
\\begin{tabular}{lcc}
Interpolation & HOTA$\\uparrow$ & MOTA$\\uparrow$ \\\\
\\hline
Linear & 47.1 & 72.4 \\\\
GPR Interp & 65.9 & 74.2 \\\\
\\end{tabular}
\\end{table}
`;

function paper(abstractLast: string, extraTables = TABLE_MOT20 + TABLE_ABLATION): string {
  return `\\documentclass{article}
\\usepackage{colortbl}
\\title{Observation-Centric SORT for Multi-Object Tracking}
\\begin{document}
\\begin{abstract}
We present OC-SORT, a simple and online tracker that fixes the error accumulation of Kalman filters during occlusion. ${abstractLast}
\\end{abstract}
\\section{Introduction}
OC-SORT rethinks the limitation of SORT. Given off-the-shelf detections, OC-SORT runs at 700+ FPS on a single CPU.
\\section{Experiments}
We compare with state-of-the-art trackers on MOT17 and MOT20. ${TABLE_MOT17}${extraTables}
\\section{Conclusion}
In this work we presented OC-SORT. It achieves state-of-the-art performance on multiple benchmarks.
\\end{document}
`;
}

describe("M15.6 跨节数值一致性（crossSectionConsistency）", () => {
  it("CE1 注入形态：摘要 HOTA 与唯一绑定表格 DISJOINT + 值仅出现在无关行 → VERIFIED_CONTRADICTION", () => {
    const content = paper(
      "On MOT17, OC-SORT achieves a HOTA of 65.9.",
    );
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.status).toBe("EVALUATED");
    const contradictions = result.witnesses.filter((w) => w.outcome === "VERIFIED_CONTRADICTION");
    expect(contradictions.length).toBe(1);
    expect(contradictions[0]!.raw).toBe("65.9");
    expect(contradictions[0]!.binding?.bound?.value).toBe("63.2");
    expect(contradictions[0]!.doubtResolution?.resolved).toBe(true);
    // 值 65.9 在 GPR 消融表出现，但行（GPR Interp）未被论断点名 → 疑义消解
    expect(contradictions[0]!.doubtResolution?.competitors).toBeGreaterThan(0);
    expect(contradictions[0]!.doubtResolution?.plausible).toBe(0);
    expect(result.counts.verifiedContradictions).toBe(1);
  });

  it("反例保护：摘要数值与表格一致（63.2）→ CONSISTENT，零矛盾签发", () => {
    const content = paper("On MOT17, OC-SORT achieves a HOTA of 63.2.");
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    expect(result.counts.suspected).toBe(0);
    expect(result.counts.consistent).toBe(1);
    const consistent = result.witnesses.find((w) => w.outcome === "CONSISTENT");
    expect(consistent?.reasonCodes).toContain("UNIQUE_BINDING_OVERLAP");
  });

  it("跨表疑义未消解：摘要值 DISJOINT 但值在另一表的同指标+被点名行 → SUSPECTED_ISSUE（不出强判）", () => {
    // 摘要说 61.5：与 MOT17 表 OC-SORT 行（63.2）DISJOINT；61.5 出现在 MOT20 表 OC-SORT 行（同指标 HOTA、行被点名）
    // paper() 已内含 TABLE_MOT17，这里只追加含 61.5 的第二张表
    const tables = `
\\begin{table}[t]
\\caption{Results on the MOT20 test set.}
\\label{tab:mot20}
\\begin{tabular}{lcc}
Tracker & HOTA$\\uparrow$ & MOTA$\\uparrow$ \\\\
\\hline
\\rowcolor{babyblue!20}OC-SORT & 61.5 & 75.5 \\\\
\\end{tabular}
\\end{table}
`;
    const content = paper("On MOT17, OC-SORT achieves a HOTA of 61.5.", tables);
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    expect(result.counts.suspected).toBe(1);
    const suspected = result.witnesses.find((w) => w.outcome === "SUSPECTED_ISSUE");
    expect(suspected?.doubtResolution?.plausible).toBeGreaterThan(0);
    expect(suspected?.doubtResolution?.resolved).toBe(false);
  });

  it("聚合措辞守卫：average/平均 → NOT_EVALUATED（聚合口径不可证可比；共享 AGGREGATE 限定或本地守卫任一命中即可）", () => {
    const content = paper("OC-SORT obtains an average HOTA of 55.5 across all benchmarks.");
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    expect(result.counts.suspected).toBe(0);
    expect(result.counts.consistent).toBe(0);
    expect(result.counts.notEvaluated).toBe(1);
    // 「across all benchmarks」由共享 AGGREGATE 限定捕获（派生路径）或本地聚合守卫命中——两者都不得签发矛盾
    expect(
      result.notEvaluatedReasons["AGGREGATE_WORDING"] === 1 ||
      result.notEvaluatedReasons["DERIVED_NOT_CERTIFIABLE"] === 1,
    ).toBe(true);
  });

  it("整数不进矛盾判定（计数 / FPS）", () => {
    const content = paper("OC-SORT runs at 700 FPS on a single CPU.");
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    expect(result.counts.skippedInteger).toBe(1);
  });

  it("约数 / 不等式限定 → NOT_EVALUATED（不出强判）", () => {
    const approx = paper("On MOT17, OC-SORT achieves a HOTA of approximately 65.9.");
    const ineq = paper("On MOT17, OC-SORT achieves a HOTA of more than 63.2.");
    for (const content of [approx, ineq]) {
      const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
      expect(result.counts.verifiedContradictions).toBe(0);
      expect(result.counts.suspected).toBe(0);
      expect(result.counts.notEvaluated).toBe(1);
    }
  });

  it("f1 增量回归：结论「延迟增量为 594.1 ms(65.9%)」不得按原子值绑定出矛盾（差值名词 = 派生量）", () => {
    // 直接验证共享限定词机制：增量为 → DERIVED；（65.9%）继承派生语义（为守卫只看最后数值之后片段）
    const sentence = "相对 ByteTrack 式基线的端到端延迟增量为 594.1 ms(65.9%),增量主要来自当前参数量。";
    const at594 = sentence.indexOf("594.1");
    const at659 = sentence.indexOf("65.9");
    const scopes594 = textScopes(sentence, at594, at594 + 5);
    const scopes659 = textScopes(sentence, at659, at659 + 4);
    expect(atomQualifiers(scopes594, "594.1")).toContain("DERIVED");
    expect(atomQualifiers(scopes659, "65.9")).toContain("DERIVED");
    // 端到端文档级：含该句的结论 + 延迟表不得产生 verified contradiction
    const content = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
本文部署 MRG-DTM 至边缘平台。
\\end{abstract}
\\section{实验}
\\begin{table}[t]
\\caption{端到端延迟对比（RDK X3）。}
\\label{tab:latency}
\\begin{tabular}{lcc}
方法 & 输入分辨率 & E2E 延迟(ms) \\\\
\\hline
ByteTrack 基线 & 1280 768 & 901.54 \\\\
本文完整链路 & 1280 768 & 1495.64 \\\\
\\end{tabular}
\\end{table}
\\section{结论}
本文将完整算法链路部署至 RDK X3:相对 ByteTrack 式基线的端到端延迟增量为 594.1 ms(65.9%),增量主要来自当前参数量。
\\end{document}
`;
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    const notEvaluated = result.witnesses.filter((w) => w.raw === "594.1" || w.raw === "65.9");
    expect(notEvaluated.every((w) => w.outcome === "NOT_EVALUATED")).toBe(true);
    expect(notEvaluated.some((w) => w.reasonCodes.some((code) => code.startsWith("DERIVED")))).toBe(true);
  });

  it("结论节检测 + 摘要环境变体（cnabstract）", () => {
    const content = `\\documentclass{article}
\\begin{document}
\\begin{cnabstract}
本文方法在 MOT17 上取得 63.2 的 HOTA。
\\end{cnabstract}
\\section{实验}
${TABLE_MOT17}
\\section{结论}
实验表明,OC-SORT 在 MOT17 上达到 63.2 HOTA,优于先前方法。
\\end{document}
`;
    const sections = locateCoreSections([{ file: "main.tex", content }]);
    expect(sections.map((section) => section.kind).sort()).toEqual(["abstract", "conclusion"]);
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(result.counts.verifiedContradictions).toBe(0);
    expect(result.counts.consistent).toBeGreaterThanOrEqual(1);
  });

  it("无表格 / 无核心节 → UNAVAILABLE（fail-closed，不签发任何判定）", () => {
    expect(computeCrossSectionConsistency({ files: [] }).status).toBe("UNAVAILABLE");
    const noTables = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
We present a method achieving 63.2 HOTA.
\\end{abstract}
\\section{Conclusion}
Done.
\\end{document}
`;
    const result = computeCrossSectionConsistency({ files: [{ file: "main.tex", content: noTables }] });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.unavailableReason).toBe("NO_TABLES");
  });

  it("多文件项目：摘要与表格分处不同文件仍可绑定", () => {
    const main = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
On MOT17, OC-SORT achieves a HOTA of 65.9.
\\end{abstract}
\\input{results}
\\section{Conclusion}
Done.
\\end{document}
`;
    const result = computeCrossSectionConsistency({
      files: [
        { file: "main.tex", content: main },
        { file: "results.tex", content: `\\section{Experiments}\n${TABLE_MOT17}` },
      ],
    });
    expect(result.counts.verifiedContradictions).toBe(1);
    expect(result.witnesses.find((w) => w.outcome === "VERIFIED_CONTRADICTION")?.binding?.bound?.file).toBe("results.tex");
  });

  it("同一输入恒得同一结果（inputsSha256 稳定，无时间字段）", () => {
    const content = paper("On MOT17, OC-SORT achieves a HOTA of 65.9.");
    const a = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    const b = computeCrossSectionConsistency({ files: [{ file: "main.tex", content }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
