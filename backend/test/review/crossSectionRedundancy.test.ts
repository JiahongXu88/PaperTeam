/**
 * M13.7.7 Cross-Section Redundancy 探测器测试：
 * - 同一机制在后节被近似重述 → 命中，earlier 永远是大纲顺序靠前的一节；
 * - 同节内重复、短句、标题 / \cite / \label / 公式 → 不参与或不误报；
 * - 措辞完全不同的章节 → 零 pair；
 * - 限制声明哨兵只统计分布，不改任何文本；
 * - 阈值可调且被回显在报告里。
 */
import { describe, expect, it } from "vitest";

import {
  analyzeCrossSectionRedundancy,
  isLimitationSentence,
  splitRedundancySentences,
  stripLatexForRedundancy,
  tokenizeForRedundancy,
} from "../../src/review/crossSectionRedundancy.js";

const LORA_BASE = "LoRA 冻结预训练模型权重，并在 Transformer 的每一层注入可训练的秩分解矩阵\\cite{hu2021lora}。";
const LORA_RESTATED = "如前所述，LoRA 的做法是冻结预训练权重，向 Transformer 各层注入可训练的秩分解矩阵\\cite{hu2021lora}。";

describe("analyzeCrossSectionRedundancy", () => {
  it("命中后节对前节机制句的近似重述，并给出两处原句", () => {
    const report = analyzeCrossSectionRedundancy([
      { id: "introduction", latex: "\\section{引言}\n本文整理两篇文献的机制关系，不开展本文实验。" },
      { id: "base", latex: `\\section{低秩适配机制}\n${LORA_BASE} 这一设计把可训练参数限制在低秩子空间。` },
      { id: "comparison", latex: `\\section{综合比较}\n${LORA_RESTATED} 相比之下，QLoRA 改变的是存储对象。` },
    ]);
    expect(report.summary.pairCount).toBeGreaterThanOrEqual(1);
    const pair = report.pairs[0]!;
    expect(pair.earlier.section).toBe("base");
    expect(pair.later.section).toBe("comparison");
    expect(pair.earlier.text).toContain("秩分解矩阵");
    expect(pair.later.text).toContain("秩分解矩阵");
    expect(pair.containment).toBeGreaterThanOrEqual(0.5);
    expect(report.summary.sectionsWithRestatement).toBe(1);
    expect(report.sections.find((s) => s.id === "comparison")?.restatedSentences).toBe(1);
    expect(report.sections.find((s) => s.id === "base")?.restatedSentences).toBe(0);
  });

  it("只比较不同章节；同节内重复不计，顺序决定 earlier / later", () => {
    const report = analyzeCrossSectionRedundancy([
      { id: "a", latex: `${LORA_BASE} ${LORA_BASE}` },
      { id: "b", latex: "QLoRA 通过冻结的四位量化模型把梯度反传到低秩适配器。" },
    ]);
    expect(report.summary.pairCount).toBe(0);
    const reversed = analyzeCrossSectionRedundancy([
      { id: "later-in-outline", latex: LORA_RESTATED },
      { id: "owner", latex: LORA_BASE },
    ]);
    expect(reversed.pairs[0]?.earlier.section).toBe("later-in-outline");
    expect(reversed.pairs[0]?.later.section).toBe("owner");
  });

  it("措辞不同的章节零命中；标题 / cite / label / 公式不制造伪共享", () => {
    const report = analyzeCrossSectionRedundancy([
      {
        id: "a",
        latex: "\\section{低秩适配机制}\\label{sec:base}\n$W_0 + BA$ 的分解把梯度更新约束在低秩空间\\cite{hu2021lora}。",
      },
      {
        id: "b",
        latex: "\\section{低秩适配机制回顾}\\label{sec:base2}\n$W_0 + BA$ 并不改变推理时的参数量\\cite{hu2021lora}。",
      },
    ]);
    expect(report.summary.pairCount).toBe(0);
    expect(stripLatexForRedundancy("\\section{引言}\\cite{a,b}\\label{x}$y=1$\\emph{强调}")).not.toMatch(/section|cite|label|\$/);
    expect(stripLatexForRedundancy("\\emph{强调}")).toContain("强调");
  });

  it("短句不参与比较，但仍计入字符统计", () => {
    const report = analyzeCrossSectionRedundancy([
      { id: "a", latex: "LoRA 冻结权重。" },
      { id: "b", latex: "LoRA 冻结权重。" },
    ]);
    expect(report.summary.pairCount).toBe(0);
    expect(report.summary.sentenceCount).toBe(2);
    expect(report.summary.charCount).toBeGreaterThan(0);
  });

  it("限制声明哨兵统计分布：命中句与所在节数", () => {
    const report = analyzeCrossSectionRedundancy([
      { id: "base", latex: "LoRA 冻结预训练权重。本文未进行独立实验，不能给出性能排序。" },
      { id: "conclusion", latex: "材料仅有两篇摘要，未统一复现。" },
      { id: "intro", latex: "本文整理两条路线。" },
    ]);
    expect(report.summary.limitationSentenceCount).toBe(2);
    expect(report.summary.sectionsWithLimitation).toBe(2);
    expect(report.limitationSentences.map((s) => s.section)).toEqual(["base", "conclusion"]);
    expect(isLimitationSentence("该机制将可训练参数限制在低秩空间。")).toBe(false);
    expect(isLimitationSentence("相关结论尚待跨任务评测。")).toBe(true);
  });

  it("阈值可调并回显；提高阈值可关闭边界命中", () => {
    const sections = [
      { id: "base", latex: LORA_BASE },
      { id: "comparison", latex: LORA_RESTATED },
    ];
    const loose = analyzeCrossSectionRedundancy(sections);
    const strict = analyzeCrossSectionRedundancy(sections, { minContainment: 0.99, minJaccard: 0.99 });
    expect(loose.summary.pairCount).toBe(1);
    expect(strict.summary.pairCount).toBe(0);
    expect(strict.options.minContainment).toBe(0.99);
    expect(loose.options.minShared).toBe(6);
  });

  it("分句与分词是确定性的，功能字 bigram 被过滤", () => {
    expect(splitRedundancySentences("第一句。第二句！第三句？\n第四句")).toHaveLength(4);
    const tokens = tokenizeForRedundancy("LoRA 的秩分解矩阵与 4 位量化");
    expect(tokens.has("lora")).toBe(true);
    expect(tokens.has("4")).toBe(true);
    expect(tokens.has("秩分")).toBe(true);
    expect(tokens.has("的秩")).toBe(false);
    expect(tokens.has("阵与")).toBe(false);
  });
});
