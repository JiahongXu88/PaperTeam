import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  archiveProject,
  createProject,
  deleteProject,
  getManuscriptOverview,
  getProject,
  importProjectPaper,
  listProjects,
  renameProject,
  restoreProject,
} from "../api/projects.js";
import { getRuntimeStatus } from "../api/runtime.js";
import {
  finalizeProject,
  getBuildStatus,
  listArtifacts,
  listIterations,
  getStylePolish,
  runBuild,
} from "../api/artifacts.js";
import { cancelWorkflowRun, createWorkflowRun, listProjectRuns, resumeWorkflowRun } from "../api/runs.js";
import { compareVersions, listVersions, restoreRevision } from "../api/versions.js";
import {
  confirmEvidenceVerified,
  getQualityGate,
  listEvidence,
  reevaluateQualityGate,
} from "../api/evidence.js";
import {
  importSourceByArxiv,
  importSourceBibtex,
  importSourceByDoi,
  importSourceByUrl,
  listSources,
  uploadSourceFile,
} from "../api/sources.js";
import {
  academicSearch,
  listCandidates,
  promoteCandidate,
  rejectCandidate,
  webSearch,
  type AcademicSearchInput,
  type WebSearchInput,
} from "../api/discovery.js";
import {
  acceptResearchGap,
  approveResearchPlan,
  activateResearchPlan,
  analyzeResearchCoverage,
  deriveResearchGap,
  deriveResearchPlan,
  executeResearchPlan,
  getResearchCoverage,
  getResearchPlan,
  listExecutionHistory,
  listResearchGaps,
  listResearchPlans,
  rejectResearchGap,
  saveExecutionResultsAsCandidates,
  updateResearchPlan,
  type ResearchPlanDeriveInput,
  type ResearchPlanUpdateInput,
} from "../api/researchPlan.js";
import {
  exportReviewReport,
  extractCitations,
  getCitationIntegrity,
  getClaimRecords,
  getMetadataRecords,
  getPaper,
  getPaperReviewReport,
  listCitations,
  reparsePaperPdf,
  uploadPaperPdf,
  verifyClaims,
  verifyMetadata,
} from "../api/paper.js";
import {
  applySkillUpdate,
  getSkillProvenance,
  getSkillUpdatePreview,
  installSkill,
  listSkills,
  regenerateSkillSummary,
} from "../api/skills.js";
import {
  addExternalInstruction,
  deleteExternalInstruction,
  getRevisionPlan,
  listExternalInstructions,
} from "../api/externalInstructions.js";
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
import type {
  CitationSemanticMode,
  StylePolicy,
  CreateProjectInput,
  CustomProviderInput,
  HitlDecisionInput,
  ImportProjectPaperInput,
  WorkflowKind,
  WorkflowRunView,
} from "../types/api.js";
import type {
  BibTexImportResultView,
  CandidateStatus,
  SourceImportResult,
  SourceRole,
} from "../types/sources.js";

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
  claimRecords: (projectId: string) => ["project", projectId, "citations", "claims"] as const,
  evidence: (projectId: string) => ["project", projectId, "evidence"] as const,
  /** 项目文献库（M6.2；导入 / 上传 / 删除后失效重取） */
  sources: (projectId: string) => ["project", projectId, "sources"] as const,
  /** Discovery 候选（M7.1c；检索保存 / promote / reject 后失效重取） */
  candidates: (projectId: string) => ["project", projectId, "candidates"] as const,
  /** Research Plan（M8.1；调研产出 / 编辑保存后失效重取） */
  researchPlan: (projectId: string) => ["project", projectId, "research-plan"] as const,
  /** Research Plan 计划链（M8.3.1；迭代列表 / 派生 / 激活后失效重取） */
  researchPlans: (projectId: string) => ["project", projectId, "research-plans"] as const,
  /** 计划执行审计（M8.5 executionHistory；执行后失效重取） */
  executionHistory: (projectId: string) => ["project", projectId, "execution-history"] as const,
  /** Research Coverage（M8.3.2；只读派生视图——计划 / 证据 / 候选变化后失效重取） */
  researchCoverage: (projectId: string) => ["project", projectId, "research-coverage"] as const,
  /** Research Gaps（M8.3.3；覆盖派生 + HITL 决策覆盖——分析 / 决策 / 计划变化后失效重取） */
  researchGaps: (projectId: string) => ["project", projectId, "research-gaps"] as const,
  /** Draft / Final 产物（manifest；构建 / Finalize / run 结束后失效） */
  artifacts: (projectId: string) => ["project", projectId, "artifacts"] as const,
  buildStatus: (projectId: string) => ["project", projectId, "build"] as const,
  versions: (projectId: string) => ["project", projectId, "versions"] as const,
  /** 当前稿件聚合视图（M7.0.3；导入 / 构建 / 修订后失效重取） */
  manuscript: (projectId: string) => ["project", projectId, "manuscript"] as const,
  versionCompare: (projectId: string, from: number, to: number) =>
    ["project", projectId, "versions", "compare", from, to] as const,
  buildLog: (projectId: string) => ["project", projectId, "build", "log"] as const,
  iterations: (projectId: string) => ["project", projectId, "iterations"] as const,
  /** round 缺省 = 最新（后端决定；不在前端缓存「最新」的轮次号，避免轮次漂移） */
  qualityGate: (projectId: string, round?: number) =>
    ["project", projectId, "quality-gate", ...(round !== undefined ? [round] : ["latest"])] as const,
  runtimeStatus: ["runtime-status"] as const,
  skills: ["skills"] as const,
  stylePolish: (projectId: string) => ["project", projectId, "style-polish"] as const,
  skillProvenance: (skillId: string) => ["skills", skillId, "provenance"] as const,
  skillUpdatePreview: (skillId: string) => ["skills", skillId, "update-preview"] as const,
  modelSettings: ["model-settings"] as const,
  modelOptions: ["model-settings", "options"] as const,
  modelOptionsFor: (provider: string) => ["model-settings", "options", provider] as const,
  customProviders: ["model-settings", "custom-providers"] as const,
  /** 外部修改意见（M5.7；修订派发后失效重取） */
  externalInstructions: (projectId: string) =>
    ["project", projectId, "external-instructions"] as const,
  /** 修订计划（M5.7；round 缺省 = 最新） */
  revisionPlan: (projectId: string) => ["project", projectId, "revision-plan"] as const,
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

