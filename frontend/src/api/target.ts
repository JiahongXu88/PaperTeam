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

// ---- M15.9：官方投稿要求（G1）与期刊级 rubric（G2）——均为 advisory ----

export interface GuidelineCheckView {
  requirementId: string;
  field: string;
  status: "PASS" | "VIOLATION" | "NOT_EVALUATED" | "ADVISORY";
  hard: boolean;
  observed: string;
  expected: string;
  officialQuote: string;
  sourceUrl: string;
  reason?: string;
}

export interface GuidelineComplianceView {
  schemaVersion: 1;
  venueId: string;
  guidelineFrozenAt: string;
  evaluatedAt: string;
  manuscriptRevision: number | null;
  checks: GuidelineCheckView[];
  summary: {
    hardViolations: number;
    passCount: number;
    notEvaluatedCount: number;
    advisoryCount: number;
    topStatus: "COMPLIANT" | "HARD_VIOLATION" | "NOT_EVALUATED_ONLY";
  };
  provenance: { basis: string; disclaimer: string; guidelineConfidence: string };
}

export interface TargetGuidelineView {
  schemaVersion: 1;
  venueId: string;
  displayName: string;
  scope: { scopeStatement?: string; columnsZh?: string[]; quote?: string; sourceUrl?: string };
  requirements: Array<{ id: string; field: string; operator: string; value?: number; hard: boolean; officialQuote: string; sourceUrl: string }>;
  provenance: { sourceUrls: string[]; accessDate: string; confidence: string };
  frozenAt: string;
}

export interface TargetRubricDimensionView {
  dimension: string;
  verdict: "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE";
  evidenceQuotes: string[];
  gaps: string[];
  needsExpertReview: boolean;
}

export interface TargetRubricView {
  schemaVersion: 1;
  venueId: string;
  promptVersion: string;
  model?: string;
  evaluatedAt: string;
  manuscriptRevision: number | null;
  documentType: string;
  withBenchmarkBands: boolean;
  dimensions: TargetRubricDimensionView[];
  scopeRelevance: { inScope: boolean | null; evidence: string; columnMatch?: string };
  overall: { verdict: "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE" | "NEEDS_EXPERT_REVIEW"; rationale: string };
  summaryFailure?: string;
  provenance: { basis: string; disclaimer: string };
}

export async function getTargetGuideline(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetGuidelineView | null> {
  const body = await apiClient.get<{ guideline: TargetGuidelineView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/guideline`,
    signal,
  );
  return body.guideline ?? null;
}

export async function getTargetGuidelineCompliance(
  projectId: string,
  signal?: AbortSignal,
): Promise<GuidelineComplianceView | null> {
  const body = await apiClient.get<{ compliance: GuidelineComplianceView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/guideline/compliance`,
    signal,
  );
  return body.compliance ?? null;
}

/** 官方要求符合度评估（确定性零模型；指南工件须先经后端/驱动导入） */
export async function evaluateTargetGuidelineCompliance(
  projectId: string,
): Promise<{ compliance: GuidelineComplianceView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/guideline/compliance`);
}

export async function getTargetRubric(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetRubricView | null> {
  const body = await apiClient.get<{ rubric: TargetRubricView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/target/rubric`,
    signal,
  );
  return body.rubric ?? null;
}

