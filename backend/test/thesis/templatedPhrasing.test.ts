/**
 * M14.5 — 模板化表达扫描单元测试（真实案例 B：「本章首先……其次……最后……」）。
 */
import { describe, expect, it } from "vitest";

import { renderTemplatedPhrasingAdvice, scanTemplatedPhrasing } from "../../src/thesis/templatedPhrasing.js";

describe("scanTemplatedPhrasing", () => {
  it("enumerated_summary：总结语境下的首先/其次/最后", () => {
    const content = [
      "\\section{本章小结}",
      "本章首先介绍了下洗数据采集方案，其次设计了神经网络预测器，最后给出了预测结果。",
    ].join("\n");
    const { findings, summary } = scanTemplatedPhrasing([{ file: "ch03-summary.tex", content }]);
    expect(findings.map((finding) => finding.kind)).toEqual(["enumerated_summary"]);
    expect(findings[0]?.file).toBe("ch03-summary.tex");
    expect(findings[0]?.offset).toBe(content.indexOf("本章首先"));
    expect(summary.byKind).toEqual({ enumerated_summary: 1 });
  });

  it("不误报：单个首先/其次对、非总结语境的三段式", () => {
    const content = [
      "\\section{方法}",
      "首先对原始数据进行滤波，其次按时间对齐。",
      "",
      "为求解该问题，首先建立模型，其次线性化，最后离散化求解。",
    ].join("\n");
    expect(scanTemplatedPhrasing([{ file: "m.tex", content }]).findings).toEqual([]);
  });

  it("formulaic_transition：通过上述分析可以看出 一次即报；弱承接句需 ≥ 2 次且不含数字", () => {
    const content = [
      "\\section{结果分析}",
      "通过上述分析可以看出，该方法有效。",
      "",
      "不难看出，预测器收敛。由此可见，控制器稳定。",
    ].join("\n");
    const { findings } = scanTemplatedPhrasing([{ file: "r.tex", content }]);
    const kinds = findings.filter((finding) => finding.kind === "formulaic_transition");
    expect(kinds).toHaveLength(3);
    expect(kinds[0]?.excerpt).toBe("通过上述分析可以看出，该方法有效。");
  });

  it("不误报：含数字的结果句即使出现两次「可以看出，」也不报", () => {
    const content = "可以看出，误差下降 3.2\\%。可以看出，表 \\ref{tab:1} 中 RMSE 为 0.12 m。";
    expect(scanTemplatedPhrasing([{ file: "r.tex", content }]).findings).toEqual([]);
  });

  it("不误报：单次「由上述分析可知」", () => {
    const content = "由上述分析可知，模型满足约束。本节到此结束。";
    expect(scanTemplatedPhrasing([{ file: "r.tex", content }]).findings).toEqual([]);
  });

  it("repeated_opener：同段 ≥ 3 句连续以同一连接词开头", () => {
    const content = "此外，A 成立。此外，B 成立。此外，C 成立。";
    const { findings } = scanTemplatedPhrasing([{ file: "o.tex", content }]);
    expect(findings.map((finding) => finding.kind)).toEqual(["repeated_opener"]);
    expect(findings[0]?.detail).toContain("此外");
  });

  it("不误报：一两次此外 / 不同连接词交替", () => {
    const content = "此外，A 成立。然而，B 不成立。因此，C 成立。此外，D 成立。";
    expect(scanTemplatedPhrasing([{ file: "o.tex", content }]).findings).toEqual([]);
  });

  it("generic_summary：小结小节内无数字/引用、≤ 2 句、只复述", () => {
    const content = ["\\subsection{本章小结}", "本章介绍了控制器的设计过程。本章对所提方法进行了说明。"].join("\n");
    const { findings } = scanTemplatedPhrasing([{ file: "s.tex", content }]);
    expect(findings.map((finding) => finding.kind)).toEqual(["generic_summary"]);
  });

  it("不误报：小结含数字或 \\ref；非小结标题下的复述段", () => {
    const withNumber = ["\\subsection{本章小结}", "本章介绍了控制器设计，跟踪误差降至 0.12 m。"].join("\n");
    const noHeading = "本章介绍了控制器的设计过程。";
    expect(scanTemplatedPhrasing([{ file: "a.tex", content: withNumber }]).findings).toEqual([]);
    expect(scanTemplatedPhrasing([{ file: "b.tex", content: noHeading }]).findings).toEqual([]);
  });

  it("跳过 table/figure 环境与注释行；summary 统计文件数", () => {
    const content = [
      "% 此外，注释。此外，注释。此外，注释。",
      "\\begin{table}",
      "\\caption{此外，A。此外，B。此外，C。}",
      "\\end{table}",
      "正常段落。",
    ].join("\n");
    const result = scanTemplatedPhrasing([
      { file: "t.tex", content },
      { file: "u.tex", content: "另一段。" },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ files: 2, findings: 0, byKind: {} });
  });
});

describe("renderTemplatedPhrasingAdvice", () => {
  it("无发现返回空；有发现时 ≤ 8 行、锚定文件与摘录、声明不改数值", () => {
    expect(renderTemplatedPhrasingAdvice([])).toEqual([]);
    const findings = Array.from({ length: 10 }, (_, index) => ({
      file: `f${index}.tex`,
      kind: "formulaic_transition" as const,
      excerpt: `通过上述分析可以看出，第 ${index} 处。`,
      offset: index,
      detail: "公式化承接",
    }));
    const lines = renderTemplatedPhrasingAdvice(findings);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines[0]).toContain("[f0.tex]");
    expect(lines[0]).toContain("通过上述分析可以看出");
    expect(lines.at(-1)).toContain("另有 3 处");
    expect(lines.at(-1)).toMatch(/保留全部数值/);
    for (const line of lines) expect([...line.match(/「[^」]*」/)?.[0] ?? ""].length).toBeLessThanOrEqual(62);
  });
});
