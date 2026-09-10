/**
 * Evidence / Quality Gate API。
 *
 *   GET  /api/projects/:id/evidence                → { evidence: EvidenceRecordView[] }
 *   GET  /api/projects/:id/evidence/:eid           → { evidence }（详情；列表已含全字段）
 *   POST /api/projects/:id/evidence/:eid/verify    → 人工确认核验（user_confirmed）
 *   GET  /api/projects/:id/quality-gate[?round=N]  → QualityGateResponseView
 *   POST /api/projects/:id/quality-gate            → 从最新 artifacts 重新确定性评估
 */

import { apiClient } from "./client.js";
import type { EvidenceRecordView, QualityGateResponseView, QualityGateResultView } from "../types/api.js";

export async function listEvidence(
  projectId: string,
  signal?: AbortSignal,
): Promise<EvidenceRecordView[]> {
  const body = await apiClient.get<{ evidence: EvidenceRecordView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/evidence`,
    signal,
  );
  return body.evidence ?? [];
}

export async function getEvidence(
  projectId: string,
  evidenceId: string,
  signal?: AbortSignal,
): Promise<EvidenceRecordView> {
  const body = await apiClient.get<{ evidence: EvidenceRecordView }>(
    `/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidenceId)}`,
    signal,
  );
  return body.evidence;
}

/**
 * 人工确认核验：把未核验证据标记为 verified（verificationLevel=user_confirmed）。
 * 这不是外部检索——PaperTeam 的证据核验动作是「用户确认已人工核对来源」，
 * 与 Citation 的学术库自动核验是两条链路（语义不混用）。
 */
export async function confirmEvidenceVerified(
  projectId: string,
  evidenceId: string,
): Promise<EvidenceRecordView> {
  const body = await apiClient.post<{ evidence: EvidenceRecordView }>(
    `/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidenceId)}/verify`,
    { verificationStatus: "verified", verificationLevel: "user_confirmed", verificationMethod: "user_confirmed" },
  );
  return body.evidence;
}

/** 按轮读取 gate 产物（缺省最新；尚无产物时 gate / reviewSummary / round 为 null） */
export async function getQualityGate(
  projectId: string,
  round?: number,
  signal?: AbortSignal,
): Promise<QualityGateResponseView> {
  const query = round !== undefined ? `?round=${round}` : "";
  return apiClient.get<QualityGateResponseView>(
    `/api/projects/${encodeURIComponent(projectId)}/quality-gate${query}`,
    signal,
  );
}

/** 从最新 review / citation / evidence artifacts 重新确定性评估并按 review 轮落盘 */
export async function reevaluateQualityGate(
  projectId: string,
): Promise<{ gate: QualityGateResultView; round: number }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/quality-gate`);
}
