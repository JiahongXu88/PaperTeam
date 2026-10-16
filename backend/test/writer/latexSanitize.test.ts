/**
 * M14.6：Writer 输出裸百分号转义（案例 B 真实 PDF 文本丢失根因）。
 */
import { describe, expect, it } from "vitest";

import { countBarePercentAfterDigits, escapeBarePercentAfterDigits } from "../../src/writer/latexSanitize.js";

describe("M14.6 — 裸百分号转义", () => {
  it("数字后的裸 % 转义为 \\%（含一个空格的形态）；已转义不重复", () => {
    expect(escapeBarePercentAfterDigits("高度跟踪误差降低了 75.37%。后文")).toBe("高度跟踪误差降低了 75.37\\%。后文");
    expect(escapeBarePercentAfterDigits("降低 75.37 % 的幅度")).toBe("降低 75.37 \\% 的幅度");
    expect(escapeBarePercentAfterDigits("已转义 75.37\\% 不动")).toBe("已转义 75.37\\% 不动");
    expect(countBarePercentAfterDigits("a 10% b 20\\% c 30%")).toBe(2);
  });

  it("注释 / 协议行 / 非数字前缀的 % 不动", () => {
    expect(escapeBarePercentAfterDigits("% 这是注释\n正文")).toBe("% 这是注释\n正文");
    expect(escapeBarePercentAfterDigits("%%%PT-OUTCOMES%%% {}")).toBe("%%%PT-OUTCOMES%%% {}");
    expect(escapeBarePercentAfterDigits("文字 % 注释 50")).toBe("文字 % 注释 50");
  });

  it("幂等", () => {
    const once = escapeBarePercentAfterDigits("A 12% B 3.5 % C");
    expect(escapeBarePercentAfterDigits(once)).toBe(once);
  });
});
