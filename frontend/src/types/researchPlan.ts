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
