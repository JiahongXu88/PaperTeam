/**
 * Research Coverage Analyzer（M8.3.2：Research Coverage Analyzer）。
 *
 * 回答三个问题：研究问题是否被覆盖？哪些方向仍存在缺口？下一轮 Research
 * Plan 应该关注什么？本模块把回答建模为「结构化覆盖状态」（ResearchCoverage），
 * 而不是评分系统——covered / partial / missing 的三态判定 + 缺口建议，
 * 全部是**确定性规则**（第一版不依赖 LLM；如需语义归因，未来复用已有
 * Researcher 通道，不新增角色）。
 *
 * 冻结规则（M8 架构）全部遵守：
 * - 不新增 Agent（无 Coverage Agent / Research Gap Agent）：纯 Service +
 *   纯函数，不调用 Runtime.runAgent、无 prompt；
 * - 不修改 Runtime / Workflow Orchestrator：不进 workflowServices，覆盖
 *   分析是用户经 HTTP 显式触发的同步只读动作；
 * - 不引入 RAG / Vector DB / MCP / 新 Provider / CLI：只读 research.json
 *   与既有 Store 的落盘产物；
 * - 只读纪律：不写 plan / executionHistory / EvidenceStore / CandidateStore
 *   ——Coverage 是**派生视图**（deterministic projection），随源数据即时重算，
 *   不在 research.json 上新增持久化字段，避免状态双写漂移；
 * - Evidence 不变量：Search Result ≠ Candidate ≠ Literature ≠ Verified
 *   Evidence——覆盖判定如实分层（resultCount 是 Search Result 计数；
 *   promoted literature 是已入库候选；evidence 是已核验 EvidenceStore 条目），
 *   三层各计各数，不混写。M9.4 收紧：unverified / legacy 证据不再把问题推成
 *   covered（最多 partial），只有 verified 证据或 promoted literature 构成
 *   strong covered。
 *
 * M8.3.3：报告的 gaps 升级为 ResearchGap[]（researchGap.ts）——带稳定
 * gapId / severity / status=proposed 的显式研究对象，供 HITL 确认与
 * 「从缺口派生下一轮计划」消费；分析器只产生 proposed，永不自动 accepted。
 *
 * 判定输入（全部来自既有状态）：
 * - plan.questions（活动计划的检索意图）+ report.researchQuestions（调研报告
 *   的结论问题；与 plan.questions 去重后补充分析）；
 * - plan.queries（status / resultCount）+ executionHistory（M8.2 执行记录：
 *   旧 artifact 的 query 缺 resultCount 时从历史回补，planId 不限——旧记录
 *   无该字段，见 researchPlanExecution.ts）；
 * - EvidenceStore.list（证据条目）与 CandidateStore 中 accepted + 已 promote
 *   的候选（promoted literature）。
 *
 * 关联规则（确定性，无语义模型）：
 * 问题与文本（检索词 / 期望覆盖 / 证据 claim / 候选检索词与标题）按
 * 「token 交集非空」判关联——拉丁词（≥3 字符）+ CJK 二元组（bigram）。
 * 纯中文问题 vs 纯英文检索词判不关联是已知局限（如实落入 missing/缺口，
 * 不伪造关联）；未来 M8.3.3 Controlled Research Loop 若引入 Researcher
 * 语义归因，可替换该匹配器而不动规则骨架。
 */

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { CandidateStore } from "../sources/CandidateStore.js";
import {
  readPlanChain,
  type EvidenceClaimType,
  type EvidenceRequirement,
  type EvidenceRequirementPriority,
  type ExpectedEvidenceType,
  type ResearchPlan,
  type ResearchPlanStatus,
} from "./researchPlan.js";
import type { PlanExecutionEntry } from "./researchPlanExecution.js";
import { readResearchArtifact, type ResearchArtifact } from "./ResearcherService.js";
import { buildResearchGaps, type ResearchGap } from "./researchGap.js";

// ---- 领域模型（结构化状态优先，不过度设计评分） ----

export type ResearchCoverageLevel = "covered" | "partial" | "missing";

