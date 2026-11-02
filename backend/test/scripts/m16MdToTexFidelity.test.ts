/**
 * M16 收口 · A：benchmark 输入保真适配器（scripts/m16-closure/md-to-tex-fidelity.mjs）确定性回归。
 *
 * 旧 M15 适配器（md_to_tex.mjs，仓库外）对正文整体 esc()：`$\mu_k^n$` → `\$\textbackslash{}mu\_k\^{}n\$`。
 * 这里逐字内嵌其 esc 规则作为「旧版本失败」对照（legacyParagraph），并断言新适配器：
 * 数学逐字直通、正文仍转义、原稿错误保留并归因原稿、比较器能抓到旧版残留。
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const modulePath = join(repoRoot, "scripts", "m16-closure", "md-to-tex-fidelity.mjs");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;
beforeAll(async () => {
  F = await import(pathToFileURL(modulePath).href);
});

/** M15 md_to_tex.mjs（md5 7b167b58…）正文段落规则的逐字复刻：整块 esc，不识别数学 */
const LEGACY_ESC: Record<string, string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "%": "\\%", _: "\\_", "^": "\\^{}", "~": "\\~{}" };
const legacyParagraph = (s: string) => s.replace(/[\\{}$&#%_^~]/g, (c) => LEGACY_ESC[c]!);

const doc = (body: string) => `# A Title\n\n# 1 Introduction\n\n${body}\n`;

describe("M16 closure · MD→LaTeX fidelity adapter", () => {
  it("reproduces the legacy failure: inline math becomes literal escaped text", () => {
    const legacy = legacyParagraph("the target $\\pi$ and iterate $\\mu_k^n$");
    expect(legacy).toContain("\\$\\textbackslash{}mu\\_k\\^{}n\\$");
    const cmp = F.compareFidelity(doc("the target $\\pi$ and iterate $\\mu_k^n$"), legacy);
    expect(cmp.math.preserved).toBe(0);
    expect(cmp.escapedMathResidue).toBeGreaterThan(0);
  });

  it("passes inline, \\( \\), display, aligned/equation environments and \\tag through verbatim", () => {
    const md = doc(
      [
        "where $C > 0$ and $\\mathcal{I}_{\\mathrm{stein}}(\\mu_k^n \\| \\pi) < C'/k$ hold, also \\(x^2\\).",
        "$$\n\\pi (x) \\propto \\exp (- F (x)), \\tag {1}\n$$",
        "\\begin{equation}\\label{eq:loss} L = \\sum_i \\ell_i \\end{equation}",
        "$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$",
        "\\[ E = mc^2 \\]",
      ].join("\n\n"),
    );
    const { tex, report } = F.markdownToLatexFidelity(md, "en");
    expect(tex).toContain("$C > 0$");
    expect(tex).toContain("$\\mathcal{I}_{\\mathrm{stein}}(\\mu_k^n \\| \\pi) < C'/k$");
    expect(tex).toContain("$x^2$");
    expect(tex).toContain("\\[\n\\pi (x) \\propto \\exp (- F (x)), \\tag {1}\n\\]");
    expect(tex).toContain("\\begin{equation}\\label{eq:loss} L = \\sum_i \\ell_i \\end{equation}");
    expect(tex).toContain("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}");
    expect(tex).toContain("E = mc^2");
    expect(tex).not.toContain("\\textbackslash{}");
    expect(report.math.map((m: { kind: string }) => m.kind)).toEqual(["environment", "display", "display", "display", "inline", "inline", "inline"]);
    const cmp = F.compareFidelity(md, tex);
    expect(cmp.math.preserved).toBe(cmp.math.total);
    expect(cmp.escapedMathResidue).toBe(0);
  });

  it("still escapes prose specials, keeps \\$ as a literal dollar, \\ref/\\cite text, numbers and Unicode", () => {
    const md = doc("Cost is 50% of \\$30 & the R_2 score #1 rose 0.91→0.95 (see Eq. \\eqref{e1}, \\cite{smith}) — naïve ünïcode 中文 [12, 15].");
    const { tex } = F.markdownToLatexFidelity(md, "en");
    expect(tex).toContain("50\\% of \\$30 \\& the R\\_2 score \\#1 rose 0.91→0.95");
    expect(tex).toContain("naïve ünïcode 中文 [12, 15]");
    const cmp = F.compareFidelity(md, tex);
    expect(cmp.numbers.preserved).toBe(cmp.numbers.total);
    expect(cmp.citeMarkers).toEqual({ total: 1, preserved: 1 });
  });

  it("treats currency-like $…$ prose as text, not math", () => {
    const { tex, report } = F.markdownToLatexFidelity(doc("shorts cost $16.50. One pair of pants costs $22.50 and shoes $42."), "en");
    expect(tex).toContain("\\$16.50. One pair of pants costs \\$22.50 and shoes \\$42.");
    expect(report.math).toHaveLength(0);
    expect(report.notes.CURRENCY_DOLLAR_AS_TEXT).toBeGreaterThan(0);
  });

  it("negative control: invalid source LaTeX is kept verbatim and attributed to the source, not repaired", () => {
    const md = doc("broken $\\frac{a}{b$ here and $$\n\\left( x + y\n$$\n\nand an unpaired $ sign. Table 2 reports 0.19 (teh typo).");
    const { tex, report } = F.markdownToLatexFidelity(md, "en");
    expect(tex).toContain("$\\frac{a}{b$");
    expect(tex).toContain("\\left( x + y");
    expect(report.notes.SOURCE_MATH_UNBALANCED_BRACES).toBe(1);
    expect(report.notes.SOURCE_MATH_LEFT_RIGHT_MISMATCH).toBe(1);
    expect(report.notes.SOURCE_UNPAIRED_DOLLAR).toBe(1);
    expect(tex).toContain("Table 2 reports 0.19 (teh typo).");
  });

  it("maps numbered MinerU headings to depth, keeps numbering text, and handles CRLF/CR line endings", () => {
    const md = "# Title\r\n\r\n# ABSTRACT\r\n\r\nabs\r\r# 1 INTRODUCTION\n\n# 1.1 Related works\n\n# 3.2.1 Detail\n\n# A.1 Proofs\n\ntext\n\n# References\n\n- [1] Doe, $O(n)$ bound.\n";
    const { tex, report } = F.markdownToLatexFidelity(md, "en");
    expect(report.headings).toEqual([
      { level: 1, text: "ABSTRACT" },
      { level: 1, text: "1 INTRODUCTION" },
      { level: 2, text: "1.1 Related works" },
      { level: 3, text: "3.2.1 Detail" },
      { level: 2, text: "A.1 Proofs" },
    ]);
    expect(tex).toContain("\\subsection*{1.1 Related works}");
    expect(tex).toContain("\\bibitem{ref1} [1] Doe, $O(n)$ bound.");
    expect(tex).not.toContain("\r");
  });

  it("converts HTML tables with math cells and entities; marks figures and simplified layout explicitly", () => {
    const md = doc('<table><tr><td>Model</td><td>Score</td></tr><tr><td rowspan="2">Let&#x27;s $\\alpha_1$</td><td>0.93<sup>*</sup></td></tr></table>\n\n![](images/abc.jpg)');
    const { tex, report } = F.markdownToLatexFidelity(md, "en");
    expect(tex).toContain("Let's $\\alpha_1$ & 0.93\\textsuperscript{*} \\\\");
    expect(tex).toContain("\\textit{[Figure image not available as text]}");
    expect(report.notes).toMatchObject({ TABLE_LAYOUT_SIMPLIFIED: 1, FIGURE_NOT_READABLE: 1 });
    expect(tex).not.toContain("<td");
  });
});
