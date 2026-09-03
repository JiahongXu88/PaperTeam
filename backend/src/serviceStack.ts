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
import { ProjectStore } from "./project/ProjectStore.js";
import { FeasibilityService } from "./agents/FeasibilityService.js";
import { ResearcherService } from "./agents/ResearcherService.js";
import type { AgentRuntime } from "./runtime/types.js";
import { SourceStore } from "./sources/SourceStore.js";
import { BuiltinPdfAnalyzer } from "./sources/PdfAnalyzer.js";
import { WriterService } from "./writer/WriterService.js";
import { CitationService } from "./citation/CitationService.js";
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
  citation?: {
    metadataEnabled?: boolean;
    maxMetadataLookups?: number;
    metadataTimeoutMs?: number;
    contactEmail?: string;
    /** 可注入 fetch（测试） */
    fetchImpl?: typeof fetch;
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
  evidence: EvidenceStore;
  sources: SourceStore;
  pdfAnalyzer: BuiltinPdfAnalyzer;
  manuscript: ManuscriptService;
  citation: CitationService;
  latex: LatexCompiler;
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
  return {
    runtime: options.runtime,
    agentIds: options.agentIds,
    projects: options.projects,
    writer,
    generation,
    researcher,
    feasibility,
    evidence,
    sources,
    pdfAnalyzer,
    manuscript,
    citation,
    latex,
    workflowServices: {
      projects: options.projects,
      generation,
      researcher,
      feasibility,
      evidence,
      sources,
      manuscript,
      writer,
      citation,
      latex,
      stageTimeoutMs: options.stageTimeoutMs ?? 900_000,
      stageMaxAttempts: options.stageMaxAttempts ?? 2,
    },
  };
}
