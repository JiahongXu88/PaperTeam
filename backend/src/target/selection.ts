/**
 * Benchmark selection 纯函数（M12.1 A6——产品层修正：本轮不接 workflow、
 * 不建 HITL stage、不做 UI；只提供服务层选择逻辑）。
 *
 * 规则（确定性，无 LLM）：
 * - 按 citationCount 降序取前 N（缺 citationCount 视为 -1 排最后——缺数据的
 *   候选不弃用但排尾）；并列时按融合分降序、再按标题指纹字典序稳定排序；
 * - 默认目标 12 篇，带内 8–15（targetCount 被钳制到 [min, max]）；
 * - inclusionReason 生成「top-cited in venue corpus, rank #N, cited X times」
 *   （缺引用数时如实写 cited unknown）；
 * - sufficiency：选中数 ≥ 8 → sufficient；< 8 → insufficient（带 reason：
 *   候选不足 / 检索结果空）——**必须标记在 discovery/freeze 结果里，不静默**；
 * - requiresAttention（结构化，供未来 workflow 决定是否 required HITL）只在：
 *   选中数 < 5（严重不足）/ venueResolution ambiguous / target venue 不可解析 /
 *   检索结果为空——正常流程不产生任何注意项，不强制暂停。
 */

import type { BenchmarkSufficiency, TargetBenchmarkSelection } from "./types.js";

/** 推荐语料规模（M12.0 §22 作者默认：8–15 篇，HITL 可改） */
export const BENCHMARK_MIN_PAPERS = 8;
export const BENCHMARK_DEFAULT_TARGET = 12;
export const BENCHMARK_MAX_PAPERS = 15;
/** 低于此数 = 严重不足（requiresAttention） */
export const BENCHMARK_SEVERELY_INSUFFICIENT = 5;

/** 选择输入候选的最小结构面（排序键）；泛型保 callers 拿回完整原对象 */
export interface SelectableBenchmarkCandidate {
  title?: string;
  citationCount?: number;
  /** 融合分（RRF；并列 citationCount 时的次级排序） */
  fusedScore?: number;
}

export interface SelectRecommendedOptions {
  min?: number;
  target?: number;
  max?: number;
  /** 发现侧上下文（venue 解析状态 / 检索结果数；只影响标记，不影响选择） */
  context?: {
    /** venueResolution.status（"resolved" | "ambiguous" | "not_found" | "skipped"） */
    venueStatus?: string;
    /** 检索（fusion 后）结果总数；0 = 空结果 */
    totalResults?: number;
  };
  /** 注入时钟（测试确定性；缺省真实时间——只用于 selectedAt 审计字段） */
  now?: () => Date;
}

export interface BenchmarkSelectionResult<T extends SelectableBenchmarkCandidate = SelectableBenchmarkCandidate> {
  /** 选中的候选（按选择顺序；citationCount 降序），附 inclusionReason */
  selected: Array<T & { inclusionReason: string }>;
  selection: TargetBenchmarkSelection;
}

/** 带内钳制：targetCount ∈ [min, max]（min ≤ target ≤ max 结构保证） */
export function clampTargetCount(options: {
  min?: number;
  target?: number;
  max?: number;
}): { min: number; target: number; max: number } {
  const min = options.min ?? BENCHMARK_MIN_PAPERS;
  const max = Math.max(options.max ?? BENCHMARK_MAX_PAPERS, min);
  const rawTarget = options.target ?? BENCHMARK_DEFAULT_TARGET;
  const target = Math.min(Math.max(rawTarget, min), max);
  return { min, target, max };
}

export function selectRecommended<T extends SelectableBenchmarkCandidate>(
  candidates: readonly T[],
  options: SelectRecommendedOptions = {},
): BenchmarkSelectionResult<T> {
  const { min, target } = clampTargetCount(options);
  const requiresAttention: string[] = [];

  const ordered = [...candidates].sort(
    (a, b) =>
      (b.citationCount ?? -1) - (a.citationCount ?? -1) ||
      (b.fusedScore ?? 0) - (a.fusedScore ?? 0) ||
      (a.title ?? "").localeCompare(b.title ?? ""),
  );
  const chosen = ordered.slice(0, target);
  const selected = chosen.map((candidate, index) => ({
    ...candidate,
    inclusionReason:
      candidate.citationCount !== undefined
        ? `top-cited in venue corpus, rank #${index + 1}, cited ${candidate.citationCount} times`
        : `rank #${index + 1} (citation count unavailable from provider), relevance-ordered fallback`,
  }));

  // sufficiency（必须标记，不静默）
  let sufficiency: BenchmarkSufficiency;
  let reason: string | undefined;
  if (selected.length >= min) {
    sufficiency = "sufficient";
  } else {
    sufficiency = "insufficient";
    reason =
      candidates.length === 0
        ? "检索结果为空（无候选可选）"
        : `候选不足：带内下限 ${min} 篇，实际可选 ${selected.length} 篇（候选总数 ${candidates.length}）`;
  }

  // requiresAttention（只在四种情况；正常流程零注意项）
  const venueStatus = options.context?.venueStatus;
  if (selected.length < BENCHMARK_SEVERELY_INSUFFICIENT) {
    requiresAttention.push(
      `severely_insufficient_corpus: 仅 ${selected.length} 篇（< ${BENCHMARK_SEVERELY_INSUFFICIENT}）——benchmark 参照系不可用，目标档位结论将是 INSUFFICIENT_EVIDENCE`,
    );
  }
  if (venueStatus === "ambiguous") {
    requiresAttention.push(
      "venue_resolution_ambiguous: 目标 venue 解析出多个候选 source——需要作者裁决（discovery 已降级为纯关键词+引用数排序）",
    );
  }
  if (venueStatus === "not_found") {
    requiresAttention.push(
      "venue_resolution_not_found: 目标 venue 未能解析到 OpenAlex source——discovery 已降级为纯关键词+引用数排序（如实标记，不静默）",
    );
  }
  if ((options.context?.totalResults ?? candidates.length) === 0) {
    requiresAttention.push("empty_search_results: 学术检索未返回任何结果");
  }

  const selection: TargetBenchmarkSelection = {
    selectedAt: (options.now ?? (() => new Date()))().toISOString(),
    targetCount: target,
    sufficiency,
    ...(reason !== undefined ? { reason } : {}),
    requiresAttention,
  };
  return { selected, selection };
}

/** 冻结语料的有效条目（未 excluded）——profile/readiness 消费口径 */
export function effectivePapers<T extends { excluded?: unknown }>(papers: readonly T[]): T[] {
  return papers.filter((paper) => paper.excluded === undefined);
}
