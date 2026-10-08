/**
 * Caption ↔ Dataset 真实性守卫（M12.3 C6）：确定性校验「caption 里的定量声明
 * 是否被数据支撑」。这是防「LLM 编实验曲线 / 编结论」的最后一道确定性闸门。
 *
 * 设计纪律（任务书 §14 + M12.0 §13）：
 * - 不阻断无数值声明的普通 caption（纯定性描述 → PASS）；
 * - 数值声明按语义分桶校验，杜绝「百分点 ↔ 相对百分比」混淆：
 *     value 桶    —— caption 裸数值（含小数）须存在于 dataset 单元格值；
 *     delta 桶    —— "X points / X 个百分点 / X pp" 须匹配行内 / 列内成对差值
 *                    （按声明精度四舍五入比较：claim "2" 匹配 1.9，不匹配 1.4）；
 *     relative 桶 —— "X% / 百分之X / by X percent" 须匹配 (b-a)/a*100 成对相对
 *                    差值（同精度规则）；跨桶命中 = 混淆 → violation；
 *     count 桶    —— "N 个/种/条/行/列/组 / N datasets/methods" 匹配行数/列数/
 *                    series 数 → 否则 UNVERIFIED（计数声明弱断言，交作者）；
 * - 无法可靠校验的声明（全称量词 / 单位冲突 / 大数据集差值跳过）→ UNVERIFIED
 *   （AUTHOR_REVIEW_REQUIRED），绝不伪装 PASS，也绝不二值误杀；
 * - 确定性：同一 (caption, dataset, spec) 输入恒同输出；零模型参与。
 *
 * 返回三态 verdict + 人读 issues（violation 附实际数据锚点）。
 */

import type { InlineDataset, NormalizedPlotSpec } from "./spec.js";

export type CaptionVerdict = "pass" | "unverified" | "violation";

export interface CaptionIssue {
  /** violation（数据不支持）/ unverified（无法可靠校验）/ info（披露性说明） */
  level: "violation" | "unverified" | "info";
  claim: string;
  message: string;
}

export interface CaptionValidation {
  verdict: CaptionVerdict;
  issues: CaptionIssue[];
}

// ---- 数值 token 提取 ----

/** 排除前缀：这些词紧跟的数字不是定量声明（图表编号 / 迭代号等） */
const NON_CLAIM_PREFIX =
  /(?:figure|fig|table|tab|epoch|step|stage|layer|version|chapter|section|图|表|轮|层|阶段)\s*[.:]?\s*$/i;

/** 数值 token：可选符号 / 千分位 / 小数；捕获整数与小数部分 */
const NUMBER_PATTERN = /([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)/g;

interface NumericClaim {
  raw: string;
  value: number;
  /** 声明小数位数（决定差值比较的舍入精度） */
  decimals: number;
  /** 相邻上下文（token 前后各 ~24 字符；用于语言判定） */
  before: string;
  after: string;
}

function extractNumericClaims(caption: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  NUMBER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_PATTERN.exec(caption)) !== null) {
    const raw = match[1] ?? "";
    const value = Number(raw.replaceAll(",", ""));
    if (!Number.isFinite(value)) {
      continue;
    }
    const endIndex = match.index + raw.length;
    const before = caption.slice(Math.max(0, match.index - 24), match.index);
    const after = caption.slice(endIndex, endIndex + 24);
    // 排除：图表编号等非声明数字（前缀紧邻）
    if (NON_CLAIM_PREFIX.test(before)) {
      continue;
    }
    // 排除：标识符内嵌数字（MOT17 / B0001 / YOLOv7 —— 视觉检查同款口径；
    // 这些数字是名称的一部分，不是定量声明）
    const prevChar = caption[match.index - 1];
    const nextChar = caption[endIndex];
    if (/[A-Za-z]/.test(prevChar ?? "") || /[A-Za-z]/.test(nextChar ?? "")) {
      continue;
    }
    const decimalPart = raw.split(".")[1] ?? "";
    claims.push({ raw, value, decimals: decimalPart.length, before, after });
  }
  return claims;
}

// ---- 声明分桶的语言判定 ----

