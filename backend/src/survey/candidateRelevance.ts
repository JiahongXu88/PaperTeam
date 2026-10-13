/**
 * 综述候选文献的主题相关性排序与推荐集选择（M13.8；确定性、可解释、无 LLM）。
 *
 * 背景（M13 Final Closure §4-10 / §15-4）：旧推荐集按「学术形态优先、年份降序」截断，
 * 与主题无关——在只有 arXiv 可用时，近年外围工作（单目标 / 多模态 VOT、点跟踪）压过
 * 代表性文献，taxonomy 13/14 无法归类。
 *
 * 信号（全部来自已落盘的真实检索产物，不编造任何文献、不硬编码任何标题 / arXiv ID）：
 * - 主题词面：从研究计划的 academic 检索词提取「核心短语」（≥ 2 条检索词共享的 2/3-gram）
 *   与「核心词」（≥ 2 条检索词共享的非停用词）；标题命中权重高于摘要片段；
 * - 多查询命中：同一身份在几条不同检索词的结果快照中出现（executionHistory；越多越中心）；
 * - 方法家族：surveyProfile.taxonomy 的 label / subFamilies / 描述中的拉丁词项命中 → 覆盖信号；
 * - 引用数：provider 实测值（无则 0；只是弱信号，绝不作为唯一依据）；
 * - 时间：yearFrom / yearTo 范围内略加分，范围前不剔除；
 * - 近似重复：归一化后标题完全相同（同一论文被多条检索词各自物化为不同候选）的后位候选
 *   标记 nearDuplicateOf，不进推荐集——只认完全相同，不做模糊相似（"Method 1/2" 这类系列
 *   论文不是重复）。
 *
 * 诚实标注：无摘要片段且零词面命中 → relevance="uncertain"（无法确认相关性），不冒充相关。
 * 回退：没有任何上下文（旧 artifact / 测试）或全部候选 low / uncertain → 旧口径
 * （学术形态优先、年份降序），basis 如实标 "recency_fallback"。
 */

import type { CandidateSource } from "../sources/CandidateStore.js";
import { identityKey, type SourceIdentity } from "../sources/identity.js";

export const RELEVANCE_ALGORITHM_VERSION = "topic_relevance_v1";

export interface RelevanceQuery {
  query: string;
  kind: string;
}

export interface RelevanceFamily {
  label: string;
  description?: string;
  subFamilies?: string[];
}

export interface SurveyRelevanceContext {
  /** 综述主题（项目标题；拉丁词项参与核心词，CJK 只在候选标题含 CJK 时参与） */
  topic?: string;
  /** 研究计划检索词（只用 kind=academic） */
  queries?: readonly RelevanceQuery[];
  /** surveyProfile.taxonomy.families */
  taxonomyFamilies?: readonly RelevanceFamily[];
  /** identityKey → 命中的不同检索词数（buildQueryHitCounts） */
  queryHits?: ReadonlyMap<string, number>;
  yearFrom?: number;
  yearTo?: number;
}

export type RelevanceLabel = "high" | "medium" | "low" | "uncertain";

export interface RankedCandidate {
  candidateId: string;
  score: number;
  relevance: RelevanceLabel;
  /** 有 DOI / arXiv 身份（学术形态） */
  paperLike: boolean;
  signals: {
    topicOverlap: number;
    matchedPhrases: string[];
    matchedTerms: string[];
    queryHits: number;
    familyMatches: string[];
    citationCount?: number;
    year?: number;
    hasAbstract: boolean;
    nearDuplicateOf?: string;
  };
  /** 用户可读的理由（中文；展示在 HITL 面板） */
  reasons: string[];
}

export interface RecommendationSelection {
  candidateIds: string[];
  basis: "topic_relevance_v1" | "recency_fallback";
  counts: Record<RelevanceLabel, number>;
  /** 推荐集中每个方法家族的命中数（coverage 可解释） */
  familyCoverage: Record<string, number>;
  nearDuplicatesSuppressed: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "in", "on", "with", "to", "by", "from", "at", "as", "is", "are", "be",
  "via", "using", "based", "towards", "toward", "into", "over", "under", "between", "its", "their", "this", "that",
  "we", "our", "it", "can", "than", "more", "most", "very", "both", "all", "any", "new", "novel", "paper", "papers",
  "method", "methods", "approach", "approaches", "framework", "frameworks", "model", "models", "learning", "deep",
  "neural", "network", "networks", "survey", "review", "overview", "recent", "advances", "advance", "comprehensive",
  "study", "analysis", "code", "github", "awesome", "state", "art", "task", "tasks", "problem", "problems",
  "performance", "results", "proposed", "propose", "existing", "various", "different", "multiple", "large",
]);

