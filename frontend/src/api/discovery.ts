/**
 * Research Discovery API（Backend M6.3 / M6.2 已实现，M7.1c 前端消费）。
 *
 *   POST /api/projects/:id/research/academic-search
 *        → { query, limit?, yearFrom?, yearTo?, openAccessOnly?, saveAsCandidates? }
 *   POST /api/projects/:id/research/web-search
 *        → { query, limit?, saveAsCandidates? }
 *   GET  /api/projects/:id/sources/candidates?status=
 *   POST /api/projects/:id/sources/candidates/:cid/promote   → { source, created, candidate }
 *   POST /api/projects/:id/sources/candidates/:cid/reject    → { candidate }
 *
 * 语义（docs/API_CONTRACT.md §1.2）：检索默认不持久化；saveAsCandidates
 * （结果下标数组）显式写入 CandidateStore；promote 幂等（library 已有
 * 同身份 → merge 返回既有）；reject 幂等。检索结果 ≠ Evidence ≠ 正式文献。
 */

import { apiClient } from "./client.js";
import type {
  AcademicSearchResponseView,
  WebSearchResponseView,
} from "../types/discovery.js";
import type {
  CandidatePromoteResult,
  CandidateSourceView,
  CandidateStatus,
  SourceRole,
} from "../types/sources.js";

export type DiscoveryMode = "academic" | "web";

export interface AcademicSearchInput {
  query: string;
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  /** 要保存为候选的结果下标（0 起；显式保存语义，缺省只检索） */
  saveAsCandidates?: number[];
}

export interface WebSearchInput {
  query: string;
  limit?: number;
  saveAsCandidates?: number[];
}

export async function academicSearch(
  projectId: string,
  input: AcademicSearchInput,
): Promise<AcademicSearchResponseView> {
  return apiClient.post<AcademicSearchResponseView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/academic-search`,
    input,
  );
}

export async function webSearch(
  projectId: string,
  input: WebSearchInput,
): Promise<WebSearchResponseView> {
  return apiClient.post<WebSearchResponseView>(
    `/api/projects/${encodeURIComponent(projectId)}/research/web-search`,
    input,
  );
}

export async function listCandidates(
  projectId: string,
  status?: CandidateStatus,
  signal?: AbortSignal,
): Promise<CandidateSourceView[]> {
  const suffix = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
  const body = await apiClient.get<{ candidates: CandidateSourceView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/candidates${suffix}`,
    signal,
  );
  return body.candidates ?? [];
}

/** 候选 → 文献库（后端幂等；sourceRole 缺省 both） */
export async function promoteCandidate(
  projectId: string,
  candidateId: string,
  input: { sourceRole?: SourceRole } = {},
): Promise<CandidatePromoteResult> {
  return apiClient.post<CandidatePromoteResult>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/candidates/${encodeURIComponent(candidateId)}/promote`,
    input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {},
  );
}

/** 用户否决候选（幂等） */
export async function rejectCandidate(
  projectId: string,
  candidateId: string,
): Promise<CandidateSourceView> {
  const body = await apiClient.post<{ candidate: CandidateSourceView }>(
    `/api/projects/${encodeURIComponent(projectId)}/sources/candidates/${encodeURIComponent(candidateId)}/reject`,
  );
  return body.candidate;
}
