/**
 * Research Discovery 检索 DTO（M7.1c）——与 Backend src/search 的
 * fusion.ts（FusedAcademicResult）/ types.ts（WebSearchResult）/
 * academicSearchService.ts（AcademicSearchResponse）HTTP 投影对齐。
 * Provider raw payload 不出后端；这里只承接归一化投影。可选字段保持可选，
 * UI 不虚构数据（M6.1 ADR 纪律的前端延续）。
 */

import type { CandidateSourceView } from "./sources.js";

/** 学术检索结果（CanonicalPaperRecord 的检索投影 + 跨源身份 + RRF 融合信息） */
export interface AcademicResultView {
  record: {
    provider: string;
    recordId: string;
    title?: string;
    authors?: string[];
    year?: number;
    venue?: string;
    doi?: string;
    arxivId?: string;
    url?: string;
    abstract?: string;
  };
  citationCount?: number;
  openAccess?: boolean;
  /** RRF 融合分（Σ 权重/(K+rank)；单源命中即单源归一分） */
  score: number;
  /** 命中该结果的全部 provider 及名次（provenance；sources[0] = 最强来源） */
  sources: Array<{ provider: string; rank: number }>;
}

/** Web 检索结果（SearXNG 归一化投影；URL 已 canonical 化） */
export interface WebResultView {
  url: string;
  title: string;
  snippet: string;
  engines: string[];
  score: number;
  rank?: number;
  /** ISO 日期（引擎提供时才有） */
  publishedDate?: string;
  provider: string;
}

/** 单 provider 参与情况（diagnostics；无敏感信息） */
export interface ProviderAttemptView {
  provider: string;
  outcome: "ok" | "not_configured" | "skipped_cooldown" | "skipped_circuit_open" | "failed" | "degraded";
  resultCount: number;
  error?: { kind: string; message: string };
  note?: string;
}

/** provider 健康快照（GET /api/research/providers 投影；无敏感信息） */
export interface ProviderHealthSnapshotView {
  provider: string;
  state: "healthy" | "degraded" | "rate_limited" | "unavailable";
  circuit: "closed" | "open" | "half_open";
  lastError?: string;
  consecutiveFailures: number;
}

/** Web 检索可用性观测（web 数组为空 = SearXNG 未配置，非故障） */
export interface ResearchProvidersView {
  academic: ProviderHealthSnapshotView[];
  web: ProviderHealthSnapshotView[];
}

export interface SearchDiagnosticsView {
  providers: ProviderAttemptView[];
  rawResultCount: number;
  fusedResultCount: number;
}

/** 显式保存结果（saveAsCandidates 的响应投影） */
export interface SavedCandidatesView {
  saved: CandidateSourceView[];
  /** 同身份已有 pending 候选（合并补充而非新建）的结果下标 */
  mergedExisting: number[];
}

/** 学术检索响应：success=全部参与 provider 成功；partial=部分失败但有结果 */
export interface AcademicSearchResponseView {
  status: "success" | "partial";
  results: AcademicResultView[];
  diagnostics?: SearchDiagnosticsView;
  saved?: SavedCandidatesView;
}

export interface WebSearchResponseView {
  status: "success" | "partial";
  results: WebResultView[];
  diagnostics?: SearchDiagnosticsView;
  saved?: SavedCandidatesView;
}