/** 单个研究问题的覆盖判定 */
export interface ResearchCoverageQuestion {
  question: string;
  /** 问题来源：plan（活动计划的检索意图）| report（调研报告的结论问题） */
  origin: "plan" | "report";
  coverage: ResearchCoverageLevel;
  /** 与该问题关联的计划检索条数（token 关联） */
  relatedQueryCount: number;
  /** 关联检索中已执行且带回结果的条数 */
  executedQueryCount: number;
  /** 关联检索带回的 Search Result 总数（≠候选≠文献≠证据） */
  resultCount: number;
  /** 与该问题关联的已核验（verified）EvidenceStore 条目数（M9.4：只有 verified 可支撑 covered） */
  evidenceCount: number;
  /** 与该问题关联的已入库文献数（accepted 且已 promote 的候选） */
  promotedCount: number;
  /** 非 covered 时的缺口描述（covered 时省略） */
  gap?: string;
}

export interface ResearchCoverage {
  /** 被分析的计划（= 活动计划；M8.3.1 计划链中 activePlanId 指向的条目） */
  planId: string;
  planStatus: ResearchPlanStatus;
  iterationNumber?: number;
  analyzedAt: string;
  questions: ResearchCoverageQuestion[];
  /**
   * 预写证据需求的覆盖判定（M9.8 Phase 3；与 questions / gaps 平行的派生
   * 视图——不在 research.json 上持久化任何覆盖状态）。旧 artifact 无
   * requirements 时为空数组。
   */
  requirementCoverage: RequirementCoverageEntry[];
  overall: {
    questionCount: number;
    covered: number;
    partial: number;
    missing: number;
    summary: string;
    /** M9.8：需求覆盖汇总（加性字段；waived = 用户显式弃权不参与判定） */
    requirements?: {
      analyzed: number;
      covered: number;
      partial: number;
      missing: number;
      waived: number;
    };
  };
  /**
   * 缺口清单（M8.3.3 起为 ResearchGap[]——带稳定 gapId / severity /
   * status=proposed 的显式研究对象；分析器只产生 proposed，HITL 决策与
   * 派生走 ResearchGapService）。字段是 M8.3.2 缺口建议（description /
   * suggestedQueries）的纯增量扩展。
   */
  gaps: ResearchGap[];
}

// ---- 关联匹配（确定性纯函数） ----

/**
 * 文本 → 匹配 token 集：拉丁词（[a-z0-9]+ 且 ≥3 字符，过滤 a/of/the 类噪声）
 * + CJK 连续段二元组（单字段退化为该字）。空集 = 无可匹配信息。
 */
export function matchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 3) {
      tokens.add(word);
    }
  }
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 问题与文本是否关联（token 交集非空；任一侧无可匹配信息 → 不关联） */
export function isTextRelated(question: string, text: string): boolean {
  if (text.trim() === "") {
    return false;
  }
  const questionTokens = matchTokens(question);
  if (questionTokens.size === 0) {
    return false;
  }
  const textTokens = matchTokens(text);
  for (const token of questionTokens) {
    if (textTokens.has(token)) {
      return true;
    }
  }
  return false;
}

// ---- 覆盖判定（纯函数，输入已由 Service 聚合） ----

/** 参与判定的单条检索事实（plan.queries 与 executionHistory 的合并视图） */
export interface CoverageQueryFacts {
  queryId: string;
  query: string;
  expectedCoverage?: string;
  /** 已执行（plan status=executed，或执行历史有该 queryId 的 executed 记录） */
  executed: boolean;
  /** 合并后的 Search Result 数（plan 回填优先，缺省从历史累加） */
  resultCount: number;
}

export interface CoverageQuestionContext {
  question: string;
  origin: "plan" | "report";
  queries: CoverageQueryFacts[];
  /** 每条已核验（verified）EvidenceRecord 的匹配文本（claim + 来源标题） */
  evidenceTexts: string[];
  /** 未核验（legacy unverified / plausible 等）证据文本——最多支撑 partial（M9.4）；缺省空 */
  unverifiedEvidenceTexts?: string[];
  /** 每条已入库候选的匹配文本（发现检索词 + 标题） */
  literatureTexts: string[];
}

