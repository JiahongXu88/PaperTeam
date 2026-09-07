/**
 * PDF / Citation Integrity API。
 *
 *   GET  /api/projects/:id/paper                  → PaperResponse
 *   POST /api/projects/:id/paper/pdf              → 上传 + 解析 Final PDF
 *   POST /api/projects/:id/paper/reparse          → 重跑解析
 *   GET  /api/projects/:id/citations              → { summary, references }
 *   POST /api/projects/:id/citations/extract      → 引用提取（确定性）
 *   POST /api/projects/:id/citations/verify-metadata → 外部学术库核验
 *   POST /api/projects/:id/citations/verify-claims   → (claim,citation) 语义核验
 *   GET  /api/projects/:id/citations/integrity    → 汇总报告
 */

import { apiClient } from "./client.js";
import type {
  IntegrityReportView,
  MetadataRecordView,
  PaperResponse,
  ReferenceView,
  ExtractionSummary,
} from "../types/paper.js";
import type { ExistingReviewReportView } from "../types/api.js";

export async function getPaper(projectId: string, signal?: AbortSignal): Promise<PaperResponse> {
  return apiClient.get<PaperResponse>(`/api/projects/${encodeURIComponent(projectId)}/paper`, signal);
}

export async function uploadPaperPdf(
  projectId: string,
  input: { fileName: string; contentBase64: string },
): Promise<{ document: PaperResponse["document"]; unchanged: boolean }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/paper/pdf`, input);
}

/** 用已上传的原始 PDF 重新解析（解析器升级后无需重新上传） */
export async function reparsePaperPdf(projectId: string): Promise<{ document: PaperResponse["document"] }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/paper/reparse`);
}

export async function listCitations(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ summary: ExtractionSummary; references: ReferenceView[] }> {
  return apiClient.get(`/api/projects/${encodeURIComponent(projectId)}/citations`, signal);
}

export async function extractCitations(
  projectId: string,
  options: { force?: boolean } = {},
): Promise<{ summary: { referenceCount: number; calloutCount: number }; reused: boolean }> {
  return apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/citations/extract`,
    options.force === true ? { force: true } : {},
  );
}

export async function verifyMetadata(
  projectId: string,
  options: { force?: boolean } = {},
): Promise<{
  byStatus: Record<string, number>;
  checked: number;
  reused: number;
  telemetry: { providerCalls: number; cacheHits: number; retries: number };
  records: MetadataRecordView[];
}> {
  return apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/citations/verify-metadata`,
    options.force === true ? { force: true } : {},
  );
}

export async function verifyClaims(
  projectId: string,
  options: { force?: boolean; limit?: number } = {},
): Promise<{ summary: { total: number; byVerdict: Record<string, number> }; verified: number; telemetry: { modelCalls: number; failed: number } }> {
  return apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/citations/verify-claims`,
    {
      ...(options.force === true ? { force: true } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    },
  );
}

export async function getCitationIntegrity(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ report: IntegrityReportView }> {
  return apiClient.get(
    `/api/projects/${encodeURIComponent(projectId)}/citations/integrity`,
    signal,
  );
}

/** 逐条 metadata 核验记录（Reference 表的 status 列数据源） */
export async function getMetadataRecords(
  projectId: string,
  signal?: AbortSignal,
): Promise<MetadataRecordView[]> {
  const body = await apiClient.get<{ records: MetadataRecordView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/citations/metadata`,
    signal,
  );
  return body.records ?? [];
}

/** 最新快速 Review 聚合报告（existing_paper_review；尚无报告为 null） */
export async function getPaperReviewReport(
  projectId: string,
  signal?: AbortSignal,
): Promise<ExistingReviewReportView | null> {
  const body = await apiClient.get<{ report: ExistingReviewReportView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/paper-review`,
    signal,
  );
  return body.report ?? null;
}
