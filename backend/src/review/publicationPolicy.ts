/**
 * 发表目标（publication-target/v1）与审稿政策快照（review-policy/v1）。
 *
 * 产品语义（docs/research/PUBLICATION_TARGET_REVIEW_POLICY_PRODUCT_CLOSURE.md）：
 * - PublicationTarget 只表达用户的**投稿意图**（体系 + 层级 + 名单年份 + 可选期刊），不是「这篇稿件 / 这本期刊
 *   属于该层级」的事实。北大核心 / CSCD / CSSCI 是彼此独立的收录体系（不排一维等级）；中科院分区与 JCR 分区是两套
 *   体系（「SCI 一区」含糊 → 要求用户二选一）；EI / Scopus 不是 SCI 分区，不提供该选项。
 * - 层级是否「已核实」只来自已核验期刊 profile 的官方自述（SELF_DECLARED + 原句 + 来源）；CAS / JCR 分区没有接入任何
 *   数据源 → 恒为「用户设定目标，未核实」。
 * - ReviewPolicy 只调整**审稿关注点与建议排序**（受控 rubric registry；按稿件类型区分研究论文 / 综述 / 学位论文）。
 *   它不设分数线、不预测录用、不声称「达到某分区水平」；与发表层级无关的底线（事实 / 数据 / 引用 / 定位 / 方法证据
 *   对应 / 如实标注不确定性）对所有目标完全相同。
 * - 快照在 WorkflowRun 创建时冻结（WorkflowState.reviewPolicy）；运行中修改项目设置只影响之后新建的运行。
 *   旧 run（无快照）按 null 处理 = 全部审稿 prompt 与升级前逐字节一致。
 *
 * 纯函数模块：无 I/O、无模型调用。
 */
import { createHash } from "node:crypto";

import type { JournalProfile } from "../target/journal/profileTypes.js";

export const PUBLICATION_TARGET_SCHEMA_VERSION = "publication-target/v1" as const;
export const REVIEW_POLICY_SCHEMA_VERSION = "review-policy/v1" as const;
/** 审稿政策（rubric registry + 渲染文案）版本：任何维度 / 文案语义变化必须递增 */
export const REVIEW_POLICY_VERSION = "publication-review-policy/1" as const;

export type PublicationScheme = "none" | "chinese_index" | "cas" | "jcr";

export const PUBLICATION_SCHEMES: readonly PublicationScheme[] = ["none", "chinese_index", "cas", "jcr"];

/** 各体系的合法层级（体系内校验；不同体系的层级不可互换，也不跨体系比较高低） */
export const PUBLICATION_TIERS: Record<Exclude<PublicationScheme, "none">, readonly string[]> = {
  // 三个独立收录 / 评价体系，不是一维等级
  chinese_index: ["PKU_CORE", "CSCD", "CSSCI"],
  cas: ["1", "2", "3", "4"],
  jcr: ["Q1", "Q2", "Q3", "Q4"],
};

export const PUBLICATION_SCHEME_LABELS: Record<PublicationScheme, string> = {
  none: "未设置发表目标",
  chinese_index: "中文核心类收录",
  cas: "中科院分区",
  jcr: "JCR 分区",
};

export const PUBLICATION_TIER_LABELS: Record<string, string> = {
  PKU_CORE: "北大核心",
  CSCD: "CSCD",
  CSSCI: "CSSCI",
  "cas:1": "中科院一区",
  "cas:2": "中科院二区",
  "cas:3": "中科院三区",
  "cas:4": "中科院四区",
  Q1: "JCR Q1",
  Q2: "JCR Q2",
  Q3: "JCR Q3",
  Q4: "JCR Q4",
};

export interface PublicationTarget {
  schemaVersion: typeof PUBLICATION_TARGET_SCHEMA_VERSION;
  scheme: PublicationScheme;
  /** 体系内层级（scheme=none 时缺省） */
  tier?: string;
  /** 用户所指的名单 / 分区版本年份（只记录意图，不据此认证任何事实） */
  schemeYear?: number;
  /** 已核验期刊 profile 身份（内置 registry 中必须存在） */
  targetJournalId?: string;
  /** 用户自填期刊名（不代表存在已核验 profile；与 targetJournalId 互斥） */
  customJournalName?: string;
  updatedAt: string;
}

/** 层级事实状态：系统只承认已核验 profile 的官方自述；其余恒为未核实 */
export type TierFactStatus = "NOT_SET" | "USER_TARGET_UNVERIFIED" | "JOURNAL_SELF_DECLARED";

export interface TierFact {
  status: TierFactStatus;
  /** 面向用户的一句话（不含「已认证 / 达标」措辞） */
  note: string;
  officialQuote?: string;
  sourceUrl?: string;
  year?: string;
}

const CUSTOM_JOURNAL_MAX = 200;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class PublicationTargetValidationError extends Error {}