type ClaimBucket = "value" | "delta" | "relative" | "count" | "ignore";

/** 比较语言（提升/降低/差异语境——数字是结论性声明的强信号） */
const COMPARISON_WORDS =
  /(improv|increas|decreas|reduc|gain|drop|by|提升|提高|降低|减少|改善|下降|增加|优于|劣于|相差|差了|涨|跌)/i;

function classifyClaim(claim: NumericClaim): ClaimBucket {
  const { before, after, decimals } = claim;
  const context = `${before} ${after}`;
  // 百分比 / 相对声明
  if (/^\s*(%|％)/.test(after) || /百分之|percent\b|relative/i.test(context)) {
    return "relative";
  }
  // 绝对差值声明（百分点 / points / pp）
  if (
    /^\s*(个?百分点|points?\b|pp\b)/i.test(after) ||
    /percentage points?|百分点/i.test(context)
  ) {
    return "delta";
  }
  // 计数声明（量词 / 可数名词）
  if (
    /^\s*(个|种|条|行|列|组|张|篇|项|datasets?\b|methods?\b|models?\b|sequences?\b|videos?\b|scenes?\b|settings?\b|runs?\b|trials?\b)/i.test(
      after,
    )
  ) {
    return "count";
  }
  // 小数（带小数位的数字几乎总是测量值）
  if (decimals > 0) {
    return "value";
  }
  // 整数 + 比较语境 → 声明性数值
  if (COMPARISON_WORDS.test(context)) {
    return "value";
  }
  // 裸整数（无上下文信号）：不强制（Figure 3 已排除；年份/编号风险高）
  return "ignore";
}

// ---- dataset 数值面（值集 / 差值 / 相对差值；有界计算） ----

const MAX_DIFF_ROWS = 100;

interface DatasetNumericSurface {
  values: number[];
  /** 行内 / 列内成对绝对差 */
  deltas: number[];
  /** 行内 / 列内成对相对差（(b-a)/a*100；分母非零） */
  relativeDeltas: number[];
  rowCount: number;
  columnCount: number;
  diffSkipped: boolean;
  hasMissing: boolean;
}

function buildNumericSurface(dataset: InlineDataset, numericColumnIndexes: Set<number>): DatasetNumericSurface {
  const values: number[] = [];
  const deltas: number[] = [];
  const relativeDeltas: number[] = [];
  let hasMissing = false;
  const numericRows: number[][] = dataset.rows.map((row) => {
    const numericRow: number[] = [];
    row.forEach((cell, columnIndex) => {
      if (typeof cell === "number" && Number.isFinite(cell)) {
        if (numericColumnIndexes.has(columnIndex)) {
          values.push(cell);
          numericRow.push(cell);
        }
      } else if (cell === null) {
        hasMissing = true;
      }
    });
    return numericRow;
  });
  const diffSkipped = dataset.rows.length > MAX_DIFF_ROWS;
  if (!diffSkipped) {
    // 行内成对差（同一行不同列——A vs B 场景）
    for (const row of numericRows) {
      for (let i = 0; i < row.length; i += 1) {
        for (let j = i + 1; j < row.length; j += 1) {
          deltas.push(Math.abs(row[j]! - row[i]!));
          if (row[i] !== 0) {
            relativeDeltas.push(((row[j]! - row[i]!) / Math.abs(row[i]!)) * 100);
          }
        }
      }
    }
    // 列内成对差（同列不同行——baseline 行 vs ours 行场景）
    for (const columnIndex of numericColumnIndexes) {
      const columnValues = dataset.rows
        .map((row) => row[columnIndex])
        .filter((cell): cell is number => typeof cell === "number" && Number.isFinite(cell));
      for (let i = 0; i < columnValues.length; i += 1) {
        for (let j = i + 1; j < columnValues.length; j += 1) {
          const a = columnValues[i]!;
          const b = columnValues[j]!;
          deltas.push(Math.abs(b - a));
          if (a !== 0) {
            relativeDeltas.push(((b - a) / Math.abs(a)) * 100);
          }
        }
      }
    }
  }
  return {
    values,
    deltas,
    relativeDeltas,
    rowCount: dataset.rows.length,
    columnCount: dataset.columns.length,
    diffSkipped,
    hasMissing,
  };
}

