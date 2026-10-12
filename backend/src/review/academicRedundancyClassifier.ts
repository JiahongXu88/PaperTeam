/**
 * Academic Redundancy Classifier（M13.7.9）：在 M13.7.7 的词面复述探测器之上的轻量分类评价层。
 *
 * 背景：`analyzeCrossSectionRedundancy` 只做词面必要条件检测，把"后节句 ≈ 前节句"统一记为复述；
 * M13.7.8 的人工逐句核对表明它命中的东西性质不同——机制被原样重述、免责声明到处重复、
 * 引言提前讲完一切、模板化路标句、比较节为建立对照所做的必要机制提醒、结论的必要概括，
 * 以及词面相似但语义不同的误报——而且有害的一侧并不总是"后节"（引言预展开时有害的是引言句）。
 *
 * 本模块只消费探测器的候选 pair（不删除、不替代既有功能），按**可解释的确定性判据**给每个 pair
 * 一个类别，并给出两个独立指标：
 * - 指标 A（词面复述占比）：原封不动来自探测器，保持与历史报告可比；
 * - 指标 B（有害学术重复占比）：只统计 M / L / P / S 与"逐字搬运"的 X / E 所落在的那一侧句子。
 *
 * 类别：
 *   M  机制或结果在 owner 之外被无新增信息地完整重述（后节 develop 对前节 develop；结论逐一复述）
 *   L  科研限制 / 免责声明在非指定位置重复（develop 节；framing / conclude 第二句起）
 *   P  引言（framing）先于 owner 节完整展开机制 —— 有害的是引言句，不是 owner 句
 *   S  模板化路标 / 交叉引用句（"见「X」一节""将在「Y」一节展开"）；framing 的路线图句是惯例，不计有害
 *   X  比较节（或节首承接句）为建立对照所做的机制提醒 —— 必要，但 containment ≥ 0.8 的逐字搬运计有害
 *   E  结论对框架 / 主要结论的必要概括 —— 必要，但逐字搬运计有害；结论若对 ≥ 2 条机制逐一复述则升级为 M
 *   F  词面相似但语义不同的误报（短标签句被长句包含、Jaccard 低）
 *   uncertain  判据之间的灰区（X 在 0.7–0.8 且 Jaccard ≥ 0.4；framing 句过短难辨路线级描述与机制；非常规大纲顺序）
 *
 * 纪律：
 * - 不是语义等价证明；类别判据全部是词面 / 位置 / 角色规则，判据与阈值回显在报告里；
 * - 不接入 Quality Gate / Reviewer / Revision，不自动删改正文；
 * - X / E 不因"句子在比较节 / 结论"自动豁免：逐字搬运（containment ≥ verbatimContainment）仍记有害；
 * - 必要引用、科学限制与重要数值不会因为出现而被判为应删：只有**跨节重复**且位置不被允许时才记 L；
 *   孤立出现在 develop 节的限制句只记 uncertain，不进入指标 B 的下界；
 * - 有害占比给出下界（不含 uncertain）与上界（含 uncertain），两者都报告。
 */

import {
  analyzeCrossSectionRedundancy,
  isLimitationSentence,
  splitRedundancySentences,
  stripLatexForRedundancy,
  type CrossSectionRedundancyOptions,
  type CrossSectionRedundancyReport,
  type RedundancySectionInput,
  type RedundancySentence,
  type RedundantPair,
} from "./crossSectionRedundancy.js";

export type SectionRole = "framing" | "develop" | "compare" | "conclude";

export type RedundancyClass = "M" | "L" | "P" | "S" | "X" | "E" | "F" | "uncertain";

export type HarmfulSide = "later" | "earlier" | "both" | "none";

export interface ClassifierThresholds {
  /** X / E 的逐字搬运判定：containment ≥ 此值即记有害（默认 0.8） */
  verbatimContainment: number;
  /** X 的灰区下限：containment ∈ [uncertainContainment, verbatimContainment) 且 jaccard ≥ uncertainJaccard → uncertain（默认 0.7） */
  uncertainContainment: number;
  /** 同上（默认 0.4） */
  uncertainJaccard: number;
  /** F（误报）：较短一侧信息单位（CJK 字 + 拉丁 token）≤ 此值且 jaccard < asymmetricJaccard → 短标签句被长句包含（默认 30） */
  asymmetricShortChars: number;
  /** 同上（默认 0.3） */
  asymmetricJaccard: number;
  /** P 要求 framing 句至少这么多信息单位，才视为"完整展开"而非路线级描述；更短记 uncertain（默认 36） */
  framingExpansionMinChars: number;
  /** S：路标 / 交叉引用片段占句字符 ≥ 此值即记 S（默认 0.5） */
  signpostShare: number;
  /** S：去掉路标片段后剩余字符 < 此值即记 S（默认 24） */
  signpostRemainderChars: number;
  /** 结论中与 develop 节配对的机制句 ≥ 此数 → 逐一复述，升级为 M（默认 2） */
  conclusionMechanismSentences: number;
}

export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = {
  verbatimContainment: 0.8,
  uncertainContainment: 0.7,
  uncertainJaccard: 0.4,
  asymmetricShortChars: 30,
  asymmetricJaccard: 0.3,
  framingExpansionMinChars: 36,
  signpostShare: 0.5,
  signpostRemainderChars: 24,
  conclusionMechanismSentences: 2,
};