/** 已有论文 File-First 导入（统一入口；后端建项目 + 定标题，失败回滚） */
export function useImportProjectPaper() {
  const { syncProject } = useProjectMutationEffects();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportProjectPaperInput) => importProjectPaper(input),
    onSuccess: ({ project, document }) => {
      syncProject(project, project);
      // PDF 导入响应已带文档摘要：直接种进 paper 缓存，落地工作区不再等一轮请求
      if (document !== undefined) {
        queryClient.setQueryData(queryKeys.paper(project.id), { document, sections: undefined, stages: undefined });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.manuscript(project.id) });
    },
  });
}

/** 当前稿件聚合视图（M7.0.3：项目概览「当前稿件」卡） */
export function useManuscriptOverview(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.manuscript(projectId ?? ""),
    queryFn: ({ signal }) => getManuscriptOverview(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
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

/** 启动 WorkflowRun（快速 Review = existing_paper_review）；成功后刷新该项目的 run 列表。
 * citationSemanticMode 缺省 off（后端同语义）；仅 existing_paper_review 消费。 */
export function useCreateWorkflowRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      kind,
      citationSemanticMode,
      stylePolicy,
    }: {
      projectId: string;
      kind: WorkflowKind;
      citationSemanticMode?: CitationSemanticMode;
      /** M5.4 语言润色策略（idea / improvement；Quick Review 不发送） */
      stylePolicy?: StylePolicy;
    }) =>
      createWorkflowRun(projectId, kind, {
        ...(citationSemanticMode !== undefined ? { citationSemanticMode } : {}),
        ...(stylePolicy !== undefined ? { stylePolicy } : {}),
      }),
    onSuccess: (_run, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(projectId) });
    },
  });
}

