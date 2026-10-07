/**
 * 确定性分位数工具（M12 Batch 2 · A7；M12.0 §4.3 Distribution 冻结形态）。
 *
 * 纪律：
 * - 纯函数、无 IO、无时间、无随机——同输入恒同输出（golden 测试锁定）；
 * - 分位数用线性插值（唯一确定性形态：idx = (n-1)·p，floor/ceil 内插），
 *   数值统一 round2——避免浮点尾数在跨平台 / 序列化往返中漂移；
 * - 空输入 → null（不是伪造的 0 分布）——维度可用性由调用方按 coverage 判定。
 */

import type { Distribution } from "./types.js";

/** 维度可用的最低有效样本数（< 5 → insufficient；readiness 消费为 INSUFFICIENT_EVIDENCE） */
export const MIN_PROFILE_SAMPLES = 5;

/** round 到 2 位小数（确定性；0.005 边界由 IEEE754 半偶舍入决定，恒一致） */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 单分位数（线性插值；n=1 恒返回唯一值） */
export function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error("quantile: 空输入（调用方先判空）");
  }
  if (sortedAsc.length === 1) {
    return round2(sortedAsc[0]!);
  }
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const value = sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * frac;
  return round2(value);
}

/** 值序列 → Distribution（升序排序后取五点）；空序列 → null（不发明数据） */
export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round2(sorted[0]!),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: round2(sorted[sorted.length - 1]!),
  };
}

/** 数组中位数（独立于 Distribution 的便捷入口；同样确定性 round2） */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

/**
 * observed 与分位带的位置判定（A8 消费；三带语义）：
 * - "inner"：落在 [p25, p75] —— MEETS_TARGET 带；
 * - "outer"：落在 (min, max) 但不在内带 —— PARTIALLY_MEETS_TARGET 带；
 * - "below"/"above"：越出 [min, max] —— BELOW_TARGET（方向供 gap 措辞）。
 */
export type BandPosition = "inner" | "outer" | "below" | "above";

export function bandPosition(observed: number, band: Distribution): BandPosition {
  if (observed < band.min) {
    return "below";
  }
  if (observed > band.max) {
    return "above";
  }
  if (observed < band.p25 || observed > band.p75) {
    return "outer";
  }
  return "inner";
}

/** 分位带的人读区间串（gap / prompt 复用；确定性格式） */
export function describeBand(label: string, band: Distribution): string {
  return `${label} p25–p75 = ${band.p25}–${band.p75}（min–max ${band.min}–${band.max}，n=${band.n}）`;
}
