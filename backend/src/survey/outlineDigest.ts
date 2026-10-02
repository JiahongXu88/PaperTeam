/**
 * Survey Outline Planner 输入 digest（M11.1.3）。
 *
 * 数据边界（Outline 是组织层，不是新的研究推理层）：
 * - digest 是 Synthesis artifact 的**投影**，不是第二份事实源——claim 截断、
 *   detail 摘要化，正文写作（M11.2）才需要真正的 EvidenceRecord / chunk；
 * - literatureRefs 的合法候选集 = Matrix entryIds 全集（经 entryId → Matrix →
 *   sourceId 追溯；title / year 只是 prompt 里的辅助视野，从 SourceStore
 *   注入，不落 Outline）；
 * - 真实已知弱点如实进入 digest（M11.1.2 smoke：abstract_only 聚集、
 *   unclassified、family 失衡）——这些是组织提示（planner 需解释结构依据），
 *   不是硬性配额；
 * - 纯函数（无 IO / 时钟）：同 Matrix + Synthesis 恒同 digest。
 */

import type { SurveyMatrixArtifact, SurveyMatrixEntry } from "./matrixTypes.js";
import { UNCLASSIFIED_FAMILY } from "./matrixTypes.js";
import type {
  SurveySynthesisArtifact,
  SurveySynthesisItem,
  SurveySynthesisKind,
  SynthesisGroundingLevel,
  SynthesisDetail,
} from "./synthesisTypes.js";

/** digest 内 claim 截断上限（完整 claim 在 synthesis artifact） */
export const DIGEST_CLAIM_LIMIT = 240;
/** digest 文献清单 title 截断上限 */
export const DIGEST_TITLE_LIMIT = 120;
/** digest items 防御上限（超大 synthesis 时按 grounding 优先级截断 speculative） */
export const DIGEST_ITEMS_MAX = 150;

/** digest 单条 synthesis 投影 */
export interface SurveyOutlineDigestItem {
  synthesisId: string;
  kind: SurveySynthesisKind;
  /** 截断后的综合陈述（≤ DIGEST_CLAIM_LIMIT） */
  claim: string;
  groundingLevel: SynthesisGroundingLevel;
  /** detail 关键字段的确定性摘要（family/subFamily、period、dimension、trigger、origin 等） */
  detail?: string;
  sourceCount: number;
  /** 该 synthesis 覆盖的 Matrix 条目（literatureRefs 候选） */
  entryIds: string[];
}

/** digest 文献清单行（title/year 从 SourceStore 注入；仅 prompt 视野，不落 Outline） */
export interface SurveyOutlineDigestLiterature {
  entryId: string;
  family: string;
  subFamily?: string;
  year?: number;
  title?: string;
  interpretationDepth: "fulltext" | "abstract_only";
}

export interface SurveyOutlineStats {
  totalEntries: number;
  fulltext: number;
  abstractOnly: number;
  unclassified: number;
  familyDistribution: Array<{
    label: string;
    count: number;
    subFamilies?: Array<{ label: string; count: number }>;
  }>;
  /** 年份分布（升序；无年份条目不计入） */
  yearDistribution: Array<{ year: number; count: number }>;
  groundingDistribution: Record<SynthesisGroundingLevel, number>;
}

export interface SurveyOutlineDigest {
  /** 综述主题（project.title） */
  topic: string;
  stats: SurveyOutlineStats;
  /** 按 synthesisId 升序（确定性） */
  items: SurveyOutlineDigestItem[];
  /** 按 entryId 升序（确定性） */
  literature: SurveyOutlineDigestLiterature[];
  /** speculative 超上限被截断的条数（>0 时 prompt 如实提示） */
  truncatedSpeculative: number;
}

export interface SurveyOutlineDigestMeta {
  topic: string;
  yearBySource?: Map<string, number>;
  titleBySource?: Map<string, string>;
}

/** detail → 确定性单行摘要（Outline 组织只需关键字段，不复制完整结构） */
function summarizeDetail(detail: SynthesisDetail | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  switch (detail.kind) {
    case "taxonomy":
      return `family=${detail.family}${detail.subFamily !== undefined ? ` / subFamily=${detail.subFamily}` : ""}`;
    case "trend":
      return `period=${detail.period}；direction=${detail.direction}`;
    case "comparison":
      return `dimension=${detail.dimension}；sides=${detail.sides.map((side) => `${side.label}(${side.entryIds.length})`).join(" vs ")}`;
    case "consensus":
      return detail.observedAgreement
        ? `observed agreement（${detail.distinctSources} 来源一致，非 consensus）`
        : `consensus（${detail.distinctSources} 来源）`;
    case "disagreement":
      return `issue=${detail.issue}`;
    case "research_gap":
      return `trigger=${detail.trigger}；basis=${detail.basis}`;
    case "future_direction":
      return `origin=${detail.origin}`;
  }
}

