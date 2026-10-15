/**
 * M14.2：研究输入面板 API（Backend /api/projects/:id/research-inputs/*）。
 */

import { apiClient } from "./client.js";
import type {
  ResearchConflictView,
  ResearchDecisionResult,
  ResearchInputFactView,
  ResearchInputsFileView,
  ResearchInputType,
} from "../types/researchInputs.js";

export async function listResearchInputs(projectId: string): Promise<ResearchInputsFileView> {
  return apiClient.get<ResearchInputsFileView>(`/api/projects/${encodeURIComponent(projectId)}/research-inputs`);
}

export async function registerResearchInput(
  projectId: string,
  input: { sourceId: string; inputType: ResearchInputType; title?: string; ensureParsed?: boolean },
): Promise<{ created: boolean; inputId: string }> {
  const body = await apiClient.post<{ created: boolean; input: { inputId: string } }>(
    `/api/projects/${encodeURIComponent(projectId)}/research-inputs`,
    input,
  );
  return { created: body.created, inputId: body.input.inputId };
}

export async function listResearchInputFacts(
  projectId: string,
  query: { inputId?: string; conflictStatus?: string } = {},
): Promise<ResearchInputFactView[]> {
  const params = new URLSearchParams();
  if (query.inputId !== undefined) params.set("inputId", query.inputId);
  if (query.conflictStatus !== undefined) params.set("conflictStatus", query.conflictStatus);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const body = await apiClient.get<{ facts: ResearchInputFactView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/research-inputs/facts${suffix}`,
  );
  return body.facts;
}

export async function listResearchConflicts(projectId: string, status?: string): Promise<ResearchConflictView[]> {
  const suffix = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
  const body = await apiClient.get<{ conflicts: ResearchConflictView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/research-inputs/conflicts${suffix}`,
  );
  return body.conflicts;
}

export async function submitResearchDecision(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<ResearchDecisionResult> {
  return apiClient.post<ResearchDecisionResult>(
    `/api/projects/${encodeURIComponent(projectId)}/research-inputs/decisions`,
    { payload },
  );
}

export async function extractResearchInputFacts(projectId: string, inputId: string): Promise<void> {
  await apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/research-inputs/${encodeURIComponent(inputId)}/extract`,
    {},
  );
}
