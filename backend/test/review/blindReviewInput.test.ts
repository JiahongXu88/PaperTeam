/**
 * M14.9.1 B2/B3：Reviewer 输入投影 + 确定性内容等价门。
 *
 * - 结构化盲化：只按字段 / span 移除作者、单位、邮箱、\thanks、致谢、源码注释；公式原文、表格单元格、
 *   图注、引用键、参考文献全部保留，等价门 VALID；
 * - 元数据变形不变性：插入 / 改写作者、单位、基金、邮箱、注释、致谢后，盲化输出逐字节相同；
 * - 反例：正文里有学术意义的「清华大学发布的公开数据集」「国家自然科学基金支持建设的平台」必须保留——
 *   朴素方案（全局关键词整行删除）会误删并被等价门判 INVALID_INPUT；
 * - \multicolumn 补位在原列位置（M14.9.1 A/B 中行尾补位曾被审稿模型报为「表格整体左移一列」）。
 */
import { describe, expect, it } from "vitest";

import { projectNaive, projectPdfTextBlind, projectPdfTextNaive, projectRaw, projectStructuredBlind } from "../../src/review/blindReviewInput.js";
import { checkEquivalence, latexInventory, pdfTextInventory } from "../../src/review/reviewInputEquivalence.js";

const BODY = [
  "\\begin{abstract}",
  "We study association repair; IDSW drops from 700 to 497 (29.0\\%).",
  "\\end{abstract}",
  "\\section{Introduction}",
  "\\label{sec:intro}",
  "Motion costs dominate stale tracks~\\cite{wojke2017,zhang2022}.",
  "实验使用清华大学发布的公开数据集，该平台由国家自然科学基金支持建设。",
  "\\section{Method}",
  "The cost is",
  "\\begin{equation}",
  "c = \\alpha \\min(d^2, \\tau_{\\chi^2}) + \\beta \\label{eq:cost}",
  "\\end{equation}",
  "with $\\tau_{\\chi^2}=9.4877$ (Eq.~\\eqref{eq:cost}).",
  "\\begin{table}[t]",
  "\\caption{Main results on 40 sequences.}",
  "\\label{tab:main}",
  "\\begin{tabular}{l|cc}",
  "\\toprule",
  "Method & IDSW$\\downarrow$ & HOTA \\\\",
  "\\midrule",
  "Base & 700 & 60.12 \\\\",
  "H1+H4 & \\textbf{497} & 60.31$^{\\dagger}$ \\\\",
  "\\multicolumn{2}{l}{Overall (A / C)} & 73.87 / 73.54 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\begin{figure}[h]",
  "\\includegraphics[width=0.8\\linewidth]{figs/pipeline.pdf}",
  "\\caption{Pipeline of the 3-stage forensics.}",
  "\\label{fig:pipe}",
  "\\end{figure}",
  "\\section*{Acknowledgments}",
  "We thank Alice for discussion. Supported by NSF Grant 1234567.",
  "\\begin{thebibliography}{99}",
  "\\bibitem{wojke2017} Wojke N. Simple online and realtime tracking with a deep association metric. ICIP, 2017.",
  "\\bibitem{zhang2022} Zhang Y. ByteTrack. ECCV, 2022.",
  "\\end{thebibliography}",
].join("\n");

function paper(front: string): string {
  return `\\documentclass{article}\n% internal note: funding pending\n\\title{Event-level Diagnosis}\n${front}\n\\begin{document}\n\\maketitle\n${BODY}\n\\end{document}\n`;
}

const FRONT = "\\author{Jia Xu\\thanks{Corresponding author: jx@example.edu}\\\\ Anhui Jianzhu University, Hefei 230601}";

