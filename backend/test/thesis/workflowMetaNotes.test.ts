/**
 * M14.5 — 工作流元注记检测/剥离单元测试（真实案例 B：「依据本章的科研事实纪律」）。
 */
import { describe, expect, it } from "vitest";

import { detectWorkflowMetaNotes, stripWorkflowMetaNotes } from "../../src/thesis/workflowMetaNotes.js";

describe("detectWorkflowMetaNotes", () => {
  it("命中真实泄漏与已知形态（high）", () => {
    const text = [
      "本章依据本章的科研事实纪律，仅使用已确认数值。",
      "根据当前 Workflow，系统已完成本阶段。",
      "需要用户确认后继续；Agent 将进一步处理。",
      "按照提示词要求，本轮检索未发现新文献。",
      "【修订说明】已替换表 3 的数值。",
      "该参数待作者确认。",
      "PaperTeam 核验通过。",
    ].join("\n");
    const hits = detectWorkflowMetaNotes(text);
    expect(hits.every((hit) => hit.confidence === "high")).toBe(true);
    expect(hits.map((hit) => hit.sentence)).toEqual([
      "本章依据本章的科研事实纪律，仅使用已确认数值。",
      "根据当前 Workflow，系统已完成本阶段。",
      "需要用户确认后继续；",
      "Agent 将进一步处理。",
      "按照提示词要求，本轮检索未发现新文献。",
      "【修订说明】已替换表 3 的数值。",
      "该参数待作者确认。",
      "PaperTeam 核验通过。",
    ]);
    expect(hits[0]?.offset).toBe(0);
    expect(hits[1]?.offset).toBe(text.indexOf("根据当前 Workflow"));
  });

  it("medium 只上报：尚未核验 / 待补实验 / 内部记录 / 授权范围", () => {
    const hits = detectWorkflowMetaNotes("该结论尚未核验。此处待补实验。（内部记录）超出授权范围。");
    expect(hits.map((hit) => hit.confidence)).toEqual(["medium", "medium", "medium"]);
  });

  it("不误报合法计算机术语与学术表述", () => {
    const text = [
      "本文提出的系统在嵌入式平台上运行。",
      "神经网络模型用于预测下洗速度。",
      "控制系统在约束范围内保持稳定。",
      "模型预测控制通过滚动优化求解。",
      "本文对相关方法进行系统性综述。",
      "系统辨识结果表明模型精度满足要求。",
    ].join("\n");
    expect(detectWorkflowMetaNotes(text)).toEqual([]);
  });

  it("跳过注释行、table 块与 \\label/\\ref/\\cite 参数", () => {
    const text = [
      "% 根据当前 Workflow 这是注释",
      "\\begin{table}",
      "\\caption{系统已完成本阶段}",
      "\\end{table}",
      "参见 \\ref{sec:PaperTeam} 与 \\cite{paperteam2026}。",
    ].join("\n");
    expect(detectWorkflowMetaNotes(text)).toEqual([]);
  });
});

describe("stripWorkflowMetaNotes", () => {
  it("剥离 high 整句、保留其余句子与段落结构", () => {
    const text = [
      "\\section{实验设置}",
      "实验平台为四旋翼无人机。依据本章的科研事实纪律，以下数值均来自已确认事实。采样频率为 100 Hz。",
      "",
      "根据当前 Workflow，本节略。",
      "",
      "控制器在 50 Hz 下运行。",
    ].join("\n");
    const result = stripWorkflowMetaNotes(text);
    expect(result.text).toBe(
      ["\\section{实验设置}", "实验平台为四旋翼无人机。采样频率为 100 Hz。", "", "控制器在 50 Hz 下运行。"].join("\n"),
    );
    expect(result.removed.map((hit) => hit.sentence)).toEqual([
      "依据本章的科研事实纪律，以下数值均来自已确认事实。",
      "根据当前 Workflow，本节略。",
    ]);
    expect(result.kept).toEqual([]);
  });

  it("含带单位数值或 \\cite/\\ref 的 high 句不剥离，转入 kept", () => {
    const text = "按照提示词要求，跟踪误差降至 0.12 m。待作者确认的结果见 \\cite{xu2026}。";
    const result = stripWorkflowMetaNotes(text);
    expect(result.text).toBe(text);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((hit) => hit.confidence)).toEqual(["high", "high"]);
  });

  it("超过 120 字的 high 句保留并上报", () => {
    const long = `本轮检索覆盖了${"相关文献".repeat(35)}。`;
    const result = stripWorkflowMetaNotes(long);
    expect(result.text).toBe(long);
    expect(result.kept).toHaveLength(1);
  });

  it("medium 永不剥离", () => {
    const text = "该结论尚未核验。";
    const result = stripWorkflowMetaNotes(text);
    expect(result.text).toBe(text);
    expect(result.kept[0]?.confidence).toBe("medium");
  });

  it("整段被剥离时删除该段并折叠空行；无命中时原文不变", () => {
    const text = ["第一段。", "", "系统已完成本阶段。", "", "第三段。"].join("\n");
    expect(stripWorkflowMetaNotes(text).text).toBe("第一段。\n\n第三段。");
    const clean = "本文提出的系统性能良好。\n\n模型预测控制有效。";
    expect(stripWorkflowMetaNotes(clean).text).toBe(clean);
  });

  it("%%%PT-OUTCOMES%%% 标记行被剥离", () => {
    const result = stripWorkflowMetaNotes("正文。\n%%%PT-OUTCOMES%%% applied\n后文。");
    expect(result.text).toBe("正文。\n后文。");
  });
});
