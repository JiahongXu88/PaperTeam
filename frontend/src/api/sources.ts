/**
 * Literature Library API（Backend M6.2 已实现，M7.0 起前端消费；M9.3 全文激活）。
 *
 *   GET  /api/projects/:id/sources                     → { sources: SourceItemView[] }
 *   POST /api/projects/:id/sources                     → 文件上传（base64-in-JSON；contentHash 判重）
 *   POST /api/projects/:id/sources/import/doi          → { doi, sourceRole?, enrich? }
 *   POST /api/projects/:id/sources/import/arxiv        → { arxivId, sourceRole?, enrich? }
 *   POST /api/projects/:id/sources/import/url          → { url, title?, sourceRole? }
 *   POST /api/projects/:id/sources/import/bibtex       → { content, sourceRole? }（批量，恒 200）
 *   POST /api/projects/:id/sources/:sid/resolve-fulltext → 单篇全文解析（M7.2）
 *   POST /api/projects/:id/sources/resolve-fulltext      → 批量全文解析（M9.3，有界并发）
 *   POST /api/projects/:id/sources/:sid/fulltext         → 手动 PDF 补挂（M9.3）
 *
 * 语义（docs/API_CONTRACT.md §1.2）：标识符导入只建 canonical 记录（DOI/arXiv 默认
 * 经 ScholarlyResolver 补全元数据，未命中如实记录，不伪造）；URL 不抓正文。
 * 全文解析结局是数据不是异常（resolved / not_found / failed / skipped_has_file /
 * not_resolvable）；不可自动解析（无 DOI/arXiv 身份）→ 422 结构化错误。
 */

import { apiClient } from "./client.js";
import type {
  BatchFullTextResultView,
  BibTexImportResultView,
  FullTextResolveResultView,
  SourceImportResult,
  SourceItemView,
  SourceRole,
} from "../types/sources.js";

export async function listSources(
  projectId: string,
  signal?: AbortSignal,
): Promise<SourceItemView[]> {
  const body = await apiClient.get<{ sources: SourceItemView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/sources`,
    signal,
  );
  return body.sources ?? [];
}

/** 文件上传（PDF/BibTeX/文本等；重复内容 → created=false 的 200） */
export async function uploadSourceFile(
  projectId: string,
  input: { fileName: string; contentBase64: string; sourceRole?: SourceRole },
): Promise<{ source: SourceItemView; created: boolean }> {
  const { sourceRole, ...rest } = input;
  return apiClient.post<{ source: SourceItemView; created: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/sources`,
    { ...rest, ...(sourceRole !== undefined ? { sourceRole } : {}) },
  );
}

export async function importSourceByDoi(
  projectId: string,
  input: { doi: string; sourceRole?: SourceRole; enrich?: boolean },
): Promise<SourceImportResult> {
  const { sourceRole, ...rest } = input;
  return apiClient.post<SourceImportResult>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/import/doi`,
    { ...rest, ...(sourceRole !== undefined ? { sourceRole } : {}) },
  );
}

export async function importSourceByArxiv(
  projectId: string,
  input: { arxivId: string; sourceRole?: SourceRole; enrich?: boolean },
): Promise<SourceImportResult> {
  const { sourceRole, ...rest } = input;
  return apiClient.post<SourceImportResult>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/import/arxiv`,
    { ...rest, ...(sourceRole !== undefined ? { sourceRole } : {}) },
  );
}

export async function importSourceByUrl(
  projectId: string,
  input: { url: string; title?: string; sourceRole?: SourceRole },
): Promise<SourceImportResult> {
  const { sourceRole, ...rest } = input;
  return apiClient.post<SourceImportResult>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/import/url`,
    { ...rest, ...(sourceRole !== undefined ? { sourceRole } : {}) },
  );
}

export async function importSourceBibtex(
  projectId: string,
  input: { content: string; sourceRole?: SourceRole },
): Promise<BibTexImportResultView> {
  const { sourceRole, ...rest } = input;
  return apiClient.post<BibTexImportResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/import/bibtex`,
    { ...rest, ...(sourceRole !== undefined ? { sourceRole } : {}) },
  );
}

/** 单篇全文解析（M7.2 端点；无学术身份 → 422 FULLTEXT_NOT_RESOLVABLE） */
export async function resolveSourceFullText(
  projectId: string,
  sourceId: string,
): Promise<FullTextResolveResultView> {
  return apiClient.post<FullTextResolveResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/resolve-fulltext`,
  );
}

/** 批量全文解析（M9.3；后端有界并发，partial success 汇总） */
export async function batchResolveSourceFullText(
  projectId: string,
  sourceIds: string[],
): Promise<BatchFullTextResultView> {
  return apiClient.post<BatchFullTextResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/resolve-fulltext`,
    { sourceIds },
  );
}

/** 手动上传 PDF 补挂（M9.3；自动解析失败的人工 fallback） */
export async function attachSourceFullTextPdf(
  projectId: string,
  sourceId: string,
  input: { fileName: string; contentBase64: string },
): Promise<FullTextResolveResultView> {
  return apiClient.post<FullTextResolveResultView>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/fulltext`,
    input,
  );
}