/**
 * 单问题三态判定（规则全序，纯函数）：
 * 1. 无关联检索（token 无交集）→ missing（计划检索不覆盖该问题）；
 * 2. 有关联检索但无「已执行且带回结果」→ missing（有 query，resultCount=0）；
 * 3. 有带回结果的检索，且存在关联的**已核验** evidence 或 promoted literature
 *    → covered（M9.4 收紧：Search Result ≠ Candidate ≠ Verified Evidence——
 *    unverified / legacy 证据不能把问题推成 covered，最多 partial）；
 * 4. 其余（有结果但只有未核验证据 / 无证据 / 无入库文献支撑）→ partial。
 */
export function assessQuestionCoverage(context: CoverageQuestionContext): ResearchCoverageQuestion {
  const { question, origin, queries, evidenceTexts, literatureTexts } = context;
  const unverifiedEvidenceTexts = context.unverifiedEvidenceTexts ?? [];
  const related = queries.filter(
    (entry) =>
      isTextRelated(question, entry.query) ||
      (entry.expectedCoverage !== undefined && isTextRelated(question, entry.expectedCoverage)),
  );
  const executed = related.filter((entry) => entry.executed && entry.resultCount > 0);
  const resultCount = executed.reduce((sum, entry) => sum + entry.resultCount, 0);
  const evidenceCount = evidenceTexts.filter((text) => isTextRelated(question, text)).length;
  const unverifiedEvidenceCount = unverifiedEvidenceTexts.filter((text) =>
    isTextRelated(question, text),
  ).length;
  const promotedCount = literatureTexts.filter((text) => isTextRelated(question, text)).length;

  let coverage: ResearchCoverageLevel;
  let gap: string | undefined;
  if (related.length === 0) {
    coverage = "missing";
    gap = "计划中没有任何与该问题相关的检索（建议围绕问题原文制定检索词）";
  } else if (executed.length === 0) {
    coverage = "missing";
    gap = `有 ${related.length} 条相关检索，但均未执行带回结果（resultCount=0，Search Result 层未覆盖）`;
  } else if (evidenceCount + promotedCount > 0) {
    coverage = "covered";
  } else if (unverifiedEvidenceCount > 0) {
    coverage = "partial";
    gap = `有 ${executed.length} 条检索带回 ${resultCount} 条结果与 ${unverifiedEvidenceCount} 条相关未核验证据，但尚无已核验（verified）证据或已入库文献支撑`;
  } else {
    coverage = "partial";
    gap = `有 ${executed.length} 条检索带回 ${resultCount} 条结果，但尚无相关证据或已入库文献支撑（Candidate / Evidence 层未覆盖）`;
  }
  return {
    question,
    origin,
    coverage,
    relatedQueryCount: related.length,
    executedQueryCount: executed.length,
    resultCount,
    evidenceCount,
    promotedCount,
    ...(gap !== undefined ? { gap } : {}),
  };
}

// ---- 缺口建议（M8.3.3 起移至 researchGap.ts：buildResearchGaps 产出 ----
// ---- ResearchGap[]，含稳定 gapId / severity / status=proposed；只建议， ----
// ---- 不派生不执行）                                                   ----

// ---- 需求覆盖判定（M9.8 Phase 3：与问题覆盖同骨架的确定性三态） ----

/**
 * M9.8 Phase 5 实测修正（两处）：
 * 1. 供给优先全序——research 阶段检索由 Agent 工具执行，plan.queries 的执行
 *    回填只在显式计划执行（M8.2）后存在；证据才是供给的落地信号；
 * 2. 需求 ↔ 证据/文献匹配要求 ≥2 个内容词命中（REQUIREMENT_MIN_MATCHED_TERMS，
 *    与 claimGrounding CLAIM_REPAIR_MIN_MATCHED_TERMS 同哲学：宁可判缺不强配）。
 *    实测（m98 B 臂）：孤立单字功能词（「与」）与泛化学术词（「机制」）单命中
 *    会把无全文系统的需求误判 covered（CAMEL/MemGPT 需求被 ReAct 证据「覆盖」
 *    ——恰是 M9.7.7 根因的漏报）；≥2 命中后 uncovered 集合与 unsupported claim
 *    面精确吻合。问题覆盖（questions）口径不变。
 */
export const REQUIREMENT_MIN_MATCHED_TERMS = 2;

/** 内容 token 集：matchTokens 剔除孤立单字 CJK（「与 / 或」级功能词无区分度） */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of matchTokens(text)) {
    if (/^[一-鿿]$/.test(token)) {
      continue;
    }
    out.add(token);
  }
  return out;
}