function toDigestItem(item: SurveySynthesisItem): SurveyOutlineDigestItem {
  return {
    synthesisId: item.synthesisId,
    kind: item.kind,
    claim: item.claim.slice(0, DIGEST_CLAIM_LIMIT),
    groundingLevel: item.groundingLevel,
    ...(item.detail !== undefined
      ? { detail: summarizeDetail(item.detail) }
      : {}),
    sourceCount: item.sourceIds.length,
    entryIds: [...item.derivedFrom.entryIds],
  };
}

/**
 * 构建 digest（纯函数）。超大 synthesis 时保 evidence_backed /
 * literature_cited 全量，speculative 按 synthesisId 序截断到 DIGEST_ITEMS_MAX
 * ——截断只影响推测类候选视野（planner 可用展望素材变少），绝不动摇已验证
 * 结论的组织依据；截断计数如实进入 digest。
 */
export function buildSurveyOutlineDigest(
  matrix: SurveyMatrixArtifact,
  synthesis: SurveySynthesisArtifact,
  meta: SurveyOutlineDigestMeta,
): SurveyOutlineDigest {
  const sorted = [...synthesis.items].sort((a, b) => a.synthesisId.localeCompare(b.synthesisId));
  const grounded = sorted.filter((item) => item.groundingLevel !== "speculative");
  const speculative = sorted.filter((item) => item.groundingLevel === "speculative");
  const keep = [...grounded, ...speculative.slice(0, Math.max(0, DIGEST_ITEMS_MAX - grounded.length))];
  const items = keep.map(toDigestItem).sort((a, b) => a.synthesisId.localeCompare(b.synthesisId));

  const familyDistribution: SurveyOutlineStats["familyDistribution"] = [];
  for (const family of matrix.taxonomy.families) {
    const inFamily = matrix.entries.filter((entry) => entry.methodFamily === family.label);
    if (inFamily.length === 0) {
      continue;
    }
    familyDistribution.push({
      label: family.label,
      count: inFamily.length,
      ...(family.subFamilies !== undefined && family.subFamilies.length > 0
        ? {
            subFamilies: family.subFamilies.map((sub) => ({
              label: sub,
              count: inFamily.filter((entry) => entry.subFamily === sub).length,
            })),
          }
        : {}),
    });
  }
  const unclassifiedCount = countUnclassified(matrix.entries);
  if (unclassifiedCount > 0) {
    familyDistribution.push({ label: UNCLASSIFIED_FAMILY, count: unclassifiedCount });
  }

  const yearCounts = new Map<number, number>();
  for (const entry of matrix.entries) {
    const year = meta.yearBySource?.get(entry.sourceId);
    if (year !== undefined) {
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
  }

  const groundingDistribution: Record<SynthesisGroundingLevel, number> = {
    evidence_backed: 0,
    literature_cited: 0,
    speculative: 0,
  };
  for (const item of synthesis.items) {
    groundingDistribution[item.groundingLevel] += 1;
  }

  const literature: SurveyOutlineDigestLiterature[] = matrix.entries
    .map((entry) => ({
      entryId: entry.entryId,
      family: entry.methodFamily ?? UNCLASSIFIED_FAMILY,
      ...(entry.subFamily !== undefined ? { subFamily: entry.subFamily } : {}),
      interpretationDepth: entry.interpretationDepth,
      ...(meta.yearBySource?.get(entry.sourceId) !== undefined
        ? { year: meta.yearBySource!.get(entry.sourceId) }
        : {}),
      ...(meta.titleBySource?.get(entry.sourceId) !== undefined
        ? { title: meta.titleBySource!.get(entry.sourceId)!.slice(0, DIGEST_TITLE_LIMIT) }
        : {}),
    }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));

  return {
    topic: meta.topic,
    stats: {
      totalEntries: matrix.entries.length,
      fulltext: matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length,
      abstractOnly: matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only").length,
      unclassified: unclassifiedCount,
      familyDistribution,
      yearDistribution: [...yearCounts.entries()]
        .map(([year, count]) => ({ year, count }))
        .sort((a, b) => a.year - b.year),
      groundingDistribution,
    },
    items,
    literature,
    truncatedSpeculative: speculative.length - Math.max(0, keep.length - grounded.length),
  };
}

/** unclassified 口径（与 SynthesisService.buildTaxonomyItems 一致：含标签失效条目） */
function countUnclassified(entries: SurveyMatrixEntry[]): number {
  return entries.filter((entry) => entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY)
    .length;
}

// ---- 渲染（prompt 组装单元；WriterService.buildSurveyOutlinePrompt 消费） ----

const KIND_LABELS: Record<SurveySynthesisKind, string> = {
  taxonomy: "taxonomy（方法分类骨架）",
  trend: "trend（演进趋势）",
  comparison: "comparison（跨方法比较）",
  consensus: "consensus（共识）",
  disagreement: "disagreement（分歧）",
  research_gap: "research_gap（研究空缺）",
  future_direction: "future_direction（未来方向）",
};

/** 按 kind 分组渲染 digest items（确定性文本；synthesisId 逐字可复制） */
export function renderDigestItems(digest: SurveyOutlineDigest): string[] {
  const lines: string[] = [];
  for (const kind of [
    "taxonomy",
    "trend",
    "comparison",
    "consensus",
    "disagreement",
    "research_gap",
    "future_direction",
  ] as SurveySynthesisKind[]) {
    const items = digest.items.filter((item) => item.kind === kind);
    if (items.length === 0) {
      lines.push(`--- ${KIND_LABELS[kind]}：无（大纲不得为该类发明内容）---`);
      continue;
    }
    lines.push(`--- ${KIND_LABELS[kind]}（${items.length} 条）---`);
    for (const item of items) {
      lines.push(
        `- [${item.synthesisId}] grounding=${item.groundingLevel}｜来源 ${item.sourceCount} 篇｜${item.claim}` +
          (item.detail !== undefined ? `｜detail: ${item.detail}` : "") +
          `｜entries: ${item.entryIds.join(",")}`,
      );
    }
  }
  if (digest.truncatedSpeculative > 0) {
    lines.push(
      `（注：speculative 条目超上限，另有 ${digest.truncatedSpeculative} 条未列出——展望章节只能引用已列出的 synthesisId）`,
    );
  }
  return lines;
}

/** 渲染文献清单（literatureRefs 候选全集） */
export function renderDigestLiterature(digest: SurveyOutlineDigest): string[] {
  return digest.literature.map((item) => {
    const parts = [
      item.entryId,
      `深度=${item.interpretationDepth}`,
      `家族=${item.family}${item.subFamily !== undefined ? `/${item.subFamily}` : ""}`,
    ];
    if (item.year !== undefined) {
      parts.push(`${item.year}`);
    }
    if (item.title !== undefined) {
      parts.push(item.title);
    }
    return `- ${parts.join("｜")}`;
  });
}

/** 渲染覆盖与分布统计（组织提示，不是硬性配额） */
export function renderDigestStats(digest: SurveyOutlineDigest): string[] {
  const { stats } = digest;
  const familyLines = stats.familyDistribution.map((family) => {
    const subs =
      family.subFamilies !== undefined
        ? `（${family.subFamilies.map((sub) => `${sub.label}=${sub.count}`).join(" / ")}）`
        : "";
    return `- ${family.label}: ${family.count} 篇${subs}`;
  });
  return [
    `- 文献总数：${stats.totalEntries}（fulltext ${stats.fulltext} / abstract_only ${stats.abstractOnly}）`,
    ...familyLines,
    stats.yearDistribution.length > 0
      ? `- 年份分布：${stats.yearDistribution.map((item) => `${item.year}:${item.count}`).join("、")}`
      : "- 年份分布：（无年份元数据）",
    `- grounding 分布：evidence_backed ${stats.groundingDistribution.evidence_backed} / literature_cited ${stats.groundingDistribution.literature_cited} / speculative ${stats.groundingDistribution.speculative}`,
    ...(stats.unclassified > 0
      ? [`- 未归类（unclassified）：${stats.unclassified} 篇——可在 keyPoints 说明其处理（如归入「其他方法」或留待人工修正）`]
      : []),
    ...(stats.abstractOnly >= Math.max(1, Math.ceil(stats.totalEntries / 2)) && stats.totalEntries >= 4
      ? [
          `- 提示：abstract_only 占比过半（${stats.abstractOnly}/${stats.totalEntries}）——这些文献只有摘要级理解，组织结构时避免让它们承载需要全文依据的小节（如实证对比）`,
        ]
      : []),
  ];
}
