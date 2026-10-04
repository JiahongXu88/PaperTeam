/**
 * Reviewer Stability（M11.3 Phase A）。
 *
 * 背景（M11.2.3 §14.7 的真实观测）：同一冻结稿件 rev7，两次独立 review 的
 * fact claim 枚举 65 → 41、academicScore 77 → 73、styleRisk 30 → 48——
 * 单次 LLM Reviewer 输出不能被当成精确测量仪。
 *
 * 本模块给「同一 artifact 在完全相同条件下重复 review」的采样做确定性整理：
 * - metricStats：数值指标（score / counts）的 min / median / mean / max /
 *   range / stddev；
 * - normalizeFindingKey：finding 的跨轮匹配键（section + category +
 *   rootCauseKey / 归一化目标文本）——不要求字符串完全一致，复用既有
 *   rootCauseKey 语义，不引入 embedding clustering；
 * - matchFindings：N 次采样 → 每个键的出现次数与代表性描述（stable =
 *   出现在全部采样；unstable = 仅出现在部分采样）。
 *
 * 纯函数、无 LLM、无存储；消费方：scripts/m113-reviewer-stability.mjs、
 * M11.3 报告与单测。
 */

/** 单次 review 采样的可统计指标投影（ModeReviewResult / ReviewSummary 的子集） */
export interface ReviewRunSample {
  run: string;
  mode: "academic" | "fact" | "style";
  academicScore?: number;
  styleRisk?: number;
  claims?: number;
  supported?: number;
  partiallySupported?: number;
  unsupported?: number;
  contradicted?: number;
  critical?: number;
  blocking?: number;
  major?: number;
  minor?: number;
  issues?: StabilityFinding[];
}

export interface StabilityFinding {
  section?: string;
  category?: string;
  severity?: string;
  /** M11.2.3 rootCauseKey（claim grounding 归因）；缺省时回退目标文本 */
  rootCauseKey?: string;
  /** finding 的目标 / 描述文本（匹配用归一化，不要求逐字一致） */
  description?: string;
  target?: string;
}

export interface MetricStats {
  n: number;
  min: number;
  median: number;
  mean: number;
  max: number;
  range: number;
  /** 总体标准差（n=1 时为 0；保留 3 位小数） */
  stddev: number;
}

export function metricStats(values: readonly number[]): MetricStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, min: 0, median: 0, mean: 0, max: 0, range: 0, stddev: 0 };
  }
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / n;
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / n;
  return {
    n,
    min: sorted[0]!,
    median: n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2,
    mean: Number(mean.toFixed(3)),
    max: sorted[n - 1]!,
    range: sorted[n - 1]! - sorted[0]!,
    stddev: Number(Math.sqrt(variance).toFixed(3)),
  };
}

/** 目标文本归一化：去空白 / 标点（中英全半角），取小写；截断到稳定长度（防超长描述漂移键） */
function normalizeTargetText(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。；：、""''「」『』（）()\[\]【】《》<>,.;:!?？!！—\-–…·]/g, "")
    .toLowerCase()
    .slice(0, 80);
}

/**
 * finding 的跨采样匹配键。
 *
 * 优先级：rootCauseKey（claim 级确定性归因，M11.2.3 已回填）>
 * section+category+归一化目标文本。同键 = 同一问题在不同采样中的再现。
 */
export function normalizeFindingKey(finding: StabilityFinding): string {
  const section = (finding.section ?? "").trim() || "-";
  const category = (finding.category ?? "").trim() || "-";
  if (finding.rootCauseKey !== undefined && finding.rootCauseKey.trim() !== "") {
    return `${section}|${category}|rc:${finding.rootCauseKey.trim()}`;
  }
  const target = normalizeTargetText(finding.target ?? finding.description ?? "");
  return `${section}|${category}|t:${target}`;
}

export interface FindingStabilityEntry {
  key: string;
  section: string;
  category: string;
  severity: string;
  /** 代表性描述（首次出现样例，人读） */
  sample: string;
  /** 出现于哪些采样（run 名，保持顺序） */
  runs: string[];
  /** 出现次数 / 采样数 */
  frequency: number;
  stable: boolean;
}

export interface FindingStabilityResult {
  runs: string[];
  totalFindings: number;
  stable: FindingStabilityEntry[];
  unstable: FindingStabilityEntry[];
}

/**
 * 跨采样匹配 findings（确定性；同 run 内同键去重一次）。
 * stable 阈值：出现在全部采样（frequency === runs.length）；
 * 部分出现（1 ≤ frequency < n）= unstable。
 */
export function matchFindings(
  samples: readonly ReviewRunSample[],
  options: { stableThreshold?: number } = {},
): FindingStabilityResult {
  const runs = samples.map((sample) => sample.run);
  const threshold =
    options.stableThreshold ?? (runs.length > 0 ? runs.length : 1);
  const byKey = new Map<string, FindingStabilityEntry>();
  for (const sample of samples) {
    const seenInRun = new Set<string>();
    for (const finding of sample.issues ?? []) {
      const key = normalizeFindingKey(finding);
      if (seenInRun.has(key)) {
        continue;
      }
      seenInRun.add(key);
      const section = (finding.section ?? "").trim() || "-";
      const category = (finding.category ?? "").trim() || "-";
      const entry = byKey.get(key);
      if (entry === undefined) {
        byKey.set(key, {
          key,
          section,
          category,
          severity: finding.severity ?? "-",
          sample: (finding.description ?? finding.target ?? "").slice(0, 160),
          runs: [sample.run],
          frequency: 1,
          stable: false,
        });
      } else if (!entry.runs.includes(sample.run)) {
        entry.runs.push(sample.run);
        entry.frequency += 1;
      }
    }
  }
  const entries = [...byKey.values()].map((entry) => ({
    ...entry,
    stable: entry.frequency >= threshold,
  }));
  entries.sort((a, b) => b.frequency - a.frequency || a.key.localeCompare(b.key));
  return {
    runs,
    totalFindings: entries.length,
    stable: entries.filter((entry) => entry.stable),
    unstable: entries.filter((entry) => !entry.stable),
  };
}

/** 多采样数值指标汇总（键 → MetricStats；缺省键跳过） */
export function summarizeMetrics(
  samples: readonly ReviewRunSample[],
): Record<string, MetricStats> {
  const collectors: Record<string, number[]> = {};
  const metricKeys = [
    "academicScore",
    "styleRisk",
    "claims",
    "supported",
    "partiallySupported",
    "unsupported",
    "contradicted",
    "critical",
    "blocking",
    "major",
    "minor",
  ] as const;
  for (const sample of samples) {
    for (const key of metricKeys) {
      const value = sample[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        (collectors[key] ??= []).push(value);
      }
    }
  }
  const result: Record<string, MetricStats> = {};
  for (const [key, values] of Object.entries(collectors)) {
    result[key] = metricStats(values);
  }
  return result;
}
