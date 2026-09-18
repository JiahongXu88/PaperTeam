/**
 * Backend 服务栈装配。
 *
 * 把 ProjectStore / 各业务 Service / WorkflowServices 组装为单一入口，
 * 供 index.ts（生产）与测试共用，保证两侧装配一致。
 */

import { EvidenceStore } from "./evidence/EvidenceStore.js";
import { GenerationService } from "./generation/GenerationService.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { ManuscriptService } from "./manuscript/ManuscriptService.js";
import { ManuscriptRevisionStore } from "./manuscript/RevisionStore.js";
import { PaperArtifactStore } from "./artifacts/ArtifactStore.js";
import { FinalizeService } from "./artifacts/FinalizeService.js";
import { VersionService } from "./version/VersionService.js";
import { PaperIngestService } from "./paper/PaperIngestService.js";
import { PaperMapService } from "./paper/PaperMapService.js";
import { PaperStore } from "./paper/PaperStore.js";
import { ReviewContextBuilder } from "./paper/ReviewContextBuilder.js";
import { SectionReviewService } from "./paper/SectionReviewService.js";
import { PyMuPdfParser, type PdfParser } from "./paper/PdfParser.js";
import { ProjectStore } from "./project/ProjectStore.js";
import { ProjectImportService } from "./project/ProjectImportService.js";
import { FeasibilityService } from "./agents/FeasibilityService.js";
import { ResearcherService } from "./agents/ResearcherService.js";
import type { AgentRuntime } from "./runtime/types.js";
import { ReviewerService } from "./agents/ReviewerService.js";
import { SourceStore } from "./sources/SourceStore.js";
import { CandidateStore } from "./sources/CandidateStore.js";
import { SourceImportService } from "./sources/SourceImportService.js";
import { BuiltinPdfAnalyzer } from "./sources/PdfAnalyzer.js";
import { ProviderHttpClient } from "./search/providerHttp.js";
import { AcademicSearchService } from "./search/academicSearchService.js";
import { OpenAlexSearchProvider } from "./search/openalexProvider.js";
import { SemanticScholarSearchProvider } from "./search/semanticScholarProvider.js";
import { ArxivSearchProvider } from "./search/arxivProvider.js";
import { AMinerSearchProvider } from "./search/aminerProvider.js";
import { SearXNGProvider } from "./search/searxngProvider.js";
import { WebSearchService } from "./search/webSearchService.js";
import { ResearchDiscoveryService } from "./search/researchDiscoveryService.js";
import type { AcademicSearchProvider } from "./search/types.js";
import type { WebSearchProvider } from "./search/types.js";
import type { SearchConfig } from "./config/config.js";
import { ChunkStore } from "./retrieval/ChunkStore.js";
import { RetrievalService } from "./retrieval/RetrievalService.js";
import { SourceChunker } from "./retrieval/SourceChunker.js";
import type { EmbeddingProvider } from "./retrieval/types.js";
import { EvidenceCandidateStore } from "./evidence/candidates.js";
import { EvidenceGroundingService } from "./evidence/EvidenceGroundingService.js";
import { EvidenceSelectionService } from "./evidence/EvidenceSelectionService.js";
import { ChunkAccess } from "./evidence/chunkAccess.js";
import { WriterService } from "./writer/WriterService.js";
import { CitationService } from "./citation/CitationService.js";
import { CitationIntegrityService } from "./citation/CitationIntegrityService.js";
import { ReviewArtifactStore } from "./review/reviewArtifacts.js";
import { ExternalInstructionStore } from "./review/externalInstructions.js";
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
  /**
   * 长论文阶段（Writer / 三路 Reviewer / 分章节 Reviewer / Researcher）的逐 run 执行超时
   * （PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS）；缺省不覆盖（沿用 Runtime 通用默认）
   */
  longRunTimeoutMs?: number;
  review?: {
    maxRevisionRounds?: number;
    academicPassScore?: number;
    styleRiskMax?: number;
    sectionRetryBackoffMs?: readonly number[];
    /** section review 有界并发度（缺省 3） */
    reviewConcurrency?: number;
    /** benchmark / 诊断：限制单次审阅章节数（缺省 0 = 不限制） */
    reviewSectionLimit?: number;
  };
  /** PaperMap 章节摘要并发度（缺省 3） */
  summaryConcurrency?: number;
  citation?: {
    metadataEnabled?: boolean;
    maxMetadataLookups?: number;
    metadataTimeoutMs?: number;
    contactEmail?: string;
    /** 可注入 fetch（测试） */
    fetchImpl?: typeof fetch;
    /** scholarly resolver（PDF 引用核验；测试注入 providers/fetch） */
    scholarly?: ScholarlyResolverOptions;
  };
  /** Final PDF parser 注入（测试用 fake parser；缺省 PyMuPdfParser） */
  paperParser?: PdfParser;
  /** PyMuPdfParser 的解释器覆盖（PAPERTEAM_PDF_PYTHON）；注入 paperParser 时忽略 */
  pdfPythonCommand?: string;
  /**
   * Research Discovery（M6.3）：Academic / Web Search provider 装配。
   * 缺省零配置 = OpenAlex + arXiv + 匿名 S2（学术链路可用），SearXNG / AMiner
   * 未配置不注册；disabledProviders 可显式关停任一源。fetchImpl 供测试注入。
   */
  search?: SearchConfig & { fetchImpl?: typeof fetch };
  /**
   * Project Retrieval（M6.4）：chunk 预算覆盖（缺省 400/600/60）与可选
   * EmbeddingProvider（测试注入确定性 provider；生产默认不注册 =
   * lexical-only 健康运行，D-0033 optional 红线）。
   */
  retrieval?: {
    chunkTargetTokens?: number;
    chunkMaxTokens?: number;
    chunkOverlapTokens?: number;
    embedding?: EmbeddingProvider;
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
  /** Evidence 候选队列（M6.5：propose → ground 状态机；evidence/candidates.jsonl） */
  evidenceCandidates: EvidenceCandidateStore;
  /** Evidence Grounding 管道（M6.5：grounded EvidenceStore 写入的唯一入口） */
  evidenceGrounding: EvidenceGroundingService;
  /** Evidence 使用策略（M6.6：formal = verified + 锚点才进 Writer/Reviewer 正式上下文） */
  evidenceSelection: EvidenceSelectionService;
  /** chunk 精确回取（M6.5：get_chunk 工具与 quote 校验共用锚点；只读） */
  chunkAccess: ChunkAccess;
  sources: SourceStore;
  /** Discovery 候选（sources/candidates.json；非 authoritative，M6.2） */
  candidates: CandidateStore;
  /** 文献入库路径编排（DOI/arXiv/URL/BibTeX 导入 + promotion + enrich；M6.2） */
  sourceImport: SourceImportService;
  /** Research Discovery（M6.3）：Academic / Web Search 编排 + 显式 Candidate 持久化 */
  discovery: ResearchDiscoveryService;
  /** Project Retrieval（M6.4）：chunk 管线 + 进程内 hybrid index + Context Packing */
  retrieval: RetrievalService;
  pdfAnalyzer: BuiltinPdfAnalyzer;
  manuscript: ManuscriptService;
  citation: CitationService;
  citationIntegrity: CitationIntegrityService;
  latex: LatexCompiler;
  paperStore: PaperStore;
  /** 解析器实例（HTTP 诊断 / 启动自检读取工具链就绪度） */
  paperParser: PdfParser;
  paperIngest: PaperIngestService;
  paperMap: PaperMapService;
  reviewContext: ReviewContextBuilder;
  /** 已有论文 PDF 导入（File First：一次调用建项目 + 解析 + 定标题） */
  projectImport: ProjectImportService;
  reviewArtifacts: ReviewArtifactStore;
  /** 外部修改意见存储（M5.7） */
  externalInstructions: ExternalInstructionStore;
  /** manuscript 修订提交（M4.7） */
  revisions: ManuscriptRevisionStore;
  /** Draft / Final 产物存储（M4.7） */
  artifacts: PaperArtifactStore;
  /** Finalize：双 Gate 对齐校验 + Final 冻结（M4.7） */
  finalize: FinalizeService;
  /** 版本体验：ManuscriptVersionDTO / 确定性 Compare / Restore（M4.8） */
  versions: VersionService;
  workflowServices: WorkflowServices;
}

