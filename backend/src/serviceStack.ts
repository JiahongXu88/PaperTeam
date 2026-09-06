/**
 * Backend 服务栈装配（M3.1）。
 *
 * 把 ProjectStore / 各业务 Service / WorkflowServices 组装为单一入口，
 * 供 index.ts（生产）与测试共用，保证两侧装配一致。
 */

import { EvidenceStore } from "./evidence/EvidenceStore.js";
import { GenerationService } from "./generation/GenerationService.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { ManuscriptService } from "./manuscript/ManuscriptService.js";
import { PaperIngestService } from "./paper/PaperIngestService.js";
import { PaperMapService } from "./paper/PaperMapService.js";
import { PaperStore } from "./paper/PaperStore.js";
import { ReviewContextBuilder } from "./paper/ReviewContextBuilder.js";
import { ProjectStore } from "./project/ProjectStore.js";
import { FeasibilityService } from "./agents/FeasibilityService.js";
import { ResearcherService } from "./agents/ResearcherService.js";
import type { AgentRuntime } from "./runtime/types.js";
import { ReviewerService } from "./agents/ReviewerService.js";
import { SourceStore } from "./sources/SourceStore.js";
import { BuiltinPdfAnalyzer } from "./sources/PdfAnalyzer.js";
import { WriterService } from "./writer/WriterService.js";
import { CitationService } from "./citation/CitationService.js";
import { CitationIntegrityService } from "./citation/CitationIntegrityService.js";
import type { ScholarlyResolverOptions } from "./citation/scholarly.js";
import type { WorkflowServices } from "./workflow/definitions.js";

export interface ServiceStackOptions {
  runtime: AgentRuntime;
  projects: ProjectStore;
  latex?: LatexCompiler;
  agentIds: {
    writer: string;
    researcher: string;
    reviewer: string;
    citation: string;
  };
  stageTimeoutMs?: number;
  stageMaxAttempts?: number;
  review?: {
    maxRevisionRounds?: number;
    academicPassScore?: number;
    styleRiskMax?: number;
  };
  citation?: {
    metadataEnabled?: boolean;
    maxMetadataLookups?: number;
    metadataTimeoutMs?: number;
    contactEmail?: string;
    /** 可注入 fetch（测试） */
    fetchImpl?: typeof fetch;
    /** M4.3.4 scholarly resolver（PDF 引用核验；测试注入 providers/fetch） */
    scholarly?: ScholarlyResolverOptions;
  };
  log?: (message: string) => void;
}

export interface ServiceStack {
  runtime: AgentRuntime;
  agentIds: ServiceStackOptions["agentIds"];
  projects: ProjectStore;
  writer: WriterService;
  generation: GenerationService;
  researcher: ResearcherService;
  feasibility: FeasibilityService;
  reviewer: ReviewerService;
  evidence: EvidenceStore;
  sources: SourceStore;
  pdfAnalyzer: BuiltinPdfAnalyzer;
  manuscript: ManuscriptService;
  citation: CitationService;
  citationIntegrity: CitationIntegrityService;
  latex: LatexCompiler;
  paperStore: PaperStore;
  paperIngest: PaperIngestService;
  paperMap: PaperMapService;
  reviewContext: ReviewContextBuilder;
  workflowServices: WorkflowServices;
}

export function buildServiceStack(options: ServiceStackOptions): ServiceStack {
  const log = options.log ?? (() => {});
  const latex = options.latex ?? new LatexCompiler({ timeoutMs: 120_000 });
  const writer = new WriterService({
    runtime: options.runtime,
    agentId: options.agentIds.writer,
    log,
  });
  const generation = new GenerationService({
    projects: options.projects,
    writer,
    latex,
    log,
  });
  const evidence = new EvidenceStore(options.projects);
  const sources = new SourceStore(options.projects);
  const pdfAnalyzer = new BuiltinPdfAnalyzer();
  const manuscript = new ManuscriptService(options.projects);
  const researcher = new ResearcherService({
    runtime: options.runtime,
    agentId: options.agentIds.researcher,
    projects: options.projects,
    evidence,
    sources,
    log,
  });
  const feasibility = new FeasibilityService({
    runtime: options.runtime,
    agentId: options.agentIds.researcher,
    projects: options.projects,
    log,
  });
  const citation = new CitationService({
    projects: options.projects,
    ...(options.citation?.metadataEnabled !== undefined
      ? { metadataEnabled: options.citation.metadataEnabled }
      : {}),
    ...(options.citation?.maxMetadataLookups !== undefined
      ? { maxMetadataLookups: options.citation.maxMetadataLookups }
      : {}),
    ...(options.citation?.metadataTimeoutMs !== undefined
      ? { metadataTimeoutMs: options.citation.metadataTimeoutMs }
      : {}),
    ...(options.citation?.contactEmail !== undefined
      ? { contactEmail: options.citation.contactEmail }
      : {}),
    ...(options.citation?.fetchImpl !== undefined
      ? { fetchImpl: options.citation.fetchImpl }
      : {}),
    log,
  });
  const paperStore = new PaperStore(options.projects);
  const paperIngest = new PaperIngestService({
    projects: options.projects,
    store: paperStore,
    log,
  });
  const paperMap = new PaperMapService({
    projects: options.projects,
    store: paperStore,
    runtime: options.runtime,
    reviewerAgentId: options.agentIds.reviewer,
    log,
  });
  const reviewContext = new ReviewContextBuilder({ projects: options.projects, store: paperStore });
  const citationIntegrity = new CitationIntegrityService({
    projects: options.projects,
    store: paperStore,
    runtime: options.runtime,
    citationAgentId: options.agentIds.citation,
    ...(options.citation?.scholarly !== undefined ? { scholarly: options.citation.scholarly } : {}),
    ...(options.citation?.maxMetadataLookups !== undefined
      ? { maxMetadataLookups: options.citation.maxMetadataLookups }
      : {}),
    log,
  });
  const reviewer = new ReviewerService({
    runtime: options.runtime,
    agentId: options.agentIds.reviewer,
    projects: options.projects,
    log,
  });
  return {
    runtime: options.runtime,
    agentIds: options.agentIds,
    projects: options.projects,
    writer,
    generation,
    researcher,
    feasibility,
    reviewer,
    evidence,
    sources,
    pdfAnalyzer,
    manuscript,
    citation,
    citationIntegrity,
    latex,
    paperStore,
    paperIngest,
    paperMap,
    reviewContext,
    workflowServices: {
      projects: options.projects,
      generation,
      researcher,
      feasibility,
      reviewer,
      evidence,
      sources,
      manuscript,
      writer,
      citation,
      latex,
      stageTimeoutMs: options.stageTimeoutMs ?? 900_000,
      stageMaxAttempts: options.stageMaxAttempts ?? 2,
      review: {
        maxRevisionRounds: options.review?.maxRevisionRounds ?? 2,
        academicPassScore: options.review?.academicPassScore ?? 80,
        styleRiskMax: options.review?.styleRiskMax ?? 35,
      },
    },
  };
}
