/**
 * TargetGapService（M12 Batch 2 · A8）：当前稿 × TargetPublicationProfile →
 * research/target-readiness.json（六维四档判决 + 结构化差距）。
 *
 * 判定纪律（M12.0 §15 冻结语义）：
 * - 确定性对比为主：观测侧全部来自 manuscript .tex / visualInventory（B1 产物
 *   可缺省）的确定性提取；无 LLM 参与（LLM 摘要只作为 method/writing 维的
 *   targetRange 措辞进入，恒标注 model_summary）；
 * - 四档判决：内带 [p25,p75] = MEETS；外带 (min,max) = PARTIALLY；越出
 *   [min,max] = BELOW；样本不足/数据缺失 = INSUFFICIENT_EVIDENCE；
 * - **Target Gap 是「与 benchmark 观测带的距离」，永远不是稿件缺陷（事实
 *   错误）**——gap 文案固定携带该限定语；provenance 显式声明目标带来自
 *   benchmark 观测而非官方投稿要求（无 guideline ingestion，不冒充）；
 * - 无新数值分数门：不存在任何 targetScore；readiness 是 advisory 分类，
 *   不参与任何 Quality Gate 阻断判定（A9 只以附加字段透传）；
 * - 无手稿 → 全维 INSUFFICIENT_EVIDENCE（不 crash）；语料维度
 *   insufficient/unavailable → 该维 INSUFFICIENT_EVIDENCE（带原因）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { TargetBenchmarkService } from "./TargetBenchmarkService.js";
import { observeManuscript, type ManuscriptObservation } from "./manuscriptStats.js";
import { bandPosition, describeBand } from "./quantiles.js";
import type {
  TargetDimensionName,
  TargetDimensionReadiness,
  TargetGapConfidence,
  TargetProfileEnvelope,
  TargetPublicationProfile,
  TargetReadinessArtifact,
  TargetVerdict,
} from "./types.js";
import type { Distribution } from "./types.js";
import type { TargetProfileService } from "./TargetProfileService.js";

/** 「目标带多数论文具备」的判定线（present/n ≥ 0.5；确定性描述统计） */
const MAJORITY_RATIO = 0.5;

const GAP_DISCLAIMER = "（与 benchmark 观测带的距离陈述，不构成稿件事实错误；目标带非官方投稿要求）";

export interface TargetGapServiceOptions {
  projects: ProjectStore;
  benchmarks: TargetBenchmarkService;
  profiles: TargetProfileService;
  /** 当前稿修订号（缺省由调用方传入；如 ManuscriptRevisionStore.currentRevision） */
  currentRevision?: (projectId: string) => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface EvaluateReadinessOptions {
  /** 显式指定对齐修订号（null = 明确无修订记录；undefined = 未指定时尝试 dep） */
  manuscriptRevision?: number | null;
}

export class TargetGapService {
  private readonly projects: ProjectStore;
  private readonly benchmarks: TargetBenchmarkService;
  private readonly profiles: TargetProfileService;
  private readonly currentRevision: ((projectId: string) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetGapServiceOptions) {
    this.projects = options.projects;
    this.benchmarks = options.benchmarks;
    this.profiles = options.profiles;
    this.currentRevision = options.currentRevision;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-readiness.json");
  }

  /** 读上次评估结果（未评估 → null；损坏 → fail-closed 抛错） */
  async get(projectId: string): Promise<TargetReadinessArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseTargetReadiness(projectId, raw);
  }

