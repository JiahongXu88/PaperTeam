import { describe, expect, it } from "vitest";

import { buildReviewCoveragePlan } from "../../src/review/coverageLedger.js";
import { FRONT_MATTER_SECTION, applyRevisionSpan, locateLatexSections } from "../../src/review/revisionScope.js";
import { isHeadingOnlyUnit } from "../../src/workflow/definitions.js";

/**
 * M14.8-MOT 真实单文件期刊稿件暴露的覆盖盲区：
 * - `\begin{document}\maketitle` 与第一个 `\section` 之间的中英文摘要 / 关键词不属于任何
 *   span → 不被审阅也不可修订，覆盖率仍报 100%；
 * - 最后一节吞并整个内联参考文献（thebibliography）；
 * - 父章节标题紧跟子章节的「标题单元」每轮各耗一次模型调用。
 */

const TEX = [
  String.raw`\documentclass{ctexart}`,
  String.raw`\title{车辆跟踪}\author{作者}`,
  String.raw`\begin{document}`,
  String.raw`\maketitle`,
  "",
  String.raw`\begin{abstract}`,
  "本文提出事件级诊断，官方整段协议上 IDSW 由 700 降至 497，并给出统计检验与负结果。",
  String.raw`\end{abstract}`,
  String.raw`\keywords{多目标跟踪；身份切换}`,
  "",
  String.raw`\section{引言}\label{sec:intro}`,
  "引言正文。",
  "",
  String.raw`\section{实验}\label{sec:exp}`,
  String.raw`\subsection{主结果}`,
  "主结果正文。",
  "",
  String.raw`\section{结论}\label{sec:conclusion}`,
  "结论正文。",
  "",
  String.raw`\begin{thebibliography}{9}`,
  String.raw`\bibitem{A} Wen L. UA-DETRAC[J]. CVIU, 2020.`,
  String.raw`\end{thebibliography}`,
  String.raw`\end{document}`,
  "",
].join("\n");

describe("locateLatexSections：单文件稿件的前置部分与参考文献边界", () => {
  const spans = locateLatexSections("main.tex", TEX);

  it("摘要 / 关键词成为首个 span（不含导言区、\\title/\\author 与 \\maketitle）", () => {
    expect(spans[0]?.logicalSection).toBe(FRONT_MATTER_SECTION);
    const front = spans[0]!.content;
    expect(front).toContain("IDSW 由 700 降至 497");
    expect(front).toContain("\\keywords{");
    expect(front).not.toContain("\\maketitle");
    expect(front).not.toContain("\\author");
    expect(front).not.toContain("\\section");
  });

  it("最后一节止于 \\begin{thebibliography}；其余章节 id 不变", () => {
    expect(spans.map((span) => span.logicalSection)).toEqual([FRONT_MATTER_SECTION, "sec:intro", "sec:exp", "subsection:主结果", "sec:conclusion"]);
    const last = spans[spans.length - 1]!;
    expect(last.content).toContain("结论正文");
    expect(last.content).not.toContain("thebibliography");
    expect(last.content).not.toContain("\\bibitem");
  });

  it("前置 span 可被 applyRevisionSpan 原地修订（摘要可修订）", () => {
    const front = spans[0]!;
    const revised = applyRevisionSpan(TEX, front, front.content.replace("并给出统计检验与负结果", "并报告统计检验、负结果与适用边界"));
    expect(revised).toContain("并报告统计检验、负结果与适用边界");
    expect(revised).toContain("\\maketitle");
    expect(locateLatexSections("main.tex", revised).map((span) => span.logicalSection)).toEqual(spans.map((span) => span.logicalSection));
  });

  it("无 \\begin{document} 的章节文件 / 前置区只有命令时不生成前置 span", () => {
    expect(locateLatexSections("sections/a.tex", String.raw`\section{A}正文`)[0]?.logicalSection).toBe("section:A");
    const onlyCommands = String.raw`\documentclass{article}\begin{document}
\maketitle
\input{sections/abstract}
\section{A}正文`;
    expect(locateLatexSections("main.tex", onlyCommands).map((span) => span.logicalSection)).toEqual(["section:A"]);
  });

  it("覆盖计划把摘要计入审阅单元", () => {
    const plan = buildReviewCoveragePlan([{ file: "main.tex", content: TEX }], 9000);
    expect(plan.units[0]?.unitId).toBe(`main.tex::${FRONT_MATTER_SECTION}`);
  });
});

describe("isHeadingOnlyUnit", () => {
  it("只有章节命令 / label / 注释 → true；有正文 → false", () => {
    expect(isHeadingOnlyUnit(String.raw`\section{实验}\label{sec:exp}` + "\n")).toBe(true);
    expect(isHeadingOnlyUnit(String.raw`\section*{附录}` + "\n% 注释\n")).toBe(true);
    expect(isHeadingOnlyUnit(String.raw`\subsection{主结果}` + "\n主结果正文。")).toBe(false);
    expect(isHeadingOnlyUnit(String.raw`\section{A}\begin{table}x\end{table}`)).toBe(false);
  });
});
