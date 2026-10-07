/**
 * PlotSpec → PGFPlots TeX 确定性 codegen（M12.3 C2）。
 *
 * 设计纪律：
 *
 * 1. 确定性（同 spec → 字节级同 TeX）：
 *    - 文档骨架钉死：standalone + border=2pt、\usepackage{pgfplots}、
 *      \pgfplotsset{compat=1.18}（compat 不钉死会随 pgfplots 版本漂移）；
 *    - 数值格式化统一走 formatNumber（toFixed 定点 + 去尾零；不用
 *      toPrecision / String(number)——两者会产出科学计数法与平台相关的
 *      有效位漂移，例如 0.1+0.2 的经典表示问题必须被规整掉）；
 *    - 坐标顺序有规范规则：line / scatter 按数值 x 稳定升序（行序扰动不
 *      改变输出）；bar / grouped_bar 的类目序 = 数据集行序（类目是名义量，
 *      作者的行序即语义序——重排行是数据变化，datasetHash 会如实反映）；
 *    - series 顺序 = spec 声明顺序（legend 同序）；axis 选项按固定次序拼接
 *      （条形选项 → tick 选项 → title → 轴名 → 宽高），行尾逗号规则固定
 *      （除末行外每行一个逗号）。
 *
 * 2. 图型模板（每型一个选项模板，不搞通用图形语法）：line（折线+标记）、
 *    scatter（散点）、bar / grouped_bar（共用 ybar 模板；pgfplots 的 ybar
 *    按 plot 序自动错位，系列数区分两形态）。semantic 元数据只是标注，
 *    不派生 renderer（M12.0 §11.2 冻结）。
 *
 * 3. 类目轴实现：bar/grouped_bar 把 x 当类目——坐标用行索引（0..n-1），
 *    文本经 xticklabels 提供（每项独立成组，标签里的逗号不会切断列表）。
 *    不用 symbolic x coords（该机制对含逗号/特殊字符的类目名更脆弱）。
 *
 * 4. 注入安全：全部用户文本（title / 轴名 / series 名 / 类目标签）经
 *    escapeLatex（figures/latexEscape.ts 唯一出口）后才能进入 TeX。
 *
 * 5. 缺失值：missingPolicy=skip_row 的行在渲染前确定性丢弃（规则与校验层
 *    一致：使用的列含 null 即丢弃整行）；reject 策略下校验层已保证无 null，
 *    这里对漏网缺失防御性抛错（codegen 不静默产出坏数据图）。
 */

import { containsCjk, escapeLatex } from "./latexEscape.js";
import type { NormalizedPlotSpec } from "./spec.js";

/**
 * 数值 → TeX 定点字符串（确定性唯一出口）。
 * - 整数：定点输出（< 1e21 用 toFixed(0)；≥ 1e21 时 toFixed 会切换科学计数
 *   法——用 BigInt 精确展开，双精度整数在此范围内无精度损失）；
 * - 非整数：toFixed(10) 后去尾零（非整数的 |值| 必 < 2^53 < 1e21，toFixed
 *   不会走指数形态；10 位小数足够图表量级，且彻底避免二进制浮点的有效位
 *   噪声，如 0.1+0.2 的经典表示问题被规整为 0.3）；
 * - "-0" 规整为 "0"；全程无科学计数法（TeX 数值解析不接受指数形态）。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // 校验层（spec.ts）已拒绝非有限数值；到达这里说明内部契约被破坏
    throw new Error(`formatNumber 收到非有限数值：${String(value)}`);
  }
  if (Number.isInteger(value)) {
    return Math.abs(value) < 1e21 ? value.toFixed(0) : String(BigInt(value));
  }
  const trimmed = value
    .toFixed(10)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

/** 渲染行（缺失行已按策略丢弃；values 恒为有限数值） */
interface PlotRow {
  /** 数值 x（line/scatter）或行索引（bar/grouped_bar） */
  x: number;
  /** 类目标签原文（bar/grouped_bar；line/scatter 无） */
  category?: string;
  /** 每个 series 一个数值（与 spec.data.series 同序） */
  values: number[];
}

/** 提取并规范化渲染行：缺失策略 → 数值规整 → 类目索引 / 数值排序 */
function prepareRows(spec: NormalizedPlotSpec): PlotRow[] {
  const dataset = spec.data.inlineDataset;
  const xColumn = spec.data.x[0];
  if (xColumn === undefined) {
    throw new Error("prepareRows：spec.data.x 为空（校验层应已拒绝）");
  }
  const xIndex = dataset.columns.indexOf(xColumn);
  const seriesIndexes = spec.data.series.map((series) => dataset.columns.indexOf(series.column));
  const categorical = spec.plotType === "bar" || spec.plotType === "grouped_bar";
  const skipMissing = spec.data.missingPolicy === "skip_row";

  const rows: PlotRow[] = [];
  for (const row of dataset.rows) {
    const xCell = row[xIndex];
    const seriesCells = seriesIndexes.map((index) => row[index]);
    if (xCell === null || seriesCells.some((cell) => cell === null)) {
      if (skipMissing) {
        continue; // 显式策略：丢弃整行（不静默填 0）
      }
      // reject 策略下校验层已拒绝——漏网即内部契约破坏
      throw new Error("prepareRows：reject 策略下仍出现缺失值（校验层应已拒绝）");
    }
    const values = seriesCells.map((cell) => {
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        throw new Error("prepareRows：series 单元格不是有限数值（校验层应已拒绝）");
      }
      return cell;
    });
    if (categorical) {
      if (xCell === undefined) {
        throw new Error("prepareRows：类目 x 缺失（校验层应已拒绝）");
      }
      rows.push({
        x: 0, // 行索引在收集完成后统一回填
        category: typeof xCell === "number" ? formatNumber(xCell) : xCell,
        values,
      });
    } else {
      if (typeof xCell !== "number" || !Number.isFinite(xCell)) {
        throw new Error("prepareRows：line/scatter 的 x 不是有限数值（校验层应已拒绝）");
      }
      rows.push({ x: xCell, values });
    }
  }

  if (categorical) {
    rows.forEach((row, index) => {
      row.x = index;
    });
  } else {
    // 数值 x 稳定升序（Node 的 Array.prototype.sort 为稳定排序）：
    // 行序扰动不改变坐标块输出
    rows.sort((a, b) => a.x - b.x);
  }
  return rows;
}

