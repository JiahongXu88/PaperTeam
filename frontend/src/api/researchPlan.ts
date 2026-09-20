/**
 * Research Plan API（M8.1；Backend research artifact plan 字段的读写。
 * M8.2 增加批准 / 执行。M8.3.1 增加迭代：列出计划链 / 从 done 计划派生
 * 下一轮 / 切换活动计划）。
 *
 *   GET   /api/projects/:id/research/plan                  → { plan: ResearchPlanView | null }
 *   PUT   /api/projects/:id/research/plan                  → { questions?, queries? }
 *         → { plan: ResearchPlanView }
 *   POST  /api/projects/:id/research/plan/approve          → { plan }（draft → approved）
 *   POST  /api/projects/:id/research/plan/execute          → PlanExecutionResultView
 *   GET   /api/projects/:id/research/plans                 → ResearchPlanListView
 *   POST  /api/projects/:id/research/plan/:planId/derive   → { plan }（done → 新 draft，自动激活）
 *   POST  /api/projects/:id/research/plan/:planId/activate → { plan }（切换活动计划）
 *
 * 语义：plan 是 Researcher 调研产出（research artifact 的计划链）的一等
 * 视图——只读展示 + 受限编辑（questions / query / rationale / query
 * status；resultCount 与 plan 状态由执行侧维护，编辑面不接受）。
 * 编辑 / 批准 / 执行始终作用于**活动计划**；迭代（derive / activate）只
 * 搬移计划数据。执行只回填 query 状态与 resultCount：Search Result ≠
 * Candidate ≠ Literature ≠ Verified Evidence 链路不变（保存候选仍由用户显式驱动）。
 */

import { apiClient } from "./client.js";
import type {
  PlanExecutionResultView,
  ResearchPlanListView,
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

/** ---- Iteration（M8.3.1）---- */

/** derive 请求体中的单条检索（新计划全部从 planned 起步：不接受 queryId / status） */
export interface ResearchPlanDeriveQueryInput {
  query: string;
  kind: ResearchQueryKind;
  rationale?: string;
  expectedCoverage?: string;
}

export interface ResearchPlanDeriveInput {
  questions?: string[];
  queries?: ResearchPlanDeriveQueryInput[];
}

/** 列出全部迭代轮次（计划链 plans + activePlanId；无计划 → 空数组空态） */
export async function listResearchPlans(
  projectId: string,
  signal?: AbortSignal,
): Promise<ResearchPlanListView> {
  return apiClient.get<ResearchPlanListView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plans`,
    signal,
  );
}

/**
 * 从已完成（done）的计划派生下一轮：新计划 draft、自动成为活动计划；
 * questions / queries 缺省整拷来源，提供则覆盖（知识缺口 → 调整研究方向）。
 * 旧计划保持 done 原样不动。
 */
export async function deriveResearchPlan(
  projectId: string,
  planId: string,
  input: ResearchPlanDeriveInput = {},
): Promise<ResearchPlanView> {
  const body = await apiClient.post<{ plan: ResearchPlanView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan/${encodeURIComponent(planId)}/derive`,
    input,
  );
  return body.plan;
}

/** 切换当前活动计划（编辑 / 批准 / 执行都作用于活动计划；幂等） */
export async function activateResearchPlan(
  projectId: string,
  planId: string,
): Promise<ResearchPlanView> {
  const body = await apiClient.post<{ plan: ResearchPlanView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/plan/${encodeURIComponent(planId)}/activate`,
    {},
  );
  return body.plan;
}
