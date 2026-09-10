import { apiClient } from "./client.js";
import type {
  VersionCompareView,
  VersionListView,
  VersionRestoreResultView,
} from "../types/api.js";

/**
 * Manuscript Version API（M4.8 版本体验）。
 *
 *   GET    /api/projects/:id/versions                       → ManuscriptVersionDTO 历史
 *   GET    /api/projects/:id/versions/compare?from=&to=     → 确定性版本比较（零 LLM）
 *   POST   /api/projects/:id/revisions/:revision/restore    → 恢复历史修订 = 创建新修订
 *
 * 纪律：版本与 review / gate / artifact 的关联只由 Backend 组装（前端不拼装猜测）；
 * 差异是确定性计算（内容 / 行级对比），不是模型结论；恢复不覆盖任何历史。
 */

export async function listVersions(
  projectId: string,
  signal?: AbortSignal,
): Promise<VersionListView> {
  return apiClient.get<VersionListView>(
    `/api/projects/${encodeURIComponent(projectId)}/versions`,
    signal,
  );
}

export async function compareVersions(
  projectId: string,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<VersionCompareView> {
  return apiClient.get<VersionCompareView>(
    `/api/projects/${encodeURIComponent(projectId)}/versions/compare?from=${from}&to=${to}`,
    signal,
  );
}

/** 恢复历史修订：Backend 复制该修订快照并提交新的不可变修订（旧 Gate 自然 stale） */
export async function restoreRevision(
  projectId: string,
  revision: number,
): Promise<VersionRestoreResultView> {
  return apiClient.post<VersionRestoreResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/revisions/${revision}/restore`,
    {},
  );
}
