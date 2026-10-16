/**
 * 学位论文「研究材料缺口」账本 API
 * （Backend /api/projects/:id/thesis/missing-materials*）。
 *
 * 缺口只有作者决定后才会影响写作；系统不会为缺失材料生成任何实验数值。
 */

import { apiClient } from "./client.js";

export type MissingMaterialGapType = "planned_chapter_material" | "proposed_scope_gap";

export type MissingMaterialGapStatus =
  | "proposed"
  | "confirmed_missing"
  | "supplied"
  | "resolved"
  | "deferred"
  | "rejected";

export type MissingMaterialDecision =
  | "confirm_missing"
  | "supply_experiment_data"
  | "supply_research_record"
  | "supply_manuscript"
  | "write_as_limitation"
  | "defer_chapter"
  | "reject";

export type MissingMaterialOrigin = "deterministic" | "storyline_scope_concern" | "model_proposal";

export type RequiredMaterialKind =
  | "experiment_data"
  | "research_record"
  | "manuscript"
  | "dataset_description"
  | "author_confirmation";

export interface MissingMaterialGap {
  gapId: string;
  gapType: MissingMaterialGapType;
  origin: MissingMaterialOrigin;
  chapterId?: string;
  chapterTitleZh?: string;
  contributionIds: string[];
  sourceInputIds: string[];
  title: string;
  description: string;
  whyInsufficient: string;
  supportingEvidence: string[];
  requiredMaterials: Array<{ kind: RequiredMaterialKind; description: string }>;
  canWriteWithoutMaterial: boolean;
  requiresExperiment: boolean;
  status: MissingMaterialGapStatus;
  decision?: MissingMaterialDecision;
  decisionRationale?: string;
  resolution?: string;
  stale?: { since: string; reason: string };
  createdAt: string;
  updatedAt: string;
}

export interface MissingMaterialLedger {
  schemaVersion: 1;
  projectId: string;
  gaps: MissingMaterialGap[];
  lastEvaluatedAt?: string;
  updatedAt: string;
}

export interface MissingMaterialDecisionResult {
  gap: MissingMaterialGap;
  decisionId: string;
}

export async function getMissingMaterialLedger(projectId: string): Promise<MissingMaterialLedger> {
  const body = await apiClient.get<{ ledger: MissingMaterialLedger }>(
    `/api/projects/${encodeURIComponent(projectId)}/thesis/missing-materials`,
  );
  return body.ledger;
}

export async function submitMissingMaterialDecision(
  projectId: string,
  gapId: string,
  decision: MissingMaterialDecision,
  rationale?: string,
): Promise<MissingMaterialDecisionResult> {
  return apiClient.post<MissingMaterialDecisionResult>(
    `/api/projects/${encodeURIComponent(projectId)}/thesis/missing-materials/${encodeURIComponent(gapId)}/decision`,
    {
      decision,
      ...(rationale !== undefined ? { rationale } : {}),
      actor: { kind: "user" },
    },
  );
}