export interface SignpostAnalysis {
  signpost: boolean;
  /** 路标 / 交叉引用片段（合并后）的字符数 */
  signpostChars: number;
  /** 去掉路标片段后剩余的字符数 */
  remainderChars: number;
  /** signpostChars / (signpostChars + remainderChars) */
  share: number;
  /** 句子是否以交叉引用谓语收尾（"……将在「X」一节展开。"） */
  endsWithCrossReference: boolean;
  spans: string[];
}

export interface ClassifiedPair {
  pair: RedundantPair;
  class: RedundancyClass;
  harmful: boolean;
  harmfulSide: HarmfulSide;
  /** 命中的规则编号（与 RULES 文档一致） */
  rule: string;
  reason: string;
  laterRole: SectionRole;
  earlierRole: SectionRole;
}

export interface FlaggedSentence {
  section: string;
  index: number;
  text: string;
  chars: number;
  class: RedundancyClass;
  reason: string;
  /** 由哪些 pair（later/earlier 坐标）得出；孤立路标 / 限制句为空 */
  pairs: string[];
}

export interface AcademicRedundancySummary {
  sentenceCount: number;
  charCount: number;
  /** 指标 A：探测器原口径 */
  lexical: {
    pairCount: number;
    restatedSentenceCount: number;
    restatedChars: number;
    restatedCharShare: number;
  };
  /** 指标 B 下界：确定有害的句子 */
  harmful: {
    sentenceCount: number;
    chars: number;
    share: number;
    byClass: Partial<Record<RedundancyClass, { sentences: number; chars: number }>>;
  };
  /** 灰区（不计入下界） */
  uncertain: {
    sentenceCount: number;
    chars: number;
    share: number;
  };
  /** 指标 B 上界：有害 + 灰区 */
  harmfulUpperShare: number;
  classCounts: Record<RedundancyClass, number>;
  /** framing 节内路线图 / 交叉引用句（惯例，不计有害，仅报告） */
  framingRoadmapSentences: number;
}

export interface AcademicRedundancyReport {
  thresholds: ClassifierThresholds;
  roles: Record<string, SectionRole>;
  detector: CrossSectionRedundancyReport;
  pairs: ClassifiedPair[];
  harmfulSentences: FlaggedSentence[];
  uncertainSentences: FlaggedSentence[];
  /** 全文所有路标 / 交叉引用句（含 framing 的惯例句与未进入任何 pair 的孤立句） */
  signpostSentences: Array<{ section: string; index: number; text: string; chars: number; role: SectionRole; paired: boolean; harmful: boolean }>;
  summary: AcademicRedundancySummary;
}

export interface ClassifyOptions {
  /** 显式章节角色；缺省按 inferSectionRoles 推断 */
  roles?: Record<string, SectionRole>;
  detector?: CrossSectionRedundancyOptions;
  thresholds?: Partial<ClassifierThresholds>;
}

/* ------------------------------------------------------------------------------------------------ */
/* 角色推断                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const COMPARE_TITLE = /(比较|对照|讨论|局限|综合对比|对比与局限|对比分析|横向对比|synthesis|comparison|discussion|limitations?)/i;
/** 「对比学习」「对比框架」「比较基准」这类标题不是比较节 */
const COMPARE_TITLE_EXCLUDE = /(对比|比较)(学习|框架|方法|损失|式|基准|模型)/;
const isCompareTitle = (title: string): boolean => COMPARE_TITLE.test(title) && !COMPARE_TITLE_EXCLUDE.test(title);
const CONCLUDE_TITLE = /(结论|总结|展望|结语|conclusion|summary|outlook)/i;
const FRAMING_TITLE = /(引言|绪论|导言|背景|概述|introduction|overview|background)/i;

/**
 * 从大纲顺序与标题推断角色：首节为 framing（或标题命中），末节为 conclude（或标题命中），
 * 标题含比较 / 讨论 / 局限为 compare，其余为 develop。显式传入 roles 时以传入为准。
 */
export function inferSectionRoles(sections: ReadonlyArray<{ id: string; title?: string }>): Record<string, SectionRole> {
  const roles: Record<string, SectionRole> = {};
  sections.forEach((section, index) => {
    const title = section.title ?? "";
    let role: SectionRole;
    if (CONCLUDE_TITLE.test(title) || (index === sections.length - 1 && sections.length > 1 && !isCompareTitle(title))) {
      role = "conclude";
    } else if (isCompareTitle(title)) {
      role = "compare";
    } else if (FRAMING_TITLE.test(title) || index === 0) {
      role = "framing";
    } else {
      role = "develop";
    }
    roles[section.id] = role;
  });
  return roles;
}

/* ------------------------------------------------------------------------------------------------ */
/* 路标 / 交叉引用句                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

const CROSS_REFERENCE_VERBS = "(?:完整|集中|分别|详细|进一步|一并)?(?:展开|讨论|说明|介绍|给出|陈述|分析|比较|对照|总结|呈现|阐述|论述|梳理)";

/**
 * 路标 / 交叉引用片段。顺序：带引号章节名的交叉引用 → 相对位置路标 → 固定模板短语。
 * 每个正则都要求有"指向其他位置"的语义，单纯的"本文""综述"等不算。
 */
