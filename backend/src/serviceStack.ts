/**
 * Backend 服务栈装配。
 *
 * 把 ProjectStore / 各业务 Service / WorkflowServices 组装为单一入口，
 * 供 index.ts（生产）与测试共用，保证两侧装配一致。
 */

import { EvidenceStore } from "./evidence/EvidenceStore.js";
import { GenerationService } from "./generation/GenerationService.js";
import { LatexCompiler } from "./latex/LatexCompiler.js";
import { LatexImporter } from "./import/LatexImporter.js";
import { ManuscriptService } from "./manuscript/ManuscriptService.js";
import { ManuscriptOverviewService } from "./manuscript/ManuscriptOverviewService.js";
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
import { ResearchPlanExecutionService } from "./agents/researchPlanExecution.js";
import { ResearchPlanIterationService } from "./agents/researchPlanIteration.js";
import { ResearchCoverageService } from "./agents/researchCoverage.js";
import { ResearchGapService } from "./agents/researchGap.js";
import { ResearchLoopService } from "./agents/researchLoop.js";
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
import { buildDefaultFullTextResolvers, type FullTextResolver } from "./search/fullText.js";
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
  /**
   * M7.2 FullTextResolver 装配。缺省启用（Unpaywall 需 email 配置，未配置
   * 自动不注册）；enabled=false 不注入 FullTextSupport（promote 后台尝试
   * no-op，测试保持离线）；resolvers 覆盖默认装配（测试注入 fake）；
   * batchConcurrency 是 M9.3 批量解析的有界并发度（缺省 3）。
   */
  fullText?: {
    enabled?: boolean;
    resolvers?: FullTextResolver[];
    batchConcurrency?: number;
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
  /** Research Plan 执行层（M8.2）：批准 / 执行 approved 计划 + executionHistory 回填 */
  planExecution: ResearchPlanExecutionService;
  /** Research Plan 迭代层（M8.3.1）：列出迭代 / 派生新计划 / 切换活动计划 */
  planIteration: ResearchPlanIterationService;
  /** Research Coverage Analyzer（M8.3.2）：活动计划覆盖分析（只读派生视图） */
  coverage: ResearchCoverageService;
  /** Research Gap HITL（M8.3.3）：缺口确认 / 拒绝 / 从缺口派生下一轮计划 */
  gaps: ResearchGapService;
  /**
   * Controlled Research Loop（M8.4）：受控多轮研究执行器——把计划批准 /
   * 执行 / 覆盖 / 缺口决策 / 派生编排成带 HITL 断点的状态机（检索 / 覆盖 /
   * 缺口 / 派生全部委托上方既有服务，零逻辑复制）
   */
  loop: ResearchLoopService;
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
  /** 已有论文导入（File First：PDF 解析 / LaTeX 工程，一次调用建项目 + 定标题） */
  projectImport: ProjectImportService;
  /** Existing-LaTeX 导入器（/:id/import 与 projectImport 共用同一实例） */
  latexImport: LatexImporter;
  /** Manuscript 聚合视图（M7.0.3 只读：GET /api/projects/:id/manuscript） */
  manuscriptOverview: ManuscriptOverviewService;
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
  // Existing-LaTeX 导入器在栈内构造（projectImport 的 format=latex 路径与
  // HTTP 层 /:id/import 路由共用同一实例，避免两份状态口径）
  const latexImporter = new LatexImporter({ projects: options.projects, latex, log });
  const projectImport = new ProjectImportService({
    projects: options.projects,
    paperIngest,
    latexImporter,
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
    ...(options.fullText?.batchConcurrency !== undefined
      ? { batchConcurrency: options.fullText.batchConcurrency }
      : {}),
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
  // M8.2 计划执行层：只依赖 discovery 编排 + ProjectStore（research.json 读改写），
  // 不触碰 Runtime / Workflow / Provider 装配
  const planExecution = new ResearchPlanExecutionService({ projects: options.projects, discovery, log });
  // M8.3.1 计划迭代层：只依赖 ProjectStore（research.json 计划链读改写），
  // 不触碰 Runtime / Workflow / Discovery
  const planIteration = new ResearchPlanIterationService({ projects: options.projects, log });
  // M8.3.2 覆盖分析层：只读 research.json（活动计划）+ Evidence/Candidate
  // Store 列表，纯分析不落盘，不触碰 Runtime / Workflow / Discovery
  const coverage = new ResearchCoverageService({
    projects: options.projects,
    evidence,
    candidates,
    log,
  });
  // M8.3.3 缺口 HITL 层：覆盖缺口（proposed）→ 用户确认（accepted）→ 从
  // 缺口派生下一轮（委托 M8.3.1 planIteration.derive，单一派生逻辑）；
  // 只写 research.json gaps 决策记录，不触碰 Runtime / Workflow / Discovery
  const gaps = new ResearchGapService({
    projects: options.projects,
    coverage,
    planIteration,
    log,
  });
  // M8.4 受控多轮研究执行器：只依赖 planExecution / coverage / gaps 三个
  // 既有服务的委托入口 + ProjectStore（loop 字段读改写），不触碰 Runtime /
  // Workflow / Discovery——纯状态编排层
  const loop = new ResearchLoopService({
    projects: options.projects,
    planExecution,
    coverage,
    gaps,
    log,
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
  // M7.2 FullTextResolver（P-D 修复）：resolver 与 search provider 共享同一
  // ProviderHttpClient（超时 / 重试 / 熔断 / 健康一体）；Unpaywall email 复用
  // OpenAlex 礼貌池配置（PAPERTEAM_OPENALEX_MAILTO / CITATION_CONTACT_EMAIL），
  // 未配置则不注册 unpaywall（OpenAlex / arXiv 路径不受影响——optional 降级
  // 纪律）。挂载成功后的检索重建经 onFullTextAttached 接线（N-3）；
  // SourceNotIndexableError（扫描件等）由钩子包装层如实记录。
  if (options.fullText?.enabled !== false) {
    sourceImport.attachFullTextSupport({
      resolvers:
        options.fullText?.resolvers ??
        buildDefaultFullTextResolvers({
          http: providerHttp,
          ...(searchConfig.openalexMailto !== undefined ? { email: searchConfig.openalexMailto } : {}),
        }),
      http: providerHttp,
      analyzer: pdfAnalyzer,
      onFullTextAttached: async (projectId, sourceId) => {
        try {
          await retrieval.rebuildSource(projectId, sourceId);
        } catch (error) {
          // 全文挂载成功但不可索引（文本层过薄 / 解析失败）：resolve 不因此失败，
          // manifest 留 skipped 记录，下次检索 / rebuild 自愈口径不变
          log(`[retrieval] 全文挂载后重建 chunk 未成（${projectId}/${sourceId}）：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  }
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
  const manuscriptOverview = new ManuscriptOverviewService({
    projects: options.projects,
    revisions,
    manuscript,
    paperStore,
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
    planExecution,
    planIteration,
    coverage,
    gaps,
    loop,
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
    latexImport: latexImporter,
    reviewArtifacts,
    externalInstructions,
    revisions,
    artifacts,
    finalize,
    versions,
    manuscriptOverview,
    workflowServices: {
      projects: options.projects,
      generation,
      researcher,
      feasibility,
      reviewer,
      evidence,
      evidenceGrounding,
      evidenceSelection,
      candidates,
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
