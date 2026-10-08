/**
 * M12.3 C5：确定性 figure 环境 emitter 与插入变换（figures/insertion.ts）测试。
 * - 环境字节稳定 + caption 全量转义（注入不可构造）；
 * - label 规范 / 派生 / 冲突消解；
 * - append（含 \ref 引用句的转义保留）；
 * - replace（只动目标环境区间，label/位置保持，区间外字节不变）；
 * - main.tex graphicx 幂等注入；
 * - findFigureEnvByLabel 单文件定位。
 */

import { describe, expect, it } from "vitest";

import {
  applyAppendInsertion,
  applyReplacement,
  deriveLabelBody,
  ensureGraphicxPreamble,
  findFigureEnvByLabel,
  normalizeLabelBody,
  renderFigureEnvironment,
  uniqueLabelBody,
} from "../../src/figures/insertion.js";

describe("renderFigureEnvironment", () => {
  it("字节稳定；路径恒为 figs/generated/<figId>.pdf；caption 转义", () => {
    const environment = renderFigureEnvironment({
      figId: "fig-abcdef123456",
      caption: "100% accuracy & $pecial #chars _ {braces} ~tilde ^caret \\input{x}",
      labelBody: "results",
    });
    expect(environment).toBe(
      [
        "\\begin{figure}[htbp]",
        "    \\centering",
        "    \\includegraphics[width=0.85\\textwidth]{figs/generated/fig-abcdef123456.pdf}",
        "    \\caption{100\\% accuracy \\& \\$pecial \\#chars \\_ \\{braces\\} \\textasciitilde{}tilde \\textasciicircum{}caret \\textbackslash{}input\\{x\\}}",
        "    \\label{fig:results}",
        "\\end{figure}",
      ].join("\n"),
    );
    // 确定性：同输入同输出
    expect(
      renderFigureEnvironment({ figId: "fig-abcdef123456", caption: "100% accuracy & $pecial #chars _ {braces} ~tilde ^caret \\input{x}", labelBody: "results" }),
    ).toBe(environment);
  });

  it("宽度白名单：非法宽度表达式回退默认；合法自定义保留", () => {
    const custom = renderFigureEnvironment({ figId: "fig-abcdef123456", caption: "c", labelBody: "l", widthExpression: "0.9\\textwidth" });
    expect(custom).toContain("width=0.9\\textwidth");
    const illegal = renderFigureEnvironment({ figId: "fig-abcdef123456", caption: "c", labelBody: "l", widthExpression: "1\\textwidth}\\input{/etc/passwd}" });
    expect(illegal).toContain("width=0.85\\textwidth");
    expect(illegal).not.toContain("etc/passwd");
  });
});

describe("label 处理", () => {
  it("normalizeLabelBody：fig: 前缀可选；非法字符拒绝", () => {
    expect(normalizeLabelBody("fig:results")).toBe("results");
    expect(normalizeLabelBody("results")).toBe("results");
    expect(normalizeLabelBody("fig:re sults")).toBeNull();
    expect(normalizeLabelBody("fig:results}{}")).toBeNull();
  });

  it("deriveLabelBody：ASCII 词优先，无词回退 figId", () => {
    expect(deriveLabelBody("HOTA convergence over epochs", "fig-abc123def456")).toBe("hota-convergence-over-epochs");
    expect(deriveLabelBody("整体架构图", "fig-abc123def456")).toBe("abc123def456");
  });

  it("uniqueLabelBody：冲突追加 -2/-3", () => {
    expect(uniqueLabelBody("results", new Set())).toBe("results");
    expect(uniqueLabelBody("results", new Set(["results"]))).toBe("results-2");
    expect(uniqueLabelBody("results", new Set(["results", "results-2"]))).toBe("results-3");
  });
});

describe("applyAppendInsertion", () => {
  it("末尾追加环境 + 引用句（文本转义、\\ref 原样保留）", () => {
    const environment = renderFigureEnvironment({ figId: "fig-abcdef123456", caption: "cap", labelBody: "arch" });
    const content = "\\section{Method}\nSome text.\n";
    const inserted = applyAppendInsertion(content, environment, "arch", "整体架构如图~\\ref{fig:arch} 所示（100% 端到端）。");
    expect(inserted.startsWith("\\section{Method}\nSome text.")).toBe(true);
    expect(inserted).toContain("\\begin{figure}[htbp]");
    expect(inserted).toContain("整体架构如图~\\ref{fig:arch} 所示（100\\% 端到端）。");
    expect(inserted.endsWith("\n")).toBe(true);
  });

  it("引用句缺 \\ref → 不追加（防御性）", () => {
    const environment = renderFigureEnvironment({ figId: "f", caption: "c", labelBody: "l" });
    const inserted = applyAppendInsertion("text\n", environment, "l", "no ref here");
    expect(inserted).not.toContain("no ref here");
  });
});

describe("applyReplacement", () => {
  const content = [
    "\\section{Results}",
    "",
    "\\begin{figure}[htbp]",
    "    \\centering",
    "    \\includegraphics[width=0.8\\textwidth]{figures/old-arch.pdf}",
    "    \\caption{Old caption.}",
    "    \\label{fig:architecture}",
    "\\end{figure}",
    "",
    "Trailing text stays.",
  ].join("\n");

  it("只替换目标环境区间：区间外字节不变、label 保持", () => {
    const target = findFigureEnvByLabel("sections/results.tex", content, "fig:architecture");
    expect(target).toEqual({ lineStart: 3, lineEnd: 8, label: "fig:architecture" });
    const environment = renderFigureEnvironment({ figId: "fig-newnewnewnew", caption: "New caption.", labelBody: "architecture" });
    const result = applyReplacement(content, target!, environment);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.previousPath).toBe("figures/old-arch.pdf");
    expect(result.replacedLabel).toBe("fig:architecture");
    expect(result.content).toContain("\\includegraphics[width=0.85\\textwidth]{figs/generated/fig-newnewnewnew.pdf}");
    expect(result.content).toContain("\\caption{New caption.}");
    expect(result.content).toContain("\\label{fig:architecture}");
    expect(result.content.startsWith("\\section{Results}")).toBe(true);
    expect(result.content.endsWith("Trailing text stays.\n")).toBe(true);
    // 旧资产路径不再出现
    expect(result.content).not.toContain("old-arch.pdf");
  });

  it("label 不存在 → label_not_found", () => {
    const result = applyReplacement(content, { lineStart: 3, lineEnd: 8, label: "fig:missing" }, "\\begin{figure}x\\end{figure}");
    expect(result).toEqual({ ok: false, reason: "label_not_found" });
  });
});

describe("ensureGraphicxPreamble", () => {
  it("无 graphicx → documentclass 后注入；已有 → 幂等不动", () => {
    const before = "\\documentclass[UTF8]{ctexart}\n\\usepackage{amsmath}\n\\begin{document}\n\\end{document}\n";
    const injected = ensureGraphicxPreamble(before);
    expect(injected.injected).toBe(true);
    expect(injected.content.split("\n")[1]).toBe("\\usepackage{graphicx}");
    const again = ensureGraphicxPreamble(injected.content);
    expect(again.injected).toBe(false);
    expect(again.content).toBe(injected.content);
    // 无 documentclass → 原样
    expect(ensureGraphicxPreamble("no class here").injected).toBe(false);
  });
});