/** Review run 结束后要刷新的派生数据（报告 / 引用 / 质量门禁 / 证据 / 项目状态） */
export function useInvalidateReviewOutputs(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    const id = projectId ?? "";
    void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.citations(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.evidence(id) });
    void queryClient.invalidateQueries({ queryKey: ["project", id, "quality-gate"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectLists });
  }, [projectId, queryClient]);
}

/**
 * 取消 WorkflowRun：成功后把返回状态写回 run 列表缓存。返回状态可能仍是
 * running（在途模型调用 settle 中，UI 显示「正在取消…」），终态由 SSE /
 * 轮询推动。重复取消在后端幂等（cancelled → 200 no-op）。
 */
export function useCancelWorkflowRun(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => cancelWorkflowRun(runId),
    onSuccess: (run) => {
      if (projectId === undefined) {
        return;
      }
      queryClient.setQueryData<WorkflowRunView[]>(queryKeys.projectRuns(projectId), (prev) =>
        prev?.map((item) => (item.runId === run.runId ? run : item)),
      );
    },
  });
}

/**
 * 提交 HITL 决策（approve / adjust / revise / accept_draft / revise_more / cancel）：
 * 成功后把返回状态写回 run 列表缓存（awaiting 清空、status 变化），后续推进由
 * SSE / 轮询推动。错误（409 非法决策 / 过期请求等）由调用方映射中文提示；
 * 过期请求场景调用方应失效 run 列表取回权威状态。
 */
export function useResumeWorkflowRun(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, input }: { runId: string; input: HitlDecisionInput }) =>
      resumeWorkflowRun(runId, input),
    onSuccess: (run) => {
      if (projectId === undefined) {
        return;
      }
      queryClient.setQueryData<WorkflowRunView[]>(queryKeys.projectRuns(projectId), (prev) =>
        prev?.map((item) => (item.runId === run.runId ? run : item)),
      );
    },
  });
}

export function usePaperReviewReport(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.paperReview(projectId ?? ""),
    queryFn: ({ signal }) => getPaperReviewReport(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 导出完整 Review Markdown 报告（浏览器下载 .md；完整报告不受前端筛选影响） */
export function useExportReviewReport(projectId: string | undefined) {
  return useMutation({
    mutationFn: async () => {
      const { blob, fileName } = await exportReviewReport(projectId ?? "");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName ?? "PaperTeam-Review.md";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
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

/** 逐条 (claim, citation) 语义核验记录（语义核验明细列表） */
export function useClaimRecords(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.claimRecords(projectId ?? ""),
    queryFn: ({ signal }) => getClaimRecords(projectId ?? "", signal),
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

// ---- Sources（Literature Library M6.2；M7.0 前端消费） ----

/** 文献库全量列表（导入 / 上传 / 删除后失效重取） */
export function useSources(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sources(projectId ?? ""),
    queryFn: ({ signal }) => listSources(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 文件上传入库（PDF / BibTeX / 文本等；contentHash 判重 → created=false 幂等） */
export function useUploadSource(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileName: string; contentBase64: string; sourceRole?: SourceRole }) =>
      uploadSourceFile(projectId ?? "", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sources(projectId ?? "") });
    },
  });
}

/** 标识符导入（DOI / arXiv / URL / BibTeX；由 mode 分派到对应端点） */
export function useImportSource(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<SourceImportResult | BibTexImportResultView, Error, SourceImportInput>({
    mutationFn: (input) => {
      const id = projectId ?? "";
      const payload = input.payload;
      switch (input.mode) {
        case "doi":
          return importSourceByDoi(id, payload as DoiImportInput);
        case "arxiv":
          return importSourceByArxiv(id, payload as ArxivImportInput);
        case "url":
          return importSourceByUrl(id, payload as UrlImportInput);
        case "bibtex":
          return importSourceBibtex(id, payload as BibtexImportInput);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sources(projectId ?? "") });
    },
  });
}

type DoiImportInput = { doi: string; sourceRole?: SourceRole; enrich?: boolean };
type ArxivImportInput = { arxivId: string; sourceRole?: SourceRole; enrich?: boolean };
type UrlImportInput = { url: string; title?: string; sourceRole?: SourceRole };
type BibtexImportInput = { content: string; sourceRole?: SourceRole };

type SourceImportInput =
  | { mode: "doi"; payload: DoiImportInput }
  | { mode: "arxiv"; payload: ArxivImportInput }
  | { mode: "url"; payload: UrlImportInput }
  | { mode: "bibtex"; payload: BibtexImportInput };

// ---- Discovery（M7.1c：检索 → 候选审阅 → promote 入文献库；全部复用既有后端端点） ----

/** Discovery 候选列表（保存 / promote / reject 后失效重取） */
export function useCandidates(projectId: string | undefined, status?: CandidateStatus) {
  return useQuery({
    queryKey: [...queryKeys.candidates(projectId ?? ""), status ?? "all"],
    queryFn: ({ signal }) => listCandidates(projectId ?? "", status, signal),
    enabled: isNonEmpty(projectId),
  });
}

function useInvalidateCandidates(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.candidates(projectId ?? "") });
  };
}

