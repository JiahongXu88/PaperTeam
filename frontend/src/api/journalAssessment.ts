/**
 * 目标期刊评估 API（M15 Target Journal Assessment）。
 *
 *   GET  /api/projects/:id/target/journal-profiles                      → { profiles }
 *   POST /api/projects/:id/target/journal-profiles/:journalId/refresh   → { verification, trust }
 *   GET  /api/projects/:id/target/journal-assessment                    → { assessment | null }
 *   POST /api/projects/:id/target/journal-assessment                    → { assessment }
 *   POST /api/projects/:id/target/journal-assessment/revision-instructions → { created, skipped, instructions }
 *
 * 视图类型与 backend/src/target/journal/{assessment,criteria,profileTypes}.ts 同形。
 * 评估不产生任何 gate / passed；外部效度恒 EXTERNAL_CALIBRATION_NOT_VALIDATED。
 */
import { apiClient } from "./client.js";

export type JournalArticleType = "research" | "survey" | "systematic_review" | "dataset" | "code" | "protocol";

export const ARTICLE_TYPE_LABELS: Record<JournalArticleType, string> = {
  research: "研究论文",
  survey: "综述（叙述性）",
  systematic_review: "系统综述 / Meta 分析",
  dataset: "数据集论文",
  code: "代码论文",
  protocol: "研究方案 / 实验规程",
};

export type JournalVerificationStatus = "VERIFIED_SNAPSHOT" | "VERIFIED_LIVE" | "STALE" | "SOURCE_CHANGED" | "UNREACHABLE" | "UNVERIFIED";

export interface JournalTrustView {
  status: JournalVerificationStatus;
  verifiedAt: string | null;
  ageDays: number | null;
  trusted: boolean;
  note: string;
}

export interface JournalProfileSummaryView {
  journalId: string;
  displayName: string;
  nameEn?: string;
  issn: string[];
  language: "zh" | "en";
  rulesVersion: string;
  ruleCount: number;
  articleTypes: Array<{ type: JournalArticleType; accepted: boolean | null; labelOfficial: string; officialQuote: string; sourceUrl: string; note?: string }>;
  verification: JournalTrustView;
  sourcePages: Array<{ url: string; sha256: string; role: string }>;
}

export type CriterionStatus = "SATISFIED" | "VIOLATED" | "NOT_EVALUATED" | "NOT_APPLICABLE";
export type EvidenceLevel = "verified" | "author-check" | "model-opinion" | "unassessed";

export interface JournalCriterionView {
  criterionId: string;
  ruleId: string;
  category: "submission_requirement" | "article_type" | "scope";
  kind: "hard_deterministic" | "evidence_based" | "advisory" | "unknown" | "article_type";
  title: string;
  status: CriterionStatus;
  blocking: boolean;
  evidenceLevel: EvidenceLevel;
  observed: string;
  expected: string;
  why: string;
  location: string;
  officialQuote: string;
  sourceUrl: string;
  sourceStatus: "QUOTE_VERIFIED_LIVE" | "SNAPSHOT" | "QUOTE_NOT_FOUND" | "UNVERIFIED";
  reliability: "high" | "medium";
  suggestion: string;
  actionability: string;
  convertible: boolean;
  requiresAuthorDecision: boolean;
  gap?: string;
}

export interface JournalRiskFindingView {
  findingId: string;
  source: string;
  category: string;
  title: string;
  evidenceLevel: EvidenceLevel;
  affectsVerdict: boolean;
  detail: string;
  location: string;
  suggestion: string;
  evidenceQuotes?: string[];
}

export interface JournalFitEvidenceView {
  fitId: string;
  aspect: "article_type" | "scope" | "language" | "recent_publications";
  status: "MATCH" | "VERIFIED_MISMATCH" | "OBSERVED_DIFFERENCE" | "MODEL_OPINION" | "UNASSESSED";
  evidenceLevel: EvidenceLevel;
  detail: string;
  sourceUrl?: string;
  referenceKind?: "POSITIVE_ONLY_REFERENCE";
}

export type JournalAssessmentVerdict =
  | "READY_FOR_AUTHOR_SUBMISSION_REVIEW"
  | "CHANGES_REQUIRED"
  | "BLOCKED_BY_VERIFIED_ISSUE"
  | "INSUFFICIENT_EVIDENCE"
  | "JOURNAL_PROFILE_UNVERIFIED";

export interface JournalAssessmentView {
  schemaVersion: "journal-assessment/v1";
  assessmentId: string;
  projectId: string;
  generatedAt: string;
  articleType: JournalArticleType;
  manuscript: { revision: number | null; revisionHash: string; fidelity: "latex" | "pdf" | "none"; fileCount: number };
  journal: {
    journalId: string | null;
    displayName: string;
    profileHash: string | null;
    rulesVersion: string | null;
    verification: JournalTrustView;
    sourcePages: Array<{ url: string; role: string; sha256: string }>;
    indexing: Array<{ label: string; status: "SELF_DECLARED" | "UNVERIFIED"; officialQuote?: string; sourceUrl?: string; year?: string }>;
    scope: { statement: string; topics: string[]; officialQuote: string; sourceUrl: string } | null;
  };
  criteria: JournalCriterionView[];
  riskFindings: JournalRiskFindingView[];
  subjectiveEstimates: Array<{ dimension: string; verdict: string; evidenceQuotes: string[]; needsExpertReview: boolean }>;
  fitEvidence: JournalFitEvidenceView[];
  summary: {
    verdict: JournalAssessmentVerdict;
    statement: string;
    reasons: string[];
    observableRequirements: { satisfied: number; violated: number; denominator: number; notEvaluated: number; notApplicable: number; authorCheck: number; advisory: number };
    authorChecks: string[];
    unknowns: string[];
  };
  capabilities: Record<string, string>;
  uncertainty: string[];
  externalValidity: { status: "EXTERNAL_CALIBRATION_NOT_VALIDATED"; independentHumanLabels: number; benchmarkProvenance: string; statement: string };
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/target`;

export async function listJournalProfiles(projectId: string, signal?: AbortSignal): Promise<JournalProfileSummaryView[]> {
  const body = await apiClient.get<{ profiles: JournalProfileSummaryView[] }>(`${base(projectId)}/journal-profiles`, signal);
  return body.profiles;
}

export async function refreshJournalProfile(projectId: string, journalId: string): Promise<{ trust: JournalTrustView }> {
  return apiClient.post(`${base(projectId)}/journal-profiles/${encodeURIComponent(journalId)}/refresh`, {});
}

export async function getJournalAssessment(projectId: string, signal?: AbortSignal): Promise<JournalAssessmentView | null> {
  const body = await apiClient.get<{ assessment: JournalAssessmentView | null }>(`${base(projectId)}/journal-assessment`, signal);
  return body.assessment ?? null;
}

export async function evaluateJournalAssessment(
  projectId: string,
  input: { journalId: string; articleType: JournalArticleType; includeModelReview?: boolean },
): Promise<{ assessment: JournalAssessmentView }> {
  return apiClient.post(`${base(projectId)}/journal-assessment`, input);
}

export async function convertJournalCriteriaToRevision(
  projectId: string,
  input: { assessmentId: string; criterionIds: string[] },
): Promise<{ created: Array<{ instructionId: string }>; skipped: Array<{ criterionId: string; reason: string }> }> {
  return apiClient.post(`${base(projectId)}/journal-assessment/revision-instructions`, input);
}