/** 常见含糊 / 错误体系名 → 引导文案（API 拒绝时原样返回给用户） */
const SCHEME_GUIDANCE: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /^(sci|scie)$/i, message: "「SCI 分区」有中科院分区（cas）与 JCR 分区（jcr）两套体系，层级不可互换：请明确选择其一" },
  { pattern: /^(ei|scopus|ei_compendex)$/i, message: "EI / Scopus 是收录数据库，不是 SCI 分区；当前版本不支持把它们设为分区目标（可在目标期刊中填写期刊名）" },
  { pattern: /^(core|chinese_core|pku|cscd|cssci)$/i, message: "中文核心类请使用 scheme=chinese_index，并在 tier 中选择 PKU_CORE / CSCD / CSSCI 之一（三者是独立体系）" },
];

/**
 * 校验并归一化发表目标输入。null / undefined / {scheme:"none"} 且无期刊 → null（= 未设置）。
 * 非法输入抛 PublicationTargetValidationError（调用方映射为 400）。
 */
export function normalizePublicationTarget(
  raw: unknown,
  options: { now: Date; knownJournalIds: ReadonlySet<string> },
): PublicationTarget | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicationTargetValidationError("publicationTarget 必须是对象");
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "scheme", "tier", "schemeYear", "targetJournalId", "customJournalName", "updatedAt"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new PublicationTargetValidationError(`publicationTarget 不支持字段 ${key}`);
  }
  const schemeRaw = record["scheme"] ?? "none";
  if (typeof schemeRaw !== "string") throw new PublicationTargetValidationError("scheme 必须是字符串");
  if (!(PUBLICATION_SCHEMES as readonly string[]).includes(schemeRaw)) {
    const guidance = SCHEME_GUIDANCE.find((entry) => entry.pattern.test(schemeRaw.trim()));
    throw new PublicationTargetValidationError(guidance?.message ?? `scheme 只能是 ${PUBLICATION_SCHEMES.join(" / ")}`);
  }
  const scheme = schemeRaw as PublicationScheme;

  const out: PublicationTarget = { schemaVersion: PUBLICATION_TARGET_SCHEMA_VERSION, scheme, updatedAt: options.now.toISOString() };

  const tierRaw = record["tier"];
  if (scheme === "none") {
    if (tierRaw !== undefined && tierRaw !== null && tierRaw !== "") {
      throw new PublicationTargetValidationError("未选择发表体系（scheme=none）时不能设置 tier");
    }
    if (record["schemeYear"] !== undefined && record["schemeYear"] !== null) {
      throw new PublicationTargetValidationError("未选择发表体系（scheme=none）时不能设置 schemeYear");
    }
  } else {
    if (typeof tierRaw !== "string" || tierRaw.trim() === "") {
      throw new PublicationTargetValidationError(`${PUBLICATION_SCHEME_LABELS[scheme]} 需要选择层级（${PUBLICATION_TIERS[scheme].join(" / ")}）`);
    }
    const tier = tierRaw.trim();
    const canonical = scheme === "cas" ? tier : tier.toUpperCase();
    if (!PUBLICATION_TIERS[scheme].includes(canonical)) {
      throw new PublicationTargetValidationError(
        `${PUBLICATION_SCHEME_LABELS[scheme]} 的层级只能是 ${PUBLICATION_TIERS[scheme].join(" / ")}（收到 ${tier}；不同体系的层级不可混用）`,
      );
    }
    out.tier = canonical;
    const yearRaw = record["schemeYear"];
    if (yearRaw !== undefined && yearRaw !== null && yearRaw !== "") {
      const year = typeof yearRaw === "string" ? Number(yearRaw) : yearRaw;
      const maxYear = options.now.getUTCFullYear() + 1;
      if (typeof year !== "number" || !Number.isInteger(year) || year < 1990 || year > maxYear) {
        throw new PublicationTargetValidationError(`schemeYear 必须是 1990–${maxYear} 之间的整数年份`);
      }
      out.schemeYear = year;
    }
  }

  const journalIdRaw = record["targetJournalId"];
  const customRaw = record["customJournalName"];
  const journalId = typeof journalIdRaw === "string" ? journalIdRaw.trim() : journalIdRaw === undefined || journalIdRaw === null ? "" : null;
  const custom = typeof customRaw === "string" ? customRaw.trim() : customRaw === undefined || customRaw === null ? "" : null;
  if (journalId === null) throw new PublicationTargetValidationError("targetJournalId 必须是字符串");
  if (custom === null) throw new PublicationTargetValidationError("customJournalName 必须是字符串");
  if (journalId !== "" && custom !== "") {
    throw new PublicationTargetValidationError("targetJournalId（已核验期刊资料）与 customJournalName（自填期刊名）只能二选一");
  }
  if (journalId !== "") {
    if (!options.knownJournalIds.has(journalId)) {
      throw new PublicationTargetValidationError(`targetJournalId ${journalId} 不在已核验期刊资料库中；未收录的期刊请填写 customJournalName`);
    }
    out.targetJournalId = journalId;
  }
  if (custom !== "") {
    if (custom.length > CUSTOM_JOURNAL_MAX) throw new PublicationTargetValidationError(`customJournalName 不能超过 ${CUSTOM_JOURNAL_MAX} 个字符`);
    if (CONTROL_CHARS.test(custom)) throw new PublicationTargetValidationError("customJournalName 不能包含控制字符");
    out.customJournalName = custom;
  }
  if (out.scheme === "none" && out.targetJournalId === undefined && out.customJournalName === undefined) return null;
  return out;
}

