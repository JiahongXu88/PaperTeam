/**
 * Research Plan API（M8.1；Backend research artifact plan 字段的读写。
 * M8.2 增加批准 / 执行）。
 *
 *   GET   /api/projects/:id/research/plan          → { plan: ResearchPlanView | null }
 *   PUT   /api/projects/:id/research/plan          → { questions?, queries? }
 *         → { plan: ResearchPlanView }
 *   POST  /api/projects/:id/research/plan/approve  → { plan }（draft → approved）
 *   POST  /api/projects/:id/research/plan/execute  → PlanExecutionResultView
 *
 * 语义：plan 是 Researcher 调研产出（research/research.json 的 plan 字段）的
 * 一等视图——只读展示 + 受限编辑（questions / query / rationale / query
 * status；resultCount 与 plan 状态由执行侧维护，编辑面不接受）。
 * 执行只回填 query 状态与 resultCount：Search Result ≠ Candidate ≠
 * Literature ≠ Verified Evidence 链路不变（保存候选仍由用户显式驱动）。
 */

import { apiClient } from "./client.js";
import type {
  PlanExecutionResultView,
  ResearchPlanView,
  ResearchQueryKind,
  ResearchQueryStatus,
} from "../types/researchPlan.js";

/** PUT 请求体中的单条检索（queryId 缺省 = 新增条目） */
export interface ResearchPlanQueryInput {
  queryId?: string;
  query: string;
  kind: ResearchQueryKind;
  rationale?: string;
  expectedCoverage?: string;
  status?: ResearchQueryStatus;
}

export interface ResearchPlanUpdateInput {
  questions?: string[];
  queries?: ResearchPlanQueryInput[];
}

export async function getResearchPlan(
  projectId: string,
  signal?: AbortSignal,
): Promise<ResearchPlanView | null> {
  const body = await apiClient.get<{ plan: ResearchPlanView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan`,
    signal,
  );
  return body.plan ?? null;
}

export async function updateResearchPlan(
  projectId: string,
  input: ResearchPlanUpdateInput,
): Promise<ResearchPlanView> {
  const body = await apiClient.put<{ plan: ResearchPlanView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan`,
    input,
  );
  return body.plan;
}

/** 批准计划（draft → approved；显式 HITL 动作，非 draft → 409） */
export async function approveResearchPlan(projectId: string): Promise<ResearchPlanView> {
  const body = await apiClient.post<{ plan: ResearchPlanView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan/approve`,
    {},
  );
  return body.plan;
}

/**
 * 执行 approved 计划（planned query 逐一检索并回填 status / resultCount；
 * 状态不允许 → 409）。执行不写候选 / 文献 / Evidence。
 */
export async function executeResearchPlan(
  projectId: string,
): Promise<PlanExecutionResultView> {
  return apiClient.post<PlanExecutionResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan/execute`,
    {},
  );
}
