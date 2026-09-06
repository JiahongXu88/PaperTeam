import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  importProjectPdf,
  listProjects,
  renameProject,
  restoreProject,
} from "../api/projects.js";
import { getRuntimeStatus } from "../api/runtime.js";
import { createWorkflowRun, listProjectRuns } from "../api/runs.js";
import {
  extractCitations,
  getCitationIntegrity,
  getMetadataRecords,
  getPaper,
  getPaperReviewReport,
  listCitations,
  uploadPaperPdf,
  verifyClaims,
  verifyMetadata,
} from "../api/paper.js";
import { listSkills, regenerateSkillSummary } from "../api/skills.js";
import {
  clearModelApiKey,
  getModelOptions,
  getModelSettings,
  saveModelSettings,
  testModelConnection,
} from "../api/settings.js";
import type { CreateProjectInput, ImportProjectPdfInput, WorkflowKind } from "../types/api.js";

/**
 * Server State hooks（M4.1-M4.3）：projects / runs / runtime status / PDF /
 * citations / skills 全部经 TanStack Query（缓存、重试、失效）。
 * Zustand 只保存纯 UI 状态。
 */

export const queryKeys = {
  projects: ["projects"] as const,
  archivedProjects: ["projects", "archived"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projectRuns: (projectId: string) => ["projects", projectId, "runs"] as const,
  paperReview: (projectId: string) => ["projects", projectId, "paper-review"] as const,
  runtimeStatus: ["runtime-status"] as const,
  paper: (projectId: string) => ["projects", projectId, "paper"] as const,
  citations: (projectId: string) => ["projects", projectId, "citations"] as const,
  citationIntegrity: (projectId: string) => ["projects", projectId, "citations", "integrity"] as const,
  skills: ["skills"] as const,
  modelSettings: ["model-settings"] as const,
  modelOptions: ["model-settings", "options"] as const,
  modelOptionsFor: (provider: string) => ["model-settings", "options", provider] as const,
};

/** 项目列表（updatedAt 降序；默认未归档） */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => listProjects("active", signal),
  });
}

/** 已归档项目列表（设置 → 项目管理） */
export function useArchivedProjects() {
  return useQuery({
    queryKey: queryKeys.archivedProjects,
    queryFn: ({ signal }) => listProjects("archived", signal),
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

/** 项目最近 WorkflowRun 摘要（intervalMs：运行监控轮询，如 Review 进度） */
export function useProjectRuns(projectId: string | undefined, intervalMs?: number) {
  return useQuery({
    queryKey: queryKeys.projectRuns(projectId ?? ""),
    queryFn: ({ signal }) => listProjectRuns(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
    ...(intervalMs !== undefined ? { refetchInterval: intervalMs } : {}),
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

/** 已有论文 File-First 导入（后端建项目 + 解析 + 自动标题，失败回滚） */
export function useImportProjectPdf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportProjectPdfInput) => importProjectPdf(input),
    onSuccess: ({ project }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.setQueryData(queryKeys.project(project.id), project);
    },
  });
}

/** 重命名项目（PATCH title；成功后同步详情与列表缓存） */
export function useRenameProject(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => renameProject(projectId!, title),
    onSuccess: (project) => {
      void queryClient.setQueryData(queryKeys.project(projectId ?? ""), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/** 归档项目（运行中 → 409 PROJECT_BUSY，由调用方展示错误信息） */
export function useArchiveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSuccess: (project) => {
      void queryClient.setQueryData(queryKeys.project(project.id), project);
      // projects 前缀失效会同时刷新默认列表、最近项目与已归档列表
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/** 恢复已归档项目 */
export function useRestoreProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => restoreProject(projectId),
    onSuccess: (project) => {
      void queryClient.setQueryData(queryKeys.project(project.id), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/** 永久删除（仅已归档项目；成功后清理该项目全部缓存） */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: (_result, projectId) => {
      void queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/** 启动 WorkflowRun（快速 Review 用 existing_paper_review） */
export function useCreateWorkflowRun(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: WorkflowKind) => createWorkflowRun(projectId!, kind),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(projectId ?? "") });
    },
  });
}

/** 最新快速 Review 聚合报告（无报告为 null） */
export function usePaperReviewReport(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.paperReview(projectId ?? ""),
    queryFn: ({ signal }) => getPaperReviewReport(projectId!, signal),
    enabled: projectId !== undefined && projectId !== "",
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

/** 上传 Final PDF（成功后失效 paper / citations / review 缓存） */
export function useUploadPaperPdf(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileName: string; contentBase64: string }) =>
      uploadPaperPdf(projectId!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.paper(projectId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.citations(projectId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(projectId ?? "") });
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

// ---- M4.3.7.5 Model Settings ----

/** 配置失效：model settings + 权威 runtime status（顶栏徽标随之刷新） */
function invalidateModelState(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.modelSettings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus });
}

/** Model Settings 状态（无 key 本体） */
export function useModelSettings() {
  return useQuery({
    queryKey: queryKeys.modelSettings,
    queryFn: ({ signal }) => getModelSettings(signal),
  });
}

/** 模型目录：无参 = provider 列表；provider = 该 provider 的模型列表 */
export function useModelOptions(provider?: string) {
  return useQuery({
    queryKey: provider === undefined ? queryKeys.modelOptions : queryKeys.modelOptionsFor(provider),
    queryFn: ({ signal }) => getModelOptions(provider, signal),
  });
}

/** 保存模型偏好（可选携带新 Key；成功后失效 model settings + runtime status） */
export function useSaveModelSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; apiKey?: string }) => saveModelSettings(input),
    onSuccess: () => invalidateModelState(queryClient),
  });
}

/** 清除本地保存的 API Key */
export function useClearModelApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearModelApiKey(),
    onSuccess: () => invalidateModelState(queryClient),
  });
}

/** Test Connection（携带当前填写但未保存的 model/key；不改缓存状态） */
export function useTestModelConnection() {
  return useMutation({
    mutationFn: (input: { model: string; apiKey?: string }) => testModelConnection(input),
  });
}