/** 读取已落盘的目标（损坏 / 旧格式 → null，不抛错：读路径不得因单字段损坏使项目不可读） */
export function readStoredPublicationTarget(raw: unknown, knownJournalIds: ReadonlySet<string>): PublicationTarget | null {
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== PUBLICATION_TARGET_SCHEMA_VERSION) return null;
  try {
    const updatedAt = typeof record["updatedAt"] === "string" && !Number.isNaN(Date.parse(record["updatedAt"])) ? new Date(record["updatedAt"]) : new Date(0);
    const normalized = normalizePublicationTarget(record, { now: updatedAt, knownJournalIds });
    // 年份校验以写入时间为基准（不因时间推移把旧的合法记录判为非法）
    return normalized;
  } catch {
    return null;
  }
}

export function tierLabel(target: Pick<PublicationTarget, "scheme" | "tier"> | null): string | null {
  if (target === null || target.scheme === "none" || target.tier === undefined) return null;
  const key = target.scheme === "cas" ? `cas:${target.tier}` : target.tier;
  return PUBLICATION_TIER_LABELS[key] ?? target.tier;
}

const CHINESE_INDEX_PATTERNS: Record<string, RegExp> = {
  PKU_CORE: /北大|中文核心/,
  CSCD: /CSCD/i,
  CSSCI: /CSSCI/i,
};

/**
 * 层级事实状态。只有「已核验期刊 profile + 中文收录体系 + 官方页面自述（SELF_DECLARED）」才给出自述状态；
 * CAS / JCR 分区没有可信数据源接入 → 恒为用户目标、未核实。永不输出「已认证 / 达标」。
 */
export function tierFactOf(target: PublicationTarget | null, profile: JournalProfile | null): TierFact {
  if (target === null || target.scheme === "none" || target.tier === undefined) {
    return { status: "NOT_SET", note: "未设置发表层级：使用通用学术审稿策略" };
  }
  const label = tierLabel(target) ?? target.tier;
  if (target.scheme === "chinese_index" && profile !== null) {
    const pattern = CHINESE_INDEX_PATTERNS[target.tier];
    const hit = pattern === undefined ? undefined : profile.indexing.find((entry) => entry.status === "SELF_DECLARED" && pattern.test(entry.label));
    if (hit !== undefined) {
      return {
        status: "JOURNAL_SELF_DECLARED",
        note: `期刊官方页面自述收录于 ${label}${hit.year !== undefined ? `（${hit.year}）` : "（官方未写明年份）"}；这是期刊自述，不代表本系统核实了最新名单`,
        ...(hit.officialQuote !== undefined ? { officialQuote: hit.officialQuote } : {}),
        ...(hit.sourceUrl !== undefined ? { sourceUrl: hit.sourceUrl } : {}),
        ...(hit.year !== undefined ? { year: hit.year } : {}),
      };
    }
  }
  return {
    status: "USER_TARGET_UNVERIFIED",
    note: `${label} 是用户设定的投稿目标${target.schemeYear !== undefined ? `（参照 ${target.schemeYear} 年名单）` : ""}；系统未核实任何期刊的分区 / 收录事实`,
  };
}

// ============================================================
// Rubric registry
// ============================================================

/** 审稿政策使用的稿件类型（由 documentType / workflowKind 派生；不改变 workflow 路由） */
export type ReviewArticleType = "research" | "survey" | "thesis";

/** 维度作用域：unit = 单元可定位细节；whole = 整稿（贡献 / 实验 / 跨章）；both = 两者 */
type DimensionScope = "unit" | "whole" | "both";

export interface PolicyDimension {
  id: string;
  label: string;
  labelEn: string;
  scope: DimensionScope;
  focus: string;
  focusEn: string;
}