/** 需求主题在文本池中的「≥2 内容词命中」条数（确定性；空文本池 = 0） */
function countRequirementEvidenceMatches(topic: string, texts: readonly string[]): number {
  const topicTokens = contentTokens(topic);
  if (topicTokens.size === 0) {
    return 0;
  }
  let matched = 0;
  for (const text of texts) {
    if (text.trim() === "") {
      continue;
    }
    const textTokens = contentTokens(text);
    let hits = 0;
    for (const token of topicTokens) {
      if (textTokens.has(token)) {
        hits += 1;
      }
    }
    if (hits >= REQUIREMENT_MIN_MATCHED_TERMS) {
      matched += 1;
    }
  }
  return matched;
}

/** 单条预写证据需求的覆盖判定（派生视图条目，不落存储） */
export interface RequirementCoverageEntry {
  requirementId: string;
  topic: string;
  claimType: EvidenceClaimType;
  expectedEvidenceType: ExpectedEvidenceType;
  priority: EvidenceRequirementPriority;
  coverage: ResearchCoverageLevel;
  /** topic token 关联的计划检索条数（关联面 = query + rationale + expectedCoverage） */
  relatedQueryCount: number;
  /** 关联检索中已执行且带回结果的条数 */
  executedQueryCount: number;
  /** 关联的已核验（verified）EvidenceStore 条目数 */
  evidenceCount: number;
  /** 关联的已入库文献数（accepted 且已 promote） */
  promotedCount: number;
  /** 非 covered 时的缺口描述（covered 时省略） */
  missingReason?: string;
}

export interface CoverageRequirementContext {
  requirement: EvidenceRequirement;
  queries: CoverageQueryFacts[];
  /** rationale 纳入关联面：需求→检索的映射是 M9.8 的显式机制，rationale 是模型声明映射意图的自然位置 */
  queryRationales?: ReadonlyMap<string, string>;
  evidenceTexts: string[];
  unverifiedEvidenceTexts?: string[];
  literatureTexts: string[];
}

/**
 * 单需求三态判定（纯函数；骨架与 assessQuestionCoverage 同构，全序以**供给**
 * 为准——M9.8 Phase 5 实测修正：research 阶段的检索由 Agent 工具执行，plan
 * .queries 的执行回填只在显式计划执行（M8.2）后存在，若以「已执行带回结果」
 * 为 covered 前置，标准 idea_to_paper 流程中需求永远 missing。证据才是供给的
 * 落地信号（Search Result ≠ Candidate ≠ Verified Evidence 不变量不变））：
 * 1. 无关联检索（topic 与 query/rationale/expectedCoverage token 无交集）
 *    → missing（「需求未驱动检索词」——M9.8 Phase 2 的对齐缺口）；
 * 2. 存在关联 verified 证据或 promoted literature → covered（证据已供给）；
 * 3. 只有未核验证据 → partial（有线索待核验）；
 * 4. 有关联检索但均未带回结果 → missing（检索层未供给）；
 * 5. 其余（有结果但无任何证据 / 文献）→ partial。
 * status=waived 的需求不进入本函数（调用方过滤，只计 waived）。
 */