const SIGNPOST_PATTERNS: RegExp[] = [
  // 见「X」一节 / 详见「X」与「Y」两节 / 相关讨论见「X」一节（所述 / 中）
  /(?:详见|参见|见于|见|参看|可见)\s*(?:「[^」]{1,40}」(?:\s*(?:与|和|及|、)\s*「[^」]{1,40}」)*)\s*(?:一|两|各|等|这些|三|四)?\s*(?:节|章)(?:所述|中)?/g,
  // 将在「X」一节展开 / 已在「X」与「Y」两节完整展开 / 在「X」一节进行对照讨论
  /(?:将|已|会|则|并|均|分别)?\s*在\s*(?:「[^」]{1,40}」(?:\s*(?:与|和|及|、)\s*「[^」]{1,40}」)*)\s*(?:一|两|各|等|三|四)?\s*(?:节|章)(?:中)?[^。；，]{0,8}?CROSSREF_VERBS/g,
  // 与「X」一节（中的方法 / 所述）相对照 / 相比 / 不同 / 一致
  /(?:与|同|和)\s*「[^」]{1,40}」\s*(?:一|两)?\s*(?:节|章)(?:中的[^。；，]{1,6}|所述|中)?\s*(?:相对照|相比|相较|对照|不同|一致|类似|相呼应|呼应)/g,
  // 如「X」一节所述 / 「X」一节已说明
  /(?:如|正如|按)\s*「[^」]{1,40}」\s*(?:一|两)?\s*(?:节|章)\s*(?:所述|所示|已[^。；，]{0,6}(?:说明|展开|指出|讨论))/g,
  /「[^」]{1,40}」\s*(?:一|两)?\s*(?:节|章)\s*已(?:经)?[^。；，]{0,6}(?:说明|展开|指出|讨论|陈述|给出)/g,
  // 相对位置：将在下一节 / 留待后文 / 已在前文 / 在后续章节中 … 展开
  /(?:将|已|会|留待|放在|留给)?\s*在?\s*(?:前文|后文|上文|下文|前一节|后一节|上一节|下一节|后续章节|后续各节|后续小节|随后各节|其余部分|其余各节|本文其余部分|后面的章节|后续部分|后续小节|下一章|后文中)[^。；，]{0,10}?CROSSREF_VERBS/g,
  /(?:留待|留给|放到|放在)\s*(?:下|后|后续|随后|最后)\s*(?:一)?\s*(?:节|章|部分)/g,
  // 固定模板短语
  /如前所述|如上所述|如前文所述|如上文所述|前文已(?:经)?(?:述|说明|指出|讨论|展开)|前文所述|上文已(?:经)?(?:述|说明|指出)|已在前文(?:说明|展开|指出|讨论)?|详见前文|详见后文|见前文|见后文|见下文|见上文/g,
  // 引言路线图："本文其余部分依次介绍…" / "本文接下来分别…"
  /本文(?:的)?(?:其余部分|其余各节|后续部分|后续章节|接下来|下面|余下部分)[^。；]{0,30}?(?:依次|分别|先|首先|将)?[^。；]{0,6}?(?:介绍|展开|讨论|论述|给出|呈现|梳理|回顾|总结)/g,
];

const CROSS_REFERENCE_VERB_TOKEN = "CROSSREF_VERBS";

function compiledSignpostPatterns(): RegExp[] {
  return SIGNPOST_PATTERNS.map((pattern) => new RegExp(pattern.source.replace(CROSS_REFERENCE_VERB_TOKEN, CROSS_REFERENCE_VERBS), "g"));
}

const SIGNPOST_REGEXES = compiledSignpostPatterns();

