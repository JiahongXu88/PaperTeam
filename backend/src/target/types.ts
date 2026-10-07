/**
 * Target Publication Intelligence 域类型（M12.1 A5；M12.0 §4.3 冻结 schema）。
 *
 * artifact 布局（project artifact，落 projects.researchDir）：
 *   research/target-benchmark.json   冻结的 benchmark 语料（本文件；revision 模式
 *                                    照抄 CorpusSnapshotService——冻结后普通读取
 *                                    no-op，显式 refresh 才 revision+1）
 *   research/target-profile.json     A7（Batch 2）：确定性提取 + bounded LLM 摘要
 *   research/target-readiness.json   A8（Batch 2）：六维四档判决 + 结构化差距
 *
 * 语义红线：
 * - benchmark 论文在 SourceStore 里恒 `sourceRole="reference"`（D-0012：回答
 *   「这类论文通常怎么写」，不回答「claim 是否被支撑」）；它永远不进 evidence
 *   供给链（M12.0 §5 四道隔离）；
 * - fingerprint 只覆盖参与语料的行内容（含 citationCount/venue/excluded），
 *   确定性排序——同语料恒同指纹，不含时间戳/revision；
 * - citationCount 是发现时快照（provider provenance，LLM 不得生成）。
 */

/** 语料时间窗（发现范围；inclusive） */
export interface BenchmarkTimeWindow {
  from?: number;
  to?: number;
}

/** 目标三元组 + 研究领域（ProjectMetadata 对应字段的冻结快照） */
export interface BenchmarkTargetSpec {
  documentType: string;
  targetProfile: string;
  targetVenue?: string;
  researchField?: string;
  timeWindow?: BenchmarkTimeWindow;
}

/** 冻结语料单行（一篇 benchmark 论文） */
export interface TargetBenchmarkPaper {
  /** SourceStore 主键（sourceRole="reference"） */
  sourceId: string;
  /** 冻结时身份快照（identity.ts 分层键；跨 provider 判等审计） */
  identityKey: string;
  provenance: {
    provider: string;
    retrievedAt: string;
    queryUsed: string;
  };
  /** 复用 CandidateStore.selectionReason 语义（为什么进语料） */
  inclusionReason: string;
  /** 发现时快照（provider 实测；缺省 = provider 未提供） */
  citationCount?: number;
  /** 未归一化 venue 原文（诚实：不作 canonical 化） */
  venueRaw: string;
  /** 磁盘事实：发现/冻结时是否已有全文文件 */
  hasFullText: boolean;
  /** 冻结后显式剔除（revision 语义见 TargetBenchmarkService.exclude） */
  excluded?: { reason: string; at: string };
}

/** 语料充分性（A6；必须标记，不静默） */
export type BenchmarkSufficiency = "sufficient" | "insufficient";

/** 选择记录（A6 auto-select 的审计快照；additive——旧 artifact 无此块照常读） */
export interface TargetBenchmarkSelection {
  selectedAt: string;
  /** 选中目标数（带内 8–15，默认目标 12） */
  targetCount: number;
  sufficiency: BenchmarkSufficiency;
  /** insufficient 时的原因（候选不足 / venue 未解析等） */
  reason?: string;
  /** 结构化注意项（供未来 workflow 决定是否 required HITL；空 = 无） */
  requiresAttention: string[];
}

export interface TargetBenchmarkArtifact {
  schemaVersion: 1;
  /** 0 起；显式 refresh / addPaper +1；exclude 不加（同修订内剔除标记） */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** 参与语料行的 sha256（见 benchmarkFingerprint；语料变指纹必变） */
  fingerprint: string;
  target: BenchmarkTargetSpec;
  papers: TargetBenchmarkPaper[];
  /** 选中快照（A6 discoverAndFreeze 写入；手动 freeze 可缺省） */
  selection?: TargetBenchmarkSelection;
  /** HITL 确认时间戳（A6 confirm；幂等——仅首次写入） */
  confirmedAt?: string;
}