const PHRASE_MAX_LEN = 3;
/** 推荐集上限（与旧口径一致） */
export const SURVEY_RECOMMENDED_MAX = 25;

/** 领域内同义写法归一（两侧同一规则）：multiple object → multi object、multi-target → multi object */
const SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/\bmultiple[\s-]+object\b/g, "multi object"],
  [/\bmulti[\s-]+target\b/g, "multi object"],
  [/\bmultiple[\s-]+target\b/g, "multi object"],
];

function normalizeLatin(text: string): string {
  let lowered = text.toLowerCase();
  for (const [pattern, replacement] of SYNONYMS) {
    lowered = lowered.replace(pattern, replacement);
  }
  return lowered
    .replace(/[‐-―-]/g, " ")
    .replace(/[^a-z0-9一-鿿\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 轻量单复数归一（transformers → transformer、tracklets → tracklet、queries → query）；两侧同一规则 */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

function latinTokens(text: string): string[] {
  return normalizeLatin(text)
    .split(" ")
    .filter((token) => token !== "" && /^[a-z0-9]+$/.test(token) && (token.length >= 3 || /^\d[a-z]$/.test(token)))
    .map(stem);
}

function contentTokens(text: string): string[] {
  return latinTokens(text).filter((token) => !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/**
 * 家族「区分性」词项：≥ 5 字符的实词、含数字的技术词（3d / mot17）、原文全大写缩写（MOT / DETR / VIS）。
 * 短的普通词（joint / data）不算——否则一个家族会吞掉全部候选。
 */
function distinctiveTokens(text: string): string[] {
  const acronyms = new Set((text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? []).map((token) => stem(token.toLowerCase())));
  return contentTokens(text).filter((token) => token.length >= 5 || /\d/.test(token) || acronyms.has(token));
}

function cjkBigrams(text: string): string[] {
  const runs = text.match(/[一-鿿]{2,}/g) ?? [];
  const grams: string[] = [];
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      grams.push(run.slice(index, index + 2));
    }
  }
  return grams;
}

/** 检索词 n-gram（保留停用词以便 "end to end" 成立；要求 ≥ 2 个非停用词） */
function phrasesOf(text: string): Set<string> {
  const tokens = latinTokens(text);
  const phrases = new Set<string>();
  for (let size = 2; size <= PHRASE_MAX_LEN; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      const slice = tokens.slice(index, index + size);
      const content = slice.filter((token) => !STOPWORDS.has(token));
      if (content.length >= 2) {
        phrases.add(slice.join(" "));
      }
    }
  }
  return phrases;
}

interface TopicProfile {
  corePhrases: string[];
  coreTerms: string[];
  topicCjk: string[];
  families: Array<{ label: string; tokens: Set<string> }>;
  hasQueries: boolean;
}

function buildTopicProfile(context: SurveyRelevanceContext): TopicProfile {
  const academic = (context.queries ?? []).filter((query) => query.kind === "academic" && query.query.trim() !== "");
  const phraseCounts = new Map<string, number>();
  const termCounts = new Map<string, number>();
  for (const query of academic) {
    for (const phrase of phrasesOf(query.query)) {
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
    for (const term of new Set(contentTokens(query.query))) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }
  const threshold = academic.length >= 2 ? 2 : 1;
  let corePhrases = [...phraseCounts.entries()].filter(([, count]) => count >= threshold).map(([phrase]) => phrase);
  // 去掉被更长核心短语完全覆盖的短短语（"object tracking" ⊂ "multi object tracking"）——避免重复计分
  corePhrases = corePhrases.filter(
    (phrase) => !corePhrases.some((other) => other !== phrase && other.includes(phrase) && (phraseCounts.get(other) ?? 0) >= (phraseCounts.get(phrase) ?? 0)),
  );
  const coreTerms = new Set([...termCounts.entries()].filter(([, count]) => count >= threshold).map(([term]) => term));
  for (const term of contentTokens(context.topic ?? "")) {
    coreTerms.add(term);
  }
  // 家族词项只保留「区分性」词：排除核心词（transformer / tracking / multi…对所有候选都成立）
  // 与出现在 ≥ 2 个家族里的共同词（detection / tracking 之类），否则一个家族会吞掉全部候选
  const rawFamilies = (context.taxonomyFamilies ?? []).map((family) => {
    const tokens = new Set<string>();
    for (const token of distinctiveTokens(family.label.replace(/_/g, " ").toUpperCase() === family.label.replace(/_/g, " ") ? family.label.replace(/_/g, " ") : family.label.replace(/_/g, " "))) tokens.add(token);
    for (const sub of family.subFamilies ?? []) for (const token of distinctiveTokens(sub.replace(/_/g, " "))) tokens.add(token);
    for (const token of distinctiveTokens(family.description ?? "")) tokens.add(token);
    // label 自身的短词（mot / 3d）也算区分性：label 是作者给家族起的名字
    for (const token of contentTokens(family.label.replace(/_/g, " "))) if (/\d/.test(token) || token.length <= 4) tokens.add(token);
    return { label: family.label, tokens };
  });
  const familyTokenCounts = new Map<string, number>();
  for (const family of rawFamilies) for (const token of family.tokens) familyTokenCounts.set(token, (familyTokenCounts.get(token) ?? 0) + 1);
  const families = rawFamilies.map((family) => ({
    label: family.label,
    tokens: new Set([...family.tokens].filter((token) => !coreTerms.has(token) && (familyTokenCounts.get(token) ?? 0) < 2)),
  }));
  return {
    corePhrases: corePhrases.sort(),
    coreTerms: [...coreTerms].sort(),
    topicCjk: cjkBigrams(context.topic ?? ""),
    families,
    hasQueries: academic.length > 0,
  };
}

function hasContext(profile: TopicProfile): boolean {
  return profile.corePhrases.length > 0 || profile.coreTerms.length > 0 || profile.families.length > 0;
}

/** executionHistory → identityKey 命中的不同检索词数（只认 status=executed，可按 planId 过滤） */
export function buildQueryHitCounts(
  entries: readonly {
    kind: string;
    status: string;
    query: string;
    planId?: string;
    resultSnapshot?: readonly { kind?: string; identity?: SourceIdentity }[];
  }[],
  planId?: string,
): Map<string, number> {
  const byKey = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "academic" || entry.status !== "executed") continue;
    if (planId !== undefined && entry.planId !== undefined && entry.planId !== planId) continue;
    for (const snapshot of entry.resultSnapshot ?? []) {
      if (snapshot.identity === undefined) continue;
      const key = identityKey(snapshot.identity);
      if (key === undefined) continue;
      let queries = byKey.get(key);
      if (queries === undefined) {
        queries = new Set();
        byKey.set(key, queries);
      }
      queries.add(entry.query);
    }
  }
  return new Map([...byKey.entries()].map(([key, queries]) => [key, queries.size]));
}

function recencyScore(year: number | undefined, from: number | undefined, to: number | undefined): number {
  if (year === undefined) return 0.5;
  if (from !== undefined && year < from) return 0.3;
  if (to !== undefined && year > to) return 0.8;
  return 1;
}

function isPaperLike(candidate: CandidateSource): boolean {
  return candidate.doi !== undefined || candidate.arxivId !== undefined || candidate.identity.doi !== undefined || candidate.identity.arxivId !== undefined;
}

/** 旧口径（学术形态优先、年份降序、candidateId 升序；回退与无上下文时使用） */
export function legacyRecencyOrder(candidates: readonly CandidateSource[]): CandidateSource[] {
  const paperLike = candidates.filter(isPaperLike);
  const pool = paperLike.length > 0 ? paperLike : [...candidates];
  return pool.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.candidateId.localeCompare(b.candidateId));
}