export function assessRequirementCoverage(context: CoverageRequirementContext): RequirementCoverageEntry {
  const { requirement, queries, evidenceTexts, literatureTexts } = context;
  const unverifiedEvidenceTexts = context.unverifiedEvidenceTexts ?? [];
  const rationales = context.queryRationales ?? new Map<string, string>();
  const related = queries.filter(
    (entry) =>
      isTextRelated(requirement.topic, entry.query) ||
      (entry.expectedCoverage !== undefined && isTextRelated(requirement.topic, entry.expectedCoverage)) ||
      (rationales.get(entry.queryId) !== undefined &&
        isTextRelated(requirement.topic, rationales.get(entry.queryId)!)),
  );
  const executed = related.filter((entry) => entry.executed && entry.resultCount > 0);
  const evidenceCount = countRequirementEvidenceMatches(requirement.topic, evidenceTexts);
  const unverifiedEvidenceCount = countRequirementEvidenceMatches(
    requirement.topic,
    unverifiedEvidenceTexts,
  );
  const promotedCount = countRequirementEvidenceMatches(requirement.topic, literatureTexts);

  let coverage: ResearchCoverageLevel;
  let missingReason: string | undefined;
  if (related.length === 0) {
    coverage = "missing";
    missingReason = "计划中没有任何与该需求主题相关的检索（需求未驱动检索词生成）";
  } else if (evidenceCount + promotedCount > 0) {
    coverage = "covered";
  } else if (unverifiedEvidenceCount > 0) {
    coverage = "partial";
    missingReason = `存在 ${unverifiedEvidenceCount} 条相关未核验证据，但尚无已核验（verified）证据或已入库文献支撑该需求`;
  } else if (executed.length === 0) {
    coverage = "missing";
    missingReason = `有 ${related.length} 条相关检索，但均未执行带回结果（检索层未供给该需求）`;
  } else {
    coverage = "partial";
    missingReason = `有 ${executed.length} 条检索带回结果，但尚无相关证据或已入库文献支撑该需求（Candidate / Evidence 层未供给）`;
  }
  return {
    requirementId: requirement.requirementId,
    topic: requirement.topic,
    claimType: requirement.claimType,
    expectedEvidenceType: requirement.expectedEvidenceType,
    priority: requirement.priority,
    coverage,
    relatedQueryCount: related.length,
    executedQueryCount: executed.length,
    evidenceCount,
    promotedCount,
    ...(missingReason !== undefined ? { missingReason } : {}),
  };
}

// ---- 报告组装（纯函数） ----

export interface CoverageAnalysisInput {
  planId: string;
  planStatus: ResearchPlanStatus;
  iterationNumber?: number;
  analyzedAt: string;
  /** 活动计划的研究问题（检索意图，先计划后检索的一侧） */
  planQuestions: string[];
  /** 调研报告的研究问题（检索后结论的一侧；与 planQuestions 精确去重后补充） */
  reportQuestions: string[];
  /** 活动计划的预写证据需求（M9.8；缺省空 = 旧 artifact / 无需求） */
  requirements?: EvidenceRequirement[];
  queries: CoverageQueryFacts[];
  /** queryId → rationale（M9.8 需求关联面；缺省不参与匹配） */
  queryRationales?: ReadonlyMap<string, string>;
  evidenceTexts: string[];
  /** 未核验（legacy unverified / plausible 等）证据文本——最多支撑 partial（M9.4）；缺省空 */
  unverifiedEvidenceTexts?: string[];
  literatureTexts: string[];
  literaturePlan: string[];
}

