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
  const body = await apiClient.get<{
    inputs: Array<{
      inputId: string;
      inputType: ResearchInputType;
      title: string;
      workId: string;
      version: { contentHash: string };
      versionLabel?: string;
      /** 后端为对象（M14.1b 契约）：{ status, updatedAt, decisionId? } */
      scope: { status: string; updatedAt: string; decisionId?: string };
      /** 后端为对象：{ status, parser?, notes, ... } */
      parse: { status: string };
      publicationStatus?: { value: string };
      unpublishedMaterialPolicy?: { allowed: boolean };
    }>;
    workGroups: ResearchInputsFileView["workGroups"];
    relations?: unknown[];
    alignments?: unknown[];
  }>(`/api/projects/${encodeURIComponent(projectId)}/research-inputs`);
  // M14.3：后端 ResearchInput 契约（scope/parse/publicationStatus 为对象）→ 面板
  // 视图（字符串徽章）。此前直接透传导致 React 渲染对象崩溃（浏览器 E2E 实锤）。
  return {
    inputs: body.inputs.map((input) => ({
      inputId: input.inputId,
      inputType: input.inputType,
      title: input.title,
      workId: input.workId,
      contentHash: input.version.contentHash,
      ...(input.versionLabel !== undefined ? { versionLabel: input.versionLabel } : {}),
      scope: input.scope.status,
      parseStatus: input.parse.status,
      ...(input.publicationStatus !== undefined ? { publicationStatus: input.publicationStatus.value } : {}),
      ...(input.unpublishedMaterialPolicy !== undefined
        ? { unpublishedMaterialAllowed: input.unpublishedMaterialPolicy.allowed }
        : {}),
    })),
    workGroups: body.workGroups,
  };
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
