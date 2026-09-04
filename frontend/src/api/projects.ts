import { apiClient } from "./client.js";
import type { CreateProjectInput, ProjectView } from "../types/api.js";

/**
 * Project API（M4.2）。
 *
 *   GET    /api/projects        → { projects: ProjectView[] }（updatedAt 降序）
 *   GET    /api/projects/:id    → { project: ProjectView }
 *   POST   /api/projects        → 201 { project: ProjectView }
 */

export async function listProjects(signal?: AbortSignal): Promise<ProjectView[]> {
  const body = await apiClient.get<{ projects: ProjectView[] }>("/api/projects", signal);
  return body.projects ?? [];
}

export async function getProject(projectId: string, signal?: AbortSignal): Promise<ProjectView> {
  const body = await apiClient.get<{ project: ProjectView }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    signal,
  );
  return body.project;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectView> {
  const body = await apiClient.post<{ project: ProjectView }>("/api/projects", input);
  return body.project;
}