function matchesAtPrecision(claim: number, actual: number, decimals: number): boolean {
  const factor = 10 ** decimals;
  return Math.round(actual * factor) / factor === claim;
}

function formatActual(list: number[]): string {
  const shown = [...new Set(list.map((value) => Math.round(value * 100) / 100))]
    .sort((a, b) => a - b)
    .slice(0, 6)
    .map((value) => String(value));
  return shown.join("、");
}

// ---- 主入口 ----

/**
 * 校验 caption 的定量声明是否被 dataset 支撑。
 * - plot：dataset = spec.data.inlineDataset（数值面限定为 x + series 引用的列）；
 * - 纯定性 caption → PASS（issues 可能为空或只有 info）。
 */
export function validateCaptionAgainstDataset(
  caption: string,
  spec: NormalizedPlotSpec,
): CaptionValidation {
  const issues: CaptionIssue[] = [];
  const dataset = spec.data.inlineDataset;
  const usedColumnNames = new Set([spec.data.x[0], ...spec.data.series.map((series) => series.column)]);
  const numericColumnIndexes = new Set<number>();
  dataset.columns.forEach((column, index) => {
    if (usedColumnNames.has(column)) {
      numericColumnIndexes.add(index);
    }
  });
  const surface = buildNumericSurface(dataset, numericColumnIndexes);
  const seriesCount = spec.data.series.length;

  if (surface.hasMissing && spec.data.missingPolicy === "skip_row") {
    issues.push({
      level: "info",
      claim: "缺失值",
      message: `数据集存在缺失值，按 missingPolicy=skip_row 跳过对应行渲染（未补零）`,
    });
  }

  for (const claim of extractNumericClaims(caption)) {
    const bucket = classifyClaim(claim);
    switch (bucket) {
      case "ignore":
        break;
      case "value": {
        if (surface.values.some((value) => matchesAtPrecision(claim.value, value, claim.decimals))) {
          break;
        }
        // "差 X / by X" 语境的数值允许匹配成对差值（小数差值同样是合法声明：
        // "by 1.3" 对 62.1 → 63.4）
        if (surface.deltas.some((delta) => matchesAtPrecision(claim.value, delta, claim.decimals))) {
          break;
        }
        issues.push({
          level: "violation",
          claim: claim.raw,
          message: `数值声明 ${claim.raw} 在图表数据（x/series 列）中不存在，也不匹配任何成对差值（数据值样本：${formatActual(surface.values) || "无"}）`,
        });
        break;
      }
      case "delta": {
        if (surface.deltas.some((delta) => matchesAtPrecision(claim.value, delta, claim.decimals))) {
          break;
        }
        // 跨桶：声明是百分点形态但匹配相对百分比 → 混淆
        if (
          surface.relativeDeltas.some((delta) =>
            matchesAtPrecision(claim.value, delta, claim.decimals),
          )
        ) {
          issues.push({
            level: "violation",
            claim: claim.raw,
            message: `"${claim.raw}（百分点/points）"与数据的相对提升（%）匹配但不匹配任何绝对差值——疑似把相对百分比当成了百分点（绝对差值样本：${formatActual(surface.deltas) || "无"}）`,
          });
          break;
        }
        if (surface.diffSkipped) {
          issues.push({
            level: "unverified",
            claim: claim.raw,
            message: `数据集超过 ${MAX_DIFF_ROWS} 行，成对差值未校验（${claim.raw} 的差值声明需作者确认）`,
          });
          break;
        }
        issues.push({
          level: "violation",
          claim: claim.raw,
          message: `差值声明 ${claim.raw} 不匹配任何行内/列内成对差值（绝对差值样本：${formatActual(surface.deltas) || "无"}）`,
        });
        break;
      }
      case "relative": {
        if (
          surface.relativeDeltas.some((delta) =>
            matchesAtPrecision(claim.value, delta, claim.decimals),
          )
        ) {
          break;
        }
        if (surface.deltas.some((delta) => matchesAtPrecision(claim.value, delta, claim.decimals))) {
          issues.push({
            level: "violation",
            claim: claim.raw,
            message: `"${claim.raw}%"与数据的绝对差值匹配但不匹配任何相对提升——疑似把百分点写成了百分比（相对差值样本：${formatActual(surface.relativeDeltas) || "无"}）`,
          });
          break;
        }
        if (surface.diffSkipped) {
          issues.push({
            level: "unverified",
            claim: claim.raw,
            message: `数据集超过 ${MAX_DIFF_ROWS} 行，相对差值未校验（${claim.raw}% 的声明需作者确认）`,
          });
          break;
        }
        issues.push({
          level: "violation",
          claim: claim.raw,
          message: `相对提升声明 ${claim.raw}% 不匹配任何成对相对差值（相对差值样本：${formatActual(surface.relativeDeltas) || "无"}）`,
        });
        break;
      }
      case "count": {
        const candidates = [surface.rowCount, surface.columnCount, seriesCount];
        if (candidates.includes(claim.value)) {
          break;
        }
        issues.push({
          level: "unverified",
          claim: claim.raw,
          message: `计数声明 ${claim.raw} 不等于数据行数（${surface.rowCount}）/ 列数（${surface.columnCount}）/ series 数（${seriesCount}）——需作者确认`,
        });
        break;
      }
    }
  }

  // 全称量词 → 无法确定性证明（数据只覆盖图表引用的列）→ UNVERIFIED
  if (/\b(?:every|all)\b|所有|全部|一律/i.test(caption)) {
    issues.push({
      level: "unverified",
      claim: "全称量词",
      message: `caption 含全称描述（所有/全部/all）：图表数据仅覆盖当前数据集，全称是否有依据需作者确认`,
    });
  }

  // 单位一致性：caption 与轴标签同时带单位 token 且不兼容 → UNVERIFIED。
  // caption 侧单位只在紧邻数字时认定（防 "achieves" 词尾 s 误报）；轴标签是
  // 受控短文本，直接按词边界 token 提取。百分点族（points/pp/个百分点）与
  // 百分比（%）视为兼容（百分比指标的百分点差是标准表述，不是混淆）。
  const UNIT_ADJACENT_SOURCE = "\\d\\s*(%|ms|s|dB|FPS|fps|mAP|pp|个百分点|points?)";
  // 轴标签侧：token 不嵌入更长英文词（lookaround 代替 \\b——% 等非词字符
  // 与 \\b 的组合在 "(%)" 形态下不成立）
  const AXIS_UNIT_SOURCE = "(?<![A-Za-z])(%|ms|s|dB|FPS|fps|mAP|pp|个百分点|points?)(?![A-Za-z])";
  const captionUnits: string[] = [...caption.matchAll(new RegExp(UNIT_ADJACENT_SOURCE, "g"))].map(
    (match) => match[1] ?? "",
  );
  const axisText = `${spec.axis.xLabel ?? ""} ${spec.axis.yLabel ?? ""}`;
  const axisUnits: string[] = [...axisText.matchAll(new RegExp(AXIS_UNIT_SOURCE, "g"))].map(
    (match) => match[1] ?? "",
  );
  if (captionUnits.length > 0 && axisUnits.length > 0) {
    const family = (unit: string): "percent" | "points" | "other" => {
      if (unit === "%" || unit === "％") {
        return "percent";
      }
      if (unit === "pp" || unit === "个百分点" || /^points?$/.test(unit)) {
        return "points";
      }
      return "other";
    };
    const families = new Set([...captionUnits, ...axisUnits].map(family));
    const compatible =
      families.size <= 1 || (families.size === 2 && families.has("percent") && families.has("points"));
    if (!compatible) {
      issues.push({
        level: "unverified",
        claim: "单位",
        message: `caption 单位（${captionUnits.join("")}）与轴标签单位（${axisUnits.join("")}）不一致——需作者确认是否有换算依据`,
      });
    }
  }

  if (issues.some((issue) => issue.level === "violation")) {
    return { verdict: "violation", issues };
  }
  if (issues.some((issue) => issue.level === "unverified")) {
    return { verdict: "unverified", issues };
  }
  return { verdict: "pass", issues };
}
