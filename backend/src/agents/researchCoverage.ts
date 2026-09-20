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
 *   promoted literature 是已入库候选；evidence 是 EvidenceStore 条目），
 *   三层各计各数，不混写。
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
  type ResearchPlan,
  type ResearchPlanStatus,
} from "./researchPlan.js";
import type { PlanExecutionEntry } from "./researchPlanExecution.js";
import { readResearchArtifact, type ResearchArtifact } from "./ResearcherService.js";

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
  /** 与该问题关联的 EvidenceStore 条目数（任意核验状态，如实计数） */
  evidenceCount: number;
  /** 与该问题关联的已入库文献数（accepted 且已 promote 的候选） */
  promotedCount: number;
  /** 非 covered 时的缺口描述（covered 时省略） */
  gap?: string;
}

/** 缺口建议（只生成建议：不自动 derive / approve / execute） */
export interface ResearchCoverageGap {
  description: string;
  /** 关联的研究问题（report.literaturePlan 残差方向无关联问题，省略） */
  relatedQuestion?: string;
  /** 建议下一轮执行的检索词（确定性生成：问题原文 / 残差方向原文） */
  suggestedQueries: string[];
}

export interface ResearchCoverage {
  /** 被分析的计划（= 活动计划；M8.3.1 计划链中 activePlanId 指向的条目） */
  planId: string;
  planStatus: ResearchPlanStatus;
  iterationNumber?: number;
  analyzedAt: string;
  questions: ResearchCoverageQuestion[];
  overall: {
    questionCount: number;
    covered: number;
    partial: number;
    missing: number;
    summary: string;
  };
  gaps: ResearchCoverageGap[];
}

/** 缺口条数硬帽（防 literaturePlan / 问题数异常膨胀；与既有 slice 上限同量级） */
export const MAX_COVERAGE_GAPS = 30;

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
  /** 每条 EvidenceStore 记录的匹配文本（claim + 来源标题） */
  evidenceTexts: string[];
  /** 每条已入库候选的匹配文本（发现检索词 + 标题） */
  literatureTexts: string[];
}

/**
 * 单问题三态判定（规则全序，纯函数）：
 * 1. 无关联检索（token 无交集）→ missing（计划检索不覆盖该问题）；
 * 2. 有关联检索但无「已执行且带回结果」→ missing（有 query，resultCount=0）；
 * 3. 有带回结果的检索，且存在关联 evidence 或 promoted literature → covered；
 * 4. 其余（有结果但无证据 / 入库文献支撑）→ partial。
 */
export function assessQuestionCoverage(context: CoverageQuestionContext): ResearchCoverageQuestion {
  const { question, origin, queries, evidenceTexts, literatureTexts } = context;
  const related = queries.filter(
    (entry) =>
      isTextRelated(question, entry.query) ||
      (entry.expectedCoverage !== undefined && isTextRelated(question, entry.expectedCoverage)),
  );
  const executed = related.filter((entry) => entry.executed && entry.resultCount > 0);
  const resultCount = executed.reduce((sum, entry) => sum + entry.resultCount, 0);
  const evidenceCount = evidenceTexts.filter((text) => isTextRelated(question, text)).length;
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

// ---- 缺口建议（纯函数；只建议，不派生不执行） ----

/**
 * 由判定结果 + 报告残差方向生成缺口清单：
 * - missing / partial 的问题各一条缺口，建议检索 = 问题原文（确定性 v1；
 *   语义化改写留给未来的 Researcher 通道）；
 * - report.literaturePlan 是调研方声明的「检索后仍缺失」残差方向，
 *   原文作为缺口与建议检索直通登记（无关联问题）。
 */
export function buildCoverageGaps(
  questions: ResearchCoverageQuestion[],
  literaturePlan: string[],
): ResearchCoverageGap[] {
  const gaps: ResearchCoverageGap[] = [];
  for (const entry of questions) {
    if (entry.coverage === "covered") {
      continue;
    }
    gaps.push({
      description: entry.gap ?? "该研究问题未被覆盖",
      relatedQuestion: entry.question,
      suggestedQueries: [entry.question],
    });
  }
  for (const direction of literaturePlan) {
    if (direction.trim() === "") {
      continue;
    }
    gaps.push({
      description: `调研报告登记的残差文献方向：${direction}`,
      suggestedQueries: [direction],
    });
  }
  return gaps.slice(0, MAX_COVERAGE_GAPS);
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
  queries: CoverageQueryFacts[];
  evidenceTexts: string[];
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
        literatureTexts: input.literatureTexts,
      }),
    );
  }
  const covered = questions.filter((entry) => entry.coverage === "covered").length;
  const partial = questions.filter((entry) => entry.coverage === "partial").length;
  const missing = questions.filter((entry) => entry.coverage === "missing").length;
  const gaps = buildCoverageGaps(questions, input.literaturePlan);
  return {
    planId: input.planId,
    planStatus: input.planStatus,
    ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
    analyzedAt: input.analyzedAt,
    questions,
    overall: {
      questionCount: questions.length,
      covered,
      partial,
      missing,
      summary:
        questions.length === 0
          ? "活动计划没有研究问题可供分析（可在编辑计划时补充 questions）"
          : `研究问题 ${questions.length} 个：covered ${covered} · partial ${partial} · missing ${missing}；缺口 ${gaps.length} 项`,
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
    const promoted = (await this.candidates.list(projectId)).filter(
      (candidate) => candidate.status === "accepted" && candidate.promotedSourceId !== undefined,
    );
    return analyzeCoverage({
      planId: plan.planId,
      planStatus: plan.status,
      iterationNumber: plan.iterationNumber,
      analyzedAt: new Date().toISOString(),
      planQuestions: plan.questions,
      reportQuestions: artifact.report?.researchQuestions ?? [],
      queries: plan.queries.map((query) => mergeQueryFacts(query, history)),
      evidenceTexts: evidenceRecords.map((record) =>
        [record.claim, record.source?.title].filter((part) => part !== undefined && part !== "").join(" "),
      ),
      literatureTexts: promoted.map((candidate) =>
        [candidate.query, candidate.title].filter((part) => part !== undefined && part !== "").join(" "),
      ),
      literaturePlan: artifact.report?.literaturePlan ?? [],
    });
  }
}
