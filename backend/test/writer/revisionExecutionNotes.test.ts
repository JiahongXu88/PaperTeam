/**
 * Round 2 真实 run 回归（w-d678566b94c1 rev-8）：Writer 把逐条执行注记（markdown 列表）
 * 追加在修订正文末尾 → Fact Preservation added_number → 作者只能 reject。
 * stripRevisionExecutionNotes 必须确定性剥离这些注记，且不动任何 LaTeX 正文行。
 */

import { describe, expect, it } from "vitest";

import { stripRevisionExecutionNotes } from "../../src/writer/WriterService.js";

const BODY = [
  "\\section{实验结果与分析}",
  "本章报告主实验组（main）在 Dev25 评测范围上的结果。",
  "",
  "\\paragraph{核心组件消融} 候选间隔约束、延迟确认、多锚外观一致性评分与运动约束四个组件目前尚无消融数据。",
  "",
  "\\paragraph{定性案例} 作为补充，可从 Dev25 中选取典型片段逐帧展示差异。",
].join("\n");

const LEAKED_NOTES = [
  "",
  "- fact-preserve（placeholder_regression）：表 1 与 6.1 节全部数值（79、67、0.626126、0.628030）、Dev25、6.3/6.5 交叉引用及 \\cite{pedersen2022motcom} 逐字保留。",
  "- f-11922287a3ba：无消融 Evidence，6.5 节最小消融（i）–（iv）保持待补；引言贡献(2)(3)的弱化不在本 target 范围，需另派发。",
  "- c-9fcb6217ca8a / c-94bd609c21f8：数值为冻结实验事实且来自授权观测表，未改动、未强化，保留既有限定表述。",
  "- c-c1381fec7c49：WEAKEN——「幅度差异可由指标构成作出上述解释」改为「仅是一种可能的解读」。",
  "- 2020、25 及 \\cite{ua2020} 逐字保留；未改动任何数值、公式与协议表述。",
].join("\n");

describe("stripRevisionExecutionNotes", () => {
  it("rev-8 实录：正文末尾的执行注记列表整块剥离，正文逐行原样保留", () => {
    const { latex, removed } = stripRevisionExecutionNotes(BODY + "\n" + LEAKED_NOTES + "\n");
    expect(removed).toHaveLength(5);
    expect(latex.trim()).toBe(BODY);
    expect(latex).not.toContain("f-11922287a3ba");
    expect(latex).not.toContain("逐字保留");
  });

  it("无注记的正文原样返回（含以连字符开头的数学 / 正文行不受影响）", () => {
    const clean = [
      "\\section{方法}",
      "$$ -\\frac{1}{2} $$",
      "- 这不是执行注记，只是正文里罕见的破折号开头句。",
      "\\begin{itemize}",
      "  \\item 候选间隔约束",
      "\\end{itemize}",
    ].join("\n");
    const { latex, removed } = stripRevisionExecutionNotes(clean);
    expect(removed).toEqual([]);
    expect(latex).toBe(clean);
  });

  it("夹在正文中间的标记行也剥离（【修订说明】/ id 项目符号 / 动作词），其余保留", () => {
    const mixed = [
      "\\section{讨论}",
      "【修订说明】本段按 f-51548ae73cc8 改为条件句式。",
      "若来源级分析证实异质性，这一现象将与方法的设计目标相符。",
      "- c-2bda1de9c516：REMOVE——删除「Bootstrap 分析显示」的实证陈述。",
      "本文的结论强度限定为 main/Dev25 范围。",
    ].join("\n");
    const { latex, removed } = stripRevisionExecutionNotes(mixed);
    expect(removed).toHaveLength(2);
    expect(latex).toBe(
      ["\\section{讨论}", "若来源级分析证实异质性，这一现象将与方法的设计目标相符。", "本文的结论强度限定为 main/Dev25 范围。"].join("\n"),
    );
  });

  it("末尾普通项目符号块若不含任何标记行 → 不剥离（保守）", () => {
    const text = ["正文。", "", "- 甲", "- 乙"].join("\n");
    const { latex, removed } = stripRevisionExecutionNotes(text);
    expect(removed).toEqual([]);
    expect(latex).toBe(text);
  });
});
