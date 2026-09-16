/**
 * 元数据合并规则（M6.2 最小明确版本）。
 *
 * 场景：同一文献先经 PDF 上传入库（title 来自用户输入或 PDF 抽取），后经
 * DOI resolve / candidate promotion 补全正式元数据——不能新建第二条，也不能
 * 让低可信数据随意覆盖稳定字段。
 *
 * 三级可信（高 → 低）：
 *   user     —— 用户显式操作（HTTP PATCH、手动导入填写）
 *   resolved —— 学术库正式记录（ScholarlyResolver match 的 CanonicalPaperRecord）
 *   inferred —— 推测性数据（搜索 snippet、URL 页面标题、BibTeX 手抄条目）
 *
 * 规则（M6.2 不做字段级 provenance 追踪，条目级单值）：
 * - incoming 级别 ≥ current 级别 → incoming 非空字段覆盖；
 * - incoming 级别 < current 级别 → 只填充 current 空缺字段（不覆盖任何已有值）；
 * - 级别取合并后最大值。
 * 例：正式 DOI metadata（resolved）不会覆盖用户改过的 title（user），
 * 但会覆盖 PDF 抽取的错标题（inferred）。
 */

import type { SourceMetadata } from "./SourceStore.js";

export type MetadataProvenance = "user" | "resolved" | "inferred";

const PROVENANCE_RANK: Readonly<Record<MetadataProvenance, number>> = {
  inferred: 0,
  resolved: 1,
  user: 2,
};

export function compareProvenance(a: MetadataProvenance, b: MetadataProvenance): number {
  return PROVENANCE_RANK[a] - PROVENANCE_RANK[b];
}

export function mergeSourceMetadata(
  current: { metadata: SourceMetadata; provenance?: MetadataProvenance },
  incoming: { metadata: SourceMetadata; provenance: MetadataProvenance },
): { metadata: SourceMetadata; provenance: MetadataProvenance } {
  const currentProvenance: MetadataProvenance = current.provenance ?? "inferred";
  const incomingWins = compareProvenance(incoming.provenance, currentProvenance) >= 0;
  const metadata: SourceMetadata = incomingWins
    ? { ...current.metadata, ...definedFields(incoming.metadata) }
    : { ...definedFields(incoming.metadata), ...current.metadata };
  return {
    metadata,
    provenance:
      compareProvenance(incoming.provenance, currentProvenance) >= 0
        ? incoming.provenance
        : currentProvenance,
  };
}

/** 去掉 undefined 字段（spread 覆盖时 undefined 会抹掉已有值） */
function definedFields(metadata: SourceMetadata): Partial<SourceMetadata> {
  const out: Partial<SourceMetadata> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== "") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