export function analyzeCoverage(input: CoverageAnalysisInput): ResearchCoverage {
  const seen = new Set<string>();
  const questions: ResearchCoverageQuestion[] = [];
  for (const question of input.planQuestions) {
    if (question.trim() === "" || seen.has(question)) {
      continue;
    }
    seen.add(question);
    questions.push(
      assessQuestionCoverage({
        question,
        origin: "plan",
        queries: input.queries,
        evidenceTexts: input.evidenceTexts,
        unverifiedEvidenceTexts: input.unverifiedEvidenceTexts,
        literatureTexts: input.literatureTexts,
      }),
    );
  }
  for (const question of input.reportQuestions) {
    if (question.trim() === "" || seen.has(question)) {
      continue;
    }
    seen.add(question);
    questions.push(
      assessQuestionCoverage({
        question,
        origin: "report",
        queries: input.queries,
        evidenceTexts: input.evidenceTexts,
        unverifiedEvidenceTexts: input.unverifiedEvidenceTexts,
        literatureTexts: input.literatureTexts,
      }),
    );
  }
  const covered = questions.filter((entry) => entry.coverage === "covered").length;
  const partial = questions.filter((entry) => entry.coverage === "partial").length;
  const missing = questions.filter((entry) => entry.coverage === "missing").length;
  // M8.3.3：缺口构造移交 researchGap.ts（确定性 gapId + severity + proposed）
  const gaps = buildResearchGaps({
    planId: input.planId,
    createdAt: input.analyzedAt,
    questions,
    literaturePlan: input.literaturePlan,
  });
  // M9.8：需求覆盖判定（waived 不参与，只计数；无 requirements = 空视图）
  const requirements = input.requirements ?? [];
  const waived = requirements.filter((requirement) => requirement.status === "waived").length;
  const requirementCoverage = requirements
    .filter((requirement) => requirement.status !== "waived")
    .map((requirement) =>
      assessRequirementCoverage({
        requirement,
        queries: input.queries,
        ...(input.queryRationales !== undefined ? { queryRationales: input.queryRationales } : {}),
        evidenceTexts: input.evidenceTexts,
        unverifiedEvidenceTexts: input.unverifiedEvidenceTexts,
        literatureTexts: input.literatureTexts,
      }),
    );
  const reqCovered = requirementCoverage.filter((entry) => entry.coverage === "covered").length;
  const reqPartial = requirementCoverage.filter((entry) => entry.coverage === "partial").length;
  const reqMissing = requirementCoverage.filter((entry) => entry.coverage === "missing").length;
  const requirementSummary =
    requirements.length > 0
      ? {
          requirements: {
            analyzed: requirementCoverage.length,
            covered: reqCovered,
            partial: reqPartial,
            missing: reqMissing,
            waived,
          },
        }
      : {};
  return {
    planId: input.planId,
    planStatus: input.planStatus,
    ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
    analyzedAt: input.analyzedAt,
    questions,
    requirementCoverage,
    overall: {
      questionCount: questions.length,
      covered,
      partial,
      missing,
      summary:
        (questions.length === 0
          ? "活动计划没有研究问题可供分析（可在编辑计划时补充 questions）"
          : `研究问题 ${questions.length} 个：covered ${covered} · partial ${partial} · missing ${missing}；缺口 ${gaps.length} 项`) +
        (requirements.length > 0
          ? `；证据需求 ${requirementCoverage.length} 条：covered ${reqCovered} · partial ${reqPartial} · missing ${reqMissing}${waived > 0 ? `（另 waived ${waived}）` : ""}`
          : ""),
      ...requirementSummary,
    },
    gaps,
  };
}

// ---- 合并视图：plan.queries + executionHistory → CoverageQueryFacts ----

/**
 * 单条计划检索的事实合并（纯函数）：
 * - executed：plan status=executed 或历史存在该 queryId 的 executed 记录
 *   （失败重试后 plan 回到 planned 的场景以历史为准——曾经带回过结果即算）；
 * - resultCount：plan 回填优先（M8.2 执行层写回），缺失时从执行历史累加
 *   （旧 artifact 兼容：M8.1 手工标记 executed 无 resultCount）。
 * 历史记录不按 planId 过滤：旧记录（M8.2）无 planId 字段，queryId 在链内
 * 派生时会重新分配（q-1 起），跨轮同号属预期——下一轮计划本就承接同一研究线。
 */
export function mergeQueryFacts(
  query: Pick<ResearchPlan["queries"][number], "queryId" | "query" | "status" | "resultCount"> & {
    expectedCoverage?: string;
  },
  history: PlanExecutionEntry[],
): CoverageQueryFacts {
  const entries = history.filter(
    (entry) => entry.queryId === query.queryId && entry.status === "executed",
  );
  const historyCount = entries.reduce((sum, entry) => sum + (entry.resultCount ?? 0), 0);
  return {
    queryId: query.queryId,
    query: query.query,
    ...(query.expectedCoverage !== undefined ? { expectedCoverage: query.expectedCoverage } : {}),
    executed: query.status === "executed" || entries.length > 0,
    resultCount: query.resultCount ?? historyCount,
  };
}

// ---- Service（只读装配层） ----

export interface ResearchCoverageServiceOptions {
  projects: ProjectStore;
  evidence: EvidenceStore;
  candidates: CandidateStore;
  log?: (message: string) => void;
}

/**
 * Research Coverage Service：读取活动计划与既有 Store，产出 Coverage Report。
 * 纯分析——不写 plan / executionHistory / EvidenceStore / CandidateStore，
 * 不在 research.json 上新增字段（报告是派生视图，随源数据即时重算）。
 */
export class ResearchCoverageService {
  private readonly projects: ProjectStore;
  private readonly evidence: EvidenceStore;
  private readonly candidates: CandidateStore;
  private readonly log: (message: string) => void;

  constructor(options: ResearchCoverageServiceOptions) {
    this.projects = options.projects;
    this.evidence = options.evidence;
    this.candidates = options.candidates;
    this.log = options.log ?? (() => {});
  }

