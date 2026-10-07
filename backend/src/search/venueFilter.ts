/**
 * venue 客户端匹配规则（M12.1 A1 共享层；M12.0 §4.5 冻结）。
 *
 * 设计纪律：
 * - venue 过滤的**服务端 identity 是 OpenAlex source id**（primary_location
 *   .source.id，见 openalexProvider）；display name 只用于无服务端过滤能力的
 *   provider（Semantic Scholar / AMiner；arXiv 无 venue 字段天然过滤为空）的
 *   **客户端后滤**——本模块是该规则的唯一事实源，各 provider 复用同一函数，
 *   不在单一 Provider 内写死私有逻辑；
 * - 匹配规则（确定性、大小写/空白/标点不敏感，写明如下）：
 *   1. 归一化 = NFKC → 小写 → 去除所有非字母数字字符（保留 CJK）；
 *   2. **全等**（任意长度）算命中——"NeurIPS" vs "neurips"；
 *   3. **包含**（任一方向互为子串）且**较短一侧归一化后 ≥ 6 字符**算命中——
 *      "Advances in Neural Information Processing Systems 30"（会议卷号尾巴）
 *      命中 "Advances in Neural Information Processing Systems"；短侧长度门
 *      是刻意的反错配护栏（"ICLR" 4 字符不允许包含匹配到无关长名；缩写类
 *      venue 依赖种子表 alias 的全等命中或 OpenAlex source id 服务端过滤）。
 * - 无 venueNames（空数组 / 未提供）→ 一律放行（行为与字段引入前完全一致）。
 */

/** 归一化 venue 名：NFKC → 小写 → 仅保留字母数字与 CJK */
export function normalizeVenueForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 包含匹配的短侧最小长度（归一化后字符数；反 "ICLR"-式短缩写误命中） */
export const VENUE_CONTAINMENT_MIN_CHARS = 6;

/** 单个 venue 值是否命中过滤名集合（全等 或 带长度门的包含） */
export function matchesVenueName(
  venue: string | undefined,
  venueNames: readonly string[],
): boolean {
  if (venueNames.length === 0) {
    return true;
  }
  if (venue === undefined || venue.trim() === "") {
    return false; // 无法判定 venue 的记录不放行（不猜测——AMiner OA 同款纪律）
  }
  const normalizedVenue = normalizeVenueForMatch(venue);
  if (normalizedVenue === "") {
    return false;
  }
  for (const name of venueNames) {
    const normalized = normalizeVenueForMatch(name);
    if (normalized === "") {
      continue;
    }
    if (normalizedVenue === normalized) {
      return true;
    }
    const shorter = Math.min(normalizedVenue.length, normalized.length);
    if (
      shorter >= VENUE_CONTAINMENT_MIN_CHARS &&
      (normalizedVenue.includes(normalized) || normalized.includes(normalizedVenue))
    ) {
      return true;
    }
  }
  return false;
}

/** SearchOptions.venueNames → 有效过滤名集合（trim / 去空 / 去重；空 → 不过滤） */
export function effectiveVenueNames(
  venueNames: readonly string[] | undefined,
): string[] {
  if (venueNames === undefined) {
    return [];
  }
  return [...new Set(venueNames.map((name) => name.trim()).filter((name) => name !== ""))];
}
