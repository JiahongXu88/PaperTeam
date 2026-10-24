/**
 * M15.4.2（B4）claimGuards 共享守卫等价性测试：claimCertificate 与 candidateProposer 的单一事实来源。
 *
 * 逐字迁移自 claimCertificate@1c7713d（行为等价由本文件 + claimCertificate / SemanticBinding / CrossTable
 * 全套件共同证明）；本文件覆盖守卫本身的正反例与跨臂一致性（同输入 → 同输出）。
 */
import { describe, expect, it } from "vitest";

import {
  DERIVED_COLUMN_HEADER, OWN_ALIASES, OWN_ROW, QUALIFIER_FAMILIES, QUALIFIER_LEXICON, STOP,
  crossTableValueCompetitors, mentions, qualifierRejections, rowIsOwn, type GuardContext,
} from "../../src/review/claimGuards.js";
import { buildCertificateDocument, bindTextAtom, contextTokens, locateAtom } from "../../src/review/claimCertificate.js";
import { plainLatexText } from "../../src/review/latexTable.js";

const ctx = (text: string): GuardContext => ({ tokens: new Set(contextTokens(text)), plain: plainLatexText(text).toLowerCase() });

describe("M15.4.2 claimGuards 词表迁移等价", () => {
  it("STOP 覆盖既有语义样本（含 method/model/ours/proposed…）", () => {
    for (const token of ["the", "method", "models", "ours", "proposed", "vs", "via"]) expect(STOP.has(token)).toBe(true);
    for (const token of ["betanet", "maf1", "top-1", "alphanet"]) expect(STOP.has(token)).toBe(false);
  });

  it("OWN_ALIASES / OWN_ROW 与生产语义一致（ours/our/we/proposed；行判别含 our method）", () => {
    expect(OWN_ALIASES.test("ours")).toBe(true);
    expect(OWN_ALIASES.test("our final submission")).toBe(true);
    expect(OWN_ALIASES.test("theirs")).toBe(false);
    expect(OWN_ROW.test("our method")).toBe(true);
    expect(OWN_ROW.test("TeamPAK (ours)")).toBe(true);
    expect(OWN_ROW.test("Baseline A")).toBe(false);
  });

  it("QUALIFIER_LEXICON / FAMILIES 内容完整（validation/w/o/zero-shot；reproduce 家族）", () => {
    expect(QUALIFIER_LEXICON).toContain("validation");
    expect(QUALIFIER_LEXICON).toContain("w/o");
    expect(QUALIFIER_FAMILIES[0]).toContain("reproduced");
    expect(QUALIFIER_FAMILIES[0]).toContain("复现");
  });

  it("DERIVED_COLUMN_HEADER 与生产 tabulatedDerived 同一判别（Improv./Gain/Δ/Rel.）", () => {
    expect(DERIVED_COLUMN_HEADER.test("Improv.")).toBe(true);
    expect(DERIVED_COLUMN_HEADER.test("Gain (%)")).toBe(true);
    expect(DERIVED_COLUMN_HEADER.test("Δ")).toBe(true);
    expect(DERIVED_COLUMN_HEADER.test("Rel.")).toBe(true);
    expect(DERIVED_COLUMN_HEADER.test("Acc")).toBe(false);
  });
});

describe("M15.4.2 claimGuards 判别函数", () => {
  it("mentions：拉丁词元相等 / 中文子串包含", () => {
    expect(mentions(ctx("Macro-F1 and Acc on MOT17"), "mot17")).toBe(true);
    expect(mentions(ctx("Macro-F1 and Acc on MOT17"), "mot20")).toBe(false);
    expect(mentions(ctx("在 MOT17 数据集上"), "数据集")).toBe(true);
  });

  it("rowIsOwn：ownTerms 命中与 OWN_ROW 正则（与生产 rowIsOwn 相同输入相同输出）", () => {
    const document = buildCertificateDocument([{ file: "m.tex", content: "\\title{PatchMix Graph Learning}\n\\begin{tabular}{lc}\\toprule Method & MaF1 \\\\ \\midrule PatchMix & 84.5 \\\\ Proposed & 84.6 \\\\ Rival & 80.0 \\\\ \\bottomrule \\end{tabular}\n" }]);
    const table = document.files[0]!.tables[0]!;
    const rowKeys = table.rows.filter((r) => r.kind === "data").map((r) => r.cells[0]!);
    expect(rowIsOwn(document, rowKeys[0]!)).toBe(true); // ownTerms: patchmix/graph/learning
    expect(rowIsOwn(document, rowKeys[1]!)).toBe(true); // OWN_ROW: proposed
    expect(rowIsOwn(document, rowKeys[2]!)).toBe(false);
  });

  it("qualifierRejections：写了未被语境解释 → 拒；家族互通解释 → 过", () => {
    expect(qualifierRejections(ctx("our reproduced method achieves 84.5"), ctx("Main results on Bench-R. MaF1 Proposed"))).toContain("reproduced");
    expect(qualifierRejections(ctx("our reproduced method achieves 84.5"), ctx("Reproduction of prior methods. MaF1 Proposed"))).toEqual([]);
    expect(qualifierRejections(ctx("on the validation split"), ctx("Validation set split results."))).toEqual([]);
    expect(qualifierRejections(ctx("on the validation split"), ctx("Test set results."))).toContain("validation");
  });

  it("crossTableValueCompetitors：值逐字出现在非命中表 → 列出；纯数字守卫", () => {
    const document = buildCertificateDocument([{ file: "m.tex", content: [
      "\\title{T}",
      "\\begin{table}[t]\\caption{A.}\\label{t:1}\\begin{tabular}{lc}\\toprule M & V \\\\ \\midrule X & 84.5 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\begin{table}[t]\\caption{B.}\\label{t:2}\\begin{tabular}{lc}\\toprule M & V \\\\ \\midrule Y & 83.7 \\\\ \\bottomrule \\end{tabular}\\end{table}",
    ].join("\n") }]);
    const other = crossTableValueCompetitors(document, [{ file: "m.tex", tableIndex: 0 }], "83.7");
    expect(other).toHaveLength(1);
    expect(crossTableValueCompetitors(document, [{ file: "m.tex", tableIndex: 0 }], "84.5")).toEqual([]);
    expect(crossTableValueCompetitors(document, [{ file: "m.tex", tableIndex: 0 }], "84.5%")).toEqual([]); // 非纯数字不扫
  });

  it("跨臂一致性：bindTextAtom 的 B3 拒绝路径经由共享函数（reproduced 未解释）", () => {
    const document = buildCertificateDocument([{ file: "m.tex", content: [
      "\\title{T}",
      "\\begin{table}[t]\\caption{A.}\\label{t:1}\\begin{tabular}{lc}\\toprule M & MaF1 \\\\ \\midrule Proposed & 84.5 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{R}",
      "Our reproduced method achieves a MaF1 of 84.5 on the test split.",
      "",
    ].join("\n") }]);
    const content = document.files[0]!.content;
    const start = content.indexOf("84.5 on");
    const located = locateAtom(document, "m.tex", start, start + 4, "84.5");
    expect(located.atom).not.toBeNull();
    const binding = bindTextAtom(document, located.atom!);
    expect(binding.status).toBe("AMBIGUOUS");
    expect(binding.rejections.join(" ")).toMatch(/UNEXPLAINED_QUALIFIER:(reproduced|split)/);
  });
});
