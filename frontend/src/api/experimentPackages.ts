import { ApiError, apiClient, apiUrl } from "./client.js";

export type ExperimentRole = "main_result" | "baseline_result" | "ablation_result" | "experiment_config" | "training_log" | "evaluation_log" | "dataset_description" | "figure_asset" | "notebook" | "source_code" | "documentation" | "unknown";
export interface PackageFileView {
  path: string; hash: string; bytes: number; kind: string; parseStatus: string;
  sourceId?: string; role: ExperimentRole; roleBasis: string; roleConfidence: string; groupId: string; warning?: string;
}
export interface ExperimentGroupView {
  id: string; role: string; filePaths: string[]; basis: string;
  status: "candidate" | "confirmed" | "conflict"; conflicts: string[]; confirmedAt?: string;
}
export interface MetricObservationView {
  sourceId: string; path: string; blockId: string; row?: number; sheet?: string; column?: string; jsonPath?: string;
  method?: string; dataset?: string; seed?: string; metric: string; value: number; unit: string; direction: string; groupId: string;
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

export async function listExperimentPackages(projectId: string): Promise<ExperimentPackageSummaryView[]> {
  const result = await apiClient.get<{ packages: ExperimentPackageSummaryView[] }>(base(projectId));
  return result.packages;
}
export async function getExperimentPackage(projectId: string, packageId: string): Promise<ExperimentPackageView> {
  const result = await apiClient.get<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}`);
  return result.package;
}
export async function uploadExperimentPackage(projectId: string, file: File): Promise<ExperimentPackageView> {
  let response: Response;
  try {
    response = await fetch(apiUrl(base(projectId)), {
      method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": encodeURIComponent(file.name), Accept: "application/json" }, body: file,
    });
  } catch { throw new ApiError(0, "NETWORK_ERROR", "无法连接 PaperTeam 后端"); }
  let body: { package?: ExperimentPackageView; error?: { code?: string; message?: string } };
  try { body = await response.json() as typeof body; }
  catch { throw new ApiError(response.status, "INVALID_RESPONSE", "上传响应不是 JSON"); }
  if (!response.ok) throw new ApiError(response.status, body.error?.code ?? "HTTP_ERROR", body.error?.message ?? "实验包上传失败");
  if (!body.package) throw new ApiError(response.status, "INVALID_RESPONSE", "上传响应缺少实验包");
  return body.package;
}
export async function editExperimentFile(projectId: string, packageId: string, input: { path: string; role: ExperimentRole; groupId: string }): Promise<ExperimentPackageView> {
  const result = await apiClient.patch<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}`, input);
  return result.package;
}
export async function confirmExperimentGroups(projectId: string, packageId: string, groupIds: string[]): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/confirm`, { groupIds });
  return result.package;
}
export async function requestExperimentUnderstanding(projectId: string, packageId: string): Promise<ExperimentPackageView> {
  const result = await apiClient.post<{ package: ExperimentPackageView }>(`${base(projectId)}/${packageId}/understand`, {});
  return result.package;
}
export async function confirmExperimentMetricEvidence(projectId: string, observation: MetricObservationView, claim: string): Promise<{ evidence: { id: string; verificationLevel: string; verificationStatus: string } }> {
  const address = observation.jsonPath ? { path: observation.jsonPath } : { row: observation.row, column: observation.column ?? observation.metric, ...(observation.sheet ? { sheet: observation.sheet } : {}) };
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(observation.sourceId)}/records/evidence`, { ...address, claim });
}