  /**
   * 执行覆盖分析（POST /research/coverage/analyze）：
   * 无 artifact（未调研）/ 无计划 → 404（与 derive / execute 同口径）。
   */
  async analyze(projectId: string): Promise<ResearchCoverage> {
    const { artifact, plan } = await this.loadActivePlanOrThrow(projectId);
    const coverage = await this.buildReport(projectId, artifact, plan);
    this.log(
      `[coverage] projectId=${projectId} 覆盖分析完成：planId=${plan.planId} questions=${coverage.overall.questionCount} covered=${coverage.overall.covered} partial=${coverage.overall.partial} missing=${coverage.overall.missing} gaps=${coverage.gaps.length}`,
    );
    return coverage;
  }

  /**
   * 当前活动计划的覆盖（GET /research/coverage）：
   * 无 artifact / 无计划 → null 空态（与 GET /research/plan 的 plan:null 语义
   * 一致，读取端不报错）；有计划 → 与 analyze 同一规则即时重算。
   */
  async get(projectId: string): Promise<ResearchCoverage | null> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      return null;
    }
    const chain = readPlanChain(artifact);
    const plan = chain.plans.find((entry) => entry.planId === chain.activePlanId);
    if (plan === undefined) {
      return null;
    }
    return this.buildReport(projectId, artifact, plan);
  }

  /** 读 artifact + 活动计划（M8.3.1：plans + activePlanId；旧 artifact 归一化单轮链） */
  private async loadActivePlanOrThrow(projectId: string): Promise<{
    artifact: ResearchArtifact;
    plan: ResearchPlan;
  }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研再分析覆盖",
      );
    }
    const chain = readPlanChain(artifact);
    const plan = chain.plans.find((entry) => entry.planId === chain.activePlanId);
    if (plan === undefined) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
      );
    }
    return { artifact, plan };
  }

  /** 聚合判定输入并组装报告（只读：evidence / candidates 均为 list 读取） */
  private async buildReport(
    projectId: string,
    artifact: ResearchArtifact,
    plan: ResearchPlan,
  ): Promise<ResearchCoverage> {
    const history = artifact.executionHistory ?? [];
    const evidenceRecords = await this.evidence.list(projectId);
    // M9.4 质量收紧：covered 的 Evidence 支撑只认 verified（grounded 管道 /
    // user_confirmed 产物）；legacy unverified / plausible 等待核验线索最多
    // 支撑 partial——Search Result ≠ Candidate ≠ Verified Evidence 不变量落地。
    const evidenceTextOf = (record: (typeof evidenceRecords)[number]) =>
      [record.claim, record.source?.title].filter((part) => part !== undefined && part !== "").join(" ");
    const promoted = (await this.candidates.list(projectId)).filter(
      (candidate) => candidate.status === "accepted" && candidate.promotedSourceId !== undefined,
    );
    // M9.8：rationale 参与「需求 → 检索」关联面（模型在 rationale 中声明映射意图）
    const queryRationales = new Map<string, string>();
    for (const query of plan.queries) {
      if (query.rationale !== undefined) {
        queryRationales.set(query.queryId, query.rationale);
      }
    }
    return analyzeCoverage({
      planId: plan.planId,
      planStatus: plan.status,
      iterationNumber: plan.iterationNumber,
      analyzedAt: new Date().toISOString(),
      planQuestions: plan.questions,
      reportQuestions: artifact.report?.researchQuestions ?? [],
      ...(plan.requirements !== undefined && plan.requirements.length > 0
        ? { requirements: plan.requirements }
        : {}),
      queries: plan.queries.map((query) => mergeQueryFacts(query, history)),
      queryRationales,
      evidenceTexts: evidenceRecords
        .filter((record) => record.verificationStatus === "verified")
        .map(evidenceTextOf),
      unverifiedEvidenceTexts: evidenceRecords
        .filter((record) => record.verificationStatus !== "verified")
        .map(evidenceTextOf),
      literatureTexts: promoted.map((candidate) =>
        [candidate.query, candidate.title].filter((part) => part !== undefined && part !== "").join(" "),
      ),
      literaturePlan: artifact.report?.literaturePlan ?? [],
    });
  }
}
