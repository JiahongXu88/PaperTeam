/**
 * M14.6：Writer 输出的确定性 LaTeX 卫生处理（不改语义，只修会让编译器吞掉正文的字面错误）。
 *
 * 实证（M14.5 案例 B 真实 42 页 Draft，art-draft-rev2.pdf）：Writer 把百分数写成裸 `75.37%`，
 * LaTeX 把 `%` 当注释起点——「误差降低 75.37% 的幅度表明，……」整句后半在 PDF 中消失，
 * 「高度跟踪误差降低了 75.37%。」丢失句号。合法科研事实在编译产物里被静默截断，任何
 * 文本层守卫都看不到（守卫看的是 .tex 源）。
 *
 * 规则（保守）：仅转义**紧跟在数字之后**（允许一个空格）的裸 `%`，这是百分号而非注释的
 * 确定性信号；其它位置的 `%`（行首注释、`\%` 已转义、`\\%%` 协议行）一律不动。
 */

const BARE_PERCENT_AFTER_DIGIT = /(\d)([  ]?)%(?!%)/g;

export function escapeBarePercentAfterDigits(latex: string): string {
  return latex.replace(BARE_PERCENT_AFTER_DIGIT, (match: string, digit: string, space: string, offset: number, source: string) => {
    // 已转义（`\%`）不可能匹配到本模式（前一字符是数字/空格而非反斜杠）；
    // 但防御 `\\` 转义链：数字前若恰为奇数个反斜杠（极罕见）也不动
    if (offset > 0 && source[offset - 1] === "\\") return match;
    return `${digit}${space}\\%`;
  });
}

/** 统计仍存在的裸百分号（诊断 / 测试用） */
export function countBarePercentAfterDigits(latex: string): number {
  return [...latex.matchAll(BARE_PERCENT_AFTER_DIGIT)].length;
}