// ============================================================
// M12 Batch 2 · A7/A8：TargetPublicationProfile 与 TargetReadiness
//（M12.0 §4.3 冻结 schema 的实施形态；相对冻结稿的 additive 差异 =
//  每维度携带 availability/coverage/reason——「语料论文无全文/无解析产物
//  时统计不得发明」的诚实纪律要求区分数据可用性，Batch 1 先例允许 additive）
// ============================================================

/**
 * 确定性分位分布（M12.0 §4.3：小样本 8–15 篇下分位带比均值±方差诚实；
 * 分位数计算纯代码确定性——同输入恒同输出，无模型参与）。
 */
export interface Distribution {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

/**
 * 维度数据可用性三态：
 * - available：coverage ≥ MIN_PROFILE_SAMPLES(5) 且统计真实来自解析产物；
 * - unavailable：该维度根本没有可提取的数据源（无解析产物 / 无参考文献节 / 模型未配置）；
 * - insufficient：有部分数据但 coverage < 5——readiness 消费时按 INSUFFICIENT_EVIDENCE。
 */
export type DimensionAvailability = "available" | "unavailable" | "insufficient";

/** 每维度共用覆盖信息（诚实纪律：coverage 是真实贡献样本数，不是语料总数） */
export interface DimensionCoverage {
  availability: DimensionAvailability;
  /** 实际贡献该维度统计的论文数（≤ profile.n；无解析产物的论文不计数） */
  coverage: number;
  /** unavailable / insufficient 的原因（必填于非 available 态，不静默） */
  reason?: string;
}

/** structure 维度：章节模式 + 总长/摘要长分位带 */
export interface StructureProfileDimension extends DimensionCoverage {
  /** 规范化章节名 → { present: 出现该章的论文数, medianLengthWords: 跨论文章长中位数 } */
  sectionPattern: Record<string, { present: number; medianLengthWords: number }>;
  totalLengthWords?: Distribution;
  abstractLengthWords?: Distribution;
}

/** literature 维度：引用规模/密度/文献新近度（来自 references 节 + 元数据年份，确定性） */
export interface LiteratureProfileDimension extends DimensionCoverage {
  /** 参考文献条目数分位带（条目计数 = [n] 标记或年份启发，见 paperStats 注释） */
  citationCount?: Distribution;
  /** 每 100 词引用密度分位带 */
  citationDensity?: Distribution;
  /** 文献年龄中位数（论文年份 − 参考文献年份中位数；年） */
  medianReferenceAgeYears?: number;
  /** 提取口径说明（启发式的诚实披露） */
  coverageNote?: string;
}

/** experiments 维度：表格规模/数据集广度/消融与鲁棒性出现比例（确定性） */
export interface ExperimentsProfileDimension extends DimensionCoverage {
  tableCount?: Distribution;
  datasetBreadth?: Distribution;
  /** 含 ablation 表述的论文比例（0–1） */
  ablationPresent?: number;
  /** 含 robustness 表述的论文比例（0–1） */
  robustnessPresent?: number;
}

/** visuals 维度：图数量分位带 + 方法图出现比例（确定性；figureTypeMix 需逐图 vision 分析，v1 未启用） */
export interface VisualsProfileDimension extends DimensionCoverage {
  figureCount?: Distribution;
  /** 含方法总览图（caption/所在节启发式）的论文比例（0–1） */
  methodDiagramPresent?: number;
  /** figureTypeMix 的诚实说明（v1 不做逐图 vision 分类） */
  note?: string;
}

/** method 维度：LLM 结构模式归纳摘要（provenance=model_summary；失败 → UNAVAILABLE） */
export interface MethodProfileDimension extends DimensionCoverage {
  /** 方法深度模式（目标带论文通常如何组织方法/推导/复杂度论述） */
  depthNote?: string;
  /** 新颖性框定模式（如何定位贡献 vs 已有工作） */
  noveltyFramingNote?: string;
}

/** writing 维度：limitations 出现比例（确定性）+ LLM 摘要两则 */
export interface WritingProfileDimension extends DimensionCoverage {
  claimStrengthNote?: string;
  /** 含 limitations 章节的论文比例（0–1；确定性字符串判定） */
  limitationsPresent?: number;
  discussionDepthNote?: string;
}

export interface TargetPublicationProfileDimensions {
  structure: StructureProfileDimension;
  literature: LiteratureProfileDimension;
  experiments: ExperimentsProfileDimension;
  visuals: VisualsProfileDimension;
  method: MethodProfileDimension;
  writing: WritingProfileDimension;
}

/**
 * Target Publication Profile（research/target-profile.json；M12.0 §4.2-2 裁决：
 * project artifact、derived 落盘、freshness 三键）。反抄袭红线：profile 内
 * 没有任何 benchmark 论文原文——只有聚合分布与（method/writing）模型摘要。
 */
export interface TargetPublicationProfile {
  schemaVersion: 1;
  /** 溯源到冻结语料（target-benchmark.json 的 revision） */
  benchmarkRevision: number;
  /** freshness 键：与当前 benchmark artifact fingerprint 不一致 → 陈旧，须重建 */
  corpusFingerprint: string;
  /** freshness 键：提取器演进即失效（当前 1） */
  extractorSchemaVersion: number;
  /** 有效语料数（未 excluded 的条目数） */
  n: number;
  dimensions: TargetPublicationProfileDimensions;
  provenance: {
    deterministicFields: string[];
    modelSummarizedFields: string[];
    model?: string;
    /** 模型摘要失败原因（method/writing 转 UNAVAILABLE 时的诚实记录） */
    summaryFailure?: string;
  };
  generatedAt: string;
  /** 启发式口径与降级说明（确定性；不静默） */
  notes: string[];
}

/** get() 返回的信封：fresh=false 时消费方不得当作当前参照系静默使用 */
export interface TargetProfileEnvelope {
  profile: TargetPublicationProfile;
  fresh: boolean;
  staleReason?: "benchmark_revision_changed" | "corpus_fingerprint_changed" | "extractor_schema_version_changed";
}

// ---- A8：Target Readiness（research/target-readiness.json）----

export type TargetDimensionName =
  | "structure"
  | "literature"
  | "experiments"
  | "visuals"
  | "method"
  | "writing";

/** 四档分类判决（M12.0 §15：advisory，不阻断任何 gate；无数值分数） */
export type TargetVerdict =
  | "MEETS_TARGET"
  | "PARTIALLY_MEETS_TARGET"
  | "BELOW_TARGET"
  | "INSUFFICIENT_EVIDENCE";

export type TargetGapConfidence = "high" | "medium" | "low";

export interface TargetDimensionReadiness {
  dimension: TargetDimensionName;
  verdict: TargetVerdict;
  /** 当前稿实测（确定性优先；措辞描述距离，不判定缺陷） */
  observed: string;
  /** 目标带（来自 profile 分位带；标注 benchmark 观测来源） */
  targetRange: string;
  /** 结构化差距串（可被 Planner 消费；恒为「距离」语义，非事实错误） */
  gaps: string[];
  confidence: TargetGapConfidence;
  /** 支撑该判定的 parser facts / 产物来源说明 */
  evidenceBasis: string;
}

export interface TargetReadinessArtifact {
  schemaVersion: 1;
  evaluatedAt: string;
  benchmarkRevision: number;
  /** 对齐的 manuscript 修订号（无手稿 / 无修订记录 → null，不伪造 0） */
  manuscriptRevision: number | null;
  dimensions: TargetDimensionReadiness[];
  overall: { verdict: TargetVerdict; summary: string };
  /** 语义红线声明：目标带是 benchmark 观测，不是官方投稿要求 */
  provenance: {
    basis: "benchmark_observation";
    disclaimer: string;
    profileGeneratedAt: string;
  };
}