/** 类目标签的 xticklabels 选项（每项独立成组，防标签内逗号切断列表） */
function tickLabelsOption(rows: readonly PlotRow[]): string {
  const entries = rows.map((row) => `{${escapeLatex(row.category ?? formatNumber(row.x))}}`);
  return `xticklabels={${entries.join(",")}}`;
}

/** 各图型的 addplot 选项（clean academic default，不做 theme 工程） */
function plotOptions(plotType: NormalizedPlotSpec["plotType"], markSizePt: number): string {
  const markSize = `mark size=${formatNumber(markSizePt)}pt`;
  switch (plotType) {
    case "line":
      return `[thick, mark=*, ${markSize}]`;
    case "scatter":
      return `[only marks, mark=*, ${markSize}]`;
    case "bar":
    case "grouped_bar":
      // 轴级 ybar 统一开条形；plot 级不再重复（pgfplots 按 plot 序自动错位）
      return "";
  }
}

/** addplot 块（每个 series 一个；series 序 = spec 声明序） */
function plotLines(spec: NormalizedPlotSpec, rows: readonly PlotRow[]): string[] {
  const lines: string[] = [];
  spec.data.series.forEach((_, seriesIndex) => {
    lines.push(`\\addplot+${plotOptions(spec.plotType, spec.axis.renderOptions.markSizePt)} coordinates {`);
    for (const row of rows) {
      const value = row.values[seriesIndex];
      if (value === undefined) {
        throw new Error("plotLines：series 数值缺失（内部契约破坏）");
      }
      lines.push(`  (${formatNumber(row.x)}, ${formatNumber(value)})`);
    }
    lines.push("};");
  });
  return lines;
}

/** plot 全部用户可见文本（title / 轴名 / series 名 / 类目标签）的 CJK 探测 */
function plotHasCjk(spec: NormalizedPlotSpec, rows: readonly PlotRow[]): boolean {
  const texts: Array<string | undefined> = [
    spec.title,
    spec.axis.xLabel,
    spec.axis.yLabel,
    ...spec.data.series.map((series) => series.name),
    ...rows.map((row) => row.category),
  ];
  return texts.some((text) => text !== undefined && containsCjk(text));
}

/** PlotSpec → 独立编译的 standalone TeX 文档（字节确定性） */
export function renderPlotTeX(spec: NormalizedPlotSpec): string {
  const rows = prepareRows(spec);
  const categorical = spec.plotType === "bar" || spec.plotType === "grouped_bar";

  const axisOptions: string[] = [];
  if (categorical) {
    axisOptions.push("ybar", "enlarge x limits=0.2", "xtick=data", tickLabelsOption(rows));
  }
  if (spec.title !== undefined) {
    axisOptions.push(`title={${escapeLatex(spec.title)}}`);
  }
  if (spec.axis.xLabel !== undefined) {
    axisOptions.push(`xlabel={${escapeLatex(spec.axis.xLabel)}}`);
  }
  if (spec.axis.yLabel !== undefined) {
    axisOptions.push(`ylabel={${escapeLatex(spec.axis.yLabel)}}`);
  }
  axisOptions.push(`width=${formatNumber(spec.axis.renderOptions.widthCm)}cm`);
  axisOptions.push(`height=${formatNumber(spec.axis.renderOptions.heightCm)}cm`);

  // 选项行尾逗号规则固定：除末行外每行一个逗号
  const optionLines = axisOptions.map((option, index) =>
    index === axisOptions.length - 1 ? `  ${option}` : `  ${option},`,
  );

  const lines: string[] = [
    "\\documentclass[border=2pt]{standalone}",
    // CJK 文本（title / 轴名 / series 名 / 类目标签）→ ctex 导言（按平台
    // 自动选字体：Windows 中易体系 / TeX Live Fandol；无 CJK 不加载，保持
    // 纯 ASCII 图的编译零额外依赖）
    ...(plotHasCjk(spec, rows) ? ["\\usepackage[UTF8]{ctex}"] : []),
    "\\usepackage{pgfplots}",
    "\\pgfplotsset{compat=1.18}",
    "\\begin{document}",
    "\\begin{tikzpicture}",
    "\\begin{axis}[",
    ...optionLines,
    "]",
    ...plotLines(spec, rows),
  ];
  if (spec.axis.legend) {
    const entries = spec.data.series.map((series) => `{${escapeLatex(series.name)}}`);
    lines.push(`\\legend{${entries.join(",")}}`);
  }
  lines.push("\\end{axis}", "\\end{tikzpicture}", "\\end{document}");

  return `${lines.join("\n")}\n`;
}
