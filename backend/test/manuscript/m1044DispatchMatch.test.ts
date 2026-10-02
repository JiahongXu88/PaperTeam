/**
 * M10.4.4 Finding Dispatch Coverage 单测：
 *
 * Cases A–F（任务规格）+ 真实形态回归（M10.4.2 A1-attempt1 r2 的 heading 式
 * 引用集）。语义锚 = 真实 sectionMatches（definitions.ts 导出）+ latexHeadings
 * 纯函数；数据锚 = 冻结论文 paper.tex 的真实标题形态（含跨行 \mbox{-} 标题）。
 */

import { describe, expect, it } from "vitest";

import {
  extractLatexHeadings,
  latexContainsAbstract,
  normalizeHeadingTitle,
  sectionRefNamesHeading,
} from "../../src/manuscript/latexHeadings.js";
import { itemTouchesFile } from "../../src/review/revisionValidation.js";
import { sectionMatches, type RevisionTarget } from "../../src/workflow/definitions.js";

/** 单文件项目唯一目标（M10.3 真实形态） */
function singleFileTarget(latex: string): RevisionTarget {
  return { key: "main.tex", relativePath: "main.tex", currentLatex: latex };
}

const SINGLE_FILE_PAPER = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\begin{abstract}",
  "摘要内容。",
  "\\end{abstract}",
  "",
  "\\section{引言}",
  "引言正文。",
  "",
  "\\section{方法}",
  "\\subsection{总体框架}",
  "框架正文。",
  "\\subsection{轨迹稳定性自适应损失}",
  "损失正文。",
  "\\subsection{实验设置}",
  "设置正文 A。",
  "\\subsection{实验设置}",
  "设置正文 B（同名小节第二处）。",
  "",
  "\\section{结论}",
  "结论正文。",
  "\\end{document}",
].join("\n");

