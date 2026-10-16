/**
 * M14.5 — 章节引用规范化单元测试（真实案例 B：「第四章为实验验证」实为第五章）。
 */
import { describe, expect, it } from "vitest";

import {
  chapterLabel,
  chapterLabelLatex,
  chapterOrder,
  detectLiteralChapterReferences,
  normalizeChapterReferences,
  parseChapterOrdinal,
  renderChapterOrderLines,
} from "../../src/thesis/chapterReferences.js";

const CHAPTERS = [
  { chapterId: "ch01", titleZh: "绪论" },
  { chapterId: "ch02", titleZh: "相关理论与研究现状" },
  { chapterId: "ch03", titleZh: "下洗数据采集与神经网络预测器设计" },
  { chapterId: "ch04", titleZh: "NDP-NMPC 轨迹跟踪控制器设计" },
  { chapterId: "ch05", titleZh: "实时轨迹跟踪实验与结果分析" },
  { chapterId: "ch06", titleZh: "总结与展望" },
];
const ORDER = chapterOrder(CHAPTERS);

describe("chapterLabel / chapterOrder / renderChapterOrderLines", () => {
  it("label 只保留安全字符并带 ch: 前缀", () => {
    expect(chapterLabel("ch01")).toBe("ch:ch01");
    expect(chapterLabel("ch-实验 x")).toBe("ch:ch----x");
    expect(chapterLabelLatex("ch05")).toBe("\\label{ch:ch05}");
  });

  it("chapterOrder 按大纲顺序赋 1 起序号", () => {
    expect(ORDER.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ORDER[4]).toEqual({ chapterId: "ch05", ordinal: 5, titleZh: "实时轨迹跟踪实验与结果分析", label: "ch:ch05" });
  });

  it("提示行列出全部章、标记本章、给出 \\ref 写法并禁止字面序号", () => {
    const lines = renderChapterOrderLines(CHAPTERS, "ch01");
    const joined = lines.join("\n");
    expect(lines.some((line) => line.includes("第5章 实时轨迹跟踪实验与结果分析（\\ref{ch:ch05}）"))).toBe(true);
    expect(lines.some((line) => line.includes("第1章 绪论") && line.includes("本章"))).toBe(true);
    expect(joined).toContain("第\\ref{ch:<chapterId>}章");
    expect(joined).toContain("第四章");
    expect(joined).toMatch(/禁止/);
    expect(joined).toMatch(/论文结构安排/);
  });
});

describe("parseChapterOrdinal / detectLiteralChapterReferences", () => {
  it("解析阿拉伯与中文数字（≤ 20）", () => {
    expect(parseChapterOrdinal("4")).toBe(4);
    expect(parseChapterOrdinal("四")).toBe(4);
    expect(parseChapterOrdinal("十")).toBe(10);
    expect(parseChapterOrdinal("十二")).toBe(12);
    expect(parseChapterOrdinal("二十")).toBe(20);
    expect(parseChapterOrdinal("两")).toBe(2);
    expect(parseChapterOrdinal("甲")).toBeUndefined();
  });

  it("检测正文字面序号，跳过 \\chapter/\\ref/\\label/注释/数学", () => {
    const latex = [
      "\\chapter{第一章 绪论}\\label{ch:ch01}",
      "% 第二章 注释里的不算",
      "本文第 3 章给出预测器。参见第\\ref{ch:ch04}章。$第五章$",
      "第十二章不存在。",
    ].join("\n");
    const literals = detectLiteralChapterReferences(latex);
    expect(literals.map((entry) => [entry.literal, entry.ordinal])).toEqual([
      ["第 3 章", 3],
      ["第十二章", 12],
    ]);
    expect(literals[0]?.offset).toBe(latex.indexOf("第 3 章"));
  });
});

