import { apiClient } from "./client.js";
import type { SkillBindingView, SkillView } from "../types/paper.js";

/**
 * Skills API（只读 + 摘要重生成）。
 *
 *   GET  /api/skills               → { skills, bindings }
 *   POST /api/skills/:id/summary   → 重新生成中文简介
 */

export async function listSkills(signal?: AbortSignal): Promise<{ skills: SkillView[]; bindings: SkillBindingView[] }> {
  return apiClient.get<{ skills: SkillView[]; bindings: SkillBindingView[] }>("/api/skills", signal);
}

export async function regenerateSkillSummary(id: string): Promise<SkillView> {
  const body = await apiClient.post<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(id)}/summary`);
  return body.skill;
}
