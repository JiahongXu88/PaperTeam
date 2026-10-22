/**
 * M15.2 派生量确定性复算：受控表达式 AST + 区间算术（零模型、不执行任意代码）。
 *
 * - 只允许白名单操作：add / subtract / sum / mean / ratio / multiple / relative_change_percent /
 *   percentage_point_difference / unit_convert / round；其余节点一律拒绝（不 eval、不解析自由表达式字符串）；
 * - 叶子只能是 `atom`（引用已定位的原子值：表格单元格 / 原文数字，带文档位置）或显式常量；
 * - 显示精度 → 区间：写出的 61.7 表示 [61.65, 61.75]；运算按区间传播，比较看区间是否相交——舍入导致的差异不会被当成矛盾；
 * - 单位：同量纲才可换算；百分比与百分点由操作名区分，不靠模型自报。
 */

export const DERIVED_FORMULA_VERSION = "derived-formula/v1";

export type FormulaOp =
  | "add" | "subtract" | "sum" | "mean" | "ratio" | "multiple" | "relative_change_percent" | "percentage_point_difference" | "unit_convert" | "round";

export const FORMULA_OPS: readonly FormulaOp[] = ["add", "subtract", "sum", "mean", "ratio", "multiple", "relative_change_percent", "percentage_point_difference", "unit_convert", "round"];

export type FormulaNode =
  | { op: "atom"; ref: string }
  | { op: "const"; value: number }
  | { op: "add" | "subtract" | "ratio" | "multiple" | "relative_change_percent" | "percentage_point_difference"; args: [FormulaNode, FormulaNode] }
  | { op: "sum" | "mean"; args: FormulaNode[] }
  | { op: "unit_convert"; from: string; to: string; arg: FormulaNode }
  | { op: "round"; decimals: number; arg: FormulaNode };

export interface Interval {
  lo: number;
  hi: number;
}

export interface FormulaAtom {
  ref: string;
  value: number;
  /** 显示小数位（整数 = 0；千位后缀 54K = -3） */
  decimals: number;
  unit: string | null;
}

const UNIT_FACTORS: Record<string, { dimension: string; factor: number }> = {
  mm: { dimension: "length", factor: 0.001 },
  cm: { dimension: "length", factor: 0.01 },
  m: { dimension: "length", factor: 1 },
  km: { dimension: "length", factor: 1000 },
  ms: { dimension: "time", factor: 0.001 },
  s: { dimension: "time", factor: 1 },
  min: { dimension: "time", factor: 60 },
  h: { dimension: "time", factor: 3600 },
  kb: { dimension: "bytes", factor: 1e3 },
  mb: { dimension: "bytes", factor: 1e6 },
  gb: { dimension: "bytes", factor: 1e9 },
};

export function unitFactor(from: string, to: string): number | null {
  const a = UNIT_FACTORS[from.toLowerCase()];
  const b = UNIT_FACTORS[to.toLowerCase()];
  if (a === undefined || b === undefined || a.dimension !== b.dimension) return null;
  return a.factor / b.factor;
}

export function displayInterval(value: number, decimals: number): Interval {
  const half = 0.5 * 10 ** -decimals;
  return { lo: value - half, hi: value + half };
}

export function intervalsOverlap(a: Interval, b: Interval, epsilon = 1e-9): boolean {
  return a.lo <= b.hi + epsilon && b.lo <= a.hi + epsilon;
}

function add(a: Interval, b: Interval): Interval {
  return { lo: a.lo + b.lo, hi: a.hi + b.hi };
}
function sub(a: Interval, b: Interval): Interval {
  return { lo: a.lo - b.hi, hi: a.hi - b.lo };
}
function mul(a: Interval, b: Interval): Interval {
  const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return { lo: Math.min(...products), hi: Math.max(...products) };
}
function div(a: Interval, b: Interval): Interval | null {
  if (b.lo <= 0 && b.hi >= 0) return null; // 除数区间含 0：不可算
  return mul(a, { lo: 1 / b.hi, hi: 1 / b.lo });
}

export type FormulaValidation = { ok: true } | { ok: false; error: string };