/** 与发表层级无关的底线：任何目标下逐字相同（不得因目标放宽或收紧） */
export const BASELINE_DIMENSIONS: readonly PolicyDimension[] = [
  { id: "fact_data_consistency", label: "事实与数据一致", labelEn: "Fact and data consistency", scope: "both", focus: "数值、表格、正文与摘要之间的一致性", focusEn: "consistency of numbers, tables, text and abstract" },
  { id: "citation_reliability", label: "引用可靠", labelEn: "Citation reliability", scope: "both", focus: "被引观点是否真实、归因是否准确", focusEn: "whether cited claims are real and correctly attributed" },
  { id: "locatable_evidence", label: "原文可定位", labelEn: "Locatable evidence", scope: "both", focus: "每条意见能定位到原文", focusEn: "every comment can be located in the text" },
  { id: "method_evidence_match", label: "方法与证据对应", labelEn: "Method-evidence correspondence", scope: "both", focus: "方法描述与实验 / 证据是否对应", focusEn: "whether the method description matches the experiments / evidence" },
  { id: "honest_uncertainty", label: "如实标注不确定", labelEn: "Honest uncertainty", scope: "both", focus: "证据不足时标注待核验，不下确定结论", focusEn: "mark unverified points as such instead of asserting" },
];

const ARTICLE_DIMENSIONS: Record<ReviewArticleType, readonly PolicyDimension[]> = {
  research: [
    { id: "contribution_boundary", label: "研究问题与贡献边界", labelEn: "Research question and contribution boundary", scope: "whole", focus: "研究问题是否清楚、声称的贡献是否被证据支撑且不夸大", focusEn: "is the question clear and is each claimed contribution supported and not overstated" },
    { id: "strong_baselines", label: "最近 / 最强相关基线", labelEn: "Recent and strong baselines", scope: "whole", focus: "是否与最相关、最强的已有方法比较；未核实的文献只能写「建议核对」", focusEn: "comparison with the most relevant strong prior methods; unverified works may only be suggested for checking" },
    { id: "comparison_fairness", label: "对比公平性", labelEn: "Comparison fairness", scope: "both", focus: "对比设置（数据、预算、超参、实现）是否公平且写明", focusEn: "are compared settings (data, budget, tuning, implementation) fair and stated" },
    { id: "ablation", label: "消融与组件贡献", labelEn: "Ablations", scope: "whole", focus: "各组件贡献是否有消融支撑", focusEn: "is each component's contribution supported by ablation" },
    { id: "experimental_setup_statistics", label: "实验设置与统计", labelEn: "Experimental setup and statistics", scope: "both", focus: "数据集、设置、重复次数、方差 / 显著性是否足以支撑论断", focusEn: "datasets, settings, repetitions, variance / significance sufficient for the claims" },
    { id: "reproducibility", label: "可复现性", labelEn: "Reproducibility", scope: "both", focus: "实现细节、参数与数据获取是否足以复现", focusEn: "implementation details, parameters and data access sufficient to reproduce" },
    { id: "claim_result_match", label: "结论与结果匹配", labelEn: "Claims match results", scope: "both", focus: "摘要 / 结论的论断是否超出实验所示", focusEn: "do abstract / conclusion claims exceed what experiments show" },
  ],
  survey: [
    { id: "coverage_scope", label: "覆盖范围", labelEn: "Coverage and scope", scope: "whole", focus: "主要方法路线与文献家族是否覆盖，范围是否写明", focusEn: "are main method families covered and is the scope stated" },
    { id: "search_inclusion_criteria", label: "检索与纳入准则", labelEn: "Search and inclusion criteria", scope: "whole", focus: "文献检索来源、时间窗与纳入 / 排除准则是否说明", focusEn: "are sources, time window and inclusion / exclusion criteria described" },
    { id: "representativeness_recency", label: "代表性与时效性", labelEn: "Representativeness and recency", scope: "both", focus: "奠基性、代表性与近期工作是否兼顾", focusEn: "balance of seminal, representative and recent work" },
    { id: "taxonomy", label: "分类框架", labelEn: "Taxonomy", scope: "whole", focus: "分类是否合理、粒度恰当、与正文组织一致", focusEn: "is the taxonomy sound, well-grained and consistent with the structure" },
    { id: "cross_study_synthesis", label: "跨研究综合", labelEn: "Cross-study synthesis", scope: "both", focus: "是否有真实的横向比较与综合，而非逐篇罗列", focusEn: "real cross-study comparison and synthesis rather than listing" },
    { id: "evidence_based_gaps", label: "有依据的研究空白", labelEn: "Evidence-based gaps", scope: "whole", focus: "研究空白与展望是否有文献依据，推测是否被写成事实", focusEn: "are gaps / future directions grounded, and is speculation presented as fact" },
  ],
  thesis: [
    { id: "chapter_organization", label: "章节组织", labelEn: "Chapter organization", scope: "whole", focus: "章节结构与研究主线是否清楚", focusEn: "is the chapter structure aligned with the research storyline" },
    { id: "cross_chapter_consistency", label: "各章一致性", labelEn: "Cross-chapter consistency", scope: "whole", focus: "术语、符号、数值、贡献表述在各章之间是否一致", focusEn: "terminology, notation, numbers and contribution statements consistent across chapters" },
    { id: "material_figure_provenance", label: "研究材料与图表来源", labelEn: "Material and figure provenance", scope: "both", focus: "图表、数据与已发表成果的来源与版本是否说明", focusEn: "are sources and versions of figures, data and prior publications stated" },
    { id: "version_fact_conflicts", label: "版本 / 事实冲突", labelEn: "Version / fact conflicts", scope: "both", focus: "同一成果在不同章节或版本中的数值 / 结论是否冲突", focusEn: "do numbers / conclusions of the same result conflict across chapters or versions" },
    { id: "argument_depth", label: "论证深度", labelEn: "Argument depth", scope: "whole", focus: "每章的问题—方法—结果—讨论是否完整，讨论是否有深度", focusEn: "is each chapter's question-method-result-discussion complete and discussed in depth" },
  ],
};

