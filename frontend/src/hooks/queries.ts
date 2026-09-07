import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

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
  reparsePaperPdf,
  uploadPaperPdf,
  verifyClaims,
  verifyMetadata,
} from "../api/paper.js";
import { listSkills, regenerateSkillSummary } from "../api/skills.js";
import {
  clearModelApiKey,
  deleteCustomProvider,
  getCustomProviders,
  getModelOptions,
  getModelSettings,
  saveCustomProvider,
  saveModelSettings,
  testModelConnection,
} from "../api/settings.js";
import type { CreateProjectInput, CustomProviderInput, ImportProjectPdfInput, WorkflowKind, WorkflowRunView } from "../types/api.js";

/**
 * Server state 全部经 TanStack Query 流动；Zustand 只保存纯 UI 状态。
 *
 * key 设计：列表与单项分开前缀（["projects", "list", scope] vs ["project", id, …]），
 * 使列表失效不会顺带重取所有已打开项目的 PDF / 引用 / Review 子查询。
 */

export const queryKeys = {
  projectList: (scope: "active" | "archived" | "all") => ["projects", "list", scope] as const,
  projectLists: ["projects", "list"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  projectRuns: (projectId: string) => ["project", projectId, "runs"] as const,
  paper: (projectId: string) => ["project", projectId, "paper"] as const,
  paperReview: (projectId: string) => ["project", projectId, "paper-review"] as const,
  citations: (projectId: string) => ["project", projectId, "citations"] as const,
  citationIntegrity: (projectId: string) => ["project", projectId, "citations", "integrity"] as const,
  metadataRecords: (projectId: string) => ["project", projectId, "citations", "metadata"] as const,
  runtimeStatus: ["runtime-status"] as const,
  skills: ["skills"] as const,
  modelSettings: ["model-settings"] as const,
  modelOptions: ["model-settings", "options"] as const,
  modelOptionsFor: (provider: string) => ["model-settings", "options", provider] as const,
  customProviders: ["model-settings", "custom-providers"] as const,
};

/** 项目目录几乎不变：一天内不因窗口聚焦重取（1290 条模型目录不该反复下载） */
const CATALOG_STALE_MS = 24 * 60 * 60 * 1000;

const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRunView["status"]> = new Set(["pending", "running", "awaiting_input"]);

export function isRunActive(run: WorkflowRunView | undefined): boolean {
  return run !== undefined && ACTIVE_RUN_STATUSES.has(run.status);
}

// ---- 项目 ----

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projectList("active"),
    queryFn: ({ signal }) => listProjects("active", signal),
  });
}

export function useArchivedProjects() {
  return useQuery({
    queryKey: queryKeys.projectList("archived"),
    queryFn: ({ signal }) => listProjects("archived", signal),
  });
}

/** 项目详情；404 时 error 为 ApiError(isNotFound) */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? ""),
    queryFn: ({ signal }) => getProject(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 项目的 WorkflowRun 列表：存在活跃 run 时按 pollMs 轮询，否则不轮询 */
export function useProjectRuns(projectId: string | undefined, pollMs = 3000) {
  return useQuery({
    queryKey: queryKeys.projectRuns(projectId ?? ""),
    queryFn: ({ signal }) => listProjectRuns(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
    refetchInterval: (query) => (query.state.data?.some(isRunActive) === true ? pollMs : false),
  });
}

function useProjectMutationEffects() {
  const queryClient = useQueryClient();
  return {
    /** 单项写回 + 所有列表（active / archived / all）失效 */
    syncProject: (project: { id: string }, data: unknown) => {
      queryClient.setQueryData(queryKeys.project(project.id), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectLists });
    },
  };
}

export function useCreateProject() {
  const { syncProject } = useProjectMutationEffects();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: (project) => syncProject(project, project),
  });
}

/** 已有论文 File-First 导入（后端建项目 + 解析 + 自动标题，失败回滚） */
export function useImportProjectPdf() {
  const { syncProject } = useProjectMutationEffects();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportProjectPdfInput) => importProjectPdf(input),
    onSuccess: ({ project, document }) => {
      syncProject(project, project);
      // 导入响应已带文档摘要：直接种进 paper 缓存，落地工作区不再等一轮请求
      queryClient.setQueryData(queryKeys.paper(project.id), { document, sections: undefined, stages: undefined });
    },
  });
}

export function useRenameProject(projectId: string | undefined) {
  const { syncProject } = useProjectMutationEffects();
  return useMutation({
    mutationFn: (title: string) => renameProject(projectId ?? "", title),
    onSuccess: (project) => syncProject(project, project),
  });
}

/** 归档（运行中 → 409 PROJECT_BUSY，由调用方展示） */
export function useArchiveProject() {
  const { syncProject } = useProjectMutationEffects();
  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSuccess: (project) => syncProject(project, project),
  });
}

export function useRestoreProject() {
  const { syncProject } = useProjectMutationEffects();
  return useMutation({
    mutationFn: (projectId: string) => restoreProject(projectId),
    onSuccess: (project) => syncProject(project, project),
  });
}