// ---- Research Plan（M8.1：plan 是检索意图的声明，指导下方检索；M8.3.1 迭代链） ----

/** 计划相关缓存失效（活动计划视图 + 迭代链列表 + 覆盖 / 缺口派生视图 + 执行审计一起失效，保证视图不漂移） */
function useInvalidateResearchPlans(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.researchPlan(projectId ?? "") });
    void queryClient.invalidateQueries({ queryKey: queryKeys.researchPlans(projectId ?? "") });
    void queryClient.invalidateQueries({ queryKey: queryKeys.researchCoverage(projectId ?? "") });
    void queryClient.invalidateQueries({ queryKey: queryKeys.researchGaps(projectId ?? "") });
    void queryClient.invalidateQueries({ queryKey: queryKeys.executionHistory(projectId ?? "") });
  };
}

/** 当前项目的检索计划（无调研产出时 data 为 null → 空态引导） */
export function useResearchPlan(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.researchPlan(projectId ?? ""),
    queryFn: ({ signal }) => getResearchPlan(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 全部迭代轮次（M8.3.1 计划链：plans + activePlanId；无计划 → 空数组） */
export function useResearchPlans(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.researchPlans(projectId ?? ""),
    queryFn: ({ signal }) => listResearchPlans(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 计划执行审计（M8.5 executionHistory：每条 query 的 provider 参与 / 结果标识符；只读） */
export function useExecutionHistory(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.executionHistory(projectId ?? ""),
    queryFn: ({ signal }) => listExecutionHistory(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/**
 * 执行结果快照 → 候选的显式保存（M9.1 HITL）：勾选某次执行的结果快照下标，
 * 成功后失效候选列表（下方候选审阅区立即出现）。
 */
export function useSaveExecutionResults(projectId: string | undefined) {
  const invalidateCandidates = useInvalidateCandidates(projectId);
  return useMutation({
    mutationFn: (input: { executionId: string; queryId: string; saveAsCandidates: number[] }) =>
      saveExecutionResultsAsCandidates(projectId ?? "", input),
    onSuccess: () => invalidateCandidates(),
  });
}

/** 编辑保存（questions / queries 受限字段）：成功后失效计划 */
export function useUpdateResearchPlan(projectId: string | undefined) {
  const invalidate = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: (input: ResearchPlanUpdateInput) =>
      updateResearchPlan(projectId ?? "", input),
    onSuccess: () => invalidate(),
  });
}

/** 批准计划（draft → approved）：成功后失效计划（状态与 updatedAt 变化） */
export function useApproveResearchPlan(projectId: string | undefined) {
  const invalidate = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: () => approveResearchPlan(projectId ?? ""),
    onSuccess: () => invalidate(),
  });
}

/** 执行 approved 计划：成功后失效计划（query 状态 / resultCount / plan 状态回填） */
export function useExecuteResearchPlan(projectId: string | undefined) {
  const invalidate = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: () => executeResearchPlan(projectId ?? ""),
    onSuccess: () => invalidate(),
  });
}

