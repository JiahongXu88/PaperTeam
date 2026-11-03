/**
 * M16 工程收口 C：finding 定位引用三态（VALID / INVALID / UNVERIFIABLE）。零模型；夹具为合成片段。
 * 预登记的已知无效引用（可判范围内）必须 INVALID；合法 \label / 编号必须 VALID；结构缺失的输入保持 UNVERIFIABLE。
 */
import { describe, expect, it } from "vitest";

import { assessFindingLocators, buildLocatorIndex } from "../../src/review/findingLocators.js";
import { verifyFindings } from "../../src/review/verifiedFindings.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";

const AUTHOR_TEX = [
  "\\section{Method}\\label{sec:method}",
  "We minimise the loss in \\eqref{eq:loss}.",
  "\\begin{equation}\\label{eq:loss} L = \\sum_i \\ell_i \\end{equation}",
  "\\begin{align} a &= b \\\\ c &= d \\nonumber \\\\ e &= f \\end{align}",
  "\\begin{equation*} x = y \\end{equation*}",
  "\\begin{table}\\caption{Main}\\label{tab:main}\\begin{tabular}{cc} A & 1 \\\\ \\end{tabular}\\end{table}",
  "\\begin{table}\\caption{Ablation}\\label{tab:abl}\\begin{tabular}{cc} B & 2 \\\\ \\end{tabular}\\end{table}",
  "\\begin{figure}\\includegraphics{x}\\caption{Overview}\\label{fig:overview}\\end{figure}",
  "As shown by \\citet{smith2020} and \\cite{lee2021,kim2022}.",
].join("\n");

const index = (content: string, source: "AUTHOR_SOURCE" | "SOURCE_UNVERIFIED" | "SOURCE_UNKNOWN" = "AUTHOR_SOURCE", tables = 2) =>
  buildLocatorIndex({ files: [{ content, tables: Array.from({ length: tables }, (_, i) => ({ start: i * 10, floatStart: i * 10 })) }], sourceVerification: source });

const statusOf = (text: string, idx: ReturnType<typeof index>) => Object.fromEntries(assessFindingLocators(text, idx).refs.map((entry) => [entry.ref, entry.status]));

describe("findingLocators：作者 LaTeX 源稿", () => {
  const idx = index(AUTHOR_TEX);

  it("合法引用不误拒：表 / 图 / 公式编号在对象数内，\\ref 与引文键存在", () => {
    expect(statusOf("Table 2 and Fig. 1 contradict Eq. (3); see \\ref{tab:main}, \\eqref{eq:loss}, \\cite{lee2021}.", idx)).toEqual({
      "Table 2": "VALID", "Fig. 1": "VALID", "Eq. (3)": "VALID", "\\ref{tab:main}": "VALID", "\\ref{eq:loss}": "VALID", "\\cite{lee2021}": "VALID",
    });
    expect(assessFindingLocators("Table 1 is fine.", idx).status).toBe("VALID");
    expect(assessFindingLocators("No locator at all.", idx).status).toBe("NONE");
  });

  it("align 每行计编号、\\nonumber 不计、equation* 不计：上界 = 1 + 2 = 3，Eq. (4) 才是无效", () => {
    expect(idx.equations.numberedUpperBound).toBe(3);
    expect(statusOf("Eq. (4) is wrong.", idx)["Eq. (4)"]).toBe("INVALID");
  });

  it("预登记无效引用 100% 标 INVALID（表 / 图 / 公式 / 标签 / 引文键 / 中文表述）", () => {
    const text = "Table 5, Figure 3, Eq. (9), \\ref{tab:missing}, \\cite{ghost2019}；另见表 7、图 4 与式(12)。";
    const result = assessFindingLocators(text, idx);
    expect(result.status).toBe("INVALID_LOCATOR");
    expect(result.refs.every((entry) => entry.status === "INVALID")).toBe(true);
    expect(result.refs.map((entry) => entry.ref).sort()).toEqual(["Eq. (9)", "Figure 3", "Table 5", "\\cite{ghost2019}", "\\ref{tab:missing}", "图 4", "式(12)", "表 7"].sort());
  });

  it("重复标签 / 分节编号 / 子公式 / 计数器重置：UNVERIFIABLE，不断言存在或不存在", () => {
    const dup = index(`${AUTHOR_TEX}\n\\label{tab:main}`);
    expect(statusOf("\\ref{tab:main}", dup)["\\ref{tab:main}"]).toBe("UNVERIFIABLE");
    expect(statusOf("Eq. (3.2) and Eq. (2a)", idx)).toEqual({ "Eq. (3.2)": "UNVERIFIABLE", "Eq. (2a)": "UNVERIFIABLE" });
    const reset = index(`${AUTHOR_TEX}\n\\numberwithin{equation}{section}`);
    expect(statusOf("Eq. (7)", reset)["Eq. (7)"]).toBe("UNVERIFIABLE");
  });
});

