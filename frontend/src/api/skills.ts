/**
 * Skills API（M4.3.7，只读 + 摘要重生成）。
 *
 *   GET  /api/skills           → { skills, bindings }
 *   GET  /api/skills/:id       → { skill }
 *   POST /api/skills/:id/summary → 重新生成中文简介
 */

import { apiClient } from "./client.js";
import type { SkillBindingView, SkillView } from "../types/paper.js";

export async function listSkills(
  signal?: AbortSignal,
): Promise<{ skills: SkillView[]; bindings: SkillBindingView[] }> {
  return apiClient.get<{ skills: SkillView[]; bindings: SkillBindingView[] }>("/api/skills", signal);
}

export async function getSkill(id: string, signal?: AbortSignal): Promise<SkillView> {
  const body = await apiClient.get<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}`, signal);
  return body.skill;
}

export async function regenerateSkillSummary(id: string): Promise<SkillView> {
  const body = await apiClient.post<{ skill: SkillView }>(
    `/api/skills/${encodeURIComponent(id)}/summary`,
  );
  return body.skill;
}