describe("normalizeChapterReferences", () => {
  it("真实案例：「第四章为实验验证」只有独有二元组（弱证据）且序号不符 → 不改写、报告 unresolved 并给出标题线索", () => {
    // M14.6 案例 B 实测：仅凭二元组改写会把「第一章…数据采集」误改到 ch03——弱证据与序号冲突时只报告
    const latex = "第四章为实验验证，首先介绍实验平台，然后给出轨迹跟踪结果。";
    const result = normalizeChapterReferences(latex, ORDER, { currentChapterId: "ch01" });
    expect(result.latex).toBe(latex);
    expect(result.rewrites).toEqual([]);
    expect(result.issues).toEqual([
      {
        literal: "第四章",
        ordinal: 4,
        offset: 0,
        reason: "unresolved",
        nearbyTitle: "实时轨迹跟踪实验与结果分析",
        expectedChapterId: "ch05",
      },
    ]);
  });

  it("独有二元组与序号一致 → 允许改写（弱证据被序号确认）", () => {
    const result = normalizeChapterReferences("第五章为实验验证，介绍实验平台。", ORDER);
    expect(result.latex).toBe("第\\ref{ch:ch05}章为实验验证，介绍实验平台。");
    expect(result.issues).toEqual([]);
  });

  it("「第二章为相关理论基础」经标题前缀「相关理论」匹配 ch02，序号一致不报 issue", () => {
    const result = normalizeChapterReferences("第二章为相关理论基础。", ORDER);
    expect(result.latex).toBe("第\\ref{ch:ch02}章为相关理论基础。");
    expect(result.issues).toEqual([]);
    expect(result.rewrites[0]?.chapterId).toBe("ch02");
  });

  it("完整标题匹配优先；论文结构段逐章改写", () => {
    const latex = [
      "全文共六章。第一章绪论，阐述研究背景。",
      "第二章相关理论与研究现状。第三章下洗数据采集与神经网络预测器设计。",
      "第四章 NDP-NMPC 轨迹跟踪控制器设计。第五章实时轨迹跟踪实验与结果分析。第六章总结与展望。",
    ].join("\n");
    const result = normalizeChapterReferences(latex, ORDER);
    expect(result.rewrites.map((entry) => entry.chapterId)).toEqual(["ch01", "ch02", "ch03", "ch04", "ch05", "ch06"]);
    expect(result.issues).toEqual([]);
    expect(result.latex).not.toMatch(/第[一二三四五六]章/);
    expect(result.latex).toContain("第\\ref{ch:ch04}章 NDP-NMPC");
  });

  it("无邻近标题时默认不按序号改写，记录 unresolved 并给出序号对应章作提示", () => {
    const latex = "相关内容将在第三章详细讨论。";
    const result = normalizeChapterReferences(latex, ORDER);
    expect(result.latex).toBe(latex);
    expect(result.rewrites).toEqual([]);
    expect(result.issues).toEqual([
      { literal: "第三章", ordinal: 3, offset: latex.indexOf("第三章"), reason: "unresolved", expectedChapterId: "ch03" },
    ]);
  });

  it("trustOrdinal=true 时按序号改写无标题的引用", () => {
    const result = normalizeChapterReferences("相关内容将在第三章详细讨论。", ORDER, { trustOrdinal: true });
    expect(result.latex).toBe("相关内容将在第\\ref{ch:ch03}章详细讨论。");
    expect(result.issues).toEqual([]);
  });

  it("序号越界：报告 ordinal_out_of_range，不改写", () => {
    const result = normalizeChapterReferences("第八章给出附录。", ORDER, { trustOrdinal: true });
    expect(result.latex).toBe("第八章给出附录。");
    expect(result.issues[0]?.reason).toBe("ordinal_out_of_range");
    expect(result.rewrites).toEqual([]);
  });

  it("窗口内多章标题命中（歧义）→ 不改写，unresolved", () => {
    // 「神经网络/预测器」只属于 ch03，「实验」只属于 ch05 → 同层两章命中 → 歧义
    const latex = "第三章介绍神经网络预测器与轨迹跟踪实验。";
    const result = normalizeChapterReferences(latex, ORDER, { trustOrdinal: true });
    expect(result.rewrites).toEqual([]);
    expect(result.issues[0]?.reason).toBe("unresolved");
    // 高层（标题前缀）唯一命中优先于低层（独有二元组）：不被弱信号否决
    const strong = normalizeChapterReferences("第二章相关理论为后续实验奠定基础。", ORDER);
    expect(strong.rewrites[0]?.chapterId).toBe("ch02");
  });

  it("不触碰 \\chapter 标题、\\label、注释与数学；幂等", () => {
    const latex = [
      "\\chapter{第四章 实时轨迹跟踪实验与结果分析}",
      "\\label{ch:ch05}",
      "% 第四章 实验（注释）",
      "正文：第四章实时轨迹跟踪实验与结果分析见下。$x_{第四章}$",
    ].join("\n");
    const first = normalizeChapterReferences(latex, ORDER);
    expect(first.rewrites).toHaveLength(1);
    expect(first.latex.startsWith("\\chapter{第四章 实时轨迹跟踪实验与结果分析}")).toBe(true);
    expect(first.latex).toContain("% 第四章 实验（注释）");
    expect(first.latex).toContain("$x_{第四章}$");
    expect(first.latex).toContain("正文：第\\ref{ch:ch05}章实时轨迹跟踪实验与结果分析见下。");
    const second = normalizeChapterReferences(first.latex, ORDER);
    expect(second.rewrites).toEqual([]);
    expect(second.latex).toBe(first.latex);
  });

  it("带空格的「第 5 章」亦可改写；多处改写偏移正确", () => {
    const latex = "第 5 章实时轨迹跟踪实验给出结果；第六章总结与展望。";
    const result = normalizeChapterReferences(latex, ORDER);
    expect(result.latex).toBe("第\\ref{ch:ch05}章实时轨迹跟踪实验给出结果；第\\ref{ch:ch06}章总结与展望。");
    expect(result.rewrites.map((entry) => entry.offset)).toEqual([0, latex.indexOf("第六章")]);
  });

  it("空章表：原样返回", () => {
    const result = normalizeChapterReferences("第一章绪论。", []);
    expect(result.latex).toBe("第一章绪论。");
    expect(result.issues).toEqual([]);
  });
});