function countChars(sentence: string): number {
  return sentence.replace(/[\s。！？；，、：“”‘’（）()\[\]【】《》「」.,:;!?"'-]/g, "").length;
}

/**
 * 判据用的"信息单位"：CJK 字符逐个计，拉丁 / 数字 token 各计 1（否则 "SimSiam 在 ImageNet 上" 会因英文名
 * 被当成长句）。指标 A / B 的字符分母仍用探测器的 chars，以保持两者可比。
 */
export function countUnits(sentence: string): number {
  const cjk = (sentence.match(/[㐀-鿿]/g) ?? []).length;
  const latin = (sentence.match(/[A-Za-z][A-Za-z0-9\-]*|\d+(?:\.\d+)?%?/g) ?? []).length;
  return cjk + latin;
}

/**
 * 路标 / 交叉引用分析：合并所有命中片段，统计路标字符与剩余字符，并判断句子是否以交叉引用谓语收尾。
 */
export function analyzeSignpost(sentence: string, thresholds: ClassifierThresholds = DEFAULT_CLASSIFIER_THRESHOLDS): SignpostAnalysis {
  const spans: Array<{ start: number; end: number }> = [];
  for (const regex of SIGNPOST_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sentence)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (spans.length === 0) {
    const chars = countChars(sentence);
    return { signpost: false, signpostChars: 0, remainderChars: chars, share: 0, endsWithCrossReference: false, spans: [] };
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  let signpostChars = 0;
  let remainder = sentence;
  const texts: string[] = [];
  for (const span of [...merged].reverse()) {
    const text = sentence.slice(span.start, span.end);
    texts.unshift(text);
    signpostChars += countChars(text);
    remainder = remainder.slice(0, span.start) + remainder.slice(span.end);
  }
  const remainderChars = countChars(remainder);
  const total = signpostChars + remainderChars;
  const share = total === 0 ? 0 : signpostChars / total;
  const lastSpan = merged[merged.length - 1];
  const tail = lastSpan === undefined ? sentence : sentence.slice(lastSpan.end);
  const endsWithCrossReference = lastSpan !== undefined && countChars(tail) <= 2;
  const signpost = share >= thresholds.signpostShare || remainderChars < thresholds.signpostRemainderChars || endsWithCrossReference;
  return { signpost, signpostChars, remainderChars, share: round(share), endsWithCrossReference, spans: texts };
}

export function isSignpostSentence(sentence: string, thresholds?: ClassifierThresholds): boolean {
  return analyzeSignpost(sentence, thresholds).signpost;
}

/* ------------------------------------------------------------------------------------------------ */
/* 分类                                                                                               */
/* ------------------------------------------------------------------------------------------------ */

const TRANSITION_CONTRAST = /(与[^。；，]{1,30}不同|不同于|相比(?:之下)?|相较(?:之下)?|相对(?:于|地)|另一(?:条|类|种)|与之相对|与之形成对照|形成对照|反之|而是)/;
/** 节内收束 / 概括句的开头标记：这类句子不是机制陈述，结论呼应它们属于 E 而不是"逐一复述机制" */
const WRAP_UP_OPENING = /^(?:总体而言|总的来说|总体上|综合来看|综合而言|综上所述|综上|总之|概括地说|概而言之|可见|由此可见|由此可得|这表明|这说明|这一路线说明|换言之)/;

interface SentenceMeta {
  key: string;
  section: string;
  index: number;
  order: number;
  role: SectionRole;
  text: string;
  chars: number;
  /** CJK 字符 + 拉丁 / 数字 token 数（判据用） */
  units: number;
  limitation: boolean;
  signpost: SignpostAnalysis;
  /** 该节内第几个限制句（0 起） */
  limitationOrdinal: number;
  /** 该节内第几个路标句（0 起） */
  signpostOrdinal: number;
}

function sentenceKey(sentence: RedundancySentence): string {
  return `${sentence.section}#${sentence.index}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 对探测器候选 pair 做学术重复分类，并给出指标 A（词面）与指标 B（有害）两套统计。
 * sections 必须按大纲顺序传入（与探测器一致）。
 */
export function classifyAcademicRedundancy(
  sections: readonly RedundancySectionInput[],
  options: ClassifyOptions = {},
): AcademicRedundancyReport {
  const thresholds: ClassifierThresholds = { ...DEFAULT_CLASSIFIER_THRESHOLDS, ...(options.thresholds ?? {}) };
  const roles = { ...inferSectionRoles(sections), ...(options.roles ?? {}) };
  const detector = analyzeCrossSectionRedundancy(sections, options.detector);

  // 逐句元数据（与探测器相同的剥离 / 分句，所以 index 对得上）
  const metaByKey = new Map<string, SentenceMeta>();
  const allMeta: SentenceMeta[] = [];
  sections.forEach((section, order) => {
    const role = roles[section.id] ?? "develop";
    const sentences = splitRedundancySentences(stripLatexForRedundancy(section.latex));
    let limitationOrdinal = 0;
    let signpostOrdinal = 0;
    sentences.forEach((text, index) => {
      const limitation = isLimitationSentence(text);
      const signpost = analyzeSignpost(text, thresholds);
      const meta: SentenceMeta = {
        key: `${section.id}#${index}`,
        section: section.id,
        index,
        order,
        role,
        text,
        chars: countChars(text),
        units: countUnits(text),
        limitation,
        signpost,
        limitationOrdinal: limitation ? limitationOrdinal : -1,
        signpostOrdinal: signpost.signpost ? signpostOrdinal : -1,
      };
      if (limitation) limitationOrdinal += 1;
      if (signpost.signpost) signpostOrdinal += 1;
      metaByKey.set(meta.key, meta);
      allMeta.push(meta);
    });
  });

  const limitationCountBySection = new Map<string, number>();
  for (const meta of allMeta) {
    if (meta.limitation) limitationCountBySection.set(meta.section, (limitationCountBySection.get(meta.section) ?? 0) + 1);
  }

  const metaOf = (sentence: RedundancySentence): SentenceMeta => {
    const meta = metaByKey.get(sentenceKey(sentence));
    if (meta === undefined) {
      // 探测器与本模块使用相同的分句，正常不会走到这里；兜底构造
      const role = roles[sentence.section] ?? "develop";
      return {
        key: sentenceKey(sentence),
        section: sentence.section,
        index: sentence.index,
        order: sections.findIndex((s) => s.id === sentence.section),
        role,
        text: sentence.text,
        chars: sentence.chars,
        units: countUnits(sentence.text),
        limitation: isLimitationSentence(sentence.text),
        signpost: analyzeSignpost(sentence.text, thresholds),
        limitationOrdinal: 0,
        signpostOrdinal: 0,
      };
    }
    return meta;
  };

  // 限制句位置是否被允许：compare 永远允许；framing / conclude 允许第一句；develop 不允许
  const limitationPermitted = (meta: SentenceMeta): boolean => {
    if (meta.role === "compare") return true;
    if (meta.role === "framing" || meta.role === "conclude") return meta.limitationOrdinal <= 0;
    return false;
  };
  // 路标句是否被允许：只有 framing 的路线图句是惯例
  const signpostPermitted = (meta: SentenceMeta): boolean => meta.role === "framing";

  const sentenceCountBySection = new Map<string, number>();
  for (const meta of allMeta) sentenceCountBySection.set(meta.section, (sentenceCountBySection.get(meta.section) ?? 0) + 1);
  /** 前节收束句（只对 develop 节成立：引言末句常常正是机制预展开，不能据此豁免） */
  const isSectionClosing = (meta: SentenceMeta): boolean => meta.role === "develop" && meta.index === (sentenceCountBySection.get(meta.section) ?? 0) - 1;
  const isAsymmetric = (a: SentenceMeta, b: SentenceMeta, pair: RedundantPair): boolean =>
    Math.min(a.units, b.units) <= thresholds.asymmetricShortChars && pair.jaccard < thresholds.asymmetricJaccard;

  // 第一遍 (i)：会被 R4 判为 P 的引言句（机制预展开）——它们也是"机制陈述"，结论复述它们同样计入逐一复述
  const preExpandedFramingKeys = new Set<string>();
  for (const pair of detector.pairs) {
    const later = metaOf(pair.later);
    const earlier = metaOf(pair.earlier);
    if (later.role !== "develop" || earlier.role !== "framing") continue;
    if (later.limitation || earlier.limitation || later.signpost.signpost || earlier.signpost.signpost) continue;
    if (isAsymmetric(later, earlier, pair)) continue;
    if (later.index === 0 && (TRANSITION_CONTRAST.test(later.text) || TRANSITION_CONTRAST.test(earlier.text) || isSectionClosing(earlier))) continue;
    if (earlier.units >= thresholds.framingExpansionMinChars) preExpandedFramingKeys.add(earlier.key);
  }

  // 第一遍 (ii)：结论中与"机制 / 结果陈述句"配对的句子计数（用于 E → M 升级）。
  // 机制陈述句 = develop 节的非收束句，或已被判为引言预展开的 framing 句；compare 节的综合句与 develop 的"总体而言…"收束句不算，
  // 结论呼应它们是必要概括（E），不是逐一复述机制。
  const isMechanismStatement = (meta: SentenceMeta): boolean =>
    (meta.role === "develop" && !WRAP_UP_OPENING.test(meta.text)) || (meta.role === "framing" && preExpandedFramingKeys.has(meta.key));
  const conclusionMechanismKeys = new Set<string>();
  for (const pair of detector.pairs) {
    const later = metaOf(pair.later);
    const earlier = metaOf(pair.earlier);
    if (later.role !== "conclude" || !isMechanismStatement(earlier)) continue;
    if (later.limitation || earlier.limitation || later.signpost.signpost || earlier.signpost.signpost) continue;
    if (isAsymmetric(later, earlier, pair)) continue;
    conclusionMechanismKeys.add(later.key);
  }
  const conclusionEnumerates = conclusionMechanismKeys.size >= thresholds.conclusionMechanismSentences;

  const classified: ClassifiedPair[] = detector.pairs.map((pair) => {
    const later = metaOf(pair.later);
    const earlier = metaOf(pair.earlier);
    const base = { pair, laterRole: later.role, earlierRole: earlier.role };
    const verbatim = pair.containment >= thresholds.verbatimContainment;

    // R2 限制 / 免责两侧重复
    if (later.limitation && earlier.limitation) {
      // develop 节的限制句只有在"与另一 develop 节重复"或"本节已有 ≥ 2 条限制句"时才确定有害；
      // 单独一句且对方在 compare / framing / conclude 的，可能是 owner 节对 partial 证据的合法界定 → uncertain
      const developConfirmed = (meta: SentenceMeta, other: SentenceMeta): boolean =>
        meta.role !== "develop" || other.role === "develop" || (limitationCountBySection.get(meta.section) ?? 0) >= 2;
      const laterHarm = !limitationPermitted(later) && developConfirmed(later, earlier);
      const earlierHarm = !limitationPermitted(earlier) && developConfirmed(earlier, later);
      const laterGrey = !limitationPermitted(later) && !laterHarm;
      const earlierGrey = !limitationPermitted(earlier) && !earlierHarm;
      const side: HarmfulSide = laterHarm && earlierHarm ? "both" : laterHarm ? "later" : earlierHarm ? "earlier" : "none";
      if (side === "none" && (laterGrey || earlierGrey)) {
        return {
          ...base,
          class: "uncertain",
          harmful: false,
          harmfulSide: "none",
          rule: "R2u",
          reason: `develop 节（${laterGrey ? later.section : earlier.section}）仅此一句限制声明且对方在 ${laterGrey ? earlier.role : later.role}：可能是 owner 节对 partial 证据的合法界定，也可能是免责扩散`,
        } satisfies ClassifiedPair;
      }
      return {
        ...base,
        class: "L",
        harmful: side !== "none",
        harmfulSide: side,
        rule: "R2",
        reason:
          side === "none"
            ? `限制声明重复，但两侧都在允许位置（${later.role} / ${earlier.role}：局限性 owner、引言范围声明或结论一句承接）`
            : `限制声明在非指定位置重复（有害侧：${side}；${later.role} / ${earlier.role}）`,
      } satisfies ClassifiedPair;
    }

    // R1 路标 / 交叉引用：任一侧是路标句，共享 token 来自章节名与模板短语
    if (later.signpost.signpost || earlier.signpost.signpost) {
      const laterHarm = later.signpost.signpost && !signpostPermitted(later);
      const earlierHarm = earlier.signpost.signpost && !signpostPermitted(earlier);
      const side: HarmfulSide = laterHarm && earlierHarm ? "both" : laterHarm ? "later" : earlierHarm ? "earlier" : "none";
      const which = [later.signpost.signpost ? `后节句（${later.signpost.spans.join(" / ")}）` : "", earlier.signpost.signpost ? `前节句（${earlier.signpost.spans.join(" / ")}）` : ""].filter(Boolean).join("；");
      return {
        ...base,
        class: "S",
        harmful: side !== "none",
        harmfulSide: side,
        rule: "R1",
        reason: `路标 / 交叉引用句：${which}${side === "none" ? "；均位于引言（路线图惯例，不计有害）" : ""}`,
      } satisfies ClassifiedPair;
    }

    // R3 误报：短标签句被长句包含，Jaccard 低
    if (Math.min(later.units, earlier.units) <= thresholds.asymmetricShortChars && pair.jaccard < thresholds.asymmetricJaccard) {
      return {
        ...base,
        class: "F",
        harmful: false,
        harmfulSide: "none",
        rule: "R3",
        reason: `较短一侧仅 ${Math.min(later.units, earlier.units)} 个信息单位且 Jaccard ${pair.jaccard} < ${thresholds.asymmetricJaccard}：短标签 / 枚举句被长句包含，长句承载不同内容`,
      } satisfies ClassifiedPair;
    }

    // R5 节首承接句：develop 第一句带对照标记，或与前节的收束 / 对照句相接——视同必要过渡
    if (later.role === "develop" && later.index === 0 && (TRANSITION_CONTRAST.test(later.text) || TRANSITION_CONTRAST.test(earlier.text) || isSectionClosing(earlier))) {
      return {
        ...base,
        class: "X",
        harmful: verbatim,
        harmfulSide: verbatim ? "later" : "none",
        rule: "R5",
        reason: verbatim ? `节首承接句逐字搬运前节句（containment ${pair.containment} ≥ ${thresholds.verbatimContainment}）` : `develop 节首的承接句与前节${isSectionClosing(earlier) ? "收束句" : "对照句"}相接（必要过渡）`,
      } satisfies ClassifiedPair;
    }

    // R4 引言预展开：framing 句 ≈ owner(develop) 句，有害的是引言句
    if (later.role === "develop" && earlier.role === "framing") {
      if (earlier.units < thresholds.framingExpansionMinChars) {
        return {
          ...base,
          class: "uncertain",
          harmful: false,
          harmfulSide: "none",
          rule: "R4u",
          reason: `引言句仅 ${earlier.units} 个信息单位（< ${thresholds.framingExpansionMinChars}），无法区分路线级描述与机制预展开`,
        } satisfies ClassifiedPair;
      }
      return {
        ...base,
        class: "P",
        harmful: true,
        harmfulSide: "earlier",
        rule: "R4",
        reason: `引言（${earlier.section}）先于 owner 节（${later.section}）展开同一机制 / 结果（containment ${pair.containment}）；有害的是引言句`,
      } satisfies ClassifiedPair;
    }

    // R6 develop 对 develop：机制 / 结果在 owner 之外完整重述
    if (later.role === "develop" && earlier.role === "develop") {
      return {
        ...base,
        class: "M",
        harmful: true,
        harmfulSide: "later",
        rule: "R6",
        reason: `develop 节（${later.section}）重述另一 develop 节（${earlier.section}）的机制 / 结果句（containment ${pair.containment}）`,
      } satisfies ClassifiedPair;
    }

    // R7 比较节：必要的维度提醒；逐字搬运记有害；灰区记 uncertain
    if (later.role === "compare") {
      if (verbatim) {
        return {
          ...base,
          class: "X",
          harmful: true,
          harmfulSide: "later",
          rule: "R7v",
          reason: `比较节逐字搬运前节句（containment ${pair.containment} ≥ ${thresholds.verbatimContainment}），未改写为对照结论`,
        } satisfies ClassifiedPair;
      }
      if (pair.containment >= thresholds.uncertainContainment && pair.jaccard >= thresholds.uncertainJaccard) {
        return {
          ...base,
          class: "uncertain",
          harmful: false,
          harmfulSide: "none",
          rule: "R7u",
          reason: `比较节提醒句 containment ${pair.containment} ∈ [${thresholds.uncertainContainment}, ${thresholds.verbatimContainment}) 且 Jaccard ${pair.jaccard} ≥ ${thresholds.uncertainJaccard}：介于提醒与重述之间`,
        } satisfies ClassifiedPair;
      }
      return {
        ...base,
        class: "X",
        harmful: false,
        harmfulSide: "none",
        rule: "R7",
        reason: `比较节为建立对照所做的机制 / 结果提醒（containment ${pair.containment}）`,
      } satisfies ClassifiedPair;
    }

    // R8 结论：必要概括；逐字搬运记有害；对 ≥ N 条机制逐一复述升级为 M
    if (later.role === "conclude") {
      // 逐一复述优先于"逐字呼应"标签：只要本句属于枚举集合（它至少与一条 develop / compare 机制句配对），所有 pair 都记 M
      if (conclusionEnumerates && conclusionMechanismKeys.has(later.key)) {
        return {
          ...base,
          class: "M",
          harmful: true,
          harmfulSide: "later",
          rule: "R8m",
          reason: `结论对 ${conclusionMechanismKeys.size} 条机制 / 结果逐一复述（≥ ${thresholds.conclusionMechanismSentences}），本句重述 ${earlier.section} 的内容`,
        } satisfies ClassifiedPair;
      }
      return {
        ...base,
        class: "E",
        harmful: verbatim,
        harmfulSide: verbatim ? "later" : "none",
        rule: verbatim ? "R8v" : "R8",
        reason: verbatim
          ? `结论逐字搬运 ${earlier.section} 的句子（containment ${pair.containment} ≥ ${thresholds.verbatimContainment}）`
          : `结论对 ${earlier.role === "framing" ? "引言框架" : "前文主要结论"} 的必要概括（containment ${pair.containment}）`,
      } satisfies ClassifiedPair;
    }

    // R9 非常规顺序（framing 在后、develop 在 compare / conclude 之后等）
    return {
      ...base,
      class: "uncertain",
      harmful: false,
      harmfulSide: "none",
      rule: "R9",
      reason: `非常规角色顺序（后节 ${later.role} ← 前节 ${earlier.role}），不自动判定`,
    } satisfies ClassifiedPair;
  });

  // 句级汇总：每句只计一次，取"有害"优先，其次 uncertain；类别取第一条有害 pair 的类别
  const harmfulMap = new Map<string, FlaggedSentence>();
  const uncertainMap = new Map<string, FlaggedSentence>();
  const addFlag = (map: Map<string, FlaggedSentence>, meta: SentenceMeta, cls: RedundancyClass, reason: string, pairLabel: string) => {
    const existing = map.get(meta.key);
    if (existing !== undefined) {
      if (!existing.pairs.includes(pairLabel)) existing.pairs.push(pairLabel);
      return;
    }
    map.set(meta.key, { section: meta.section, index: meta.index, text: meta.text, chars: meta.chars, class: cls, reason, pairs: [pairLabel] });
  };
  for (const entry of classified) {
    const later = metaOf(entry.pair.later);
    const earlier = metaOf(entry.pair.earlier);
    const label = `${later.key}≈${earlier.key}`;
    if (entry.harmful) {
      if (entry.harmfulSide === "later" || entry.harmfulSide === "both") addFlag(harmfulMap, later, entry.class, entry.reason, label);
      if (entry.harmfulSide === "earlier" || entry.harmfulSide === "both") addFlag(harmfulMap, earlier, entry.class, entry.reason, label);
    } else if (entry.class === "uncertain") {
      // R2u 的灰区句是 develop 一侧（可能是 earlier）；其余灰区规则都指后节句
      const grey = entry.rule === "R2u" ? (later.role === "develop" && !limitationPermitted(later) ? later : earlier) : later;
      addFlag(uncertainMap, grey, "uncertain", entry.reason, label);
    }
  }

  // 孤立路标句（未进入任何 pair）：framing 之外记有害；孤立 develop 限制句记 uncertain
  const pairedKeys = new Set<string>();
  for (const pair of detector.pairs) {
    pairedKeys.add(sentenceKey(pair.later));
    pairedKeys.add(sentenceKey(pair.earlier));
  }
  const signpostSentences: AcademicRedundancyReport["signpostSentences"] = [];
  let framingRoadmapSentences = 0;
  for (const meta of allMeta) {
    if (meta.signpost.signpost) {
      const harmful = !signpostPermitted(meta);
      if (!harmful) framingRoadmapSentences += 1;
      signpostSentences.push({ section: meta.section, index: meta.index, text: meta.text, chars: meta.chars, role: meta.role, paired: pairedKeys.has(meta.key), harmful });
      if (harmful && !pairedKeys.has(meta.key)) {
        addFlag(harmfulMap, meta, "S", `孤立路标 / 交叉引用句（${meta.signpost.spans.join(" / ")}），未与任何前节句配对但仍是模板化结构提示`, "(standalone)");
      }
    } else if (meta.limitation && meta.role === "develop" && !pairedKeys.has(meta.key) && !harmfulMap.has(meta.key)) {
      addFlag(uncertainMap, meta, "uncertain", "develop 节中的孤立限制句：可能是来源本身的科学限制，也可能是免责扩散；未与其他节重复，不计入有害下界", "(standalone)");
    }
  }
  for (const key of harmfulMap.keys()) uncertainMap.delete(key);

  const harmfulSentences = [...harmfulMap.values()].sort(bySectionOrder(sections));
  const uncertainSentences = [...uncertainMap.values()].sort(bySectionOrder(sections));
  const charCount = detector.summary.charCount;
  const harmfulChars = harmfulSentences.reduce((sum, s) => sum + s.chars, 0);
  const uncertainChars = uncertainSentences.reduce((sum, s) => sum + s.chars, 0);
  const byClass: AcademicRedundancySummary["harmful"]["byClass"] = {};
  for (const sentence of harmfulSentences) {
    const entry = byClass[sentence.class] ?? { sentences: 0, chars: 0 };
    entry.sentences += 1;
    entry.chars += sentence.chars;
    byClass[sentence.class] = entry;
  }
  const classCounts: Record<RedundancyClass, number> = { M: 0, L: 0, P: 0, S: 0, X: 0, E: 0, F: 0, uncertain: 0 };
  for (const entry of classified) classCounts[entry.class] += 1;
  const restatedChars = detector.sections.reduce((sum, s) => sum + s.restatedChars, 0);

  return {
    thresholds,
    roles,
    detector,
    pairs: classified,
    harmfulSentences,
    uncertainSentences,
    signpostSentences,
    summary: {
      sentenceCount: detector.summary.sentenceCount,
      charCount,
      lexical: {
        pairCount: detector.summary.pairCount,
        restatedSentenceCount: detector.summary.restatedSentenceCount,
        restatedChars,
        restatedCharShare: detector.summary.restatedCharShare,
      },
      harmful: {
        sentenceCount: harmfulSentences.length,
        chars: harmfulChars,
        share: charCount === 0 ? 0 : round(harmfulChars / charCount),
        byClass,
      },
      uncertain: {
        sentenceCount: uncertainSentences.length,
        chars: uncertainChars,
        share: charCount === 0 ? 0 : round(uncertainChars / charCount),
      },
      harmfulUpperShare: charCount === 0 ? 0 : round((harmfulChars + uncertainChars) / charCount),
      classCounts,
      framingRoadmapSentences,
    },
  };
}

