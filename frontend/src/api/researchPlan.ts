/**
 * Research Plan API（M8.1；Backend research artifact plan 字段的读写）。
 *
 *   GET  /api/projects/:id/research/plan   → { plan: ResearchPlanView | null }
 *   PUT  /api/projects/:id/research/plan   → { questions?, queries? }
 *        → { plan: ResearchPlanView }
 *
 * 语义：plan 是 Researcher 调研产出（research/research.json 的 plan 字段）的
 * 一等视图——只读展示 + 受限编辑（questions / query / rationale / query
 * status；resultCount 与 plan 状态由执行侧维护，编辑面不接受）。
 * plan ≠ 检索结果 ≠ 候选：它只是检索意图的声明。
 */

import { apiClient } from "./client.js";
import type {
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
