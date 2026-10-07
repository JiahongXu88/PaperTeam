import { describe, expect, it } from "vitest";

import { formatNumber, renderPlotTeX } from "../../src/figures/pgfplotsCodeGen.js";
import { computeDatasetHash, validatePlotSpec } from "../../src/figures/spec.js";

/**
 * C2 pgfplots codegen golden 测试。
 *
 * golden 方式选择：**显式 golden 字符串断言**（而非 vitest toMatchSnapshot）。
 * 理由：快照会在「重跑 -U」时静默接受任何变化，模板漂移（比如某天顺手改了
 * 选项顺序/数值格式化）会被快照更新掩盖；显式字符串让 TeX 输出成为可在
 * PR 里逐行评审的契约。关键行 + 少量整文档 golden 双层断言。
 */

function compilePlotTeX(rawSpec: Record<string, unknown>): string {
  const result = validatePlotSpec(rawSpec);
  if (!result.ok || result.spec === undefined) {
    throw new Error(`spec 应合法：${result.errors.join("；")}`);
  }
  return renderPlotTeX(result.spec);
}

function plotSpec(parts: {
  plotType?: string;
  dataset?: { columns: string[]; rows: (number | string | null)[][] };
  series?: Array<{ name: string; column: string }>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const dataset =
    parts.dataset ?? {
      columns: ["x", "ours", "baseline"],
      rows: [
        [1, 3.5, 2.1],
        [2, 4.25, 2.8],
        [3, 5.5, 3.9],
      ],
    };
  return {
    plotType: parts.plotType ?? "line",
    data: {
      origin: { sourceId: "S001" },
      datasetHash: computeDatasetHash(dataset),
      x: [dataset.columns[0] ?? "x"],
      series: parts.series ?? [
        { name: "Ours", column: "ours" },
        { name: "Baseline", column: "baseline" },
      ],
      inlineDataset: dataset,
    },
    axis: {},
    ...(parts.extra ?? {}),
  };
}

describe("formatNumber（确定性数值格式化）", () => {
  it("二进制浮点噪声被规整（0.1+0.2 → 0.3）", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.3333333333");
  });

  it("整数定点输出；尾零剥除；无科学计数法；-0 规整", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(-7)).toBe("-7");
    expect(formatNumber(2.5)).toBe("2.5");
    expect(formatNumber(1.5e-13)).toBe("0");
    expect(formatNumber(-1.5e-13)).toBe("0");
    expect(formatNumber(1e21)).toBe("1000000000000000000000");
  });

  it("非有限数值抛错（防御深度）", () => {
    expect(() => formatNumber(Number.NaN)).toThrow();
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("renderPlotTeX", () => {
  it("line：整文档 golden（骨架钉死 + 坐标块 + legend）", () => {
    const tex = compilePlotTeX(plotSpec({}));
    expect(tex).toBe(
      [
        "\\documentclass[border=2pt]{standalone}",
        "\\usepackage{pgfplots}",
        "\\pgfplotsset{compat=1.18}",
        "\\begin{document}",
        "\\begin{tikzpicture}",
        "\\begin{axis}[",
        "  width=12cm,",
        "  height=8cm",
        "]",
        "\\addplot+[thick, mark=*, mark size=1.5pt] coordinates {",
        "  (1, 3.5)",
        "  (2, 4.25)",
        "  (3, 5.5)",
        "};",
        "\\addplot+[thick, mark=*, mark size=1.5pt] coordinates {",
        "  (1, 2.1)",
        "  (2, 2.8)",
        "  (3, 3.9)",
        "};",
        "\\legend{{Ours},{Baseline}}",
        "\\end{axis}",
        "\\end{tikzpicture}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
  });

  it("line：行序扰动 → 坐标按 x 升序规范化（字节级同输出）", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [3, 30],
        [1, 10],
        [2, 20],
      ],
    };
    const shuffled = compilePlotTeX(
      plotSpec({ dataset, series: [{ name: "Y", column: "y" }] }),
    );
    const sorted = compilePlotTeX(
      plotSpec({
        dataset: {
          columns: ["x", "y"],
          rows: [
            [1, 10],
            [2, 20],
            [3, 30],
          ],
        },
        series: [{ name: "Y", column: "y" }],
      }),
    );
    expect(shuffled).toBe(sorted);
    expect(shuffled).toContain("(1, 10)");
    expect(shuffled.indexOf("(1, 10)")).toBeLessThan(shuffled.indexOf("(3, 30)"));
  });

  it("bar：类目轴用行索引 + xticklabels（含特殊字符的类目安全转义）", () => {
    const tex = compilePlotTeX(
      plotSpec({
        plotType: "bar",
        dataset: {
          columns: ["clip", "ids"],
          rows: [
            ["MVI_40714", 35],
            ["MVI_40763", 41],
            ["A,B & 100%", 27],
          ],
        },
        series: [{ name: "IDS", column: "ids" }],
      }),
    );
    expect(tex).toContain("ybar,");
    expect(tex).toContain("xtick=data,");
    expect(tex).toContain("xticklabels={{MVI\\_40714},{MVI\\_40763},{A,B \\& 100\\%}}");
    expect(tex).toContain("(0, 35)");
    expect(tex).toContain("(1, 41)");
    expect(tex).toContain("(2, 27)");
    // 单系列默认无 legend
    expect(tex).not.toContain("\\legend");
  });

  it("grouped_bar：多系列共享类目轴 + legend 按声明序", () => {
    const tex = compilePlotTeX(
      plotSpec({
        plotType: "grouped_bar",
        dataset: {
          columns: ["method", "ids", "frag"],
          rows: [
            ["IoU", 73, 284],
            ["Ours", 61, 210],
          ],
        },
        series: [
          { name: "IDSW ↓", column: "ids" },
          { name: "Frag", column: "frag" },
        ],
      }),
    );
    expect(tex).toContain("ybar,");
    // ↓ 不是 LaTeX 特殊字符，原样保留（xelatex UTF-8 原生）
    expect(tex).toContain("\\legend{{IDSW ↓},{Frag}}");
    expect(tex.match(/\\addplot\+ coordinates \{/g)).toHaveLength(2);
  });

  it("scatter：only marks + mark size 来自 renderOptions", () => {
    const tex = compilePlotTeX(
      plotSpec({
        plotType: "scatter",
        series: [{ name: "Y", column: "y" }],
        dataset: { columns: ["x", "y"], rows: [[1, 2], [2, 1]] },
        extra: { axis: { renderOptions: { markSizePt: 2.5, widthCm: 10, heightCm: 6 } } },
      }),
    );
    expect(tex).toContain("\\addplot+[only marks, mark=*, mark size=2.5pt] coordinates {");
    expect(tex).toContain("width=10cm");
    expect(tex).toContain("height=6cm");
  });

  it("skip_row 策略：null 行确实不进坐标块（不静默填 0）", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [1, 10],
        [2, null],
        [3, 30],
      ],
    };
    const tex = compilePlotTeX({
      plotType: "line",
      data: {
        origin: { sourceId: "S001" },
        datasetHash: computeDatasetHash(dataset),
        x: ["x"],
        series: [{ name: "Y", column: "y" }],
        missingPolicy: "skip_row",
        inlineDataset: dataset,
      },
      axis: {},
    });
    expect(tex.match(/\(\d+, \d+(\.\d+)?\)/g)).toEqual(["(1, 10)", "(3, 30)"]);
  });

  it("注入安全：恶意 TeX 输入全部转义为无害文本", () => {
    const tex = compilePlotTeX(
      plotSpec({
        series: [
          { name: "Ours", column: "ours" },
          { name: "Baseline", column: "baseline" },
        ],
        extra: {
          title: "\\input{/etc/passwd} 100%",
          caption: "\\write18{rm -rf}",
          axis: { xLabel: "$x^2$", yLabel: "&_#{}~\\" },
        },
      }),
    );
    expect(tex).toContain("title={\\textbackslash{}input\\{/etc/passwd\\} 100\\%}");
    expect(tex).toContain("xlabel={\\$x\\textasciicircum{}2\\$}");
    expect(tex).toContain("ylabel={\\&\\_\\#\\{\\}\\textasciitilde{}\\textbackslash{}}");
    // caption 不进 TeX（候选文本，只在 record 里）
    expect(tex).not.toContain("write18");
    // 不存在任何未转义的原始 TeX 控制序列进入输出
    expect(tex).not.toMatch(/[^\\}a-z]\\input\{/);
    expect(tex).not.toMatch(/[^\\}a-z]\\write18\{/);
  });

  it("确定性：同 spec 两次渲染字节级一致；semantic 元数据不影响输出", () => {
    const spec = plotSpec({});
    expect(compilePlotTeX(spec)).toBe(compilePlotTeX(JSON.parse(JSON.stringify(spec))));
    const withSemantic = { ...plotSpec({}), semantic: "benchmark_comparison" };
    expect(compilePlotTeX(withSemantic)).toBe(compilePlotTeX(plotSpec({})));
  });

  it("数值列的浮点噪声在坐标里被规整", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [0.1, 0.1 + 0.2],
        [0.2, 0.30000000000000004],
      ],
    };
    const tex = compilePlotTeX(
      plotSpec({ plotType: "scatter", dataset, series: [{ name: "Y", column: "y" }] }),
    );
    expect(tex).toContain("(0.1, 0.3)");
    expect(tex).toContain("(0.2, 0.3)");
    expect(tex).not.toContain("0.30000000000000004");
  });
});
