/**
 * M14.9-MOT：修订候选里无标记的「修订过程说明」检测（真实返修中一段回应校验结果的说明
 * 通过全部守卫进入了正文）。
 */

import { describe, expect, it } from "vitest";

import { findWriterProcessCommentary, stripWriterProcessCommentary } from "../../src/review/writerCommentary.js";

const SPAN = [
  "\\subsection{极端场景与修正链}",
  "表~\\ref{tab:extreme} 报告链路 B 下 27 个极端片段的三臂公平对照。",
  "",
  "\\begin{table}",
  "\\caption{极端场景三臂公平对照}",
  "\\end{table}",
].join("\r\n");

describe("findWriterProcessCommentary", () => {
  it("正文末尾新增的校验回应段落被检出（真实泄漏原文形态）", () => {
    const leaked = `${SPAN}\r\n\r\n本次重提交与上一版提案相同。报告的校验失败指向本节之外的导言区定义，但本 target 不含该行。删除这些修订痕迹是 improvement:23/24 明确要求的，因此没有恢复。`;
    const found = findWriterProcessCommentary(SPAN, leaked);
    expect(found).not.toBeNull();
    expect(found).toMatch(/improvement:23|校验失败|重提交/);
  });

  it("内部计划 ID 混入已有段落同样检出", () => {
    const leaked = SPAN.replace("三臂公平对照。", "三臂公平对照（按 improvement:12 修改）。");
    expect(findWriterProcessCommentary(SPAN, leaked)).toContain("improvement:12");
  });

  it("合法改写（含“外观校验”“修正链”等论文词汇）不误报", () => {
    const rewritten = SPAN.replace("报告链路 B 下", "给出链路 B（自训身份分支）下").concat("\r\n\r\nH4 的外观校验在该链路上未单独评测。");
    expect(findWriterProcessCommentary(SPAN, rewritten)).toBeNull();
  });

  it("原文已有的同一词汇不算新增说明", () => {
    const span = `${SPAN}\r\n\r\n本单元的实验在冻结协议下完成。`;
    expect(findWriterProcessCommentary(span, span.replace("冻结协议", "同一冻结协议"))).toBeNull();
  });
});

describe("stripWriterProcessCommentary", () => {
  it("剥离带内部计划 ID 或两处以上流程词汇的段落，正文段落原样保留", () => {
    const text = `${SPAN}\r\n\r\n本次重提交与上一版提案相同，删除是 improvement:23/24 要求的。\r\n\r\nIDSW 由 121 降至 80。`;
    const stripped = stripWriterProcessCommentary(text);
    expect(stripped).not.toContain("improvement:23");
    expect(stripped).toContain("IDSW 由 121 降至 80。");
    expect(stripped).toContain("\\begin{table}");
  });
  it("只出现一处流程词汇的正文段落不剥离", () => {
    const text = "本单元的实验在冻结协议下完成，IDSW 为 121。";
    expect(stripWriterProcessCommentary(text)).toBe(text);
  });
});
