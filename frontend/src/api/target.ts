/**
 * Target Publication Intelligence API（M12 Batch 2 · A10）。
 *
 *   GET  /api/projects/:id/target/benchmark                    → { benchmark | null }
 *   POST /api/projects/:id/target/benchmark/discover           → discoverAndFreeze（一键发现+冻结）
 *   POST /api/projects/:id/target/benchmark/refresh            → 显式 refresh（revision+1）
 *   POST /api/projects/:id/target/benchmark/papers             → addPaper（body: sourceId, ...）
 *   POST /api/projects/:id/target/benchmark/papers/:sid/exclude → exclude（body: reason）
 *   POST /api/projects/:id/target/benchmark/confirm            → HITL 确认（幂等）
 *   GET  /api/projects/:id/target/profile                      → { profile | null, fresh, staleReason? }
 *   POST /api/projects/:id/target/profile/regenerate           → 重建（ensureCurrent）
 *   GET  /api/projects/:id/target/readiness                    → { readiness | null }
 *   POST /api/projects/:id/target/readiness/evaluate           → 评估当前稿（覆写）
 *
 * 视图类型与 backend/src/target/types.ts（schemaVersion 1）同形（后端原样
 * JSON 落盘形态 + HTTP 信封）。语义红线沿用后端：benchmark 论文恒
 * sourceRole=reference；readiness 是 advisory（benchmark 观测，非官方投稿
 * 要求，不构成稿件事实错误）。
 */

import { apiClient } from "./client.js";

// ---- 视图类型（backend target/types.ts 同形投影）----

export interface TargetBenchmarkPaperView {
  sourceId: string;
  identityKey: string;
  provenance: { provider: string; retrievedAt: string; queryUsed: string };
  inclusionReason: string;
  citationCount?: number;
  venueRaw: string;
  hasFullText: boolean;
  excluded?: { reason: string; at: string };
}

export interface TargetBenchmarkView {
  schemaVersion: 1;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  target: {
    documentType: string;
    targetProfile: string;
    targetVenue?: string;
    researchField?: string;
    timeWindow?: { from?: number; to?: number };
  };
  papers: TargetBenchmarkPaperView[];
  selection?: {
    selectedAt: string;
    targetCount: number;
    sufficiency: "sufficient" | "insufficient";
    reason?: string;
    requiresAttention: string[];
  };
  confirmedAt?: string;
}