  /**
   * 评估当前稿 vs 目标带（每次覆写落盘，带 evaluatedAt + manuscriptRevision）。
   * profile 不新鲜时先显式重建（ensureCurrent——陈旧参照系不得静默使用）。
   * benchmark artifact 缺失 → NotFoundError（调用方决定是否呈现 no-target 态）。
   */
  async evaluate(
    projectId: string,
    options: EvaluateReadinessOptions = {},
  ): Promise<TargetReadinessArtifact> {
    await this.projects.getRequired(projectId);
    const benchmark = await this.benchmarks.getRequired(projectId);
    const envelope: TargetProfileEnvelope | null = await this.profiles.get(projectId);
    const profile: TargetPublicationProfile =
      envelope !== null && envelope.fresh
        ? envelope.profile
        : (await this.profiles.ensureCurrent(projectId)).profile;
    const observation = await observeManuscript(this.projects, projectId);
    const manuscriptRevision =
      options.manuscriptRevision !== undefined
        ? options.manuscriptRevision
        : this.currentRevision !== undefined
          ? await this.currentRevision(projectId)
          : null;

    const dimensions: TargetDimensionReadiness[] = [
      evaluateStructure(profile, observation),
      evaluateLiterature(profile, observation),
      evaluateExperiments(profile, observation),
      evaluateVisuals(profile, observation),
      evaluateMethod(profile, observation),
      evaluateWriting(profile, observation),
    ];
    const overall = composeOverall(dimensions, profile, observation);
    const artifact: TargetReadinessArtifact = {
      schemaVersion: 1,
      evaluatedAt: this.now().toISOString(),
      benchmarkRevision: benchmark.revision,
      manuscriptRevision,
      dimensions,
      overall,
      provenance: {
        basis: "benchmark_observation",
        disclaimer:
          "目标带来自冻结 benchmark 语料的确定性观测（research/target-profile.json），不是期刊/会议官方投稿要求——系统未接入任何官方 guideline；目标带描述「这类论文通常怎么写」。",
        profileGeneratedAt: profile.generatedAt,
      },
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[target] projectId=${projectId} readiness 评估：overall=${overall.verdict}（benchmarkRevision=${benchmark.revision}，manuscriptRevision=${manuscriptRevision ?? "无"}）`,
    );
    return artifact;
  }
}

// ---- 判决组合（纯函数，单测直测）----

/** 维度判决合成：无任何可比指标 → INSUFFICIENT；有 BELOW → BELOW；有 PARTIALLY → PARTIALLY；否则 MEETS */
function rollUpVerdict(metricVerdicts: readonly TargetVerdict[]): TargetVerdict {
  const comparable = metricVerdicts.filter((verdict) => verdict !== "INSUFFICIENT_EVIDENCE");
  if (comparable.length === 0) {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (comparable.includes("BELOW_TARGET")) {
    return "BELOW_TARGET";
  }
  if (comparable.includes("PARTIALLY_MEETS_TARGET")) {
    return "PARTIALLY_MEETS_TARGET";
  }
  return "MEETS_TARGET";
}

/** 单指标三带判定（observed/band 缺失 → INSUFFICIENT_EVIDENCE） */
function metricVerdict(observed: number | null, band: Distribution | null): TargetVerdict {
  if (observed === null || band === null) {
    return "INSUFFICIENT_EVIDENCE";
  }
  const position = bandPosition(observed, band);
  if (position === "inner") {
    return "MEETS_TARGET";
  }
  if (position === "outer") {
    return "PARTIALLY_MEETS_TARGET";
  }
  return "BELOW_TARGET";
}

function confidenceOf(profileN: number, dimensionAvailable: boolean): TargetGapConfidence {
  if (!dimensionAvailable) {
    return "low";
  }
  return profileN >= 8 ? "high" : profileN >= 5 ? "medium" : "low";
}

/** 数值指标对比 → gap 串（距离语义；非 MEETS 才生成） */
function numericGap(
  dimension: TargetDimensionName,
  metric: string,
  observed: number,
  band: Distribution,
  unit: string,
): string {
  const position = bandPosition(observed, band);
  const direction =
    position === "below" ? "低于目标带下限" : position === "above" ? "高于目标带上限" : "在目标带内但不在中位带";
  return `[${dimension}/${metric}] 当前稿 ${observed} ${unit}；${direction}——${describeBand("目标带", band)}${GAP_DISCLAIMER}`;
}

/** 章节存在性对比（≥50% 带内论文具备的章节 = 预期章节；缺 → partial 级 gap） */
function missingExpectedSections(
  profile: TargetPublicationProfile,
  observation: ManuscriptObservation,
): { missing: string[]; present: string[] } {
  const n = profile.n;
  const expected = Object.entries(profile.dimensions.structure.sectionPattern)
    .filter(([, entry]) => entry.present / n >= MAJORITY_RATIO && entry.present >= 2)
    .map(([name]) => name)
    .filter((name) => name !== "references" && name !== "acknowledgments" && name !== "abstract");
  const missing = expected.filter((name) => !observation.sectionWords.has(name));
  const present = expected.filter((name) => observation.sectionWords.has(name));
  return { missing, present };
}

function noManuscriptDimension(dimension: TargetDimensionName, profileNote: string): TargetDimensionReadiness {
  return {
    dimension,
    verdict: "INSUFFICIENT_EVIDENCE",
    observed: "（尚无手稿——无观测点）",
    targetRange: profileNote,
    gaps: [],
    confidence: "low",
    evidenceBasis: "manuscript 目录无 .tex 文件——目标带参照系已就绪但当前无稿可比",
  };
}

// ---- 六维评估 ----

function evaluateStructure(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.structure;
  const band = dim.totalLengthWords ?? null;
  if (!observation.exists) {
    return noManuscriptDimension("structure", band !== null ? describeBand("正文词数", band) : "（profile 无结构统计）");
  }
  if (dim.availability !== "available") {
    return {
      dimension: "structure",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: structureObserved(observation),
      targetRange: "（语料结构统计不足）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile structure 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const gaps: string[] = [];
  const verdicts: TargetVerdict[] = [];
  const totalVerdict = metricVerdict(observation.totalWords, band);
  verdicts.push(totalVerdict);
  if (totalVerdict !== "MEETS_TARGET" && observation.totalWords !== null && band !== null) {
    gaps.push(numericGap("structure", "totalLengthWords", observation.totalWords, band, "词"));
  }
  const abstractBand = dim.abstractLengthWords ?? null;
  const abstractVerdict = metricVerdict(observation.abstractWords, abstractBand);
  verdicts.push(abstractVerdict);
  if (abstractVerdict !== "MEETS_TARGET" && observation.abstractWords !== null && abstractBand !== null) {
    gaps.push(numericGap("structure", "abstractLengthWords", observation.abstractWords, abstractBand, "词"));
  }
  const { missing } = missingExpectedSections(profile, observation);
  if (missing.length > 0) {
    verdicts.push("PARTIALLY_MEETS_TARGET");
    for (const name of missing) {
      gaps.push(
        `[structure/section:${name}] 当前稿未识别到「${name}」章；benchmark 带内 ≥${Math.round(MAJORITY_RATIO * 100)}% 论文设该章（present ${profile.dimensions.structure.sectionPattern[name]?.present ?? 0}/${profile.n}）${GAP_DISCLAIMER}`,
      );
    }
  }
  return {
    dimension: "structure",
    verdict: rollUpVerdict(verdicts),
    observed: structureObserved(observation),
    targetRange: [
      band !== null ? describeBand("正文词数", band) : "正文词数带不可用",
      abstractBand !== null ? describeBand("摘要词数", abstractBand) : "摘要词数带不可用",
    ].join("；"),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: "manuscript .tex 确定性提取（词数/章节切分）× research/target-profile.json structure 分位带",
  };
}

function structureObserved(observation: ManuscriptObservation): string {
  const sections = [...observation.sectionWords.keys()].sort();
  return `正文 ${observation.totalWords ?? "?"} 词；摘要 ${observation.abstractWords ?? "（无 abstract 环境）"}；识别章节：${sections.length > 0 ? sections.join("、") : "（无 \\section 级章节）"}`;
}

function evaluateLiterature(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.literature;
  const band = dim.citationCount ?? null;
  if (!observation.exists) {
    return noManuscriptDimension("literature", band !== null ? describeBand("参考文献条目数", band) : "（profile 无文献统计）");
  }
  if (dim.availability !== "available") {
    return {
      dimension: "literature",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: `distinct 引用 key ${observation.citationKeyCount ?? "?"} 个`,
      targetRange: "（语料文献统计不足）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile literature 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const gaps: string[] = [];
  const verdicts: TargetVerdict[] = [];
  const countVerdict = metricVerdict(observation.citationKeyCount, band);
  verdicts.push(countVerdict);
  if (countVerdict !== "MEETS_TARGET" && observation.citationKeyCount !== null && band !== null) {
    gaps.push(numericGap("literature", "citationCount", observation.citationKeyCount, band, "个 distinct key"));
  }
  const densityBand = dim.citationDensity ?? null;
  const densityVerdict = metricVerdict(observation.citationDensity, densityBand);
  verdicts.push(densityVerdict);
  if (densityVerdict !== "MEETS_TARGET" && observation.citationDensity !== null && densityBand !== null) {
    gaps.push(numericGap("literature", "citationDensity", observation.citationDensity, densityBand, "key/百词"));
  }
  return {
    dimension: "literature",
    verdict: rollUpVerdict(verdicts),
    observed: `distinct 引用 key ${observation.citationKeyCount ?? "?"} 个；密度 ${observation.citationDensity ?? "?"} key/百词`,
    targetRange: [
      band !== null ? describeBand("参考文献条目数", band) : "条目数带不可用",
      densityBand !== null ? describeBand("引用密度", densityBand) : "密度带不可用",
      dim.medianReferenceAgeYears !== undefined ? `文献年龄中位数 ${dim.medianReferenceAgeYears} 年` : "",
    ]
      .filter((part) => part !== "")
      .join("；"),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: "\\cite key 确定性提取 × profile literature 分位带（口径：profile 侧为参考文献节条目数，稿件侧为 distinct key 数——两侧口径差异如实呈现）",
  };
}

function evaluateExperiments(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.experiments;
  const band = dim.tableCount ?? null;
  if (!observation.exists) {
    return noManuscriptDimension("experiments", band !== null ? describeBand("表格数", band) : "（profile 无实验统计）");
  }
  if (dim.availability !== "available") {
    return {
      dimension: "experiments",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: experimentsObserved(observation),
      targetRange: "（语料实验统计不足）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile experiments 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const gaps: string[] = [];
  const verdicts: TargetVerdict[] = [];
  const tableVerdict = metricVerdict(observation.tableCount, band);
  verdicts.push(tableVerdict);
  if (tableVerdict !== "MEETS_TARGET" && observation.tableCount !== null && band !== null) {
    gaps.push(numericGap("experiments", "tableCount", observation.tableCount, band, "个表"));
  }
  const datasetBand = dim.datasetBreadth ?? null;
  const datasetVerdict = metricVerdict(observation.datasetCount, datasetBand);
  verdicts.push(datasetVerdict);
  if (datasetVerdict !== "MEETS_TARGET" && observation.datasetCount !== null && datasetBand !== null) {
    gaps.push(numericGap("experiments", "datasetBreadth", observation.datasetCount, datasetBand, "个 distinct dataset"));
  }
  if ((dim.ablationPresent ?? 0) >= MAJORITY_RATIO && !observation.ablationPresent) {
    // 目标带多数论文含 ablation 表述而当前稿未识别到（确定性字符串判定）
    verdicts.push("PARTIALLY_MEETS_TARGET");
    gaps.push(
      `[experiments/ablationPresent] benchmark 带内 ${Math.round((dim.ablationPresent ?? 0) * 100)}% 论文含 ablation 表述；当前稿全文未识别到该表述${GAP_DISCLAIMER}`,
    );
  }
  return {
    dimension: "experiments",
    verdict: rollUpVerdict(verdicts),
    observed: experimentsObserved(observation),
    targetRange: [
      band !== null ? describeBand("表格数", band) : "表格数带不可用",
      datasetBand !== null ? describeBand("dataset 广度", datasetBand) : "dataset 带不可用",
    ].join("；"),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: `${observation.source.visualInventory ? "visualInventory（B1）" : "\\begin{table} 计数"} 确定性提取 × profile experiments 分位带`,
  };
}

function experimentsObserved(observation: ManuscriptObservation): string {
  return `表 ${observation.tableCount ?? "?"} 个；distinct dataset 候选 ${observation.datasetCount ?? "?"} 个`;
}

function evaluateVisuals(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.visuals;
  const band = dim.figureCount ?? null;
  if (!observation.exists) {
    return noManuscriptDimension("visuals", band !== null ? describeBand("图数", band) : "（profile 无视觉统计）");
  }
  if (dim.availability !== "available") {
    return {
      dimension: "visuals",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: visualsObserved(observation),
      targetRange: "（语料视觉统计不足）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile visuals 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const gaps: string[] = [];
  const verdicts: TargetVerdict[] = [];
  const figureVerdict = metricVerdict(observation.figureCount, band);
  verdicts.push(figureVerdict);
  if (figureVerdict !== "MEETS_TARGET" && observation.figureCount !== null && band !== null) {
    gaps.push(numericGap("visuals", "figureCount", observation.figureCount, band, "个图"));
  }
  if ((dim.methodDiagramPresent ?? 0) >= MAJORITY_RATIO && observation.methodDiagramPresent === false) {
    verdicts.push("PARTIALLY_MEETS_TARGET");
    gaps.push(
      `[visuals/methodDiagramPresent] benchmark 带内 ${Math.round((dim.methodDiagramPresent ?? 0) * 100)}% 论文含方法总览图（caption/所在节启发式）；当前稿未识别到${GAP_DISCLAIMER}`,
    );
  }
  return {
    dimension: "visuals",
    verdict: rollUpVerdict(verdicts),
    observed: visualsObserved(observation),
    targetRange: [band !== null ? describeBand("图数", band) : "图数带不可用"].join("；"),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: `${observation.source.visualInventory ? "visualInventory（B1）" : "\\includegraphics 计数"} 确定性提取 × profile visuals 分位带`,
  };
}

function visualsObserved(observation: ManuscriptObservation): string {
  return `图 ${observation.figureCount ?? "?"} 个（方法总览图启发式：${observation.methodDiagramPresent === null ? "未判定" : observation.methodDiagramPresent ? "识别到" : "未识别到"}）`;
}

/**
 * method 维：确定性可比指标只有「方法章存在性」（vs 带内多数是否设方法章）；
 * 深度/新颖性框定是 model_summary 参照（targetRange 措辞），不参与判决——
 * 定性维度不得凭确定性代码判 MEETS（过度声称）。
 */
function evaluateMethod(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.method;
  const methodPattern = profile.dimensions.structure.sectionPattern["method"];
  if (!observation.exists) {
    return noManuscriptDimension("method", methodNoteRange(dim, methodPattern));
  }
  if (dim.availability !== "available") {
    return {
      dimension: "method",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: methodObserved(observation),
      targetRange: "（语料结构统计不足——method 摘要不可用）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile method 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const methodExpected = methodPattern !== undefined && methodPattern.present / profile.n >= MAJORITY_RATIO;
  const gaps: string[] = [];
  let verdict: TargetVerdict;
  if (methodExpected && observation.methodSectionWords === null) {
    verdict = "BELOW_TARGET";
    gaps.push(
      `[method/section:method] benchmark 带内 ${methodPattern!.present}/${profile.n} 篇设独立方法章；当前稿未识别到（章节切分为确定性 \\section 级识别，缺省不伪造）${GAP_DISCLAIMER}`,
    );
  } else {
    // 方法深度无法确定性判定：如实 PARTIALLY（观测点存在，但深度对比依赖 model_summary 参照）
    verdict = "PARTIALLY_MEETS_TARGET";
    if (observation.methodSectionWords !== null) {
      gaps.push(
        `[method/depth] 方法章 ${observation.methodSectionWords} 词（带内中位数 ${methodPattern?.medianLengthWords ?? "不可用"} 词）；深度与新颖性框定对照 model_summary 参照，须作者/审稿人判断${GAP_DISCLAIMER}`,
      );
    }
  }
  return {
    dimension: "method",
    verdict,
    observed: methodObserved(observation),
    targetRange: methodNoteRange(dim, methodPattern),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: "方法章存在性确定性判定 × profile method 摘要（model_summary，advisory）",
  };
}

function methodObserved(observation: ManuscriptObservation): string {
  return observation.methodSectionWords !== null
    ? `设方法章（${observation.methodSectionWords} 词）`
    : "未识别到 \\section 级方法章";
}

function methodNoteRange(
  dim: TargetPublicationProfile["dimensions"]["method"],
  methodPattern: { present: number; medianLengthWords: number } | undefined,
): string {
  const parts: string[] = [];
  if (methodPattern !== undefined) {
    parts.push(`带内 ${methodPattern.present} 篇设方法章（词数中位数 ${methodPattern.medianLengthWords}）`);
  }
  if (dim.depthNote !== undefined) {
    parts.push(`深度模式（model_summary）：${dim.depthNote}`);
  }
  if (dim.noveltyFramingNote !== undefined) {
    parts.push(`新颖性框定（model_summary）：${dim.noveltyFramingNote}`);
  }
  return parts.length > 0 ? parts.join("；") : "（无 method 参照）";
}

/** writing 维：确定性可比指标 = limitations 章存在性（vs 带内比例）；其余为 model_summary 参照 */
function evaluateWriting(profile: TargetPublicationProfile, observation: ManuscriptObservation): TargetDimensionReadiness {
  const dim = profile.dimensions.writing;
  if (!observation.exists) {
    return noManuscriptDimension("writing", writingNoteRange(dim, profile));
  }
  if (dim.availability !== "available") {
    return {
      dimension: "writing",
      verdict: "INSUFFICIENT_EVIDENCE",
      observed: writingObserved(observation),
      targetRange: "（语料结构统计不足——writing 摘要不可用）",
      gaps: [],
      confidence: "low",
      evidenceBasis: `profile writing 维度 ${dim.availability}：${dim.reason ?? "无有效样本"}`,
    };
  }
  const limitationsExpected = (dim.limitationsPresent ?? 0) >= MAJORITY_RATIO;
  const gaps: string[] = [];
  let verdict: TargetVerdict;
  if (limitationsExpected && !observation.limitationsPresent) {
    verdict = "PARTIALLY_MEETS_TARGET";
    gaps.push(
      `[writing/limitationsPresent] benchmark 带内 ${Math.round((dim.limitationsPresent ?? 0) * 100)}% 论文含 limitations 表述；当前稿未识别到（确定性字符串判定）${GAP_DISCLAIMER}`,
    );
  } else {
    verdict = "PARTIALLY_MEETS_TARGET"; // 论断强度/讨论深度须作者/审稿人判断——定性维度不判 MEETS
    gaps.push(
      `[writing/depth] 论断强度与讨论深度对照 model_summary 参照（claim 强度 / discussion 模式），须作者/审稿人判断${GAP_DISCLAIMER}`,
    );
  }
  return {
    dimension: "writing",
    verdict,
    observed: writingObserved(observation),
    targetRange: writingNoteRange(dim, profile),
    gaps,
    confidence: confidenceOf(profile.n, true),
    evidenceBasis: "limitations 存在性确定性判定 × profile writing 摘要（model_summary，advisory）",
  };
}

function writingObserved(observation: ManuscriptObservation): string {
  return `limitations 表述：${observation.limitationsPresent ? "识别到" : "未识别到"}；摘要 ${observation.abstractWords ?? "（无 abstract 环境）"} 词`;
}

function writingNoteRange(
  dim: TargetPublicationProfile["dimensions"]["writing"],
  profile: TargetPublicationProfile,
): string {
  const parts: string[] = [];
  const limitationsSection = profile.dimensions.structure.sectionPattern["limitations"];
  const limitationRatio =
    dim.limitationsPresent ??
    (limitationsSection !== undefined ? limitationsSection.present / profile.n : undefined);
  if (limitationRatio !== undefined) {
    const percent = Math.round(limitationRatio * 100);
    parts.push(`带内 ${percent}% 论文含 limitations 表述`);
  }
  if (dim.claimStrengthNote !== undefined) {
    parts.push(`论断强度模式（model_summary）：${dim.claimStrengthNote}`);
  }
  if (dim.discussionDepthNote !== undefined) {
    parts.push(`讨论深度模式（model_summary）：${dim.discussionDepthNote}`);
  }
  return parts.length > 0 ? parts.join("；") : "（无 writing 参照）";
}

// ---- 总判决 ----

function composeOverall(
  dimensions: readonly TargetDimensionReadiness[],
  profile: TargetPublicationProfile,
  observation: ManuscriptObservation,
): TargetReadinessArtifact["overall"] {
  const counts = dimensions.reduce(
    (acc, entry) => {
      acc[entry.verdict] += 1;
      return acc;
    },
    { MEETS_TARGET: 0, PARTIALLY_MEETS_TARGET: 0, BELOW_TARGET: 0, INSUFFICIENT_EVIDENCE: 0 } as Record<TargetVerdict, number>,
  );
  let verdict: TargetVerdict;
  if (counts.MEETS_TARGET + counts.PARTIALLY_MEETS_TARGET + counts.BELOW_TARGET === 0) {
    verdict = "INSUFFICIENT_EVIDENCE";
  } else if (counts.BELOW_TARGET > 0) {
    verdict = "BELOW_TARGET";
  } else if (counts.PARTIALLY_MEETS_TARGET > 0 || counts.INSUFFICIENT_EVIDENCE > 0) {
    // 存在不可判维时不声称整体 MEETS（诚实：证据不全的最强可声明档位是 PARTIAL）
    verdict = "PARTIALLY_MEETS_TARGET";
  } else {
    verdict = "MEETS_TARGET";
  }
  const parts = [
    `达标 ${counts.MEETS_TARGET} 维 / 部分 ${counts.PARTIALLY_MEETS_TARGET} 维 / 低于目标带 ${counts.BELOW_TARGET} 维 / 证据不足 ${counts.INSUFFICIENT_EVIDENCE} 维`,
  ];
  if (!observation.exists) {
    parts.push("当前无手稿——全部维度无观测点");
  } else {
    parts.push(`观测基准：manuscript ${observation.files.length} 个 .tex 的确定性提取`);
  }
  parts.push(`参照系：benchmark 语料 ${profile.n} 篇（benchmark 观测，非官方投稿要求）`);
  const totalGaps = dimensions.reduce((sum, entry) => sum + entry.gaps.length, 0);
  if (totalGaps > 0) {
    parts.push(`${totalGaps} 项距离差距（advisory，不阻断任何质量门禁，也不构成稿件事实错误）`);
  }
  return { verdict, summary: parts.join("；") };
}

/** 解析 + 结构校验（fail-closed） */
function parseTargetReadiness(projectId: string, raw: string): TargetReadinessArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw readinessCorrupted(projectId, "不是合法 JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record === null || !Array.isArray(record["dimensions"])) {
    throw readinessCorrupted(projectId, "缺少 dimensions 数组");
  }
  if (record["schemaVersion"] !== 1) {
    throw readinessCorrupted(projectId, `不支持的 schemaVersion=${String(record["schemaVersion"])}`);
  }
  if (typeof record["overall"] !== "object" || record["overall"] === null) {
    throw readinessCorrupted(projectId, "缺少 overall");
  }
  return parsed as TargetReadinessArtifact;
}

function readinessCorrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "TARGET_READINESS_CORRUPTED",
    `项目 ${projectId} 的 target-readiness.json 损坏（${detail}）——拒绝降级解读，请重新评估（target.readiness stage / evaluate 均可）`,
  );
}
