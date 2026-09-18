/**
 * Literature Library API（Backend M6.2 已实现，M7.0 起前端消费）。
 *
 *   GET  /api/projects/:id/sources                     → { sources: SourceItemView[] }
 *   POST /api/projects/:id/sources                     → 文件上传（base64-in-JSON；contentHash 判重）
 *   POST /api/projects/:id/sources/import/doi          → { doi, sourceRole?, enrich? }
 *   POST /api/projects/:id/sources/import/arxiv        → { arxivId, sourceRole?, enrich? }
 *   POST /api/projects/:id/sources/import/url          → { url, title?, sourceRole? }
 *   POST /api/projects/:id/sources/import/bibtex       → { content, sourceRole? }（批量，恒 200）
 *
 * 语义（docs/API_CONTRACT.md §1.2）：标识符导入只建 canonical 记录（DOI/arXiv 默认
 * 经 ScholarlyResolver 补全元数据，未命中如实记录，不伪造）；URL 不抓正文。
 */

import { apiClient } from "./client.js";
import type {
  BibTexImportResultView,
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