/** 期刊级 rubric 评估（模型 advisory；omitBenchmarkBands=true 为 A3 消融形态） */
export async function evaluateTargetRubric(
  projectId: string,
  input: { omitBenchmarkBands?: boolean } = {},
): Promise<{ rubric: TargetRubricView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/rubric`, {
    ...(input.omitBenchmarkBands === true ? { omitBenchmarkBands: true } : {}),
  });
}

// ---- M15.16：证据审计（实验性；feature flag PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED）----

export type EvidenceAuditComparisonStatus =
  | "SUPPORTED_DIFFERENCE"
  | "POTENTIAL_OVERLAP"
  | "EVIDENCE_GAP"
  | "INSUFFICIENT_EVIDENCE";

export interface EvidenceAuditPriorWorkView {
  candidateId?: string;
  title: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  sourceLevel?: string;
  quote?: string;
  priorQuoteVerified?: boolean;
  resolvesToPool: boolean;
  timeCausalityViolation?: boolean;
}

export interface EvidenceAuditComparisonView {
  contributionId: string;
  nearestPriorWorks: EvidenceAuditPriorWorkView[];
  commonMechanism: string;
  substantiveDifference: string;
  differenceBasis: string;
  completedVerification: string;
  missingVerification: string;
  status: EvidenceAuditComparisonStatus;
  uncertainty?: string;
}

export interface EvidenceAuditGapPlanItemView {
  contributionId: string;
  gap: string;
  actionType: "can_rewrite_from_existing_evidence" | "requires_real_experiment_or_author_input";
  experimentPlan?: { purpose: string; baselines?: string; datasets?: string; metrics?: string; expectedEvidence?: string };
  status: "proposed" | "author_decision";
}

export interface EvidenceAuditArtifactView {
  schemaVersion: number;
  venueId?: string;
  documentType: string;
  promptVersion: string;
  model?: string;
  evaluatedAt: string;
  manuscriptRevision?: number | null;
  priorWork: {
    cutoffDate: string;
    poolFingerprint: string;
    poolSize: number;
    queriesUsed: string[];
    candidates: Array<{
      candidateId: string;
      title: string;
      year?: number;
      doi?: string;
      arxivId?: string;
      contentLevel: "abstract" | "metadata" | "verified_fulltext";
      citedByManuscript: boolean;
      source: string;
      librarySourceId?: string;
    }>;
  };
  inventory: Array<{
    contributionId: string;
    claimQuote: string;
    claimParaphrase?: string;
    claimType: string;
    sectionId: string;
    page?: number;
    supportStatus: string;
    anchorVerified: boolean;
    supportLocations: Array<{ sectionId: string; kind: string; quote?: string; verified: boolean }>;
  }>;
  comparisons: EvidenceAuditComparisonView[];
  gapPlan: EvidenceAuditGapPlanItemView[];
  findings: Array<{
    findingId: string;
    category: string;
    severity: string;
    sectionId: string;
    contributionId?: string;
    message: string;
    evidenceGap?: string;
    suggestion?: string;
    claimText?: string;
    priorWorkTitles?: string[];
    comparisonStatus?: EvidenceAuditComparisonStatus;
  }>;
  coverage: {
    sectionsTotal: number;
    sectionsIndexed: number;
    sectionsIncludedFullText: number;
    manuscriptCharsTotal: number;
    manuscriptCharsIncluded: number;
    truncations: string[];
  };
  guards: {
    anchorFailures: number;
    unresolvedPriorWorkRefs: number;
    cutoffViolations: number;
    statusRuleViolations: number;
    droppedFindings: number;
    priorQuoteReplayFailures: number;
    fulltextBasisDowngrades: number;
  };
  inputFingerprint: {
    manuscriptSha256: string;
    poolFingerprint: string;
    promptVersion: string;
    documentType: string;
    venueId?: string;
  };
  provenance: { basis: string; disclaimer: string };
}

export interface EvidenceAuditRunMetaView {
  schemaVersion: 1;
  evaluatedAt: string;
  venueId?: string;
  documentType: string;
  manuscriptRevision: number | null;
  poolBuild: {
    cutoffDate: string;
    referenceEntriesTotal: number;
    referenceEntriesEligible: number;
    refResolved: number;
    refUnresolved: number;
    refLookupErrors: number;
    externalQuery: string | null;
    externalRetrieved: number;
    libraryCandidates: number;
    libraryUpgraded: number;
    dedupedCandidates: number;
    selfExcluded: number;
    poolCap: number;
    contentLevels: { abstract: number; metadata: number; verified_fulltext: number };
    buildNotes: string[];
    extractorNotes: string[];
  };
  telemetry: { calls: number; failed: number; totalMs: number; approxPromptChars: number; outputChars: number };
  extractParseFailed: boolean;
  compareParseFailed: boolean;
  synthesizeParseFailed: boolean;
}

export interface TargetEvidenceAuditView {
  artifact: EvidenceAuditArtifactView;
  meta: EvidenceAuditRunMetaView | null;
  stale: boolean;
  staleReason?: string;
  currentManuscriptRevision: number | null;
}

export interface TargetEvidenceAuditStatus {
  enabled: boolean;
  audit: TargetEvidenceAuditView | null;
}

export async function getTargetEvidenceAudit(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetEvidenceAuditStatus> {
  return apiClient.get<TargetEvidenceAuditStatus>(
    `/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit`,
    signal,
  );
}

/** 执行证据审计（真实模型调用；flag off → 403 TARGET_EVIDENCE_AUDIT_DISABLED） */
export async function evaluateTargetEvidenceAudit(
  projectId: string,
): Promise<{ enabled: true; audit: TargetEvidenceAuditView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit`);
}

// ---- M15.17：审计差距 → 修订计划（确定性分类 / 作者决策 / 转入意见队列 / 闭环复评）----

export type AuditGapClassification =
  | "REWRITE_ELIGIBLE"
  | "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT"
  | "NEEDS_TARGETED_EVIDENCE"
  | "EVIDENCE_INSUFFICIENT"
  | "UNMAPPABLE_TARGET";

