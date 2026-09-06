import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createProject, getProject, listProjects } from "../api/projects.js";
import { getRuntimeStatus } from "../api/runtime.js";
import { listProjectRuns } from "../api/runs.js";
import {
  extractCitations,
  getCitationIntegrity,
  getMetadataRecords,
  getPaper,
  listCitations,
  uploadPaperPdf,
  verifyClaims,
  verifyMetadata,
} from "../api/paper.js";
import { listSkills, regenerateSkillSummary } from "../api/skills.js";
import type { CreateProjectInput } from "../types/api.js";

/**
 * Server State hooks（M4.1-M4.3）：projects / runs / runtime status / PDF /
 * citations / skills 全部经 TanStack Query（缓存、重试、失效）。
 * Zustand 只保存纯 UI 状态。
 */

export const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projectRuns: (projectId: string) => ["projects", projectId, "runs"] as const,
  runtimeStatus: ["runtime-status"] as const,
  paper: (projectId: string) => ["projects", projectId, "paper"] as const,
  citations: (projectId: string) => ["projects", projectId, "citations"] as const,
  citationIntegrity: (projectId: string) => ["projects", projectId, "citations", "integrity"] as const,
  skills: ["skills"] as const,
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

// ---- M4.3 PDF / Citations / Skills ----

/** Final PDF 解析状态（含 sections 与 stages） */
export function usePaper(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.paper(projectId ?? ""),
    queryFn: ({ signal }) => getPaper(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

/** 上传 Final PDF（成功后失效 paper / citations 缓存） */
export function useUploadPaperPdf(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileName: string; contentBase64: string }) =>
      uploadPaperPdf(projectId!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.paper(projectId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.citations(projectId ?? "") });
    },
  });
}

/** 引用提取摘要 + reference 列表 */
export function useCitations(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.citations(projectId ?? ""),
    queryFn: ({ signal }) => listCitations(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

/** Citation Integrity 汇总报告（metadata + semantic + gate） */
export function useCitationIntegrity(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.citationIntegrity(projectId ?? ""),
    queryFn: ({ signal }) => getCitationIntegrity(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

/** 逐条 metadata 核验记录（Reference 表 status 列） */
export function useMetadataRecords(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId ?? "", "citations", "metadata"] as const,
    queryFn: ({ signal }) => getMetadataRecords(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
  });
}

function useCitationStageMutation(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.citations(projectId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.citationIntegrity(projectId ?? "") });
    },
  };
}

/** 引用提取（确定性） */
export function useExtractCitations(projectId: string | undefined) {
  const invalidation = useCitationStageMutation(projectId);
  return useMutation({
    mutationFn: () => extractCitations(projectId!),
    onSuccess: invalidation.onSuccess,
  });
}

/** metadata 核验（真实外部学术库） */
export function useVerifyMetadata(projectId: string | undefined) {
  const invalidation = useCitationStageMutation(projectId);
  return useMutation({
    mutationFn: () => verifyMetadata(projectId!),
    onSuccess: invalidation.onSuccess,
  });
}

/** (claim, citation) 语义核验 */
export function useVerifyClaims(projectId: string | undefined) {
  const invalidation = useCitationStageMutation(projectId);
  return useMutation({
    mutationFn: () => verifyClaims(projectId!, { limit: 30 }),
    onSuccess: invalidation.onSuccess,
  });
}

/** Skill 列表（全局，只读） */
export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: ({ signal }) => listSkills(signal),
  });
}

/** 重新生成单个 skill 的中文简介 */
export function useRegenerateSkillSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => regenerateSkillSummary(skillId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}
