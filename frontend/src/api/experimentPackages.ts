import { ApiError, apiClient, apiUrl } from "./client.js";

export type ExperimentRole = "main_result" | "baseline_result" | "ablation_result" | "experiment_config" | "training_log" | "evaluation_log" | "dataset_description" | "figure_asset" | "notebook" | "source_code" | "documentation" | "unknown";
export interface PackageFileView {
  path: string; hash: string; bytes: number; kind: string; parseStatus: string;
  sourceId?: string; role: ExperimentRole; roleBasis: string; roleConfidence: string; groupId: string; warning?: string;
}
export interface ExperimentSplitScopeView {
  id: string;
  split: string;
  status: "candidate" | "confirmed" | "conflict";
  conflicts: string[];
  confirmedAt?: string;
  /** allowed = 允许进入当前工作流上下文；excluded = 明确排除；undecided = 未决 */
  workflowUse: "allowed" | "excluded" | "undecided";
  workflowUseDecidedAt?: string;
  observationCount: number;
  metricCount: number;
  filePaths: string[];
  protocols: string[];
}
export interface ExperimentGroupView {
  id: string; role: string; filePaths: string[]; basis: string;
  status: "candidate" | "confirmed" | "conflict"; conflicts: string[]; confirmedAt?: string;
  /** M13.5：观测级实验范围（schema v2；无观测的组没有该字段） */
  splitScopes?: ExperimentSplitScopeView[];
}
export interface MetricObservationView {
  sourceId: string; path: string; blockId: string; row?: number; sheet?: string; column?: string; jsonPath?: string;
  method?: string; dataset?: string; seed?: string; protocol?: string; split?: string; metric: string; value: number; unit: string; direction: string; groupId: string;
}
export interface ReportedVerdictView {
  path: string; field: string; value: string;
}
export interface SemanticRoleSuggestionView {
  path: string; suggestedRole: ExperimentRole; suggestedGroupId: string; rationale: string; anchors: string[]; status: "needs_author_confirmation";
}
export interface SemanticFindingView {
  claim: string; confidence: "high" | "medium" | "low"; anchors: string[]; status: "needs_author_confirmation";
}
export interface SemanticSuggestionsView {
  schemaVersion: number; generatedAt: string; model: string; durationMs: number;
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number | string } };
  roleSuggestions: SemanticRoleSuggestionView[]; findings: SemanticFindingView[]; notes: string[];
}
export interface ExperimentPackageView {
  schemaVersion: number; packageId: string; packageHash: string; originalName: string; importedAt: string;
  status: "inventory" | "importing" | "ready" | "partial";
  files: PackageFileView[]; groups: ExperimentGroupView[]; observations: MetricObservationView[]; relationCandidates: Array<{ configPath: string; groupId: string; status: string; basis: string; matchedFields: string[]; conflictingFields: string[] }>;
  /** 详情响应附带：磁盘上的观测总数（observations 已截断为前 200 条的有界载荷） */
  observationCount?: number;
  reportedVerdicts?: ReportedVerdictView[]; semanticSuggestions?: SemanticSuggestionsView; warnings: string[];
}
/** 列表摘要（M13.3：列表不再携带全量 manifest——远程弱带宽可用性） */
export interface ExperimentPackageSummaryView {
  packageId: string; packageHash: string; originalName: string; importedAt: string;
  status: "inventory" | "importing" | "ready" | "partial";
  fileCount: number; groupCount: number; observationCount: number; warningCount: number;
}
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/experiment-packages`;

/** Backend authoritative limit: compressed ZIP request bytes. */
export const EXPERIMENT_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

export function experimentArchiveLimitMessage(file: Pick<File, "name" | "size">): string {
  const sizeMiB = (file.size / (1024 * 1024)).toFixed(2);
  return `ZIP 文件过大：当前文件 ${sizeMiB} MiB，最大允许 16 MiB。请精简实验包后重试。文件：${file.name}`;
}

export async function listExperimentPackages(projectId: string): Promise<ExperimentPackageSummaryView[]> {
  const result = await apiClient.get<{ packages: ExperimentPackageSummaryView[] }>(base(projectId));
  return result.packages;
}
export async function getExperimentPackage(projectId: string, packageId: string): Promise<ExperimentPackageView> {
  const result = await apiClient.get<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}`);
  return result.package;
}
export async function uploadExperimentPackage(projectId: string, file: File): Promise<ExperimentPackageView> {
  if (file.size > EXPERIMENT_ARCHIVE_MAX_BYTES) {
    throw new ApiError(413, "EXPERIMENT_ARCHIVE_LIMIT", experimentArchiveLimitMessage(file));
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(base(projectId)), {
      method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": encodeURIComponent(file.name), Accept: "application/json" }, body: file,
    });
  } catch (cause) {
    throw new ApiError(0, "NETWORK_ERROR", "无法连接 PaperTeam 后端服务，请确认服务已启动。", cause instanceof Error ? cause.message : String(cause));
  }
  let body: { package?: ExperimentPackageView; error?: { code?: string; message?: string } };
  try { body = await response.json() as typeof body; }
  catch { throw new ApiError(response.status, "INVALID_RESPONSE", "上传响应不是 JSON"); }
  if (!response.ok) {
    const code = response.status === 413 ? "EXPERIMENT_ARCHIVE_LIMIT" : body.error?.code ?? "HTTP_ERROR";
    const message = code === "EXPERIMENT_ARCHIVE_LIMIT"
      ? experimentArchiveLimitMessage(file)
      : body.error?.message ?? `实验包上传失败（HTTP ${response.status}）`;
    throw new ApiError(response.status, code, message);
  }
  if (!body.package) throw new ApiError(response.status, "INVALID_RESPONSE", "上传响应缺少实验包");
  return body.package;
}
export async function editExperimentFile(projectId: string, packageId: string, input: { path: string; role: ExperimentRole; groupId: string }): Promise<ExperimentPackageView> {
  const result = await apiClient.patch<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}`, input);
  return result.package;
}
export async function confirmExperimentGroups(projectId: string, packageId: string, groupIds: string[], scopeIds?: string[]): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/confirm`, { groupIds, ...(scopeIds !== undefined ? { scopeIds } : {}) });
  return result.package;
}
/** M13.5：范围级工作流授权（与确认独立的科研隔离决策；范围须已确认） */
export async function setExperimentScopeWorkflowUse(projectId: string, packageId: string, scopeId: string, use: "allowed" | "excluded"): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/workflow-use`, { scopeId, use });
  return result.package;
}
/**
 * M13.5.3：显式重新整理分组——用当前规则（观测级 split 范围）重建组 / 范围并升级到 schema v2。
 * 不改任何文件角色、分组归属或观测值；既有的组确认与工作流授权失效，需重新核对。
 * 面向 M13.5 之前导入、因「split 不一致」整组判冲突而无法按范围确认的 v1 旧包。
 */
export async function rebuildExperimentPackage(projectId: string, packageId: string): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/rebuild`, {});
  return result.package;
}
/** M13.5：指标浏览查询（服务端过滤 + 分页 + facet；展示真实观测不选优） */
export interface ObservationQueryResult {
  total: number; page: number; pageSize: number;
  observations: Array<MetricObservationView & { split?: string }>;
  facets: { splits: string[]; groupIds: string[]; methods: string[]; metrics: string[]; paths: string[] };
}
export async function queryExperimentObservations(
  projectId: string,
  packageId: string,
  filters: { split?: string; groupId?: string; method?: string; metric?: string; path?: string; page?: number; pageSize?: number },
): Promise<ObservationQueryResult> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return apiClient.get<ObservationQueryResult>(`${base(projectId)}/${packageId}/observations${query !== "" ? `?${query}` : ""}`);
}
export async function requestExperimentUnderstanding(projectId: string, packageId: string): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/understand`, {});
  return result.package;
}
export async function confirmExperimentMetricEvidence(projectId: string, observation: MetricObservationView, claim: string): Promise<{ evidence: { id: string; verificationLevel: string; verificationStatus: string } }> {
  const address = observation.jsonPath ? { path: observation.jsonPath } : { row: observation.row, column: observation.column ?? observation.metric, ...(observation.sheet ? { sheet: observation.sheet } : {}) };
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(observation.sourceId)}/records/evidence`, { ...address, claim });
}
