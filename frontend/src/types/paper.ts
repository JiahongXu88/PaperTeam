/**
 * PDF Review / Citation Integrity / Skills 的前端视图类型（M4.3.7）。
 * 与 Backend API 响应一一对应（server state，只经 TanStack Query 流动）。
 */

// ---- Paper（M4.3.1/2） ----

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

// ---- Citations（M4.3.3-5） ----

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

export type MetadataStatus =
  | "VERIFIED"
  | "METADATA_MISMATCH"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "UNRESOLVED";

export interface MetadataRecordView {
  referenceId: string;
  status: MetadataStatus;
  probableFabrication: boolean;
  canonical?: {
    provider: string;
    recordId: string;
    title?: string;
    year?: number;
    venue?: string;
    doi?: string;
  };
  mismatches?: Array<{ field: string; expected?: string; actual?: string }>;
}

export type SemanticVerdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE"
  | "SKIPPED";

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

// ---- Skills（M4.3.6） ----

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
