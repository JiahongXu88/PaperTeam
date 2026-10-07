/**
 * M4.7 / M12.2.5 LaTeX 编译日志 → 结构化诊断测试。
 *
 * 覆盖：错误行 + l.NNN 行号 + 文件栈归属；上限 5 条；
 * M12.2.5 字体问题分类（fontspec / xeCJK / not loadable → kind="font" + 平台
 * 修复建议——用户不能只看到 "xelatex failed" 而不知道是字体缺失）。
 */

import { describe, expect, it } from "vitest";

import { diagnosticFiles, parseLatexDiagnostics } from "../../src/latex/diagnostics.js";

describe("parseLatexDiagnostics", () => {
  it("错误行 + 行号 + 文件栈归属", () => {
    const log = [
      '("./sections/intro.tex"',
      '! Undefined control sequence.',
      'l.42 \\badcommand',
      ')',
      '! LaTeX Error: File `missing.sty\' not found.',
    ].join("\n");
    const diagnostics = parseLatexDiagnostics(log);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ file: "sections/intro.tex", line: 42, message: "! Undefined control sequence." });
    expect(diagnostics[0]!.kind).toBeUndefined();
    expect(diagnostics[1]!.file).toBeNull();
  });

  it("最多 5 条（多错误日志截断）", () => {
    const log = Array.from({ length: 8 }, (_, i) => `! Error number ${i}`).join("\n");
    expect(parseLatexDiagnostics(log)).toHaveLength(5);
  });

  it("diagnosticFiles 去重收集（null 跳过）", () => {
    const log = ['("./a.tex"', "! Err one.", ")", '("./b.tex"', "! Err two.", ")", "! Err three."].join("\n");
    const files = diagnosticFiles(parseLatexDiagnostics(log));
    expect(files).toEqual(["a.tex", "b.tex"]);
  });

  it("M12.2.5 字体问题 → kind=font + 可执行安装建议", () => {
    const logs = [
      '! Package fontspec Error: The font "SimSun" cannot be found.',
      '! Package xeCJK Error: Font family "FandolSong" cannot be found.',
      "! Font \\U/xxxx not loadable: Metric (TFM) file not found.",
      "! LaTeX Error: The font size 10.5pt is not available.",
    ];
    for (const log of logs) {
      const [diagnostic] = parseLatexDiagnostics(log);
      expect(diagnostic, log).toBeDefined();
      expect(diagnostic!.kind, log).toBe("font");
      expect(diagnostic!.hint, log).toContain("texlive-lang-chinese");
      expect(diagnostic!.hint, log).toContain("MiKTeX");
    }
    // 非字体错误不误标
    const [plain] = parseLatexDiagnostics("! Undefined control sequence.");
    expect(plain!.kind).toBeUndefined();
    expect(plain!.hint).toBeUndefined();
  });
});