/** 永久删除（仅已归档；成功后清掉该项目的全部缓存） */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: (_result, projectId) => {
      queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectLists });
    },
  });
}

// ---- Workflow ----

/** 启动 WorkflowRun（快速 Review = existing_paper_review）；成功后刷新该项目的 run 列表 */
export function useCreateWorkflowRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: WorkflowKind }) => createWorkflowRun(projectId, kind),
    onSuccess: (_run, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(projectId) });
    },
  });
}

/** Review run 结束后要刷新的派生数据（报告 / 引用 / 项目状态） */
export function useInvalidateReviewOutputs(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    const id = projectId ?? "";
    void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.citations(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectLists });
  }, [projectId, queryClient]);
}

export function usePaperReviewReport(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.paperReview(projectId ?? ""),
    queryFn: ({ signal }) => getPaperReviewReport(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

// ---- 运行环境 ----

/** Runtime / 模型 / PDF 工具链状态：30s 轮询 + 窗口聚焦刷新 */
export function useRuntimeStatus() {
  return useQuery({
    queryKey: queryKeys.runtimeStatus,
    queryFn: ({ signal }) => getRuntimeStatus(signal),
    refetchInterval: 30_000,
  });
}

// ---- PDF / 引用 ----

export function usePaper(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.paper(projectId ?? ""),
    queryFn: ({ signal }) => getPaper(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

export function useUploadPaperPdf(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileName: string; contentBase64: string }) => uploadPaperPdf(projectId ?? "", input),
    onSuccess: () => {
      const id = projectId ?? "";
      void queryClient.invalidateQueries({ queryKey: queryKeys.paper(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.citations(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(id) });
    },
  });
}

/** 重新解析已上传的 PDF（清空派生产物：引用 / Review 需重跑） */
export function useReparsePaperPdf(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reparsePaperPdf(projectId ?? ""),
    onSuccess: () => {
      const id = projectId ?? "";
      void queryClient.invalidateQueries({ queryKey: queryKeys.paper(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.citations(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(id) });
    },
  });
}

export function useCitations(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.citations(projectId ?? ""),
    queryFn: ({ signal }) => listCitations(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

export function useCitationIntegrity(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.citationIntegrity(projectId ?? ""),
    queryFn: ({ signal }) => getCitationIntegrity(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

export function useMetadataRecords(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.metadataRecords(projectId ?? ""),
    queryFn: ({ signal }) => getMetadataRecords(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 引用三阶段（提取 / 真实性 / 语义）任何一步成功都刷新整组引用查询 */
function useCitationInvalidation(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.citations(projectId ?? "") });
  };
}

export function useExtractCitations(projectId: string | undefined) {
  const invalidate = useCitationInvalidation(projectId);
  return useMutation({ mutationFn: () => extractCitations(projectId ?? ""), onSuccess: invalidate });
}

export function useVerifyMetadata(projectId: string | undefined) {
  const invalidate = useCitationInvalidation(projectId);
  return useMutation({ mutationFn: () => verifyMetadata(projectId ?? ""), onSuccess: invalidate });
}

/** 单次语义核验条数上限（UI 会提示） */
export const SEMANTIC_VERIFY_LIMIT = 30;

export function useVerifyClaims(projectId: string | undefined) {
  const invalidate = useCitationInvalidation(projectId);
  return useMutation({
    mutationFn: () => verifyClaims(projectId ?? "", { limit: SEMANTIC_VERIFY_LIMIT }),
    onSuccess: invalidate,
  });
}

// ---- Skills ----

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: ({ signal }) => listSkills(signal),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useRegenerateSkillSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => regenerateSkillSummary(skillId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

// ---- 模型设置 ----

function useInvalidateModelState() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.modelSettings });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus });
  };
}

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
    staleTime: CATALOG_STALE_MS,
  });
}

export function useSaveModelSettings() {
  const invalidate = useInvalidateModelState();
  return useMutation({
    mutationFn: (input: { model: string; apiKey?: string }) => saveModelSettings(input),
    onSuccess: invalidate,
  });
}

export function useClearModelApiKey() {
  const invalidate = useInvalidateModelState();
  return useMutation({ mutationFn: () => clearModelApiKey(), onSuccess: invalidate });
}

export function useCustomProviders() {
  return useQuery({
    queryKey: queryKeys.customProviders,
    queryFn: ({ signal }) => getCustomProviders(signal),
  });
}

/** 新建 / 整体替换自定义提供商；成功后 provider 目录、模型目录与状态一起失效 */
export function useSaveCustomProvider() {
  const invalidate = useInvalidateModelState();
  return useMutation({
    mutationFn: (input: { provider: CustomProviderInput; apiKey?: string }) => saveCustomProvider(input),
    onSuccess: invalidate,
  });
}

export function useDeleteCustomProvider() {
  const invalidate = useInvalidateModelState();
  return useMutation({ mutationFn: (id: string) => deleteCustomProvider(id), onSuccess: invalidate });
}

/** Test Connection：携带当前填写但未保存的 model/key；不改缓存 */
export function useTestModelConnection() {
  return useMutation({
    mutationFn: (input: { model: string; apiKey?: string }) => testModelConnection(input),
  });
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}