/**
 * 排序：score 降序 → 多查询命中降序 → 年份降序 → candidateId 升序（确定性）。
 * 无上下文时所有候选 score 只含 recency，标签 uncertain（调用方应走回退）。
 */
export function rankSurveyCandidates(
  candidates: readonly CandidateSource[],
  context: SurveyRelevanceContext = {},
): RankedCandidate[] {
  const profile = buildTopicProfile(context);
  const contextual = hasContext(profile);
  const ranked: RankedCandidate[] = candidates.map((candidate) => {
    const title = candidate.title ?? "";
    const abstract = candidate.snippetOrAbstract ?? "";
    // 短语匹配与短语提取用同一 token 序列（停用词 to/of 等已按长度过滤、已单复数归一）
    const titleNorm = latinTokens(title).join(" ");
    const abstractNorm = latinTokens(abstract).join(" ");
    const titleTokens = new Set(contentTokens(title));
    const abstractTokens = new Set(contentTokens(abstract));
    const matchedPhrases: string[] = [];
    let phraseScore = 0;
    for (const phrase of profile.corePhrases) {
      const padded = ` ${phrase} `;
      if (` ${titleNorm} `.includes(padded)) {
        matchedPhrases.push(phrase);
        phraseScore += 1;
      } else if (` ${abstractNorm} `.includes(padded)) {
        matchedPhrases.push(phrase);
        phraseScore += 0.5;
      }
    }
    const phraseFraction = profile.corePhrases.length === 0 ? 0 : Math.min(1, phraseScore / Math.min(profile.corePhrases.length, 2));
    const matchedTerms = profile.coreTerms.filter((term) => titleTokens.has(term) || abstractTokens.has(term));
    const termFraction = profile.coreTerms.length === 0 ? 0 : Math.min(1, matchedTerms.length / Math.min(profile.coreTerms.length, 6));
    const cjkHits = profile.topicCjk.length > 0 && /[一-鿿]/.test(title)
      ? profile.topicCjk.filter((gram) => title.includes(gram)).length / profile.topicCjk.length
      : 0;
    const topicOverlap = profile.corePhrases.length > 0 || profile.coreTerms.length > 0
      ? Math.min(1, 0.6 * phraseFraction + 0.4 * termFraction + 0.5 * cjkHits)
      : 0;
    const key = identityKey(candidate.identity);
    const queryHits = key !== undefined ? (context.queryHits?.get(key) ?? (candidate.query !== undefined ? 1 : 0)) : 0;
    const familyMatches = profile.families
      .filter((family) => {
        const hits = [...family.tokens].filter((token) => titleTokens.has(token) || abstractTokens.has(token));
        return hits.length >= 1 && (hits.some((token) => token.length >= 6 || /\d/.test(token)) || hits.length >= 2);
      })
      .map((family) => family.label);
    const citationScore = candidate.citationCount !== undefined && candidate.citationCount > 0
      ? Math.min(1, Math.log1p(candidate.citationCount) / Math.log1p(1000))
      : 0;
    const recency = recencyScore(candidate.year, context.yearFrom, context.yearTo);
    const hitScore = Math.min(queryHits, 3) / 3;
    const familyScore = Math.min(familyMatches.length, 2) / 2;
    const score = contextual
      ? 0.45 * topicOverlap + 0.25 * hitScore + 0.15 * familyScore + 0.05 * citationScore + 0.1 * recency
      : 0.1 * recency;
    const hasAbstract = abstract.trim() !== "";
    let relevance: RelevanceLabel;
    if (!contextual) {
      relevance = "uncertain";
    } else if (topicOverlap === 0 && !hasAbstract) {
      relevance = "uncertain";
    } else if (topicOverlap >= 0.5 && (queryHits >= 2 || familyMatches.length >= 1 || matchedPhrases.length >= 1)) {
      relevance = "high";
    } else if (topicOverlap >= 0.3 || (topicOverlap > 0 && queryHits >= 2)) {
      relevance = "medium";
    } else {
      relevance = "low";
    }
    const reasons: string[] = [];
    if (matchedPhrases.length > 0) reasons.push(`命中核心短语：${matchedPhrases.slice(0, 3).join("、")}`);
    if (matchedTerms.length > 0) reasons.push(`命中核心词 ${matchedTerms.length}/${profile.coreTerms.length}`);
    if (queryHits >= 2) reasons.push(`${queryHits} 条检索词均命中`);
    if (familyMatches.length > 0) reasons.push(`方法家族：${familyMatches.slice(0, 2).join("、")}`);
    if (candidate.citationCount !== undefined && candidate.citationCount > 0) reasons.push(`引用 ${candidate.citationCount}`);
    if (relevance === "uncertain") reasons.push(contextual ? "无摘要且标题未命中主题词，无法确认相关性" : "缺少研究计划上下文，无法判断相关性");
    if (relevance === "low" && contextual) reasons.push("主题词面命中弱（可能是外围工作）");
    return {
      candidateId: candidate.candidateId,
      score: Math.round(score * 1000) / 1000,
      relevance,
      paperLike: isPaperLike(candidate),
      signals: {
        topicOverlap: Math.round(topicOverlap * 1000) / 1000,
        matchedPhrases,
        matchedTerms,
        queryHits,
        familyMatches,
        ...(candidate.citationCount !== undefined ? { citationCount: candidate.citationCount } : {}),
        ...(candidate.year !== undefined ? { year: candidate.year } : {}),
        hasAbstract,
      },
      reasons,
    };
  });
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.signals.queryHits - a.signals.queryHits ||
      (b.signals.year ?? 0) - (a.signals.year ?? 0) ||
      a.candidateId.localeCompare(b.candidateId),
  );
  // 重复：归一化（小写 / 标点 / 空白；保留数字）后标题完全相同的后位候选
  const seen = new Map<string, string>();
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const entry of ranked) {
    const key = normalizeLatin(byId.get(entry.candidateId)?.title ?? "");
    if (key.length < 8) {
      continue;
    }
    const duplicateOf = seen.get(key);
    if (duplicateOf !== undefined) {
      entry.signals.nearDuplicateOf = duplicateOf;
      entry.reasons.push(`与 ${duplicateOf} 标题相同（同一论文的重复候选）`);
      continue;
    }
    seen.set(key, entry.candidateId);
  }
  return ranked;
}

