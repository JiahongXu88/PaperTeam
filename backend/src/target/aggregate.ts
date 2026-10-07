/**
 * 聚合：PaperStats[] → 四个确定性维度的分位带（M12 Batch 2 · A7）。
 *
 * 纯函数（无 IO / 无时间 / 无 LLM）——同语料同统计（golden 测试锁定）。
 * 覆盖纪律：每个维度只统计真实贡献样本（无解析产物 / 无对应节的论文被
 * 排除在 coverage 之外），availability 三态按 coverage 判定：
 *   0 → unavailable（带 reason）；< MIN_PROFILE_SAMPLES(5) → insufficient（带
 *   reason）；≥ 5 → available。Distribution.n 自身携带每条统计的真实样本数。
 *
 * method / writing 两维不在这里——它们是 bounded LLM 摘要维度，由
 * TargetProfileService 按调用结果填（失败 → unavailable，绝不伪造）。
 */

import type {
  ExperimentsProfileDimension,
  LiteratureProfileDimension,
  StructureProfileDimension,
  VisualsProfileDimension,
} from "./types.js";
import type { PaperStats } from "./paperStats.js";
import { distribution, medianOf, MIN_PROFILE_SAMPLES, round2 } from "./quantiles.js";

/** availability 三态判定（coverage = 真实贡献样本数） */
export function availabilityOf(
  coverage: number,
  subject: string,
): { availability: "available" | "unavailable" | "insufficient"; coverage: number; reason?: string } {
  if (coverage === 0) {
    return {
      availability: "unavailable",
      coverage,
      reason: `${subject}：语料中没有可提取该维度数据的论文（无解析产物或缺对应结构）`,
    };
  }
  if (coverage < MIN_PROFILE_SAMPLES) {
    return {
      availability: "insufficient",
      coverage,
      reason: `${subject}：仅 ${coverage} 篇有效样本（< ${MIN_PROFILE_SAMPLES}）——统计不具参照意义，readiness 按 INSUFFICIENT_EVIDENCE 处理`,
    };
  }
  return { availability: "available", coverage };
}

/** 结构维度：章节模式 + 总长/摘要长分位带 */
export function aggregateStructure(stats: readonly PaperStats[]): StructureProfileDimension {
  const contributors = stats.filter((entry) => entry.hasParsedDoc && entry.totalWords !== null && entry.totalWords > 0);
  const base = availabilityOf(contributors.length, "结构维度（正文词数）");
  if (base.availability === "unavailable") {
    return { ...base, sectionPattern: {} };
  }
  // 章节模式：跨论文聚合 present 计数 + 长度中位数（键按确定性序输出）
  const names = new Set<string>();
  for (const entry of contributors) {
    for (const name of entry.sectionWords.keys()) {
      names.add(name);
    }
  }
  const sectionPattern: StructureProfileDimension["sectionPattern"] = {};
  for (const name of [...names].sort()) {
    const lengths = contributors
      .filter((entry) => entry.sectionWords.has(name))
      .map((entry) => entry.sectionWords.get(name)!);
    sectionPattern[name] = {
      present: lengths.length,
      medianLengthWords: medianOf(lengths) ?? 0,
    };
  }
  const hasSectionTitles = names.size > 0;
  const totalLengthWords = distribution(contributors.map((entry) => entry.totalWords!));
  const abstractLengthWords = distribution(
    contributors.map((entry) => entry.abstractWords).filter((v): v is number => v !== null),
  );
  const reason =
    base.reason !== undefined
      ? base.reason
      : hasSectionTitles
        ? undefined
        : "语料解析产物无节标题（sectionPattern 为空——section provenance 缺失，总长/摘要长仍可用）";
  return {
    ...base,
    ...(reason !== undefined ? { reason } : {}),
    sectionPattern,
    ...(totalLengthWords !== null ? { totalLengthWords } : {}),
    ...(abstractLengthWords !== null ? { abstractLengthWords } : {}),
  };
}

/** 文献维度：引用规模/密度分位带 + 文献年龄中位数 */
export function aggregateLiterature(stats: readonly PaperStats[]): LiteratureProfileDimension {
  const refContributors = stats.filter((entry) => entry.referenceEntryCount !== null);
  const base = availabilityOf(refContributors.length, "文献维度（参考文献节）");
  const coverageNote =
    "引用计数 = 参考文献节条目数（[n] 标记优先，无标记按年份计数兜底）；密度 = 条目数 / 每 100 词；文献年龄 = 论文年 − 参考文献年中位数（年份为正则启发式提取）";
  if (base.availability === "unavailable") {
    return { ...base, coverageNote };
  }
  const density = refContributors
    .filter((entry) => entry.totalWords !== null && entry.totalWords > 0)
    .map((entry) => round2((entry.referenceEntryCount! / entry.totalWords!) * 100));
  const ages = stats
    .filter((entry) => entry.paperYear !== null && entry.referenceYears.length > 0)
    .map((entry) => entry.paperYear! - (medianOf(entry.referenceYears) ?? 0));
  const citationCountDist = distribution(refContributors.map((entry) => entry.referenceEntryCount!));
  const citationDensityDist = density.length > 0 ? distribution(density) : null;
  const medianAge = medianOf(ages);
  return {
    ...base,
    ...(citationCountDist !== null ? { citationCount: citationCountDist } : {}),
    ...(citationDensityDist !== null ? { citationDensity: citationDensityDist } : {}),
    ...(medianAge !== null ? { medianReferenceAgeYears: medianAge } : {}),
    coverageNote,
  };
}

/** 实验维度：表格规模分位带 + dataset 广度 + 消融/鲁棒性出现比例 */
export function aggregateExperiments(stats: readonly PaperStats[]): ExperimentsProfileDimension {
  const contributors = stats.filter((entry) => entry.hasParsedDoc);
  const base = availabilityOf(contributors.length, "实验维度（解析产物）");
  if (base.availability === "unavailable") {
    return base;
  }
  const tableDist = distribution(contributors.map((entry) => entry.tableCount ?? 0));
  const datasetDist = distribution(contributors.map((entry) => entry.datasetCount ?? 0));
  const ratio = (predicate: (entry: PaperStats) => boolean): number =>
    round2(contributors.filter(predicate).length / contributors.length);
  return {
    ...base,
    ...(tableDist !== null ? { tableCount: tableDist } : {}),
    ...(datasetDist !== null ? { datasetBreadth: datasetDist } : {}),
    ablationPresent: ratio((entry) => entry.ablationPresent),
    robustnessPresent: ratio((entry) => entry.robustnessPresent),
  };
}

/** 视觉维度：图数量分位带 + 方法总览图比例（figureTypeMix 需逐图 vision 分析，v1 未启用） */
export function aggregateVisuals(stats: readonly PaperStats[]): VisualsProfileDimension {
  const contributors = stats.filter((entry) => entry.hasParsedDoc && entry.parseMode === "structured");
  const note = "figureTypeMix（逐图类型分布）需要 per-figure vision 分析，v1 未启用——不伪造";
  if (contributors.length === 0) {
    return {
      ...availabilityOf(0, "视觉维度（结构化解析产物）"),
      note,
    };
  }
  const base = availabilityOf(contributors.length, "视觉维度（结构化解析产物）");
  const figureDist = distribution(contributors.map((entry) => entry.figureCount ?? 0));
  return {
    ...base,
    ...(figureDist !== null ? { figureCount: figureDist } : {}),
    methodDiagramPresent: round2(
      contributors.filter((entry) => entry.methodDiagramPresent).length / contributors.length,
    ),
    note,
  };
}
