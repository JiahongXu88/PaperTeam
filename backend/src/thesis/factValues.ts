/**
 * M14.1b：科研数值的归一化与可比性判定（纯函数、确定性）。
 *
 * 纪律：
 *   - 只做可靠的单位换算（同量纲且换算系数确定：时间 / 字节 / 百分比↔比率）；
 *     换算不可靠一律 unit_incomparable，不猜；
 *   - 舍入差异（0.049 vs 0.05）单列为 rounding_difference，不混入 value_mismatch；
 *   - 私用区字形（PDF 字体映射丢失，如 γ → U+F067）标 glyphIssues，禁止用于比较。
 */

import type { FactValue } from "./researchInputTypes.js";

const FULLWIDTH_DIGIT_OFFSET = 0xff10 - 0x30;

export function normalizeSurfaceText(raw: string): string {
  return raw
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET))
    .replace(/[．．]/g, ".")
    .replace(/[％]/g, "%")
    .replace(/[−–—‒]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** 私用区（U+E000–U+F8FF）或替换字符：字体映射丢失，内容不可信 */
export function hasGlyphIssues(raw: string): boolean {
  return /[-�]/.test(raw);
}

interface UnitSpec {
  dimension: "time" | "bytes" | "ratio" | "count" | "frequency" | "length" | "mass" | "none";
  /** 换算到量纲基准单位的系数 */
  factor: number;
}

const UNIT_TABLE: Record<string, UnitSpec> = {
  "%": { dimension: "ratio", factor: 0.01 },
  "‰": { dimension: "ratio", factor: 0.001 },
  ms: { dimension: "time", factor: 1e-3 },
  s: { dimension: "time", factor: 1 },
  sec: { dimension: "time", factor: 1 },
  min: { dimension: "time", factor: 60 },
  h: { dimension: "time", factor: 3600 },
  hr: { dimension: "time", factor: 3600 },
  b: { dimension: "bytes", factor: 1 },
  kb: { dimension: "bytes", factor: 1e3 },
  mb: { dimension: "bytes", factor: 1e6 },
  gb: { dimension: "bytes", factor: 1e9 },
  tb: { dimension: "bytes", factor: 1e12 },
  hz: { dimension: "frequency", factor: 1 },
  khz: { dimension: "frequency", factor: 1e3 },
  mhz: { dimension: "frequency", factor: 1e6 },
  ghz: { dimension: "frequency", factor: 1e9 },
  mm: { dimension: "length", factor: 1e-3 },
  cm: { dimension: "length", factor: 1e-2 },
  m: { dimension: "length", factor: 1 },
  km: { dimension: "length", factor: 1e3 },
  g: { dimension: "mass", factor: 1e-3 },
  kg: { dimension: "mass", factor: 1 },
  k: { dimension: "count", factor: 1e3 },
};

const NUMBER_RE = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?:[eE]([-+]?\d+))?$/;

/**
 * 解析单元格 / 片段为事实值。非数值内容（范围、✓、文本）保留 raw，不给 numeric。
 * 允许形态："0.724" ".522" "12.1" "1,065" "1e-4" "75.37%" "0.05 s" "21 ms" "5.1MB" "27.6M"
 */