const ARTICLE_TYPE_LABELS: Record<ReviewArticleType, { zh: string; en: string }> = {
  research: { zh: "研究论文", en: "research article" },
  survey: { zh: "综述论文", en: "survey / review article" },
  thesis: { zh: "学位论文", en: "thesis / dissertation" },
};

/** 稿件类型专属纪律（防止套用错误口径） */
const ARTICLE_DISCIPLINE: Record<ReviewArticleType, { zh: string; en: string } | null> = {
  research: null,
  survey: {
    zh: "综述没有原创实验是正常的：不得因「缺少实验 / 消融 / 与基线对比」判为缺陷；按覆盖、准则、综合与有依据的空白审查。",
    en: "A survey is not expected to contain original experiments: do NOT report missing experiments, ablations or baseline comparisons as defects; review coverage, criteria, synthesis and grounded gaps instead.",
  },
  thesis: {
    zh: "学位论文按章节组织与各章一致性审查：不得套用单篇期刊论文的实验条数、篇幅或「投稿规范」规则。",
    en: "Review a thesis for chapter organization and cross-chapter consistency: do NOT apply single-article rules (experiment counts, length, journal formatting).",
  },
};

/** 发表目标对审稿关注点的启发式调整（不是任何层级的官方标准） */
export type PolicyEmphasis = "generic" | "standard" | "elevated" | "domestic_index";

function emphasisOf(target: PublicationTarget | null): PolicyEmphasis {
  if (target === null || target.scheme === "none" || target.tier === undefined) return "generic";
  if (target.scheme === "chinese_index") return "domestic_index";
  if (target.scheme === "cas") return target.tier === "1" || target.tier === "2" ? "elevated" : "standard";
  return target.tier === "Q1" || target.tier === "Q2" ? "elevated" : "standard";
}

/** 关注点排序：elevated 把强先例 / 贡献论证 / 综合深度前置；其余保持 registry 顺序（排序只影响审稿提醒，不改变底线） */
const EMPHASIS_PRIORITY: Record<PolicyEmphasis, Record<ReviewArticleType, readonly string[]>> = {
  generic: { research: [], survey: [], thesis: [] },
  standard: {
    research: ["claim_result_match", "experimental_setup_statistics", "reproducibility"],
    survey: ["coverage_scope", "taxonomy"],
    thesis: ["cross_chapter_consistency", "chapter_organization"],
  },
  elevated: {
    research: ["contribution_boundary", "strong_baselines", "ablation"],
    survey: ["cross_study_synthesis", "representativeness_recency", "evidence_based_gaps"],
    thesis: ["argument_depth", "cross_chapter_consistency"],
  },
  domestic_index: {
    research: ["contribution_boundary", "experimental_setup_statistics", "reproducibility"],
    survey: ["coverage_scope", "representativeness_recency"],
    thesis: ["chapter_organization", "argument_depth"],
  },
};

const EMPHASIS_TEXT: Record<Exclude<PolicyEmphasis, "generic">, { zh: string; en: string }> = {
  standard: {
    zh: "审稿重点偏向方法正确性、论证 / 实验报告的完整与清晰。",
    en: "Emphasis: methodological soundness and completeness / clarity of reporting.",
  },
  elevated: {
    zh: "审稿重点偏向与最近强先例的对照、贡献论证的充分性与证据深度。",
    en: "Emphasis: comparison with strong recent prior work, sufficiency of the contribution argument and depth of evidence.",
  },
  domestic_index: {
    zh: "审稿重点偏向选题与研究现状的衔接、方法与数据表述的规范性、参考文献的规范与时效（北大核心 / CSCD / CSSCI 是各自独立的收录体系，此处不比较高低）。",
    en: "Emphasis: connection to the state of the art, rigor of method / data reporting, and adequacy / recency of references (PKU Core, CSCD and CSSCI are independent indexing systems; no ranking implied).",
  },
};

// ============================================================
// Snapshot
// ============================================================