export interface AuditRevisionPlanItemView {
  itemId: string;
  contributionId: string;
  gap: string;
  sourceActionType: "can_rewrite_from_existing_evidence" | "requires_real_experiment_or_author_input";
  classification: AuditGapClassification;
  classificationReason: string;
  experimentPlan?: { purpose: string; baselines?: string; datasets?: string; metrics?: string; expectedEvidence?: string };
  anchor: {
    claimQuote: string;
    sectionId: string;
    anchorVerified: boolean;
    projection: {
      status: "resolved" | "unresolved";
      file?: string;
      basis?: string;
      ambiguous?: boolean;
      reason?: string;
    };
  };
  priorWork: Array<{
    title: string;
    year?: number;
    doi?: string;
    arxivId?: string;
    sourceLevel?: string;
    resolvesToPool: boolean;
    priorQuoteVerified?: boolean;
    timeCausalityViolation?: boolean;
  }>;
  comparisonStatus?: string;
  forbidden: { values: string[]; citationKeys: string[] };
  allowedScope: string;
  authorDecision?: { decision: "approve" | "reject"; decidedAt: string };
  instructionId?: string;
}

export interface AuditRevisionPlanView {
  plan: {
    schemaVersion: 1;
    planId: string;
    projectId: string;
    source: {
      auditArtifact: string;
      inputFingerprint: {
        manuscriptSha256: string;
        poolFingerprint: string;
        promptVersion: string;
        model?: string;
        documentType: string;
        venueId?: string;
      };
      auditEvaluatedAt: string;
      venueId?: string;
      documentType: string;
      manuscriptRevisionAtPlan: number | null;
    };
    createdAt: string;
    status: "generated" | "decided";
    items: AuditRevisionPlanItemView[];
    summary: {
      total: number;
      rewriteEligible: number;
      needsRealExperiment: number;
      needsTargetedEvidence: number;
      evidenceInsufficient: number;
      unmappable: number;
      approved: number;
      rejected: number;
    };
  } | null;
  fresh: boolean;
  staleReason?: string;
  currentManuscriptRevision: number | null;
  instructions: Array<{
    instructionId: string;
    status: string;
    statusNote?: string;
    section?: string;
  }>;
}

export type AuditGapClosure =
  | "VALIDATED_FIXED"
  | "PARTIALLY_ADDRESSED"
  | "STILL_OPEN"
  | "NEEDS_AUTHOR_DECISION"
  | "ALREADY_SATISFIED"
  | "AUTHOR_REJECTED"
  | "NOT_EVALUATED";

export interface AuditClosureReportView {
  schemaVersion: 1;
  reportId: string;
  planId: string;
  projectId: string;
  generatedAt: string;
  assessedAtRevision: number | null;
  auditStaleNow: boolean;
  items: Array<{
    itemId: string;
    classification: AuditGapClassification;
    closure: AuditGapClosure;
    basis: string;
    instruction?: { instructionId: string; status: string; statusNote?: string };
    patches?: Array<{ patchId: string; revision: number; finalStatus: string }>;
    verification?: { scope?: boolean; fact?: boolean; citation?: boolean; evidence?: boolean };
  }>;
  summary: { total: number } & Record<AuditGapClosure, number>;
  disclaimer: string;
}

export interface TargetAuditRevisionStatus {
  enabled: boolean;
  plan: AuditRevisionPlanView | null;
  report: AuditClosureReportView | null;
}

/** GET 修订计划 + 最近复评报告（flag off → {enabled:false, plan:null, report:null}） */
export async function getTargetAuditRevisionPlan(
  projectId: string,
  signal?: AbortSignal,
): Promise<TargetAuditRevisionStatus> {
  return apiClient.get<TargetAuditRevisionStatus>(
    `/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit/revision-plan`,
    signal,
  );
}

/** POST 生成修订计划（确定性；审计陈旧 → 409 TARGET_AUDIT_STALE fail-closed） */
export async function generateTargetAuditRevisionPlan(
  projectId: string,
): Promise<{ enabled: true; plan: AuditRevisionPlanView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit/revision-plan`);
}

/** POST 作者逐项决策（approve 的可改写项转入修订意见队列；不自动改稿） */
export async function decideTargetAuditRevisionPlan(
  projectId: string,
  decisions: Array<{ itemId: string; decision: "approve" | "reject" }>,
): Promise<{ enabled: true; plan: AuditRevisionPlanView }> {
  return apiClient.post(
    `/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit/revision-plan/decide`,
    { decisions },
  );
}

/** POST 闭环复评（确定性：指令状态 + patch lineage + 守卫结果 → 逐项闭环状态） */
export async function reassessTargetAuditRevision(
  projectId: string,
): Promise<{ enabled: true; report: AuditClosureReportView }> {
  return apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/target/evidence-audit/revision-plan/reassess`);
}