export function parseFactValue(raw: string): FactValue {
  const glyph = hasGlyphIssues(raw);
  const surface = normalizeSurfaceText(raw);
  const base: FactValue = { raw, ...(glyph ? { glyphIssues: true } : {}) };
  if (glyph || surface === "") {
    return base;
  }
  // 去掉 ↑↓ 等装饰与前后括注（"(无)"、"†"、"*"）
  const cleaned = surface.replace(/[↑↓†‡*]+/g, "").replace(/\s+/g, " ").trim();
  const match = /^([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([%‰]|[A-Za-z]{1,3}B?)?$/.exec(cleaned);
  if (match === null) {
    return base;
  }
  const numberText = match[1] ?? "";
  const unitText = match[2];
  if (!NUMBER_RE.test(numberText) || !/\d/.test(numberText)) {
    return base;
  }
  const numeric = Number(numberText.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return base;
  }
  const unit = unitText !== undefined ? normalizeUnit(unitText) : undefined;
  if (unitText !== undefined && unit === undefined) {
    // 未知单位后缀：按非数值保留（不猜）
    return base;
  }
  return {
    ...base,
    numeric,
    ...(unit !== undefined ? { unit } : {}),
    normalized: normalizedForm(numeric, unit),
  };
}

function normalizeUnit(unit: string): string | undefined {
  if (unit === "M") {
    // 大小写敏感：27.6M（百万计数，参数量）≠ m（米）
    return "M";
  }
  const lower = unit.trim().toLowerCase();
  if (lower === "%" || lower === "‰") {
    return lower;
  }
  if (lower in UNIT_TABLE) {
    return lower;
  }
  return undefined;
}

function unitSpec(unit: string | undefined): UnitSpec {
  if (unit === undefined) {
    return { dimension: "none", factor: 1 };
  }
  if (unit === "M") {
    return { dimension: "count", factor: 1e6 };
  }
  return UNIT_TABLE[unit] ?? { dimension: "none", factor: 1 };
}

export function normalizedForm(numeric: number, unit: string | undefined): string {
  const text = trimZeros(numeric);
  return unit !== undefined ? `${text} ${unit}` : text;
}

function trimZeros(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  const text = value.toPrecision(12);
  return text.includes("e") ? String(value) : text.replace(/0+$/, "").replace(/\.$/, "");
}

function decimalsOf(raw: string): number {
  const cleaned = normalizeSurfaceText(raw).replace(/[^\d.eE-]/g, "");
  const match = /\.(\d+)/.exec(cleaned);
  return match?.[1]?.length ?? 0;
}

export type ValueComparison =
  | { outcome: "equal" }
  | { outcome: "equal_after_unit_normalization"; detail: string }
  | { outcome: "rounding_difference"; detail: string }
  | { outcome: "value_mismatch"; detail: string }
  | { outcome: "unit_incomparable"; detail: string }
  | { outcome: "non_numeric"; detail: string };

/**
 * 比较两个事实值（同可比性键前提下调用）。
 *   equal：归一化相等；
 *   equal_after_unit_normalization：单位不同但同量纲换算后相等；
 *   rounding_difference：按较粗精度四舍五入后相等；
 *   value_mismatch：可比且不等；
 *   unit_incomparable：量纲不同 / 无法换算；
 *   non_numeric：任一方不是数值（或含字形问题）。
 */
export function compareFactValues(a: FactValue, b: FactValue): ValueComparison {
  if (a.glyphIssues === true || b.glyphIssues === true) {
    return { outcome: "non_numeric", detail: "字形映射不可信，拒绝比较" };
  }
  if (a.numeric === undefined || b.numeric === undefined) {
    if (normalizeSurfaceText(a.raw) === normalizeSurfaceText(b.raw)) {
      return { outcome: "equal" };
    }
    return { outcome: "non_numeric", detail: "非数值内容" };
  }
  const specA = unitSpec(a.unit);
  const specB = unitSpec(b.unit);
  let valueA = a.numeric;
  let valueB = b.numeric;
  let converted = false;
  if (a.unit !== b.unit) {
    if (specA.dimension === specB.dimension && specA.dimension !== "none") {
      valueA = a.numeric * specA.factor;
      valueB = b.numeric * specB.factor;
      converted = true;
    } else if (isRatioPercentPair(a, b)) {
      // 百分比 ↔ [0,1] 比率：仅当无单位一方落在 [0,1] 才视为同一量
      valueA = a.unit === "%" ? a.numeric / 100 : a.numeric;
      valueB = b.unit === "%" ? b.numeric / 100 : b.numeric;
      converted = true;
    } else {
      return { outcome: "unit_incomparable", detail: `单位 ${a.unit ?? "(无)"} 与 ${b.unit ?? "(无)"} 不可换算` };
    }
  }
  if (nearlyEqual(valueA, valueB)) {
    return converted ? { outcome: "equal_after_unit_normalization", detail: `${a.raw} ≡ ${b.raw}` } : { outcome: "equal" };
  }
  const decimals = Math.min(decimalsOf(a.raw), decimalsOf(b.raw));
  if (!converted && decimals >= 0) {
    const factor = 10 ** decimals;
    if (Math.round(valueA * factor) === Math.round(valueB * factor)) {
      return { outcome: "rounding_difference", detail: `${a.raw} 与 ${b.raw} 在 ${decimals} 位小数下一致` };
    }
  }
  return { outcome: "value_mismatch", detail: `${a.raw} ≠ ${b.raw}` };
}

function isRatioPercentPair(a: FactValue, b: FactValue): boolean {
  const [percent, plain] = a.unit === "%" ? [a, b] : b.unit === "%" ? [b, a] : [undefined, undefined];
  if (percent === undefined || plain === undefined || plain.unit !== undefined || plain.numeric === undefined) {
    return false;
  }
  return plain.numeric >= 0 && plain.numeric <= 1;
}

function nearlyEqual(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

/** 行 / 列标签归一：去箭头 / 脚注记号 / 引文标记 / 空白，小写 */
export function normalizeLabel(label: string): string {
  return normalizeSurfaceText(label)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[↑↓†‡*]+/g, "")
    .replace(/[\s_\-.:：（）()|]+/g, "")
    .toLowerCase();
}

/** 标签中的大写标识符 token（数据集 / 模型名：DAVSOD、SSAV、PASCAL-S …） */
export function identifierTokens(text: string): string[] {
  const tokens = normalizeSurfaceText(text).match(/\b[A-Z][A-Z0-9]*(?:[-+][A-Z0-9]+)*\b/g) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 3 && /[A-Z]/.test(token)))];
}