/** 派生下一轮（M8.3.1：从 done 计划派生 draft 并自动激活；旧计划不动） */
export function useDeriveResearchPlan(projectId: string | undefined) {
  const invalidate = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: ({ planId, input }: { planId: string; input?: ResearchPlanDeriveInput }) =>
      deriveResearchPlan(projectId ?? "", planId, input ?? {}),
    onSuccess: () => invalidate(),
  });
}

/** 切换活动计划（M8.3.1：编辑 / 批准 / 执行都作用于活动计划；幂等） */
export function useActivateResearchPlan(projectId: string | undefined) {
  const invalidate = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: (planId: string) => activateResearchPlan(projectId ?? "", planId),
    onSuccess: () => invalidate(),
  });
}

/** 当前活动计划的覆盖报告（M8.3.2 只读派生视图；无计划 → null 空态） */
export function useResearchCoverage(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.researchCoverage(projectId ?? ""),
    queryFn: ({ signal }) => getResearchCoverage(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 执行覆盖分析（M8.3.2：确定性规则即时重算；成功后失效覆盖 + 缺口派生视图） */
export function useAnalyzeResearchCoverage(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => analyzeResearchCoverage(projectId ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.researchCoverage(projectId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.researchGaps(projectId ?? "") });
    },
  });
}

/** ---- Research Gap HITL（M8.3.3：Coverage → Gap → Human Approval → 下一轮计划）---- */

/** 当前活动计划的缺口清单（派生 proposed + 决策覆盖；无计划 → 空态） */
export function useResearchGaps(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.researchGaps(projectId ?? ""),
    queryFn: ({ signal }) => listResearchGaps(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 缺口决策缓存失效（accept / reject 只影响缺口清单，不触碰计划 / 覆盖视图） */
function useInvalidateResearchGaps(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.researchGaps(projectId ?? "") });
  };
}

/** 接受缺口（proposed → accepted，显式 HITL 动作；幂等） */
export function useAcceptResearchGap(projectId: string | undefined) {
  const invalidate = useInvalidateResearchGaps(projectId);
  return useMutation({
    mutationFn: (gapId: string) => acceptResearchGap(projectId ?? "", gapId),
    onSuccess: () => invalidate(),
  });
}

/** 拒绝缺口（proposed → rejected；幂等） */
export function useRejectResearchGap(projectId: string | undefined) {
  const invalidate = useInvalidateResearchGaps(projectId);
  return useMutation({
    mutationFn: (gapId: string) => rejectResearchGap(projectId ?? "", gapId),
    onSuccess: () => invalidate(),
  });
}

/**
 * 从缺口派生下一轮计划（accepted 缺口 → 新 draft 并自动激活；成功后失效
 * 计划链 + 缺口清单——研究循环：Coverage → Gap → Accept → Next Plan）
 */
export function useDeriveResearchGap(projectId: string | undefined) {
  const invalidatePlans = useInvalidateResearchPlans(projectId);
  return useMutation({
    mutationFn: ({ gapId, input }: { gapId: string; input?: ResearchPlanDeriveInput }) =>
      deriveResearchGap(projectId ?? "", gapId, input ?? {}),
    onSuccess: () => invalidatePlans(),
  });
}