/**
 * 推荐集：学术形态优先；先按方法家族各取最高分（coverage），再按分数填 high / medium；
 * 名额未满时再按分数补 low、最后补 uncertain（全部如实带标签——排序让相关文献在前，
 * 用户从尾部删减；不因启发式误判而把文献排除在推荐之外）；近似重复不进推荐集。
 * 全部候选无相关信号（无 high / medium）→ 旧口径回退（如实标注 recency_fallback）。
 */
export function selectRecommendedCandidates(
  candidates: readonly CandidateSource[],
  ranked: readonly RankedCandidate[],
  options: { max?: number; familyOrder?: readonly string[] } = {},
): RecommendationSelection {
  const max = options.max ?? SURVEY_RECOMMENDED_MAX;
  const counts: Record<RelevanceLabel, number> = { high: 0, medium: 0, low: 0, uncertain: 0 };
  for (const entry of ranked) counts[entry.relevance] += 1;
  const paperLike = ranked.filter((entry) => entry.paperLike);
  const pool = paperLike.length > 0 ? paperLike : [...ranked];
  const eligible = pool.filter(
    (entry) => (entry.relevance === "high" || entry.relevance === "medium") && entry.signals.nearDuplicateOf === undefined,
  );
  const nearDuplicatesSuppressed = pool.filter((entry) => entry.signals.nearDuplicateOf !== undefined).length;
  if (eligible.length === 0) {
    return {
      candidateIds: legacyRecencyOrder(candidates).slice(0, max).map((candidate) => candidate.candidateId),
      basis: "recency_fallback",
      counts,
      familyCoverage: {},
      nearDuplicatesSuppressed,
    };
  }
  const selected: RankedCandidate[] = [];
  const chosen = new Set<string>();
  const families = options.familyOrder ?? [...new Set(eligible.flatMap((entry) => entry.signals.familyMatches))];
  for (const family of families) {
    if (selected.length >= max) break;
    const pick = eligible.find((entry) => !chosen.has(entry.candidateId) && entry.signals.familyMatches.includes(family));
    if (pick !== undefined) {
      selected.push(pick);
      chosen.add(pick.candidateId);
    }
  }
  for (const entry of eligible) {
    if (selected.length >= max) break;
    if (!chosen.has(entry.candidateId)) {
      selected.push(entry);
      chosen.add(entry.candidateId);
    }
  }
  for (const label of ["low", "uncertain"] as const) {
    for (const entry of pool) {
      if (selected.length >= max) break;
      if (entry.relevance === label && entry.signals.nearDuplicateOf === undefined && !chosen.has(entry.candidateId)) {
        selected.push(entry);
        chosen.add(entry.candidateId);
      }
    }
  }
  selected.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  const familyCoverage: Record<string, number> = {};
  for (const entry of selected) {
    for (const family of entry.signals.familyMatches) {
      familyCoverage[family] = (familyCoverage[family] ?? 0) + 1;
    }
  }
  return {
    candidateIds: selected.map((entry) => entry.candidateId),
    basis: RELEVANCE_ALGORITHM_VERSION,
    counts,
    familyCoverage,
    nearDuplicatesSuppressed,
  };
}
