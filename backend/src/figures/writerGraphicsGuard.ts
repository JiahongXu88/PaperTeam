/**
 * Writer 图形输出守卫（M12.3 C5/C6）：Writer 输出的 LaTeX 片段里图形相关
 * 命令的确定性白名单检查。
 *
 * 边界语义（M12.0 冻结的「禁令改资产白名单」）：
 * - 恒禁：tikz / pgfplots 环境与宏包（arbitrary raw TikZ 不存在合法路径）；
 * - 恒禁：新增 / 改写 / 删除 \includegraphics（插图只能由图表流水线的受控
 *   action 完成）。修订已有章节时，基线里既有的受控图资产路径必须原样保留
 *   （删图 = 破坏已插入资产；换路径 = 未登记资产注入）；
 * - 恒许：\ref{fig:...} 文本引用（Writer 引用已存在图表是合法且被鼓励的）。
 *
 * 纯函数、零 IO；违规返回人读消息，通过返回 null。
 */

const GRAPHICS_ENVIRONMENT_PATTERN = /\\begin\{(?:tikzpicture|axis|semilogxaxis|groupplot)\b/;
const GRAPHICS_PACKAGE_PATTERN = /\\usepackage(?:\[[^\]]*\])?\{[^}]*(?:tikz|pgfplots|pgf)[^}]*\}/;
const INCLUDEGRAPHICS = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;

function extractGraphicsPaths(latex: string): string[] {
  const paths: string[] = [];
  INCLUDEGRAPHICS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INCLUDEGRAPHICS.exec(latex)) !== null) {
    paths.push((match[1] ?? "").trim());
  }
  return paths;
}

/**
 * @param output Writer 输出的章节 LaTeX
 * @param baseline 修订基线（当前章节内容；全新写作时 undefined）
 */
export function screenWriterGraphics(params: {
  output: string;
  baseline?: string;
}): string | null {
  const { output, baseline } = params;
  if (GRAPHICS_ENVIRONMENT_PATTERN.test(output)) {
    return "输出包含 tikz/pgfplots 图形环境（禁止手写图形宏包环境；图表由图表流水线受控生成）";
  }
  if (GRAPHICS_PACKAGE_PATTERN.test(output)) {
    return "输出包含 tikz/pgfplots 宏包加载（前导由系统管理，正文片段不允许 \\usepackage 图形宏包）";
  }
  const outputPaths = extractGraphicsPaths(output);
  if (baseline === undefined) {
    if (outputPaths.length > 0) {
      return `全新章节不允许出现 \\includegraphics（${outputPaths.length} 处；插图由图表流水线受控插入，Writer 只能用 \\ref{fig:...} 引用）`;
    }
    return null;
  }
  const baselinePaths = extractGraphicsPaths(baseline);
  const outputSet = new Map<string, number>();
  for (const path of outputPaths) {
    outputSet.set(path, (outputSet.get(path) ?? 0) + 1);
  }
  const baselineSet = new Map<string, number>();
  for (const path of baselinePaths) {
    baselineSet.set(path, (baselineSet.get(path) ?? 0) + 1);
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, count] of outputSet) {
    if ((baselineSet.get(path) ?? 0) < count) {
      added.push(path);
    }
  }
  for (const [path, count] of baselineSet) {
    if ((outputSet.get(path) ?? 0) < count) {
      removed.push(path);
    }
  }
  if (added.length > 0) {
    return `修订新增了 \\includegraphics（${added.join("、")}）——插图必须经图表流水线受控插入，不允许 Writer 手写`;
  }
  if (removed.length > 0) {
    return `修订删除了 \\includegraphics（${removed.join("、")}）——已插入图表资产不允许在修订中移除（如需替换请走图表 replace 流程）`;
  }
  return null;
}