/**
 * 学术检索（默认只返回不持久化；带 saveAsCandidates 的第二次调用保存选中
 * 结果为 pending 候选）。保存后失效候选列表。
 */
export function useAcademicSearch(projectId: string | undefined) {
  const invalidate = useInvalidateCandidates(projectId);
  return useMutation({
    mutationFn: (input: AcademicSearchInput) => academicSearch(projectId ?? "", input),
    onSuccess: (response) => {
      if (response.saved !== undefined) {
        invalidate();
      }
    },
  });
}

/** Web 检索（语义同 useAcademicSearch） */
export function useWebSearch(projectId: string | undefined) {
  const invalidate = useInvalidateCandidates(projectId);
  return useMutation({
    mutationFn: (input: WebSearchInput) => webSearch(projectId ?? "", input),
    onSuccess: (response) => {
      if (response.saved !== undefined) {
        invalidate();
      }
    },
  });
}

/** 候选 → 文献库（幂等）：成功后候选与文献库一起失效 */
export function usePromoteCandidate(projectId: string | undefined) {
  const invalidate = useInvalidateCandidates(projectId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; sourceRole?: SourceRole }) =>
      promoteCandidate(projectId ?? "", input.candidateId, {
        ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
      }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.sources(projectId ?? "") });
    },
  });
}

/** 否决候选（幂等）：成功后失效候选列表 */
export function useRejectCandidate(projectId: string | undefined) {
  const invalidate = useInvalidateCandidates(projectId);
  return useMutation({
    mutationFn: (candidateId: string) => rejectCandidate(projectId ?? "", candidateId),
    onSuccess: invalidate,
  });
}

// ---- Evidence（Workbench；server state，不复制进 Zustand） ----

/** 证据全量列表（规模内一次取回；筛选 / 搜索 / 摘要统计都在这份数据上派生，无 N+1） */
export function useEvidence(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.evidence(projectId ?? ""),
    queryFn: ({ signal }) => listEvidence(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 人工确认核验（user_confirmed）：完成后失效证据列表（含摘要统计） */
export function useConfirmEvidenceVerified(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evidenceId: string) => confirmEvidenceVerified(projectId ?? "", evidenceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidence(projectId ?? "") });
    },
  });
}

// ---- Quality Gate（只读展示；判定永远来自 Backend，前端不重算） ----

/** 按轮读取 gate 产物（缺省最新；多轮时切换器显式传 round） */
export function useQualityGate(projectId: string | undefined, round?: number) {
  return useQuery({
    queryKey: queryKeys.qualityGate(projectId ?? "", round),
    queryFn: ({ signal }) => getQualityGate(projectId ?? "", round, signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 手动重新评估（仅 gate 过期时提示使用；正常由 workflow 的 quality.gate stage 自动产出） */
export function useReevaluateQualityGate(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reevaluateQualityGate(projectId ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId ?? "", "quality-gate"] });
    },
  });
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

// ---- Paper Artifacts / Build / Finalize（M4.7；判定永远来自 Backend） ----

