/**
 * Research Plan API（M8.1；Backend research artifact plan 字段的读写。
 * M8.2 增加批准 / 执行。M8.3.1 增加迭代：列出计划链 / 从 done 计划派生
 * 下一轮 / 切换活动计划。M8.3.2 增加覆盖分析。M8.3.3 增加研究缺口 HITL：
 * 缺口清单 / 接受 / 拒绝 / 从缺口派生下一轮）。
 *
 *   GET   /api/projects/:id/research/plan                  → { plan: ResearchPlanView | null }
 *   PUT   /api/projects/:id/research/plan                  → { questions?, queries? }
 *         → { plan: ResearchPlanView }
 *   POST  /api/projects/:id/research/plan/approve          → { plan }（draft → approved）
 *   POST  /api/projects/:id/research/plan/execute          → PlanExecutionResultView
 *   GET   /api/projects/:id/research/plans                 → ResearchPlanListView
 *   GET   /api/projects/:id/research/execution-history     → { executionHistory }（M8.5 审计）
 *   POST  /api/projects/:id/research/execution-results/save-candidates
 *         → { saved, mergedExisting }（M9.1 快照显式保存为候选，HITL）
 *   POST  /api/projects/:id/research/plan/:planId/derive   → { plan }（done → 新 draft，自动激活）
 *   POST  /api/projects/:id/research/plan/:planId/activate → { plan }（切换活动计划）
 *   GET   /api/projects/:id/research/coverage              → { coverage: ResearchCoverageView | null }
 *   POST  /api/projects/:id/research/coverage/analyze      → { coverage }（无计划 → 404）
 *   GET   /api/projects/:id/research/gaps                  → { planId, gaps }（M8.3.3 缺口清单）
 *   POST  /api/projects/:id/research/gaps/:gapId/accept    → { gap }（proposed → accepted）
 *   POST  /api/projects/:id/research/gaps/:gapId/reject    → { gap }（proposed → rejected）
 *   POST  /api/projects/:id/research/gaps/:gapId/derive    → { plan }（accepted → 新 draft）
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
  ExecutionSaveResultView,
  PlanExecutionEntryView,
  PlanExecutionResultView,
  ResearchCoverageView,
  ResearchGapListView,
  ResearchGapView,
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

/** ---- Search Audit（M8.5：executionHistory 只读审计视图）---- */

/**
 * 计划执行历史（每条 query 的执行时间 / provider 参与 / 结果数 / 失败原因 /
 * 结果标识符投影 / 结果快照）。只是审计痕迹：Search Result ≠ Candidate 不变，
 * 标识符与快照都不代表已保存候选。无 artifact → 空数组（空态而非错误）。
 */
export async function listExecutionHistory(
  projectId: string,
  signal?: AbortSignal,
): Promise<PlanExecutionEntryView[]> {
  const body = await apiClient.get<{ executionHistory: PlanExecutionEntryView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/execution-history`,
    signal,
  );
  return body.executionHistory ?? [];
}

/**
 * 把执行结果快照中选中的条目显式保存为候选（M9.1 Search Result → Candidate
 * 的 HITL 衔接：executionId + queryId 定位 executionHistory 条目，
 * saveAsCandidates 是快照下标）。快照永不自动成为候选；旧条目（M8.5 及
 * 更早，无快照）→ 409 EXECUTION_RESULTS_UNAVAILABLE。
 */
export async function saveExecutionResultsAsCandidates(
  projectId: string,
  input: { executionId: string; queryId: string; saveAsCandidates: number[] },
): Promise<ExecutionSaveResultView> {
  return apiClient.post<ExecutionSaveResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/execution-results/save-candidates`,
    input,
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

/** ---- Coverage（M8.3.2：只读派生视图——分析不写任何状态）---- */

/**
 * 当前活动计划的覆盖（即时重算；无 artifact / 无计划 → null 空态）。
 * 覆盖判定是确定性规则（missing / partial / covered），不依赖 LLM。
 */
export async function getResearchCoverage(
  projectId: string,
  signal?: AbortSignal,
): Promise<ResearchCoverageView | null> {
  const body = await apiClient.get<{ coverage: ResearchCoverageView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/coverage`,
    signal,
  );
  return body.coverage ?? null;
}

/** 执行覆盖分析（同一确定性规则；无 artifact / 无计划 → 404） */
export async function analyzeResearchCoverage(
  projectId: string,
): Promise<ResearchCoverageView> {
  const body = await apiClient.post<{ coverage: ResearchCoverageView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/coverage/analyze`,
    {},
  );
  return body.coverage;
}

/** ---- Research Gap HITL（M8.3.3：Coverage → Gap → Human Approval → 下一轮计划）---- */

/**
 * 当前活动计划的缺口清单（覆盖派生 proposed + 落盘决策覆盖）。
 * 无 artifact / 无计划 → { planId: null, gaps: [] }（空态而非错误）。
 */
export async function listResearchGaps(
  projectId: string,
  signal?: AbortSignal,
): Promise<ResearchGapListView> {
  return apiClient.get<ResearchGapListView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/gaps`,
    signal,
  );
}

/**
 * 接受缺口（proposed → accepted，显式 HITL 动作）：幂等；已拒绝 → 409
 * GAP_INVALID_STATE（决策不翻转）。只有 accepted 缺口可派生下一轮计划。
 */
export async function acceptResearchGap(
  projectId: string,
  gapId: string,
): Promise<ResearchGapView> {
  const body = await apiClient.post<{ gap: ResearchGapView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/gaps/${encodeURIComponent(gapId)}/accept`,
    {},
  );
  return body.gap;
}

/** 拒绝缺口（proposed → rejected，幂等；已接受 → 409） */
export async function rejectResearchGap(
  projectId: string,
  gapId: string,
): Promise<ResearchGapView> {
  const body = await apiClient.post<{ gap: ResearchGapView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/gaps/${encodeURIComponent(gapId)}/reject`,
    {},
  );
  return body.gap;
}

/**
 * 从已接受（accepted）的缺口派生下一轮计划：复用 M8.3.1 计划派生 API
 * （不新增第二套 Plan 创建逻辑）——questions 缺省 = 缺口关联问题，
 * queries 缺省 = suggestedQueries（kind=academic），input 提供则覆盖；
 * 新计划 draft、iterationNumber+1、parentPlanId=来源、自动成为活动计划；
 * 旧计划保持不变。proposed / rejected 缺口 → 409；来源计划非 done → 409。
 */
export async function deriveResearchGap(
  projectId: string,
  gapId: string,
  input: ResearchPlanDeriveInput = {},
): Promise<ResearchPlanView> {
  const body = await apiClient.post<{ plan: ResearchPlanView }>(
    `/api/projects/${encodeURIComponent(projectId)}/research/gaps/${encodeURIComponent(gapId)}/derive`,
    input,
  );
  return body.plan;
}
