/**
 * Research Plan 视图类型（M8.1；M8.3.1 增加 iteration 字段与计划链视图。
 * 镜像 backend/src/agents/researchPlan.ts）。
 */

export type ResearchPlanStatus = "draft" | "approved" | "executing" | "done";
export type ResearchQueryKind = "academic" | "web";
export type ResearchQueryStatus = "planned" | "executed" | "skipped";

export interface ResearchPlanQueryView {
  queryId: string;
  query: string;
  kind: ResearchQueryKind;
  /** 为什么需要这条检索（计划理由） */
  rationale?: string;
  /** 期望覆盖的文献 / 信息面 */
  expectedCoverage?: string;
  status: ResearchQueryStatus;
  /** 执行后的结果数（执行侧回填；编辑面不产生该字段） */
  resultCount?: number;
}

export interface ResearchPlanView {
  planId: string;
  /** 迭代线索 id（M8.3.1；同一条派生链共享，旧计划可能缺失 → 可选） */
  iterationId?: string;
  /** 派生来源 planId（M8.3.1；首轮计划无此字段） */
  parentPlanId?: string;
  /** 迭代号（M8.3.1；旧计划可能缺失 → 可选） */
  iterationNumber?: number;
  status: ResearchPlanStatus;
  questions: string[];
  queries: ResearchPlanQueryView[];
  createdAt: string;
  updatedAt: string;
}

/** 计划链视图（M8.3.1 GET /research/plans 的响应）：全部迭代 + 当前活动计划 */
export interface ResearchPlanListView {
  plans: ResearchPlanView[];
  /** null = 还没有计划（空态而非错误） */
  activePlanId: string | null;
}

/**
 * 计划执行结果（M8.2 POST /research/plan/execute 的响应视图）。
 * executed/failed 只计本轮 planned query；执行不产生候选 / 文献 / Evidence。
 */
export interface PlanExecutionResultView {
  executionId: string;
  /** plan 内 query 总数（含既有 executed / skipped） */
  totalQueries: number;
  /** 本轮执行成功数 */
  executedQueries: number;
  /** 本轮执行失败数（逐条已记录，不中断整轮） */
  failedQueries: number;
  plan: ResearchPlanView;
}

/** ---- Search Audit（M8.5 镜像 backend PlanExecutionEntry）---- */

/** 参与该次检索的 provider 摘要（diagnostics 最小投影） */
export interface PlanExecutionProviderAttemptView {
  provider: string;
  outcome: string;
  resultCount: number;
  latencyMs?: number;
  note?: string;
}

/**
 * 单条 query 的执行审计记录（executionHistory 条目）。
 * resultIdentifiers 是结果标识符投影（doi:… / arxiv:… / url / title:…）——
 * 只是「这次搜到了什么」的痕迹，不是候选、不是文献。
 * resultSnapshot（M9.1）是有界 SearchResult 快照（Top-N 最小 projection）——
 * 同为审计痕迹；用户显式勾选保存后才经 save-candidates 端点进入候选（HITL）。
 */
export interface PlanExecutionEntryView {
  executionId: string;
  queryId: string;
  query: string;
  kind: ResearchQueryKind;
  timestamp: string;
  status: "executed" | "failed";
  planId?: string;
  resultCount?: number;
  error?: string;
  providers?: PlanExecutionProviderAttemptView[];
  resultIdentifiers?: string[];
  resultSnapshot?: PlanExecutionResultSnapshotView[];
}

/** ---- Execution Result Snapshot（M9.1 镜像 backend researchPlanExecution.ts）---- */

/** 学术检索结果快照（identity 完整；abstract 只留截断预览） */
export interface PlanExecutionAcademicResultSnapshotView {
  kind: "academic";
  provider: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  snippetPreview?: string;
  citationCount?: number;
  score?: number;
}

/** Web 检索结果快照（canonical URL 即身份键） */
export interface PlanExecutionWebResultSnapshotView {
  kind: "web";
  provider: string;
  url: string;
  title: string;
  snippetPreview?: string;
  score?: number;
  /** 命中引擎（M9.2 optional audit） */
  engines?: string[];
  /** 发布日期（M9.2 optional audit；引擎提供时才有） */
  publishedDate?: string;
}

export type PlanExecutionResultSnapshotView =
  | PlanExecutionAcademicResultSnapshotView
  | PlanExecutionWebResultSnapshotView;

/** save-candidates 响应（与 Discovery 检索面板的 saved 同形状） */
export interface ExecutionSaveResultView {
  saved: Array<{ candidateId: string; title?: string }>;
  mergedExisting: number[];
}

/** ---- Coverage（M8.3.2 镜像 backend/src/agents/researchCoverage.ts）---- */

export type ResearchCoverageLevel = "covered" | "partial" | "missing";

/** 单个研究问题的覆盖判定（结构化状态，非评分） */
export interface ResearchCoverageQuestionView {
  question: string;
  /** 问题来源：plan（活动计划检索意图）| report（调研报告结论问题） */
  origin: "plan" | "report";
  coverage: ResearchCoverageLevel;
  relatedQueryCount: number;
  executedQueryCount: number;
  /** 关联检索带回的 Search Result 总数（≠候选≠文献≠证据） */
  resultCount: number;
  evidenceCount: number;
  promotedCount: number;
  /** 非 covered 时的缺口描述 */
  gap?: string;
}

/** ---- Research Gap（M8.3.3 镜像 backend/src/agents/researchGap.ts）---- */

export type ResearchGapSeverity = "low" | "medium" | "high";
export type ResearchGapStatus = "proposed" | "accepted" | "rejected";

/**
 * 研究缺口：Coverage Analyzer 输出的显式研究对象（M8.3.2 缺口建议的增量
 * 升级——带稳定 gapId / severity / status）。分析器只产生 proposed；
 * accepted / rejected 是用户 HITL 决策快照（落盘）。
 */
export interface ResearchGapView {
  gapId: string;
  planId: string;
  /** 关联的研究问题（残差方向缺口无关联问题，字段省略） */
  question?: string;
  description: string;
  severity: ResearchGapSeverity;
  suggestedQueries: string[];
  status: ResearchGapStatus;
  createdAt: string;
  decidedAt?: string;
}

/** GET /research/gaps 的响应：当前活动计划缺口（派生 + 决策覆盖） */
export interface ResearchGapListView {
  /** null = 无 artifact / 无计划（空态而非错误） */
  planId: string | null;
  gaps: ResearchGapView[];
}

/** 覆盖报告（只读派生视图：随源数据即时重算，不落盘；gaps 为 M8.3.3 ResearchGap[]） */
export interface ResearchCoverageView {
  planId: string;
  planStatus: ResearchPlanStatus;
  iterationNumber?: number;
  analyzedAt: string;
  questions: ResearchCoverageQuestionView[];
  overall: {
    questionCount: number;
    covered: number;
    partial: number;
    missing: number;
    summary: string;
  };
  gaps: ResearchGapView[];
}