export interface ReviewPolicySnapshot {
  schemaVersion: typeof REVIEW_POLICY_SCHEMA_VERSION;
  policyVersion: typeof REVIEW_POLICY_VERSION;
  frozenAt: string;
  articleType: ReviewArticleType;
  /** 派生来源（documentType 原值 + workflowKind；只用于追溯） */
  articleTypeSource: { documentType: string | null; workflowKind: string };
  target: PublicationTarget | null;
  targetJournal: { journalId: string; displayName: string; rulesVersion: string } | null;
  tierFact: TierFact;
  emphasis: PolicyEmphasis;
  /** 按优先级排序的稿件类型维度 id */
  focus: string[];
  baseline: string[];
  /**
   * active=false：通用研究论文 + 无发表目标 → 单元 / 整稿 prompt 与升级前逐字节一致（缓存指纹不变）。
   */
  active: boolean;
  policyHash: string;
}

const THESIS_KINDS = new Set(["thesis_from_papers"]);
const SURVEY_KINDS = new Set(["topic_survey"]);

/** documentType / workflowKind → 审稿稿件类型（同 ProjectStore 的路由映射口径；不改变 workflow） */
export function reviewArticleTypeOf(input: { workflowKind: string; documentTypeKind: string }): ReviewArticleType {
  if (SURVEY_KINDS.has(input.workflowKind) || SURVEY_KINDS.has(input.documentTypeKind)) return "survey";
  if (THESIS_KINDS.has(input.workflowKind) || THESIS_KINDS.has(input.documentTypeKind)) return "thesis";
  return "research";
}

export function buildReviewPolicySnapshot(input: {
  workflowKind: string;
  documentType?: string;
  /** workflowKindForDocumentType(documentType) 的结果（由调用方传入，避免本模块依赖 ProjectStore） */
  documentTypeKind: string;
  target: PublicationTarget | null;
  profile: JournalProfile | null;
  now: Date;
}): ReviewPolicySnapshot {
  const articleType = reviewArticleTypeOf({ workflowKind: input.workflowKind, documentTypeKind: input.documentTypeKind });
  const emphasis = emphasisOf(input.target);
  const priority = EMPHASIS_PRIORITY[emphasis][articleType];
  const dims = ARTICLE_DIMENSIONS[articleType];
  const focus = [
    ...priority.filter((id) => dims.some((dim) => dim.id === id)),
    ...dims.map((dim) => dim.id).filter((id) => !priority.includes(id)),
  ];
  const targetJournal = input.profile !== null && input.target?.targetJournalId === input.profile.journalId
    ? { journalId: input.profile.journalId, displayName: input.profile.identity.nameZh ?? input.profile.identity.nameEn ?? input.profile.journalId, rulesVersion: input.profile.rulesVersion }
    : null;
  const active = articleType !== "research" || input.target !== null;
  const body = {
    schemaVersion: REVIEW_POLICY_SCHEMA_VERSION,
    policyVersion: REVIEW_POLICY_VERSION,
    articleType,
    articleTypeSource: { documentType: input.documentType ?? null, workflowKind: input.workflowKind },
    target: input.target,
    targetJournal,
    tierFact: tierFactOf(input.target, targetJournal !== null ? input.profile : null),
    emphasis,
    focus,
    baseline: BASELINE_DIMENSIONS.map((dim) => dim.id),
    active,
  };
  const policyHash = createHash("sha256").update(JSON.stringify({ ...body, target: body.target === null ? null : { ...body.target, updatedAt: undefined } })).digest("hex").slice(0, 16);
  return { ...body, frozenAt: input.now.toISOString(), policyHash };
}

/** WorkflowState.reviewPolicy 的防御性读取（字段损坏 → null = 旧行为） */
export function readReviewPolicySnapshot(raw: unknown): ReviewPolicySnapshot | null {
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const record = raw as Partial<ReviewPolicySnapshot>;
  if (record.schemaVersion !== REVIEW_POLICY_SCHEMA_VERSION || record.policyVersion !== REVIEW_POLICY_VERSION) return null;
  if (record.articleType !== "research" && record.articleType !== "survey" && record.articleType !== "thesis") return null;
  if (!Array.isArray(record.focus) || typeof record.active !== "boolean") return null;
  return record as ReviewPolicySnapshot;
}

const ALL_DIMENSION_IDS = new Set([
  ...BASELINE_DIMENSIONS.map((dim) => dim.id),
  ...Object.values(ARTICLE_DIMENSIONS).flatMap((dims) => dims.map((dim) => dim.id)),
]);

export function isPolicyDimensionId(value: unknown): value is string {
  return typeof value === "string" && ALL_DIMENSION_IDS.has(value);
}

export function policyDimension(id: string): PolicyDimension | undefined {
  return [...BASELINE_DIMENSIONS, ...Object.values(ARTICLE_DIMENSIONS).flat()].find((dim) => dim.id === id);
}