function bySectionOrder(sections: readonly RedundancySectionInput[]) {
  const order = new Map(sections.map((s, i) => [s.id, i] as const));
  return (a: FlaggedSentence, b: FlaggedSentence): number =>
    (order.get(a.section) ?? 0) - (order.get(b.section) ?? 0) || a.index - b.index;
}

/** 规则说明（供报告 / 文档引用；与 classifyAcademicRedundancy 中的 R1–R9 一一对应） */
export const ACADEMIC_REDUNDANCY_RULES: ReadonlyArray<{ id: string; class: RedundancyClass; summary: string }> = [
  { id: "R2", class: "L", summary: "（先于 R1）两侧都是限制 / 免责句：compare 允许、framing 与 conclude 允许第一句、develop 不允许；不允许的一侧记有害；两侧都允许则不计有害；develop 一侧只有在与另一 develop 节重复或本节 ≥ 2 条限制句时才确定有害，否则记 uncertain（R2u）" },
  { id: "R1", class: "S", summary: "任一侧是路标 / 交叉引用句（见「X」一节 / 将在「Y」一节展开 / 如前所述…）：路标占句 ≥ signpostShare、剩余 < signpostRemainderChars 或以交叉引用谓语收尾；framing 的路线图句是惯例不计有害，其余位置记有害；未进入任何 pair 的孤立路标句同样计入" },
  { id: "R3", class: "F", summary: "较短一侧信息单位 ≤ asymmetricShortChars 且 Jaccard < asymmetricJaccard：短标签 / 枚举句被长句包含，误报" },
  { id: "R5", class: "X", summary: "（先于 R4）develop 节首的承接句（自身带对照标记，或与前一 develop 节的收束句 / 对照句相接；引言末句不算收束句）：必要过渡；containment ≥ verbatimContainment 记有害" },
  { id: "R4", class: "P", summary: "develop 后节 ≈ framing 前节且 framing 句 ≥ framingExpansionMinChars 信息单位：引言预展开，有害的是引言句；更短的 framing 句记 uncertain（R4u）" },
  { id: "R6", class: "M", summary: "develop 后节 ≈ develop 前节：机制 / 结果在 owner 之外完整重述，后节有害" },
  { id: "R7", class: "X", summary: "compare 后节：必要维度提醒；containment ≥ verbatimContainment 记有害（R7v）；∈ [uncertainContainment, verbatimContainment) 且 Jaccard ≥ uncertainJaccard 记 uncertain（R7u）" },
  { id: "R8", class: "E", summary: "conclude 后节：必要概括；containment ≥ verbatimContainment 记有害（R8v）；结论中 ≥ conclusionMechanismSentences 句各自与机制 / 结果陈述句（develop 的非收束句，或已判为 P 的引言句；compare 综合句与「总体而言…」收束句不算）配对且非限制 / 路标 / F 时视为逐一复述，升级为 M（R8m）" },
  { id: "R9", class: "uncertain", summary: "非常规角色顺序，不自动判定" },
];
