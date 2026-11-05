/**
 * M17.2 实验指标数值与单位的显式解析（纯函数，零模型）。
 *
 * 纪律：单位只认显式证据——单元格后缀（"66.9%"）、表头单位（"HOTA (%)"、"Time (ms)"、"FPS"）、XLSX 百分比数值格式、
 * 以及评测协议词表里的计数型指标（IDSW / Frag 等按 TrackEval 定义是计数）。**不从数量级猜单位**：0.669 与 66.9 在没有
 * 显式证据时都是 unknown，交给作者在文件 metadata 中声明。
 *
 * 0.669 (ratio) 与 66.9 (percentage) 是同一量纲（proportion）的两种标度，可换算；percentage 与 fps、seconds 等不可比。
 * 「3.6 个百分点」与「3.6%」由派生运算区分（见 factSnapshot.ts），不在这里推断。
 */

export type ExperimentUnit = "percentage" | "ratio" | "count" | "fps" | "seconds" | "milliseconds" | "unknown";
export const EXPERIMENT_UNITS: readonly ExperimentUnit[] = ["percentage", "ratio", "count", "fps", "seconds", "milliseconds", "unknown"];
export type UnitBasis = "cell_suffix" | "header" | "xlsx_percent_format" | "metric_vocabulary" | "author_metadata" | "none";

/** 单位所属量纲：同量纲才可换算 / 比较 */
export function unitDimension(unit: ExperimentUnit): "proportion" | "count" | "rate" | "time" | null {
  if (unit === "percentage" || unit === "ratio") return "proportion";
  if (unit === "count") return "count";
  if (unit === "fps") return "rate";
  if (unit === "seconds" || unit === "milliseconds") return "time";
  return null;
}

/** 换算到量纲内的规范标度（proportion → percentage；time → seconds）；unknown → null */
export function toCanonical(value: number, unit: ExperimentUnit): { value: number; unit: ExperimentUnit } | null {
  switch (unit) {
    case "ratio": return { value: value * 100, unit: "percentage" };
    case "percentage": case "count": case "fps": case "seconds": return { value, unit };
    case "milliseconds": return { value: value / 1000, unit: "seconds" };
    default: return null;
  }
}

/** TrackEval / MOT Challenge 协议中定义为计数的指标（全词匹配；词表外不推断） */
const COUNT_METRICS = new Set([
  "IDSW", "FRAG", "MT", "PT", "ML", "CLR_TP", "CLR_FN", "CLR_FP", "IDTP", "IDFN", "IDFP", "DETS", "GT_DETS", "IDS", "GT_IDS", "FP", "FN", "TP",
]);

export interface HeaderUnit {
  /** 去掉单位标注后的指标名（"HOTA (%)" → "HOTA"） */
  metric: string;
  unit: ExperimentUnit;
  basis: UnitBasis;
}

const HEADER_UNIT_SUFFIX: Array<[RegExp, ExperimentUnit]> = [
  [/\s*[([（【]\s*%\s*[)\]）】]\s*$/u, "percentage"],
  [/\s*[([（【]\s*(?:fps|FPS|帧\/秒|帧每秒)\s*[)\]）】]\s*$/u, "fps"],
  [/\s*[([（【]\s*(?:ms|毫秒)(?:\s*\/\s*(?:frame|帧|img|image))?\s*[)\]）】]\s*$/u, "milliseconds"],
  [/\s*[([（【]\s*(?:s|sec|秒)(?:\s*\/\s*(?:frame|帧|img|image))?\s*[)\]）】]\s*$/u, "seconds"],
];

/** 表头 → 指标名 + 显式单位（无显式标注 → 计数词表 → unknown） */
export function headerUnit(header: string): HeaderUnit {
  const trimmed = header.trim();
  for (const [pattern, unit] of HEADER_UNIT_SUFFIX) {
    if (pattern.test(trimmed)) {
      const metric = trimmed.replace(pattern, "").trim();
      if (metric !== "") return { metric, unit, basis: "header" };
    }
  }
  if (/^fps$/i.test(trimmed)) return { metric: trimmed, unit: "fps", basis: "header" };
  const leaf = (trimmed.split(/[./]/).pop() ?? trimmed).toUpperCase();
  if (COUNT_METRICS.has(leaf)) return { metric: trimmed, unit: "count", basis: "metric_vocabulary" };
  return { metric: trimmed, unit: "unknown", basis: "none" };
}

export type ParsedMetricCell =
  | { kind: "number"; value: number; rawText: string; unit: ExperimentUnit; basis: UnitBasis }
  | { kind: "issue"; issue: "locale_decimal" | "formula_no_cached_value" | "merged_copy"; rawText: string }
  | { kind: "skip" };

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const PERCENT_SUFFIX = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*[%％]$/;
const LOCALE_DECIMAL = /^[+-]?\d{1,3}(?:\.\d{3})*,\d+$|^[+-]?\d+,\d+$/;

/**
 * 单元格文本 → 数值 + 单位（显式证据）。非数值文本 → skip；疑似小数逗号 → issue（不解析、不猜）；
 * 合并从格 / 无缓存公式 → issue（不是独立事实）。
 */
export function parseMetricCell(
  text: string,
  flags: { mergedFrom?: string; numberFormat?: "percent"; formulaNoCachedValue?: true } = {},
): ParsedMetricCell {
  const raw = text.trim();
  if (flags.formulaNoCachedValue === true) return { kind: "issue", issue: "formula_no_cached_value", rawText: raw };
  if (raw === "") return { kind: "skip" };
  const percent = PERCENT_SUFFIX.exec(raw);
  const numeric = PLAIN_NUMBER.test(raw) ? raw : percent?.[1];
  if (numeric === undefined) {
    return LOCALE_DECIMAL.test(raw) ? { kind: "issue", issue: "locale_decimal", rawText: raw } : { kind: "skip" };
  }
  if (flags.mergedFrom !== undefined) return { kind: "issue", issue: "merged_copy", rawText: raw };
  const value = Number(numeric);
  if (!Number.isFinite(value)) return { kind: "skip" };
  if (percent !== null) return { kind: "number", value, rawText: raw, unit: "percentage", basis: "cell_suffix" };
  if (flags.numberFormat === "percent") return { kind: "number", value, rawText: raw, unit: "ratio", basis: "xlsx_percent_format" };
  return { kind: "number", value, rawText: raw, unit: "unknown", basis: "none" };
}

/** 显示精度：小数位数（科学计数 / 整数 = 0）——派生量的舍入区间与「同值」判定用 */
export function decimalsOf(rawText: string): number {
  const match = /^[+-]?\d*\.(\d+)/.exec(rawText.replace(/[%％]$/, "").trim());
  return match?.[1]?.length ?? 0;
}