function targetLine(snapshot: ReviewPolicySnapshot, en: boolean): string {
  const target = snapshot.target;
  const tier = tierLabel(target);
  const journal = snapshot.targetJournal?.displayName ?? target?.customJournalName;
  if (tier === null && journal === undefined) return en ? "Publication target: not set (generic academic review)." : "发表目标：未设置（通用学术审稿）。";
  const parts: string[] = [];
  if (tier !== null) {
    const verified = snapshot.tierFact.status === "JOURNAL_SELF_DECLARED";
    parts.push(en
      ? `${tier}${target?.schemeYear !== undefined ? ` (${target.schemeYear} list)` : ""} — ${verified ? "self-declared by the journal's official page" : "user-stated target, not verified"}`
      : `${tier}${target?.schemeYear !== undefined ? `（${target.schemeYear} 年名单）` : ""}——${verified ? "期刊官方页面自述" : "用户设定目标，未核实"}`);
  }
  if (journal !== undefined) {
    const has = snapshot.targetJournal !== null;
    parts.push(en ? `journal: ${journal}${has ? "" : " (no verified journal profile)"}` : `期刊：${journal}${has ? "" : "（无已核验期刊资料）"}`);
  }
  return en ? `Publication target: ${parts.join("; ")}.` : `发表目标：${parts.join("；")}。`;
}

const DISCIPLINE = {
  zh: [
    "发表目标只调整审稿关注点与建议排序，不是该层级的官方硬性标准：不得据此设分数线、预测录用，或声称稿件「达到 / 未达到」某分区 / 某期刊水平。",
    "点名的近期强基线 / 文献若不在本文、已核验证据或检索结果中，只能写成「建议核对」，不得编造论文名、年份、DOI 或声称已充分检索。",
    "需要补实验、补数据或作者判断的意见要写明，不要求作者虚构结果。",
  ],
  en: [
    "The publication target only adjusts review emphasis and the ordering of suggestions; it is NOT an official standard of that tier: do not set score thresholds, predict acceptance, or claim the paper does / does not reach any tier or journal level.",
    "If you name a recent strong baseline / work that is not in the paper, the verified evidence or search results, phrase it as a suggestion to check; never invent titles, years or DOIs, and never claim the literature has been exhaustively searched.",
    "State when a comment requires new experiments, data or an author decision; never ask the authors to fabricate results.",
  ],
};

/**
 * 单元审查的政策块（active=false → []，prompt 逐字节不变）。单元只看可定位细节：
 * 整稿层面的贡献 / 实验充分性 / 跨章问题由整稿与跨章审查负责（角色分工不重复）。
 */
export function renderUnitPolicyLines(snapshot: ReviewPolicySnapshot | null, language?: "zh" | "en"): string[] {
  if (snapshot === null || !snapshot.active) return [];
  const en = language === "en";
  const dims = snapshot.focus.map((id) => policyDimension(id)).filter((dim): dim is PolicyDimension => dim !== undefined && dim.scope !== "whole");
  const discipline = ARTICLE_DISCIPLINE[snapshot.articleType];
  const type = ARTICLE_TYPE_LABELS[snapshot.articleType];
  return en
    ? [
        `===== Review policy (${snapshot.policyVersion}, frozen for this run) =====`,
        `Article type: ${type.en}. ${targetLine(snapshot, true)}`,
        "This unit review reports only locatable details in this unit; paper-level contribution / experimental adequacy / cross-chapter issues are handled by the whole-paper and cross-chapter reviews.",
        `Baseline checks (independent of any target): ${BASELINE_DIMENSIONS.map((dim) => dim.labelEn).join("; ")}.`,
        ...(dims.length > 0 ? [`Focus for this unit (priority order): ${dims.map((dim) => `${dim.labelEn} — ${dim.focusEn}`).join("; ")}.`] : []),
        ...(discipline !== null ? [discipline.en] : []),
        DISCIPLINE.en[0]!,
        DISCIPLINE.en[1]!,
      ]
    : [
        `===== 审稿政策（${snapshot.policyVersion}；本次运行冻结）=====`,
        `稿件类型：${type.zh}。${targetLine(snapshot, false)}`,
        "本单元只报告能在本单元原文定位的细节问题；整稿层面的贡献 / 实验充分性 / 跨章问题由整稿与跨章审查负责。",
        `底线（与发表目标无关）：${BASELINE_DIMENSIONS.map((dim) => dim.label).join("；")}。`,
        ...(dims.length > 0 ? [`本单元关注点（按优先级）：${dims.map((dim) => `${dim.label}——${dim.focus}`).join("；")}。`] : []),
        ...(discipline !== null ? [discipline.zh] : []),
        DISCIPLINE.zh[0]!,
        DISCIPLINE.zh[1]!,
      ];
}

/**
 * 整稿综合审查的问题类别（替换 prompt 中的类别清单）。active=false → null（调用方保留原清单，逐字节不变）。
 */
