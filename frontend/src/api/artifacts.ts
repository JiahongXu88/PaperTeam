import { apiClient, apiUrl } from "./client.js";
import type {
  ArtifactsResponseView,
  BuildRunResultView,
  BuildStatusView,
  FinalizeResultView,
  RevisionIterationView,
} from "../types/api.js";

/**
 * Paper Artifact / Build / Finalize API（M4.7 Draft-Final 闭环）。
 *
 *   GET    /api/projects/:id/artifacts                     → 产物列表 + 最新标记 + finalUpToDate
 *   GET    /api/projects/:id/artifacts/:artifactId/download → PDF（inline 浏览器原生 viewer；
 *                                                             ?disposition=attachment 落盘）
 *   POST   /api/projects/:id/build                          → Build Gate + Draft 冻结（质量不参与 Draft）
 *   GET    /api/projects/:id/build                          → 构建记录 + stale 信号
 *   GET    /api/projects/:id/build/log                      → compile.log 尾部
 *   POST   /api/projects/:id/finalize                       → 标记 Final（后端确定性判定）
 *   GET    /api/projects/:id/iterations                     → 修订迭代收敛历史
 *
 * 安全语义：下载 URL 只由 projectId + artifactId 构造（后端经 manifest 解析到
 * 受控 artifacts/ 路径，不接受任何文件系统路径参数）；前端不自己判定
 * 「能不能 Final」——按钮永远可点，结论由后端确定性校验返回。
 */

export async function listArtifacts(
  projectId: string,
  signal?: AbortSignal,
): Promise<ArtifactsResponseView> {
  return apiClient.get<ArtifactsResponseView>(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts`,
    signal,
  );
}

export async function getBuildStatus(projectId: string, signal?: AbortSignal): Promise<BuildStatusView> {
  return apiClient.get<BuildStatusView>(
    `/api/projects/${encodeURIComponent(projectId)}/build`,
    signal,
  );
}

export async function getBuildLog(projectId: string, signal?: AbortSignal): Promise<{ log: string }> {
  return apiClient.get<{ log: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/build/log`,
    signal,
  );
}

export async function listIterations(
  projectId: string,
  signal?: AbortSignal,
): Promise<RevisionIterationView[]> {
  const body = await apiClient.get<{ iterations: RevisionIterationView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/iterations`,
    signal,
  );
  return body.iterations ?? [];
}

/** 手动构建：Build Gate + Draft 冻结（活跃 run 期间后端 409 PROJECT_BUSY） */
export async function runBuild(projectId: string): Promise<BuildRunResultView> {
  return apiClient.post<BuildRunResultView>(`/api/projects/${encodeURIComponent(projectId)}/build`, {});
}

/** 标记 Final：纯确定性（后端双 Gate 对齐校验；失败以 BusinessError 拒绝） */
export async function finalizeProject(projectId: string): Promise<FinalizeResultView> {
  return apiClient.post<FinalizeResultView>(`/api/projects/${encodeURIComponent(projectId)}/finalize`, {});
}

/** PDF 下载地址（inline：新标签页浏览器原生 viewer；attachment：落盘保存） */
export function artifactDownloadUrl(
  projectId: string,
  artifactId: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
  return apiUrl(disposition === "attachment" ? `${base}?disposition=attachment` : base);
}
