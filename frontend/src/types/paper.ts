/**
 * PDF Review / Citation Integrity / Skills 的前端视图类型。
 * 与 Backend API 响应一一对应（server state，只经 TanStack Query 流动）。
 */

// ---- Paper ----

export interface PaperDocSummary {
  projectId: string;
  documentId: string;
  title?: string;
  originalFileName: string;
  bytes: number;
  sha256: string;
  parse: {
    parserId: string;
    parserVersion?: string;
    parsedAt: string;
    durationMs: number;
    pageCount: number;
    extractionQuality: "good" | "partial" | "poor";
    notes?: string[];
  };
  pageCount: number;
  sectionCount: number;
  chunkCount: number;
  abstractSectionId?: string;
  referencesSectionId?: string;
  ingestedAt: string;
}

export interface PaperSectionView {
  sectionId: string;
  title: string;
  level: number;
  pageStart: number;
  pageEnd: number;
  charCount: number;
  source: "toc" | "heading-pattern" | "whole-document";
}

export interface PaperResponse {
  document: PaperDocSummary | null;
  sections?: PaperSectionView[];
  stages?: Record<string, Record<string, unknown>>;
  note?: string;
}

// ---- Citations ----

export interface ExtractionSummary {
  extracted: boolean;
  references: number;
  callouts: number;
  resolvedRelations: number;
  unresolvedRelations: number;
  invalidRelations: number;
  referencesWithDoi: number;
}

export interface ReferenceView {
  referenceId: string;
  number?: number;
  rawText: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  page: number;
}

/** 引用条目类型（software 经官方 repository/docs 核验，学术库未收录 ≠ 未找到） */
export type ReferenceKindView =
  | "scholarly_paper"
  | "software"
  | "dataset"
  | "documentation"
  | "web_resource"
  | "unknown";

export type MetadataStatus =
  | "VERIFIED"
  | "METADATA_MISMATCH"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "UNRESOLVED";

export interface SoftwareSourceView {
  repositoryUrl: string;
  homepage?: string;
  description?: string;
  stars?: number;
  pushedAt?: string;
}

export interface MetadataRecordView {
  referenceId: string;
  status: MetadataStatus;
  kind?: ReferenceKindView;
  probableFabrication: boolean;
  canonical?: {
    provider: string;
    recordId: string;
    title?: string;
    authors?: string[];
    year?: number;
    venue?: string;
    doi?: string;
    url?: string;
    software?: SoftwareSourceView;
  };
  mismatches?: Array<{ field: string; expected?: string; actual?: string; note?: string }>;
  /** 各学术库查询结果（核验详情用；note 是后端诊断信息，不在 UI 展示） */
  attempts?: Array<{ provider: string; outcome: string; note?: string }>;
  checkedAt?: string;
}

export type SemanticVerdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE"
  | "SKIPPED";

/** 证据不足 / 跳过的结构化原因（有限枚举） */
export type InsufficientReasonCodeView =
  | "NO_EVIDENCE"
  | "ABSTRACT_ONLY"
  | "FULLTEXT_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "REFERENCE_UNVERIFIED"
  | "LOW_RELEVANCE";

export type EvidenceLevelView =
  | "abstract"
  | "metadata"
  | "snippet"
  | "web"
  | "fulltext"
  | "repository"
  | "official_docs";

export interface EvidenceRecordView {
  source: string;
  text: string;
  evidenceLevel: EvidenceLevelView;
  page?: number;
  url?: string;
  doi?: string;
}

/** 一条 (claim, citation) 语义核验记录（同文献多处被引 = 多条记录） */
export interface ClaimRecordView {
  claimCitationId: string;
  citationId: string;
  referenceId: string;
  claimText: string;
  sectionId: string;
  page: number;
  priority: "obligatory" | "helpful";
  metadataStatus: MetadataStatus | "SKIPPED_NO_METADATA";
  verdict: SemanticVerdict;
  reason?: string;
  reasonCode?: InsufficientReasonCodeView;
  evidence: EvidenceRecordView[];
  severity: "critical" | "major" | "minor" | "info";
  status: "pending" | "verified" | "skipped" | "failed";
  model?: string;
  error?: string;
  verifiedAt?: string;
}

export interface IntegrityReportView {
  metadataByStatus: Record<MetadataStatus, number>;
  probableFabrications: string[];
  semantic: {
    total: number;
    byVerdict: Record<SemanticVerdict, number>;
    gate: {
      probableFabricated: number;
      notFoundObligatory: number;
      unsupportedCritical: number;
      mismatchCritical: number;
      insufficientEvidence: number;
    };
  };
}

// ---- Skills ----

export interface SkillView {
  id: string;
  name: string;
  originalDescription: string;
  chineseSummary?: string;
  sourceType: "builtin" | "external" | "local";
  sourceRepo?: string;
  sourceRevision?: string;
  version?: string;
  license?: string;
  installedPath: string;
  contentHash: string;
  status: "installed" | "disabled";
  installedAt: string;
  updatedAt: string;
  assignedAgents: string[];
  allowedTools: string[];
  summaryStatus: "ok" | "summary_pending" | "stale";
  wrapperNote?: string;
}

export interface SkillBindingView {
  agentRole: string;
  skillIds: string[];
}
