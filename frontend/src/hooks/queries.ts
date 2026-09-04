import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createProject, getProject, listProjects } from "../api/projects.js";
import { getRuntimeStatus } from "../api/runtime.js";
import { listProjectRuns } from "../api/runs.js";
import type { CreateProjectInput } from "../types/api.js";

/**
 * Server State hooks（M4.1/M4.2）：projects / project detail / runs /
 * runtime status 全部经 TanStack Query（缓存、重试、失效）。
 */

export const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projectRuns: (projectId: string) => ["projects", projectId, "runs"] as const,
  runtimeStatus: ["runtime-status"] as const,
};

/** 项目列表（updatedAt 降序） */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => listProjects(signal),
  });
}

/** 项目详情；404 时 error 为 ApiError(isNotFound) */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? ""),
    queryFn: ({ signal }) => getProject(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

/** 项目最近 WorkflowRun 摘要 */
export function useProjectRuns(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projectRuns(projectId ?? ""),
    queryFn: ({ signal }) => listProjectRuns(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

/** 创建项目（成功后失效列表缓存） */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.setQueryData(queryKeys.project(project.id), project);
    },
  });
}

/** Runtime Status（Pi schema；30s 轮询 + 窗口聚焦刷新） */
export function useRuntimeStatus() {
  return useQuery({
    queryKey: queryKeys.runtimeStatus,
    queryFn: ({ signal }) => getRuntimeStatus(signal),
    refetchInterval: 30_000,
  });
}
