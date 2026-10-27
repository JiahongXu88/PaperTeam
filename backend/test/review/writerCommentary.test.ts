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

/**
 * M15.8.2（第三变体回归）：M15.8 P 项目 r7 修订泄漏形态——无书名号「执行报告：/（」
 * 段落 + finding/claim 内部 ID（f-/c- 12hex）。两个既有守卫当时双双漏检，泄漏段落的
 * 数字（65、213）与库外实体（Evidence/SUPPORT）反被事实守卫当作事实保护，清除补丁
 * 连续被拒。以下用当轮真实泄漏形态（节选）作回归锚。
 */
describe("M15.8.2 执行报告泄漏（无书名号 + f-/c- 内部 ID）", () => {
  const LEAK_COLON = "执行报告：本条目（f-4c44907c48bf / c-f1c72ee4efb1）存在约束冲突，按更高优先级守卫处置，正文保留原值未改。冲突说明：问题清单要求删除或定性化 65、213，但同一计划条目同时规定「绝对不可变动的数值（改写前后逐字保留）：65、213」。evidence_query 查询「掩码」与 voigtlaender2019mots 均无 verified Evidence 返回，故按规则无法升级为 SUPPORT。";
  const LEAK_PAREN = "执行报告（f-e3e052e2cab3）：已按计划条目的 fallback 方案执行——原断言改写为「现有综述性文献已有相关梳理可供参照」，与 evaluation-limitations 节口径一致。";

  it("findWriterProcessCommentary 检出无书名号执行报告段（冒号形态）", () => {
    expect(findWriterProcessCommentary(SPAN, `${SPAN}\r\n\r\n${LEAK_COLON}`)).toMatch(/执行报告|f-4c44907c48bf/);
  });

  it("findWriterProcessCommentary 检出括号形态与独立 f- ID", () => {
    expect(findWriterProcessCommentary(SPAN, `${SPAN}\r\n\r\n${LEAK_PAREN}`)).toMatch(/执行报告|f-e3e052e2cab3/);
    expect(findWriterProcessCommentary(SPAN, SPAN.replace("三臂公平对照。", "三臂公平对照（见 f-4c44907c48bf）。"))).toContain("f-4c44907c48bf");
  });

  it("stripWriterProcessCommentary 剥离执行报告段（其数字/实体不再算事实），正文保留", () => {
    const text = `${SPAN}\r\n\r\n${LEAK_COLON}\r\n\r\nIDSW 由 121 降至 80。`;
    const stripped = stripWriterProcessCommentary(text);
    expect(stripped).not.toContain("执行报告");
    expect(stripped).not.toContain("65");
    expect(stripped).toContain("IDSW 由 121 降至 80。");
    expect(stripped).toContain("\\begin{table}");
  });

  it("合法学术用语不误报（「执行」「报告」分开出现、纯正文 f/c 连字符词）", () => {
    const legit = SPAN.concat("\r\n\r\n后续工作将执行标准化协议并报告消融结果；参考 cf-2020 数据集的划分。");
    expect(findWriterProcessCommentary(SPAN, legit)).toBeNull();
    expect(stripWriterProcessCommentary(legit)).toBe(legit);
  });
});