export function renderWholePaperPolicy(snapshot: ReviewPolicySnapshot | null, language?: "zh" | "en"): { kinds: string[]; extra: string[]; dimensionIds: string[] } | null {
  if (snapshot === null || !snapshot.active) return null;
  const en = language === "en";
  const dims = snapshot.focus.map((id) => policyDimension(id)).filter((dim): dim is PolicyDimension => dim !== undefined && dim.scope !== "unit");
  const discipline = ARTICLE_DISCIPLINE[snapshot.articleType];
  const type = ARTICLE_TYPE_LABELS[snapshot.articleType];
  const emphasis = snapshot.emphasis === "generic" ? null : EMPHASIS_TEXT[snapshot.emphasis];
  return {
    kinds: dims.map((dim) => (en ? `- [${dim.id}] ${dim.labelEn}: ${dim.focusEn};` : `- [${dim.id}] ${dim.label}：${dim.focus}；`)),
    extra: en
      ? [
          `Review policy (${snapshot.policyVersion}, frozen for this run). Article type: ${type.en}. ${targetLine(snapshot, true)}`,
          ...(emphasis !== null ? [`${emphasis.en} (A review-emphasis heuristic, not an official standard of that tier.)`] : []),
          ...(discipline !== null ? [discipline.en] : []),
          ...DISCIPLINE.en,
          'Set "policyDimension" on every issue to the bracketed id of the kind it belongs to.',
        ]
      : [
          `审稿政策（${snapshot.policyVersion}；本次运行冻结）。稿件类型：${type.zh}。${targetLine(snapshot, false)}`,
          ...(emphasis !== null ? [`${emphasis.zh}（这是审稿关注点的启发式排序，不是该层级的官方标准。）`] : []),
          ...(discipline !== null ? [discipline.zh] : []),
          ...DISCIPLINE.zh,
          "每条 issue 的 policyDimension 填它所属类别方括号中的 id。",
        ],
    dimensionIds: dims.map((dim) => dim.id),
  };
}

/**
 * digest（短稿三路审稿）academic 模式的政策行：只在用户设置了发表目标时替代旧的
 * 「结合目标档次标准执行（目标档次：X）」行；未设置 → null（旧行逐字节不变）。
 */
export function renderDigestPolicyLines(snapshot: ReviewPolicySnapshot | null): string[] | null {
  if (snapshot === null || snapshot.target === null) return null;
  const dims = snapshot.focus.map((id) => policyDimension(id)).filter((dim): dim is PolicyDimension => dim !== undefined);
  const discipline = ARTICLE_DISCIPLINE[snapshot.articleType];
  const emphasis = snapshot.emphasis === "generic" ? null : EMPHASIS_TEXT[snapshot.emphasis];
  return [
    `审稿政策（${snapshot.policyVersion}；本次运行冻结）。${targetLine(snapshot, false)}`,
    `底线（与发表目标无关）：${BASELINE_DIMENSIONS.map((dim) => dim.label).join("；")}。`,
    `关注点（按优先级）：${dims.map((dim) => dim.label).join("；")}。`,
    ...(emphasis !== null ? [`${emphasis.zh}（启发式审稿重点，不是该层级的官方标准。）`] : []),
    ...(discipline !== null ? [discipline.zh] : []),
    ...DISCIPLINE.zh,
    "scores 是未经校准的审稿参考分，不对应任何期刊 / 分区的录用线。",
  ];
}

/** 面向报告 / API 的摘要（不含 prompt 文本） */
export function reviewPolicySummary(snapshot: ReviewPolicySnapshot | null): Record<string, unknown> | null {
  if (snapshot === null) return null;
  return {
    policyVersion: snapshot.policyVersion,
    policyHash: snapshot.policyHash,
    frozenAt: snapshot.frozenAt,
    articleType: snapshot.articleType,
    active: snapshot.active,
    emphasis: snapshot.emphasis,
    target: snapshot.target === null
      ? null
      : {
          scheme: snapshot.target.scheme,
          ...(snapshot.target.tier !== undefined ? { tier: snapshot.target.tier, tierLabel: tierLabel(snapshot.target) } : {}),
          ...(snapshot.target.schemeYear !== undefined ? { schemeYear: snapshot.target.schemeYear } : {}),
          ...(snapshot.target.targetJournalId !== undefined ? { targetJournalId: snapshot.target.targetJournalId } : {}),
          ...(snapshot.target.customJournalName !== undefined ? { customJournalName: snapshot.target.customJournalName } : {}),
        },
    targetJournal: snapshot.targetJournal,
    tierFact: snapshot.tierFact,
    focus: snapshot.focus.map((id) => ({ id, label: policyDimension(id)?.label ?? id })),
    baseline: snapshot.baseline.map((id) => ({ id, label: policyDimension(id)?.label ?? id })),
    statement: "发表目标只调整审稿关注点与建议排序；不预测录用，不证明稿件达到某分区 / 期刊的学术水平。",
  };
}