/** Draft / Final 产物列表 + 最新标记 + finalUpToDate */
export function useArtifacts(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.artifacts(projectId ?? ""),
    queryFn: ({ signal }) => listArtifacts(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** Build Gate 记录 + stale 信号（构建状态卡片数据源） */
export function useBuildStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.buildStatus(projectId ?? ""),
    queryFn: ({ signal }) => getBuildStatus(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** M5.4 语言润色状态（最新 style plan / 结果 / 是否已复审） */
export function useStylePolish(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.stylePolish(projectId ?? ""),
    queryFn: ({ signal }) => getStylePolish(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 修订迭代收敛历史（每轮 gate 的 scorecard / outcome） */
export function useIterations(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.iterations(projectId ?? ""),
    queryFn: ({ signal }) => listIterations(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 手动构建（Build Gate + Draft 冻结）：完成后构建 / 产物一起失效 */
export function useRunBuild(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => runBuild(projectId ?? ""),
    onSuccess: () => {
      const id = projectId ?? "";
      void queryClient.invalidateQueries({ queryKey: queryKeys.buildStatus(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.buildLog(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts(id) });
    },
  });
}

/** 标记 Final（后端确定性判定；错误由调用方映射中文提示）：成功后失效产物 */
export function useFinalizeProject(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => finalizeProject(projectId ?? ""),
    onSuccess: () => {
      const id = projectId ?? "";
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(id) });
    },
  });
}

// ---- Manuscript Versions（M4.8：历史 / 比较 / 恢复；事实全部来自 Backend） ----

/** 版本历史（ManuscriptVersionDTO 列表，最新在前） */
export function useVersions(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.versions(projectId ?? ""),
    queryFn: ({ signal }) => listVersions(projectId ?? "", signal),
    enabled: isNonEmpty(projectId),
  });
}

/** 两修订确定性比较（按需加载：只在面板展开比较时请求） */
export function useVersionCompare(
  projectId: string | undefined,
  from: number | null,
  to: number | null,
) {
  return useQuery({
    queryKey: queryKeys.versionCompare(projectId ?? "", from ?? 0, to ?? 0),
    queryFn: ({ signal }) => compareVersions(projectId ?? "", from as number, to as number, signal),
    enabled: isNonEmpty(projectId) && from !== null && to !== null,
  });
}

/** 恢复历史修订（= 创建新修订）：成功后版本 / 产物 / 构建状态一起失效 */
export function useRestoreRevision(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revision: number) => restoreRevision(projectId ?? "", revision),
    onSuccess: () => {
      const id = projectId ?? "";
      void queryClient.invalidateQueries({ queryKey: queryKeys.versions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.artifacts(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.buildStatus(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.iterations(id) });
    },
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

/** 审计材料（PROVENANCE.md / LICENSE / 上游快照校验）：用户展开时才请求 */
export function useSkillProvenance(skillId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.skillProvenance(skillId),
    queryFn: ({ signal }) => getSkillProvenance(skillId, signal),
    enabled,
    staleTime: CATALOG_STALE_MS,
  });
}

/** 更新预览（current / candidate hash + 文件 diff）：用户点击预览时才请求，不缓存过久 */
export function useSkillUpdatePreview(skillId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.skillUpdatePreview(skillId),
    queryFn: ({ signal }) => getSkillUpdatePreview(skillId, signal),
    enabled,
    staleTime: 0,
  });
}

export function useApplySkillUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { skillId: string; candidateHash: string }) =>
      applySkillUpdate(input.skillId, input.candidateHash),
    onSuccess: (_skill, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillUpdatePreview(input.skillId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillProvenance(input.skillId) });
    },
  });
}

export function useInstallSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => installSkill(skillId),
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
    mutationFn: (input: {
      model: string;
      apiKey?: string;
      /** per-Agent override（M5.7）：省略 = 保持现有；存在时整体替换 */
      agents?: Record<string, string | null>;
    }) => saveModelSettings(input),
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

// ---- 外部修改意见 / 修订计划（M5.7） ----

export function useExternalInstructions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.externalInstructions(projectId),
    queryFn: ({ signal }) => listExternalInstructions(projectId, signal),
  });
}

export function useAddExternalInstruction(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof addExternalInstruction>[1]) =>
      addExternalInstruction(projectId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.externalInstructions(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisionPlan(projectId) });
    },
  });
}

export function useDeleteExternalInstruction(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instructionId: string) => deleteExternalInstruction(projectId, instructionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.externalInstructions(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisionPlan(projectId) });
    },
  });
}

/** 最新修订计划（external_instructions.updated 事件后由 SSE 侧失效缓存） */
export function useRevisionPlan(projectId: string) {
  return useQuery({
    queryKey: queryKeys.revisionPlan(projectId),
    queryFn: ({ signal }) => getRevisionPlan(projectId, undefined, signal),
  });
}