/** schema + 绑定校验：未知操作 / 未绑定原子 / 参数个数 / 单位不可换算 → 拒绝 */
export function validateFormula(node: unknown, atoms: ReadonlyMap<string, FormulaAtom>, depth = 0): FormulaValidation {
  if (depth > 8) return { ok: false, error: "表达式嵌套过深" };
  if (typeof node !== "object" || node === null) return { ok: false, error: "节点不是对象" };
  const record = node as Record<string, unknown>;
  const op = record["op"];
  if (op === "atom") return typeof record["ref"] === "string" && atoms.has(record["ref"]) ? { ok: true } : { ok: false, error: `未绑定原子 ${String(record["ref"])}` };
  if (op === "const") return typeof record["value"] === "number" && Number.isFinite(record["value"]) ? { ok: true } : { ok: false, error: "常量不是有限数" };
  if (typeof op !== "string" || !(FORMULA_OPS as readonly string[]).includes(op)) return { ok: false, error: `不支持的操作 ${String(op)}` };
  if (op === "unit_convert") {
    if (typeof record["from"] !== "string" || typeof record["to"] !== "string" || unitFactor(record["from"], record["to"]) === null) return { ok: false, error: "单位不可换算" };
    return validateFormula(record["arg"], atoms, depth + 1);
  }
  if (op === "round") {
    if (typeof record["decimals"] !== "number" || !Number.isInteger(record["decimals"]) || record["decimals"] < -6 || record["decimals"] > 6) return { ok: false, error: "舍入位数非法" };
    return validateFormula(record["arg"], atoms, depth + 1);
  }
  const args = record["args"];
  if (!Array.isArray(args)) return { ok: false, error: "缺少 args" };
  if ((op === "sum" || op === "mean") ? args.length < 2 || args.length > 32 : args.length !== 2) return { ok: false, error: `${op} 参数个数非法` };
  for (const arg of args) {
    const result = validateFormula(arg, atoms, depth + 1);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** 区间求值（调用前须 validateFormula）；不可算（除以含 0 区间）→ null */
export function evaluateFormula(node: FormulaNode, atoms: ReadonlyMap<string, FormulaAtom>): Interval | null {
  switch (node.op) {
    case "atom": {
      const atom = atoms.get(node.ref)!;
      return displayInterval(atom.value, atom.decimals);
    }
    case "const":
      return { lo: node.value, hi: node.value };
    case "unit_convert": {
      const inner = evaluateFormula(node.arg, atoms);
      const factor = unitFactor(node.from, node.to);
      return inner === null || factor === null ? null : { lo: inner.lo * factor, hi: inner.hi * factor };
    }
    case "round": {
      const inner = evaluateFormula(node.arg, atoms);
      if (inner === null) return null;
      const scale = 10 ** node.decimals;
      return { lo: Math.round(inner.lo * scale) / scale, hi: Math.round(inner.hi * scale) / scale };
    }
    case "sum":
    case "mean": {
      let total: Interval = { lo: 0, hi: 0 };
      for (const arg of node.args) {
        const value = evaluateFormula(arg, atoms);
        if (value === null) return null;
        total = add(total, value);
      }
      return node.op === "sum" ? total : { lo: total.lo / node.args.length, hi: total.hi / node.args.length };
    }
    default: {
      const left = evaluateFormula(node.args[0], atoms);
      const right = evaluateFormula(node.args[1], atoms);
      if (left === null || right === null) return null;
      switch (node.op) {
        case "add": return add(left, right);
        case "subtract":
        case "percentage_point_difference": return sub(left, right);
        case "ratio":
        case "multiple": return div(left, right);
        case "relative_change_percent": {
          const quotient = div(sub(left, right), right);
          return quotient === null ? null : { lo: quotient.lo * 100, hi: quotient.hi * 100 };
        }
      }
    }
  }
  return null;
}

/** 表达式的可读形式（证书 / 报告用；不可被重新执行） */
export function renderFormula(node: FormulaNode): string {
  switch (node.op) {
    case "atom": return `[${node.ref}]`;
    case "const": return String(node.value);
    case "unit_convert": return `convert(${renderFormula(node.arg)}, ${node.from}→${node.to})`;
    case "round": return `round(${renderFormula(node.arg)}, ${node.decimals})`;
    case "sum":
    case "mean": return `${node.op}(${node.args.map(renderFormula).join(", ")})`;
    default: return `${node.op}(${renderFormula(node.args[0])}, ${renderFormula(node.args[1])})`;
  }
}