describe("findingLocators：PDF 转写稿（M16 新留出集形态）", () => {
  // 无编号公式（\[…\]）、无 \label、无 \cite、无 figure 环境，但正文自己提到 Eq. 9 与 Table 3
  const TRANSCRIPT = [
    "Our objective is \\[ L = a + b \\] and the bound in Eq. 9 follows.",
    "Results are in Table 3. As reported in [12], see also [3-5].",
    "[12] A. Author. Some paper. 2020.",
  ].join("\n");
  const idx = index(TRANSCRIPT, "SOURCE_UNVERIFIED", 1);

  it("丢了编号的公式：UNVERIFIABLE（旧检测把这类 22/22 报成「不存在」）；正文自己提到的编号 VALID", () => {
    expect(statusOf("Eq. (14) contradicts the text.", idx)["Eq. (14)"]).toBe("UNVERIFIABLE");
    // 编号连续：正文提到 Eq. 9 → 1..9 存在
    expect(statusOf("Eq. (9) and Eq. (6) are unclear.", idx)).toEqual({ "Eq. (9)": "VALID", "Eq. (6)": "VALID" });
  });

  it("无 figure / label / cite 结构：UNVERIFIABLE；有表结构时超出对象与提及的表号仍 INVALID", () => {
    expect(statusOf("Figure 2, \\ref{fig:x}, \\cite{foo}", idx)).toEqual({ "Figure 2": "UNVERIFIABLE", "\\ref{fig:x}": "UNVERIFIABLE", "\\cite{foo}": "UNVERIFIABLE" });
    expect(statusOf("Table 3 vs Table 8", idx)).toEqual({ "Table 3": "VALID", "Table 8": "INVALID" });
  });

  it("数字引文：正文出现过（含区间 [3-5]）VALID；超出全部编号 INVALID", () => {
    expect(statusOf("[12] and [4] and [40]", idx)).toEqual({ "[12]": "VALID", "[4]": "VALID", "[40]": "INVALID" });
  });

  it("作者源稿以外，「该类对象一个都没有」不判 INVALID（可能是抽取丢失）", () => {
    const empty = index("Plain text without any structure.", "SOURCE_UNKNOWN", 0);
    expect(statusOf("Table 2 and Eq. (1)", empty)).toEqual({ "Table 2": "UNVERIFIABLE", "Eq. (1)": "UNVERIFIABLE" });
    const authorEmpty = index("Plain text without any structure.", "AUTHOR_SOURCE", 0);
    expect(statusOf("Table 2 and Eq. (1)", authorEmpty)).toEqual({ "Table 2": "INVALID", "Eq. (1)": "INVALID" });
  });
});

describe("verifyFindings：定位三态进入产物，不删除 / 不改写 finding", () => {
  const issue = (description: string): ReviewIssue => ({ category: "academic", severity: "major", section: "Method", description, quote: "We minimise the loss in", blocking: false } as ReviewIssue);

  it("INVALID → anchor.reliable=false、danglingReferences 列出；UNVERIFIABLE 单独计数；意见文本原样保留", () => {
    const artifact = verifyFindings({
      round: 1, sourceRevision: 1, files: [{ file: "main.tex", content: AUTHOR_TEX }],
      issues: [issue("Table 9 is inconsistent."), issue("Eq. (3.1) is unclear."), issue("Table 1 is fine.")],
      sourceVerification: "AUTHOR_SOURCE", findingFingerprint: (entry) => entry.description,
    });
    const [invalid, unverifiable, valid] = artifact.records;
    expect(invalid!.anchor).toMatchObject({ status: "LOCATED", reliable: false, danglingReferences: ["Table 9"] });
    expect(invalid!.anchor.locator?.status).toBe("INVALID_LOCATOR");
    expect(unverifiable!.anchor).toMatchObject({ status: "LOCATED", reliable: true, danglingReferences: [] });
    expect(unverifiable!.anchor.locator?.status).toBe("UNVERIFIABLE_LOCATOR");
    expect(valid!.anchor.locator?.status).toBe("VALID");
    expect(artifact.summary).toMatchObject({ findings: 3, located: 3, reliablyLocated: 2, danglingReferences: 1, unverifiableLocators: 1 });
    expect(artifact.records.map((record) => record.findingId)).toEqual(["Table 9 is inconsistent.", "Eq. (3.1) is unclear.", "Table 1 is fine."]);
  });
});
