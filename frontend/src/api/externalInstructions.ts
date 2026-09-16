import { apiClient } from "./client.js";
import type {
  ExternalInstructionSource,
  ExternalInstructionView,
  ExternalInstructionsResponse,
  RevisionPlanView,
} from "../types/api.js";

/**
 * External Instructions / Revision Plan API（M5.7）。
 *
 *   GET    /api/projects/:id/external-instructions          → { instructions, sectionOptions }
 *   POST   /api/projects/:id/external-instructions          → { instruction, instructions }
 *   DELETE /api/projects/:id/external-instructions/:iid     → { instructions }
 *   GET    /api/projects/:id/revision-plan[?round=N]        → { round, plan }
 *
 * 外部意见是用户手工输入的期刊专家 / 编辑 / 导师 / 本人要求；原文逐字保存，
 * 作为最高业务修改优先级进入修订计划——但不绕过任何确定性质量 Gate。
 */

export async function listExternalInstructions(
  projectId: string,
  signal?: AbortSignal,
): Promise<ExternalInstructionsResponse> {
  return apiClient.get<ExternalInstructionsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/external-instructions`,
    signal,
  );
}

export async function addExternalInstruction(
  projectId: string,
  input: {
    source: ExternalInstructionSource;
    text: string;
    reviewerLabel?: string;
    section?: string;
  },
): Promise<ExternalInstructionView> {
  const body = await apiClient.post<{ instruction: ExternalInstructionView }>(
    `/api/projects/${encodeURIComponent(projectId)}/external-instructions`,
    input,
  );
  return body.instruction;
}

export async function deleteExternalInstruction(
  projectId: string,
  instructionId: string,
): Promise<ExternalInstructionView[]> {
  const body = await apiClient.delete<{ instructions: ExternalInstructionView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/external-instructions/${encodeURIComponent(instructionId)}`,
  );
  return body.instructions;
}

export async function getRevisionPlan(
  projectId: string,
  round?: number,
  signal?: AbortSignal,
): Promise<{ round: number | null; plan: RevisionPlanView | null }> {
  const path =
    round !== undefined
      ? `/api/projects/${encodeURIComponent(projectId)}/revision-plan?round=${round}`
      : `/api/projects/${encodeURIComponent(projectId)}/revision-plan`;
  return apiClient.get<{ round: number | null; plan: RevisionPlanView | null }>(path, signal);
}
