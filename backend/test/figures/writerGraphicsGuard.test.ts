/**
 * M12.3 C5/C6：Writer 图形输出守卫（figures/writerGraphicsGuard.ts）测试。
 * 边界语义：tikz/pgfplots 恒禁；\includegraphics 集合与基线一致（不增不删）；
 * 全新章节不允许任何 \includegraphics；\ref{fig:...} 恒合法。
 */

import { describe, expect, it } from "vitest";

import { screenWriterGraphics } from "../../src/figures/writerGraphicsGuard.js";

describe("screenWriterGraphics", () => {
  it("干净文本 → null", () => {
    expect(screenWriterGraphics({ output: "\\section{Method}\n我们提出方法 X，如 \\ref{fig:arch} 所示。" })).toBeNull();
  });

  it("tikzpicture / axis 环境 → 拒绝", () => {
    expect(
      screenWriterGraphics({ output: "\\begin{tikzpicture}\\node {x};\\end{tikzpicture}" }),
    ).toContain("tikz/pgfplots");
    expect(screenWriterGraphics({ output: "\\begin{axis}..." })).toContain("tikz/pgfplots");
  });

  it("\\usepackage 图形宏包 → 拒绝（含带选项形态）", () => {
    expect(screenWriterGraphics({ output: "\\usepackage{tikz}" })).toContain("宏包");
    expect(screenWriterGraphics({ output: "\\usepackage[compat=1.18]{pgfplots}" })).toContain("宏包");
  });

  it("全新章节输出 \\includegraphics → 拒绝", () => {
    const violation = screenWriterGraphics({
      output: "\\begin{figure}\\includegraphics{figs/generated/fig-abc.pdf}\\end{figure}",
    });
    expect(violation).toContain("不允许出现 \\includegraphics");
  });

  it("修订保留基线 includegraphics（路径集合一致）→ null", () => {
    const baseline = [
      "\\begin{figure}[htbp]",
      "  \\includegraphics[width=0.85\\textwidth]{figs/generated/fig-abcdef123456.pdf}",
      "  \\caption{收敛曲线。}",
      "  \\label{fig:hota-convergence}",
      "\\end{figure}",
      "如图~\\ref{fig:hota-convergence} 所示，方法收敛。",
    ].join("\n");
    // 措辞改写（caption 文本变化），资产行原样保留
    const output = baseline.replace("收敛曲线。", "训练收敛曲线（三种子平均）。");
    expect(screenWriterGraphics({ output, baseline })).toBeNull();
  });

  it("修订新增 includegraphics → 拒绝（含路径）", () => {
    const baseline = "正文无图。\n";
    const output =
      "正文。\n\\includegraphics{figs/generated/fig-abcdef123456.pdf}\n";
    const violation = screenWriterGraphics({ output, baseline });
    expect(violation).toContain("新增了 \\includegraphics");
    expect(violation).toContain("fig-abcdef123456.pdf");
  });

  it("修订删除 includegraphics → 拒绝（破坏已插入资产）", () => {
    const baseline = "\\includegraphics[width=0.5\\textwidth]{figs/generated/fig-abcdef123456.pdf}\n正文。\n";
    const output = "正文。\n";
    const violation = screenWriterGraphics({ output, baseline });
    expect(violation).toContain("删除了 \\includegraphics");
  });

  it("修订改写路径（同数量不同路径）→ 拒绝", () => {
    const baseline = "\\includegraphics{figs/generated/fig-abcdef123456.pdf}\n";
    const output = "\\includegraphics{figures/my-plot.pdf}\n";
    expect(screenWriterGraphics({ output, baseline })).toContain("新增了 \\includegraphics");
  });
});
