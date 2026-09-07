import { apiClient } from "./client.js";
import type {
  CreateProjectInput,
  ImportProjectPdfInput,
  ImportProjectPdfResult,
  ProjectView,
} from "../types/api.js";

/**
 * Project API。
 *
 *   GET    /api/projects                    → { projects }（默认未归档；?scope=archived|all）
 *   GET    /api/projects/:id                → { project }
 *   POST   /api/projects                    → 201 { project }
 *   POST   /api/projects/import-pdf         → 201 { project, titleSource }（File First 导入）
 *   PATCH  /api/projects/:id                → { project }（重命名 / 研究定位）
 *   POST   /api/projects/:id/archive        → { project }（运行中 409 PROJECT_BUSY）
 *   POST   /api/projects/:id/restore        → { project }
 *   DELETE /api/projects/:id                → { status }（仅已归档；否则 409）
 */

export async function listProjects(
  scope: "active" | "archived" | "all" = "active",
  signal?: AbortSignal,
): Promise<ProjectView[]> {
  const body = await apiClient.get<{ projects: ProjectView[] }>(
    `/api/projects?scope=${scope}`,
    signal,
  );
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

/** 已有论文 File-First 导入：一次调用建项目 + 解析 + 自动标题（后端失败回滚） */
export async function importProjectPdf(input: ImportProjectPdfInput): Promise<ImportProjectPdfResult> {
  return apiClient.post<ImportProjectPdfResult>("/api/projects/import-pdf", input);
}

/** 重命名（PDF metadata 可能识别错误，标题必须可后改） */
export async function renameProject(projectId: string, title: string): Promise<ProjectView> {
  const body = await apiClient.patch<{ project: ProjectView }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { title },
  );
  return body.project;
}

export async function archiveProject(projectId: string): Promise<ProjectView> {
  const body = await apiClient.post<{ project: ProjectView }>(
    `/api/projects/${encodeURIComponent(projectId)}/archive`,
  );
  return body.project;
}

export async function restoreProject(projectId: string): Promise<ProjectView> {
  const body = await apiClient.post<{ project: ProjectView }>(
    `/api/projects/${encodeURIComponent(projectId)}/restore`,
  );
  return body.project;
}

/** 永久删除（仅已归档项目；删除整个工作区，不可恢复） */
export async function deleteProject(projectId: string): Promise<void> {
  await apiClient.delete(`/api/projects/${encodeURIComponent(projectId)}`);
}
