/**
 * Research Plan 视图类型（M8.1；镜像 backend/src/agents/researchPlan.ts）。
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
  status: ResearchPlanStatus;
  questions: string[];
  queries: ResearchPlanQueryView[];
  createdAt: string;
  updatedAt: string;
}
