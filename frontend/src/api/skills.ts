import { apiClient } from "./client.js";
import type {
  SkillProvenanceView,
  SkillUpdatePreview,
  SkillView,
  SkillsResponse,
} from "../types/paper.js";

/**
 * Skills API（approved catalog 只读 + 受控 install / update + 摘要重生成）。
 *
 *   GET  /api/skills                       → { skills, catalog, bindings, allowedContextScopes }
 *   GET  /api/skills/:id/provenance        → { provenance }
 *   GET  /api/skills/:id/update-preview    → { preview }
 *   POST /api/skills/:id/install           → { skill }（只接受 approved catalog 的 id）
 *   POST /api/skills/:id/update            → { skill }（body.candidateHash = 预览时看到的候选 hash）
 *   POST /api/skills/:id/summary           → 重新生成中文简介
 *
 * 没有任意 URL / 路径安装接口（M5.3 明确非目标）。
 */

export async function listSkills(signal?: AbortSignal): Promise<SkillsResponse> {
  const body = await apiClient.get<Partial<SkillsResponse>>("/api/skills", signal);
  return {
    skills: body.skills ?? [],
    catalog: body.catalog ?? [],
    bindings: body.bindings ?? [],
    allowedContextScopes: body.allowedContextScopes ?? [],
  };
}

export async function regenerateSkillSummary(id: string): Promise<SkillView> {
  const body = await apiClient.post<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}/summary`);
  return body.skill;
}

export async function getSkillProvenance(id: string, signal?: AbortSignal): Promise<SkillProvenanceView> {
  const body = await apiClient.get<{ provenance: SkillProvenanceView }>(
    `/api/skills/${encodeURIComponent(id)}/provenance`,
    signal,
  );
  return body.provenance;
}

export async function getSkillUpdatePreview(id: string, signal?: AbortSignal): Promise<SkillUpdatePreview> {
  const body = await apiClient.get<{ preview: SkillUpdatePreview }>(
    `/api/skills/${encodeURIComponent(id)}/update-preview`,
    signal,
  );
  return body.preview;
}

export async function applySkillUpdate(id: string, candidateHash: string): Promise<SkillView> {
  const body = await apiClient.post<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}/update`, {
    candidateHash,
  });
  return body.skill;
}

export async function installSkill(id: string): Promise<SkillView> {
  const body = await apiClient.post<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}/install`);
  return body.skill;
}