export function buildServiceStack(options: ServiceStackOptions): ServiceStack {
  const log = options.log ?? (() => {});
  const latex = options.latex ?? new LatexCompiler({ timeoutMs: 120_000 });
  const longRun = options.longRunTimeoutMs !== undefined ? { runTimeoutMs: options.longRunTimeoutMs } : {};
  const writer = new WriterService({
    runtime: options.runtime,
    agentId: options.agentIds.writer,
    ...longRun,
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
  const candidates = new CandidateStore(options.projects);
  const pdfAnalyzer = new BuiltinPdfAnalyzer();
  const manuscript = new ManuscriptService(options.projects);
  // researcher 构造后移到 evidenceGrounding 之后（M6.5：research 阶段的
  // chunk 锚定 evidence 走候选管道，需要 grounding 服务注入）
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
  const paperParser =
    options.paperParser ??
    new PyMuPdfParser({
      ...(options.pdfPythonCommand !== undefined ? { pythonCommand: options.pdfPythonCommand } : {}),
      log,
    });
  const paperIngest = new PaperIngestService({
    projects: options.projects,
    store: paperStore,
    parser: paperParser,
    log,
  });
  const paperMap = new PaperMapService({
    projects: options.projects,
    store: paperStore,
    runtime: options.runtime,
    reviewerAgentId: options.agentIds.reviewer,
    ...(options.summaryConcurrency !== undefined ? { concurrency: options.summaryConcurrency } : {}),
    log,
  });
  const reviewContext = new ReviewContextBuilder({ projects: options.projects, store: paperStore });
  const sectionReview = new SectionReviewService({
    runtime: options.runtime,
    reviewerAgentId: options.agentIds.reviewer,
    ...longRun,
  });
  const projectImport = new ProjectImportService({
    projects: options.projects,
    paperIngest,
    log,
  });
  // CITATION_METADATA_* 配置对 PDF 引用核验（citationIntegrity）同样生效——
  // 此前只接到旧 CitationService，quick review 的 citation.metadata stage 仍会真实外呼：
  //   metadataEnabled=false 且未显式注入 providers → 空 provider 集（逐条 UNRESOLVED，不外呼）
  //   metadataTimeoutMs / contactEmail → 传给 resolver（与旧 CitationService 同语义）
  // 显式注入的 scholarly.providers 优先于 disable（测试用 fake provider 提供 metadata 记录
  // 以驱动语义核验，见 citationSemanticMode.test）。
  const scholarlyOptions: ScholarlyResolverOptions = {
    ...(options.citation?.metadataTimeoutMs !== undefined
      ? { timeoutMs: options.citation.metadataTimeoutMs }
      : {}),
    ...(options.citation?.contactEmail !== undefined ? { contactEmail: options.citation.contactEmail } : {}),
    ...(options.citation?.scholarly ?? {}),
  };
  const citationIntegrity = new CitationIntegrityService({
    projects: options.projects,
    store: paperStore,
    runtime: options.runtime,
    citationAgentId: options.agentIds.citation,
    scholarly:
      options.citation?.scholarly?.providers === undefined && options.citation?.metadataEnabled === false
        ? { ...scholarlyOptions, providers: [] }
        : scholarlyOptions,
    ...(options.citation?.maxMetadataLookups !== undefined
      ? { maxMetadataLookups: options.citation.maxMetadataLookups }
      : {}),
    log,
  });
  // M6.2 文献入库路径：与 citationIntegrity 共享同一个 ScholarlyResolver 实例
  // （缓存 / 限速礼貌间隔 / telemetry 一体；metadataEnabled=false 的离线部署
  // 下 resolver 的 provider 集为空 → 导入按 unresolved 如实记录，不外呼）
  const sourceImport = new SourceImportService({
    projects: options.projects,
    sources,
    candidates,
    evidence,
    scholarly: citationIntegrity.scholarlyResolver,
    log,
  });
  // M6.3 Research Discovery：所有 search provider 共享一个 ProviderHttpClient
  // （超时 / 退避 / Retry-After / 熔断 / 健康状态一体维护）。装配纪律（D-0033）：
  // - OpenAlex primary / S2 enrichment-fallback（匿名可调）/ arXiv preprint 默认注册；
  // - AMiner（China secondary）仅在 API Key 存在时注册——无 key 不影响其余源；
  // - SearXNG（Web）仅在 URL 配置时注册——optional，无则 Web Search 结构化不可用；
  // - disabledProviders 显式关停；Crossref 不在此出现（MetadataResolver 职责不变）。
  const searchConfig: SearchConfig = {
    disabledProviders: options.search?.disabledProviders ?? [],
    providerTimeoutMs: options.search?.providerTimeoutMs ?? 10_000,
    ...(options.search?.searxngUrl !== undefined ? { searxngUrl: options.search.searxngUrl } : {}),
    // OpenAlex 礼貌池标识：专用配置优先，回退既有 CITATION_CONTACT_EMAIL（ADR §8）
    ...(options.search?.openalexMailto !== undefined
      ? { openalexMailto: options.search.openalexMailto }
      : options.citation?.contactEmail !== undefined
        ? { openalexMailto: options.citation.contactEmail }
        : {}),
    ...(options.search?.semanticScholarApiKey !== undefined
      ? { semanticScholarApiKey: options.search.semanticScholarApiKey }
      : {}),
    ...(options.search?.aminerApiKey !== undefined ? { aminerApiKey: options.search.aminerApiKey } : {}),
  };
  const providerHttp = new ProviderHttpClient({
    ...(options.search?.fetchImpl !== undefined ? { fetchImpl: options.search.fetchImpl } : {}),
    defaultTimeoutMs: searchConfig.providerTimeoutMs,
    log,
  });
  const disabled = new Set(searchConfig.disabledProviders);
  const academicProviders: AcademicSearchProvider[] = [];
  if (!disabled.has("openalex")) {
    academicProviders.push(
      new OpenAlexSearchProvider({
        http: providerHttp,
        ...(searchConfig.openalexMailto !== undefined ? { mailto: searchConfig.openalexMailto } : {}),
      }),
    );
  }
  if (!disabled.has("semantic-scholar")) {
    academicProviders.push(
      new SemanticScholarSearchProvider({
        http: providerHttp,
        ...(searchConfig.semanticScholarApiKey !== undefined
          ? { apiKey: searchConfig.semanticScholarApiKey }
          : {}),
      }),
    );
  }
  if (!disabled.has("arxiv")) {
    academicProviders.push(new ArxivSearchProvider({ http: providerHttp }));
  }
  if (!disabled.has("aminer") && searchConfig.aminerApiKey !== undefined) {
    academicProviders.push(new AMinerSearchProvider({ http: providerHttp, apiKey: searchConfig.aminerApiKey }));
  }
  const webProviders: WebSearchProvider[] = [];
  if (!disabled.has("searxng") && searchConfig.searxngUrl !== undefined) {
    try {
      webProviders.push(new SearXNGProvider({ http: providerHttp, baseUrl: searchConfig.searxngUrl }));
    } catch (error) {
      // URL 非法：不注册 + 启动日志如实记录（Web Search 不可用，不影响其余栈）
      log(`[search] SearXNG 未注册：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const discovery = new ResearchDiscoveryService({
    academic: new AcademicSearchService({ providers: academicProviders, log }),
    web: new WebSearchService(webProviders),
    candidates,
  });
  // M6.4 Project Retrieval：chunker 复用 paper 域 PyMuPdfParser（同一工具链，
  // blocks 带页码 + TOC 章节；不可用时 PDF 回退 builtin 文本层）。Embedding
  // 未注册 = lexical-only（dense 通道 optional，不阻塞任何主链路）。
  const chunkStore = new ChunkStore(options.projects);
  const retrieval = new RetrievalService({
    projects: options.projects,
    sources,
    chunker: new SourceChunker({
      parser: paperParser,
      chunkOptions: {
        targetTokens: options.retrieval?.chunkTargetTokens ?? 400,
        maxTokens: options.retrieval?.chunkMaxTokens ?? 600,
        overlapTokens: options.retrieval?.chunkOverlapTokens ?? 60,
      },
      log,
    }),
    chunkStore,
    ...(options.retrieval?.embedding !== undefined ? { embedding: options.retrieval.embedding } : {}),
    log,
  });
  // M6.5 Evidence Grounding：候选队列 + 三段核验管道（quote 逐字 → metadata →
  // 复用 Citation 角色的语义 judge）。只读 ChunkStore 落盘产物（不触碰检索层
  // 行为）；与 sourceImport / citationIntegrity 共享同一个 ScholarlyResolver
  // （缓存 / 限速 / telemetry 一体）；grounded EvidenceStore 写入唯一入口。
  const evidenceCandidates = new EvidenceCandidateStore(options.projects);
  const chunkAccess = new ChunkAccess({
    projects: options.projects,
    chunkStore,
    sources,
  });
  const evidenceGrounding = new EvidenceGroundingService({
    projects: options.projects,
    candidates: evidenceCandidates,
    evidence,
    chunkAccess,
    scholarly: citationIntegrity.scholarlyResolver,
    runtime: options.runtime,
    citationAgentId: options.agentIds.citation,
    log,
  });
  // M6.6 Evidence 使用策略（usableEvidence 下沉；verified + 三件套锚点才进正式上下文）
  const evidenceSelection = new EvidenceSelectionService(evidence);
  const researcher = new ResearcherService({
    runtime: options.runtime,
    agentId: options.agentIds.researcher,
    projects: options.projects,
    evidence,
    sources,
    evidenceGrounding,
    ...longRun,
    log,
  });
  const reviewer = new ReviewerService({
    runtime: options.runtime,
    agentId: options.agentIds.reviewer,
    projects: options.projects,
    ...longRun,
    log,
  });
  const reviewArtifacts = new ReviewArtifactStore(options.projects);
  const externalInstructions = new ExternalInstructionStore(options.projects);
  const revisions = new ManuscriptRevisionStore({ projects: options.projects });
  const artifacts = new PaperArtifactStore({ projects: options.projects });
  const finalize = new FinalizeService({
    projects: options.projects,
    reviewArtifacts,
    artifacts,
    revisions,
  });
  const versions = new VersionService({
    projects: options.projects,
    revisions,
    artifacts,
    reviewArtifacts,
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
    evidenceCandidates,
    evidenceGrounding,
    evidenceSelection,
    chunkAccess,
    sources,
    candidates,
    sourceImport,
    discovery,
    retrieval,
    pdfAnalyzer,
    manuscript,
    citation,
    citationIntegrity,
    latex,
    paperStore,
    paperParser,
    paperIngest,
    paperMap,
    reviewContext,
    projectImport,
    reviewArtifacts,
    externalInstructions,
    revisions,
    artifacts,
    finalize,
    versions,
    workflowServices: {
      projects: options.projects,
      generation,
      researcher,
      feasibility,
      reviewer,
      evidence,
      evidenceGrounding,
      evidenceSelection,
      sources,
      manuscript,
      writer,
      citation,
      latex,
      paper: {
        store: paperStore,
        map: paperMap,
        reviewContext,
        citationIntegrity,
        sectionReview,
      },
      reviewArtifacts,
      externalInstructions,
      revisions,
      artifacts,
      finalize,
      stageTimeoutMs: options.stageTimeoutMs ?? 900_000,
      stageMaxAttempts: options.stageMaxAttempts ?? 2,
      review: {
        maxRevisionRounds: options.review?.maxRevisionRounds ?? 2,
        academicPassScore: options.review?.academicPassScore ?? 80,
        styleRiskMax: options.review?.styleRiskMax ?? 35,
        ...(options.review?.sectionRetryBackoffMs !== undefined
          ? { sectionRetryBackoffMs: options.review.sectionRetryBackoffMs }
          : {}),
        reviewConcurrency: options.review?.reviewConcurrency ?? 3,
        reviewSectionLimit: options.review?.reviewSectionLimit ?? 0,
      },
    },
  };
}