export interface DistributionView {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface DimensionCoverageView {
  availability: "available" | "unavailable" | "insufficient";
  coverage: number;
  reason?: string;
}

export interface TargetProfileDimensionsView {
  structure: DimensionCoverageView & {
    sectionPattern: Record<string, { present: number; medianLengthWords: number }>;
    totalLengthWords?: DistributionView;
    abstractLengthWords?: DistributionView;
  };
  literature: DimensionCoverageView & {
    citationCount?: DistributionView;
    citationDensity?: DistributionView;
    medianReferenceAgeYears?: number;
    coverageNote?: string;
  };
  experiments: DimensionCoverageView & {
    tableCount?: DistributionView;
    datasetBreadth?: DistributionView;
    ablationPresent?: number;
    robustnessPresent?: number;
  };
  visuals: DimensionCoverageView & {
    figureCount?: DistributionView;
    methodDiagramPresent?: number;
    note?: string;
  };
  method: DimensionCoverageView & { depthNote?: string; noveltyFramingNote?: string };
  writing: DimensionCoverageView & {
    claimStrengthNote?: string;
    limitationsPresent?: number;
    discussionDepthNote?: string;
  };
}

export interface TargetProfileView {
  schemaVersion: 1;
  benchmarkRevision: number;
  corpusFingerprint: string;
  extractorSchemaVersion: number;
  n: number;
  dimensions: TargetProfileDimensionsView;
  provenance: {
    deterministicFields: string[];
    modelSummarizedFields: string[];
    model?: string;
    summaryFailure?: string;
  };
  generatedAt: string;
  notes: string[];
}

export type TargetVerdictView =
  | "MEETS_TARGET"
  | "PARTIALLY_MEETS_TARGET"
  | "BELOW_TARGET"
  | "INSUFFICIENT_EVIDENCE";

export interface TargetReadinessDimensionView {
  dimension: "structure" | "literature" | "experiments" | "visuals" | "method" | "writing";
  verdict: TargetVerdictView;
  observed: string;
  targetRange: string;
  gaps: string[];
  confidence: "high" | "medium" | "low";
  evidenceBasis: string;
}

export interface TargetReadinessView {
  schemaVersion: 1;
  evaluatedAt: string;
  benchmarkRevision: number;
  manuscriptRevision: number | null;
  dimensions: TargetReadinessDimensionView[];
  overall: { verdict: TargetVerdictView; summary: string };
  provenance: { basis: string; disclaimer: string; profileGeneratedAt: string };
}

// ---- GET ----

export async function getTargetBenchmark(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetBenchmarkView | null> {
  const body = await apiClient.get<{ benchmark: TargetBenchmarkView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/benchmark`,
    signal,
  );
  return body.benchmark ?? null;
}

export async function getTargetProfile(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ profile: TargetProfileView | null; fresh: boolean | null; staleReason?: string }> {
  return apiClient.get<{ profile: TargetProfileView | null; fresh: boolean | null; staleReason?: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/profile`,
    signal,
  );
}

export async function getTargetReadiness(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetReadinessView | null> {
  const body = await apiClient.get<{ readiness: TargetReadinessView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/readiness`,
    signal,
  );
  return body.readiness ?? null;
}

// ---- 操作（POST）----

/** discoverAndFreeze 一键（A6 默认流程：auto-select 8–15、零暂停） */
export async function discoverTargetBenchmark(
  projectId: string,
  input: { targetCount?: number } = {},
): Promise<{
  revision: number;
  papers: number;
  savedSourceIds: number;
  venueDegraded: boolean;
  sufficiency: "sufficient" | "insufficient";
  requiresAttention: string[];
  alreadyFrozen: boolean;
}> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/benchmark/discover`, {
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
  });
}

/** 显式 refresh（新语料修订 revision+1；body 给定新的 target/候选上下文由后端组装） */
export async function refreshTargetBenchmark(
  projectId: string,
  input: { targetCount?: number } = {},
): Promise<{ benchmark: TargetBenchmarkView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/benchmark/refresh`, {
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
  });
}

/** addPaper（sourceId 必须已以 role=reference 入库；refresh 语义 revision+1） */
export async function addTargetBenchmarkPaper(
  projectId: string,
  input: { sourceId: string; citationCount?: number; venueRaw?: string; inclusionReason?: string },
): Promise<{ benchmark: TargetBenchmarkView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/benchmark/papers`, input);
}

/** exclude（同 revision 内剔除标记；reason 必填） */
export async function excludeTargetBenchmarkPaper(
  projectId: string,
  sourceId: string,
  reason: string,
): Promise<{ benchmark: TargetBenchmarkView }> {
  return apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/target/benchmark/papers/${encodeURIComponent(sourceId)}/exclude`,
    { reason },
  );
}

/** confirm（HITL 确认审计标记；幂等） */
export async function confirmTargetBenchmark(projectId: string): Promise<{ benchmark: TargetBenchmarkView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/benchmark/confirm`);
}

/** profile 重建（ensureCurrent：缺失/陈旧才重建） */
export async function regenerateTargetProfile(projectId: string): Promise<{ profile: TargetProfileView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/profile/regenerate`);
}

/** readiness 评估当前稿（覆写落盘） */
export async function evaluateTargetReadiness(projectId: string): Promise<{ readiness: TargetReadinessView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/readiness/evaluate`);
}