describe("extractLatexHeadings / normalizeHeadingTitle", () => {
  it("提取 \\section/\\subsection/\\subsubsection（含 starred）并保持文档序", () => {
    const latex = "\\section{A}\n\\subsection*{B}\n\\subsubsection{C}\n\\paragraph{D}\n\\section{E}";
    expect(extractLatexHeadings(latex)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("嵌套花括号与跨行标题（真实论文 MRG\\mbox{-}DTM 形态）完整提取", () => {
    const latex = "\\subsection{运动残差门控动态模板记忆 MRG\\mbox{-}\nDTM 的消融}";
    expect(extractLatexHeadings(latex)).toEqual(["运动残差门控动态模板记忆 MRG\\mbox{-}\nDTM 的消融"]);
    expect(normalizeHeadingTitle(extractLatexHeadings(latex)[0] ?? "")).toBe(
      "运动残差门控动态模板记忆mrg-dtm的消融",
    );
  });

  it("花括号不闭合的候选被丢弃（防御 malformed 输入）", () => {
    expect(extractLatexHeadings("\\section{未闭合")).toEqual([]);
  });

  it("归一化：命令删除 / 连接号统一 / 去空白 / 小写", () => {
    expect(normalizeHeadingTitle(" UA–DETRAC 数据集 ")).toBe("ua-detrac数据集");
    expect(normalizeHeadingTitle("总损失函数与训练策略")).toBe("总损失函数与训练策略");
  });
});

describe("sectionRefNamesHeading（heading 匹配层）", () => {
  const headings = extractLatexHeadings(SINGLE_FILE_PAPER);

  it("精确段匹配：父/子、中点、编号+标题、括号注释、并列连词", () => {
    expect(sectionRefNamesHeading("轨迹稳定性自适应损失", headings)).toBe(true);
    expect(sectionRefNamesHeading("方法/轨迹稳定性自适应损失", headings)).toBe(true);
    expect(sectionRefNamesHeading("方法 · 轨迹稳定性自适应损失", headings)).toBe(true);
    expect(sectionRefNamesHeading("方法/2.2 轨迹稳定性自适应损失", headings)).toBe(true);
    expect(sectionRefNamesHeading("轨迹稳定性自适应损失（末段）", headings)).toBe(true);
    expect(sectionRefNamesHeading("讨论与局限性 及 结论", headings)).toBe(true); // 段「结论」命中（部分引用真实存在）
    expect(sectionRefNamesHeading("相关工作 及 未来展望", headings)).toBe(false); // 无任何段命中
    expect(sectionRefNamesHeading("总体框架 与 轨迹稳定性自适应损失", headings)).toBe(true);
  });

  it("子串兜底：标题 ⊆ 引用（跨节引用「摘要与方法节（跨节）」类）", () => {
    expect(sectionRefNamesHeading("引言贡献段落与表述", headings)).toBe(true); // 引言 ⊆ 引用
  });

  it("哨兵与无法可靠匹配的引用不伪造命中", () => {
    expect(sectionRefNamesHeading("(global)", headings)).toBe(false);
    expect(sectionRefNamesHeading("(unknown)", headings)).toBe(false);
    expect(sectionRefNamesHeading("(external)", headings)).toBe(false);
    expect(sectionRefNamesHeading("", headings)).toBe(false);
    expect(sectionRefNamesHeading("相关工作", headings)).toBe(false);
    expect(sectionRefNamesHeading("方法/3.3 与 3.4.4", headings)).toBe(true); // 段「方法」命中（编号段淘汰后）
    expect(sectionRefNamesHeading("3.3 与 3.4.4", headings)).toBe(false); // 纯编号（无父节名）不可靠 → 不匹配
  });

  it("同名小节存在于同一标题集：不区分出现位置（文件粒度派发，由目标唯一性保证）", () => {
    expect(sectionRefNamesHeading("实验设置", headings)).toBe(true);
  });
});

describe("latexContainsAbstract", () => {
  it("含摘要环境 / 不含的环境", () => {
    expect(latexContainsAbstract("\\begin{abstract}\n摘要\n\\end{abstract}")).toBe(true);
    expect(latexContainsAbstract("\\section{引言}\n正文")).toBe(false);
    expect(latexContainsAbstract("\\renewcommand{\\abstractname}{摘要}")).toBe(false);
  });
});

describe("sectionMatches（真实派发语义，M10.4.4 Cases A–F）", () => {
  const target = singleFileTarget(SINGLE_FILE_PAPER);

  it("Case A：单文件 main.tex + subsection 标题引用 → 命中（修复前从不命中）", () => {
    expect(sectionMatches("轨迹稳定性自适应损失", target)).toBe(true);
    expect(sectionMatches("方法·轨迹稳定性自适应损失", target)).toBe(true);
    expect(sectionMatches("方法 / 轨迹稳定性自适应损失", target)).toBe(true);
    expect(sectionMatches("方法 > 轨迹稳定性自适应损失", target)).toBe(true);
  });

  it("Case B：父 section · 子 subsection 形式 → 命中", () => {
    expect(sectionMatches("方法 · 轨迹稳定性自适应损失", target)).toBe(true);
    expect(sectionMatches("方法/2.2 轨迹稳定性自适应损失（末段表述过强）", target)).toBe(true);
    expect(sectionMatches("引言", target)).toBe(true);
  });

  it("Case C：显式文件 / 路径 / key 引用：旧行为保持", () => {
    expect(sectionMatches("main.tex", target)).toBe(true);
    expect(sectionMatches("main", target)).toBe(true);
  });

  it("Case D：两个同名 subsection——不静默错误派发（单目标命中一次；不含该标题的目标不命中）", () => {
    const otherFile = singleFileTarget("\\section{相关工作}\n内容"); // 不含「实验设置」
    expect(sectionMatches("实验设置", target)).toBe(true); // 物理存在于目标 → 命中
    expect(sectionMatches("实验设置", otherFile)).toBe(false); // 不含该标题的文件绝不吸入
  });

  it("Case E：完全无法匹配的引用不伪造", () => {
    expect(sectionMatches("相关工作", target)).toBe(false);
    expect(sectionMatches("(global)", target)).toBe(false);
    expect(sectionMatches("", target)).toBe(false);
    expect(sectionMatches("不存在的小节", target)).toBe(false);
  });

  it("Case F：多文件原有匹配逻辑不回归（路径 / stem / outline key）", () => {
    const introTarget: RevisionTarget = {
      key: "introduction",
      relativePath: "sections/introduction.tex",
      currentLatex: "\\section{引言}\n内容",
    };
    expect(sectionMatches("sections/introduction.tex", introTarget)).toBe(true);
    expect(sectionMatches("introduction.tex", introTarget)).toBe(true);
    expect(sectionMatches("introduction", introTarget)).toBe(true);
    expect(sectionMatches("introduction", {
      ...introTarget,
      currentLatex: "\\section{别的}\n内容", // 路径层命中不依赖内容
    })).toBe(true);
    // 摘要互斥（M4.8）：摘要目标只收摘要引用；章节引用不进摘要目标
    expect(sectionMatches("引言", { key: "abstract", relativePath: "abstract", currentLatex: "摘要" })).toBe(false);
    expect(sectionMatches("摘要", { key: "abstract", relativePath: "abstract", currentLatex: "摘要" })).toBe(true);
    // 多文件章节文件无摘要环境：摘要类引用不落入（M4.8 语义保持）
    expect(sectionMatches("摘要", introTarget)).toBe(false);
    expect(sectionMatches("abstract", introTarget)).toBe(false);
  });

  it("grounded 摘要：单文件 main.tex（摘要物理在文件内）恢复派发；无摘要环境则仍不派发", () => {
    expect(sectionMatches("abstract", target)).toBe(true);
    expect(sectionMatches("摘要", target)).toBe(true);
    expect(sectionMatches("摘要、结论（跨节表述）", target)).toBe(true);
    const noAbstract = singleFileTarget("\\section{引言}\n无摘要环境");
    expect(sectionMatches("abstract", noAbstract)).toBe(false);
    expect(sectionMatches("摘要", noAbstract)).toBe(false);
  });

  it("真实形态回归：M10.4.2 A1 r2 的 heading 式引用集全部命中", () => {
    const realRefs = [
      "方法/运动残差门控动态模板记忆 MRG-DTM",
      "实验与结果/数据集介绍",
      "方法/3.6 轨迹稳定性自适应损失 与 3.7 总损失函数",
      "方法/3.2 YOLOv11 检测与身份特征分支",
      "方法/3.3 基于卡尔曼滤波的多目标时序关联",
      "实验与结果/对比实验结果与分析",
      "讨论与局限性 及 车载边缘设备部署实验",
      "摘要与方法节（跨节）",
    ];
    const realPaper = [
      "\\documentclass[UTF8]{ctexart}",
      "\\begin{document}",
      "\\begin{abstract}",
      "摘要。",
      "\\end{abstract}",
      "\\section{引言}",
      "\\section{方法}",
      "\\subsection{YOLOv11 检测与身份特征分支}",
      "\\subsection{基于卡尔曼滤波的多目标时序关联}",
      "\\subsection{运动残差门控动态模板记忆 MRG\\mbox{-}DTM}",
      "\\subsection{轨迹稳定性自适应损失}",
      "\\section{实验与结果}",
      "\\subsection{数据集介绍}",
      "\\subsection{对比实验结果与分析}",
      "\\subsection{车载边缘设备部署实验}",
      "\\subsection{讨论与局限性}",
      "\\end{document}",
    ].join("\n");
    const realTarget = singleFileTarget(realPaper);
    for (const ref of realRefs) {
      expect(sectionMatches(ref, realTarget), ref).toBe(true);
    }
  });
});

describe("itemTouchesFile heading 归因（M10.4.4 配套）", () => {
  it("无 contents：纯路径口径保持（旧调用兼容）", () => {
    expect(itemTouchesFile("方法/轨迹稳定性自适应损失", "main.tex")).toBe(false);
    expect(itemTouchesFile("sections/experiments.tex", "sections/experiments.tex")).toBe(true);
  });

  it("提供 contents：heading 引用归因到含该标题的文件（含 main.tex 单文件形态）", () => {
    expect(
      itemTouchesFile("方法/轨迹稳定性自适应损失", "main.tex", {
        before: SINGLE_FILE_PAPER,
        after: SINGLE_FILE_PAPER,
      }),
    ).toBe(true);
    // outline 组装根（只含 \input 无 \section）：heading 归因天然不误命中
    expect(
      itemTouchesFile("方法/轨迹稳定性自适应损失", "main.tex", {
        before: "\\input{sections/m}",
        after: "\\input{sections/m}",
      }),
    ).toBe(false);
  });
});
