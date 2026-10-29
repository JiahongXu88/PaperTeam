/**
 * Priority View（M15.12 B3）：审阅报告的 top-K 优先 findings 视图。
 *
 * 纯确定性投影——不改 findings 本体、不改 blocking 语义、不删任何 finding：
 * - 去重：同类目下归一化 message 完全相等，或 token Jaccard ≥ 0.8 → 折叠
 *   （保留 severity 更高者；平级保留 findingId 字典序更小者；折叠数如实登记）；
 * - 排序：severity 权重降序 → 类目权重降序 → findingId 升序（全确定性）；
 * - 标记：serious = severity critical/major；meta = source "fullpaper-review"。
 *
 * 目的：报告主视图不被几十条低价值 style/一致性小项淹没（M15.11：C1 族均
 * ~72 条 findings、仅 14% 被用于匹配）；top-K 是呈现层，原始 findings 全量保留。
 */

import { severityRank, type ReviewFinding } from "./finding.js";

/** 类目权重（学术实质 > 事实/一致性 > 引用/视觉 > 风格；同分内确定性排序） */
const CATEGORY_WEIGHT: Record<ReviewFinding["category"], number> = {
  academic: 5,
  fact: 4,
  consistency: 3,
  citation: 2,
  visual: 2,
  style: 1,
};

export const PRIORITY_VIEW_DEFAULT_K = 10;
const NEAR_DUP_JACCARD = 0.8;

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  // 全部非空 token 参与（数字/单字是区分度的一部分——"问题 0" vs "问题 5" 不是重复）
  return new Set(normalized.split(" ").filter((token) => token.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export interface PriorityViewItem {
  findingId: string;
  severity: ReviewFinding["severity"];
  category: ReviewFinding["category"];
  source: string;
  sectionId?: string;
  message: string;
  serious: boolean;
  meta: boolean;
}

export interface PriorityView {
  k: number;
  items: PriorityViewItem[];
  /** 被折叠的近重复 finding 条数（未进入 top-K 池） */
  dedupCollapsed: number;
  seriousCount: number;
  metaCount: number;
  basis: string;
  /** M15.13 A3：去重池规模与池内 serious/meta 计数（top-K retention 的诚实分母） */
  poolSize: number;
  seriousPoolCount: number;
  metaPoolCount: number;
}

/**
 * 计算 top-K 优先视图（纯函数）。输入顺序无关（内部确定性排序）。
 */
export function buildPriorityView(findings: readonly ReviewFinding[], k: number = PRIORITY_VIEW_DEFAULT_K): PriorityView {
  // 1) 去重池：按（category, 归一化 message）分组后做组内近重复折叠
  const byKey = new Map<string, Array<{ finding: ReviewFinding; normalized: string }>>();
  for (const finding of findings) {
    const normalized = normalizeMessage(finding.message);
    const key = `${finding.category}::${normalized}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push({ finding, normalized });
    byKey.set(key, bucket);
  }
  // 同 key 内部 = 精确重复 → 保留代表；跨 key 的近重复（Jaccard）在同 category 内判定
  const byCategory = new Map<ReviewFinding["category"], Array<{ finding: ReviewFinding; normalized: string; tokens: Set<string> }>>();
  let dedupCollapsed = 0;
  const keep = (entry: { finding: ReviewFinding; normalized: string }) => {
    const list = byCategory.get(entry.finding.category) ?? [];
    list.push({ ...entry, tokens: tokenSet(entry.normalized) });
    byCategory.set(entry.finding.category, list);
  };
  for (const bucket of byKey.values()) {
    const representative = [...bucket].sort(
      (a, b) =>
        severityRank(b.finding.severity) - severityRank(a.finding.severity) ||
        a.finding.findingId.localeCompare(b.finding.findingId),
    )[0]!;
    dedupCollapsed += bucket.length - 1;
    keep(representative);
  }
  const pool: Array<{ finding: ReviewFinding; tokens: Set<string> }> = [];
  for (const list of byCategory.values()) {
    // 类目内近重复折叠：与已保留项 Jaccard ≥ 0.8 → 折叠（保留代表，不叠加计数）
    for (const entry of list) {
      const duplicate = pool.some(
        (kept) =>
          kept.finding.category === entry.finding.category && jaccard(kept.tokens, entry.tokens) >= NEAR_DUP_JACCARD,
      );
      if (duplicate) {
        dedupCollapsed += 1;
      } else {
        pool.push(entry);
      }
    }
  }
  // 2) 确定性排序 + top-K
  pool.sort(
    (a, b) =>
      severityRank(b.finding.severity) - severityRank(a.finding.severity) ||
      CATEGORY_WEIGHT[b.finding.category] - CATEGORY_WEIGHT[a.finding.category] ||
      a.finding.findingId.localeCompare(b.finding.findingId),
  );
  const items: PriorityViewItem[] = pool.slice(0, Math.max(0, k)).map((entry) => ({
    findingId: entry.finding.findingId,
    severity: entry.finding.severity,
    category: entry.finding.category,
    source: entry.finding.source,
    ...(entry.finding.sectionId !== undefined ? { sectionId: entry.finding.sectionId } : {}),
    message: entry.finding.message,
    serious: entry.finding.severity === "critical" || entry.finding.severity === "major",
    meta: entry.finding.source === "fullpaper-review",
  }));
  return {
    k,
    items,
    dedupCollapsed,
    seriousCount: items.filter((item) => item.serious).length,
    metaCount: items.filter((item) => item.meta).length,
    basis: "deterministic severity+category scoring; exact/semantic(Jaccard>=0.8) dedup within category",
    poolSize: pool.length,
    seriousPoolCount: pool.filter(
      (entry) => entry.finding.severity === "critical" || entry.finding.severity === "major",
    ).length,
    metaPoolCount: pool.filter((entry) => entry.finding.source === "fullpaper-review").length,
  };
}