describe("结构化盲化投影 + 等价门", () => {
  it("盲化输出保留全部科研内容（等价门 VALID），只移除身份字段 / 注释 / 致谢", () => {
    const bundle = { main: paper(FRONT) };
    const blind = projectStructuredBlind(bundle);
    const report = checkEquivalence(latexInventory(bundle), blind);
    expect(report.reasons).toEqual([]);
    expect(report.status).toBe("VALID");
    expect(blind.text).toContain("\\begin{equation}\nc = \\alpha \\min(d^2, \\tau_{\\chi^2}) + \\beta");
    expect(blind.text).toContain("| H1+H4 | **497** | 60.31$^{\\dagger}$ |");
    expect(blind.text).toContain("[@wojke2017; @zhang2022]");
    expect(blind.text).toContain("FIGURE_CONTENT_NOT_EVALUATED");
    expect(blind.text).toContain("Pipeline of the 3-stage forensics.");
    expect(blind.text).toContain("清华大学发布的公开数据集");
    for (const leaked of ["Jia Xu", "Anhui Jianzhu", "jx@example.edu", "230601", "internal note", "We thank Alice", "1234567"]) {
      expect(blind.text).not.toContain(leaked);
    }
    expect(blind.redactions.map((entry) => entry.kind).sort()).toEqual(["acknowledgment", "author", "comment"]);
  });

  it("\\multicolumn 在原列位置补空格位（不再整行左移）", () => {
    const blind = projectStructuredBlind({ main: paper(FRONT) });
    expect(blind.text).toContain("| Overall (A / C) | | 73.87 / 73.54 |");
  });

  it("元数据变形不变性：换作者 / 单位 / 邮箱 / 基金致谢 / 注释，盲化输出逐字节相同", () => {
    const base = projectStructuredBlind({ main: paper(FRONT) }).text;
    const swapped = paper("\\author{Wei Wang\\thanks{Funded by the National Key R\\&D Program}\\\\ Tsinghua University\\\\ \\texttt{ww@tsinghua.edu.cn}}\n% 基金项目：国家自然科学基金重点项目")
      .replace("We thank Alice for discussion. Supported by NSF Grant 1234567.", "We thank Bob. Funded by Grant 7654321.");
    expect(projectStructuredBlind({ main: swapped }).text).toBe(base);
  });

  it("反例：朴素方案按「大学 / 基金」整行删除，误删正文中的数据集来源句 → INVALID_INPUT", () => {
    const bundle = { main: paper(FRONT) };
    const naive = projectNaive(bundle);
    const report = checkEquivalence(latexInventory(bundle), naive);
    expect(naive.text).not.toContain("清华大学发布的公开数据集");
    expect(naive.redactions.some((entry) => entry.kind === "naive_keyword_line" && entry.excerpt.includes("清华大学"))).toBe(true);
    expect(report.status).toBe("INVALID_INPUT");
  });

  it("raw 臂即原稿（按定义等价），保留全部身份与注释", () => {
    const raw = projectRaw({ main: paper(FRONT) });
    expect(raw.text).toContain("Jia Xu");
    expect(checkEquivalence(latexInventory({ main: paper(FRONT) }), raw).status).toBe("VALID");
  });

  it("等价门能抓住转写丢失：删掉一个表格数值即 INVALID_INPUT", () => {
    const bundle = { main: paper(FRONT) };
    const blind = projectStructuredBlind(bundle);
    const broken = { ...blind, text: blind.text.replace("60.12", "") };
    const report = checkEquivalence(latexInventory(bundle), broken);
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.missing.numbers).toContain("60.12");
  });
});

describe("期刊 PDF 文本层：字段 span 移除（同一文本基底）", () => {
  const PDF = [
    "--- page 1 ---",
    "2026，62（9）",
    "面向复杂场景的车辆多目标跟踪算法",
    "张三",
    "1，李四",
    "1.某某大学交通学院，山东淄博255000",
    "+ 通信作者E-mail：someone@example.com",
    "摘",
    "要：提出一种方法，MOTA 为89.86%。",
    "关键词：多目标跟踪；车辆",
    "文献标志码：A",
    "中图分类号：TP391.41",
    "doi：10.3778/j.issn.1002-8331.2506-0340",
    "Multi-Object Tracking for Vehicles",
    "ZHANG San",
    "1, LI Si",
    "1.School of Transportation, Some University, Zibo, Shandong 255000, China",
    "Abstract：We propose a method with MOTA 89.86%.",
    "基金项目：国家自然科学基金（52102465）；山东省自然科学基金（ZR2024ME179）。",
    "作者简介：张三（2002—），男，硕士研究生。",
    "收稿日期：2025-06-27",
    "Computer Engineering and Applications计算机工程与应用",
    "--- page 2 ---",
    "Computer Engineering and Applications计算机工程与应用",
    "张三，等：面向复杂场景的车辆多目标跟踪算法",
    "实验在吉林大学发布的数据集上进行，MOTA 提升 4.14 个百分点。",
    "--- page 3 ---",
    "Computer Engineering and Applications计算机工程与应用",
    "张三，等：面向复杂场景的车辆多目标跟踪算法",
    "[1] 王五.车辆跟踪[J].吉林大学学报（工学版），2024，54（8）：2338-2347.",
    "--- page 4 ---",
    "张三，等：面向复杂场景的车辆多目标跟踪算法",
  ].join("\n");

  it("只移除首页作者 / 单位 / 邮箱 / 分类号 / 基金 / 作者简介 / 页眉；正文与参考文献中的大学名称保留", () => {
    const blind = projectPdfTextBlind(PDF);
    for (const kept of ["面向复杂场景的车辆多目标跟踪算法", "MOTA 为89.86%", "吉林大学发布的数据集", "吉林大学学报（工学版）", "Multi-Object Tracking for Vehicles"]) {
      expect(blind.text).toContain(kept);
    }
    for (const removed of ["张三\n", "李四", "某某大学", "someone@example.com", "TP391.41", "52102465", "作者简介", "ZHANG San", "Some University", "张三，等："]) {
      expect(blind.text).not.toContain(removed);
    }
    const inventory = pdfTextInventory(PDF, new Set(blind.redactions.map((entry) => entry.line)));
    expect(checkEquivalence(inventory, blind).status).toBe("VALID");
    const naive = projectPdfTextNaive(PDF);
    expect(naive.text).not.toContain("吉林大学发布的数据集");
    expect(checkEquivalence(inventory, naive).status).toBe("INVALID_INPUT");
  });
});
