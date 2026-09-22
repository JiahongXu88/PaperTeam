/**
 * Literature Library（M6.2 Sources）DTO —— 与 Backend src/sources/SourceStore.ts
 * 及 httpServer sources 路由的 JSON 响应对齐。可选字段保持可选，UI 不虚构数据。
 * analysis / identity 内部结构不进前端 DTO（文献库列表与导入不需要）。
 */

/** 条目在项目中的角色（D-0012）：evidence=证据来源 / reference=参考范文 / both */
export type SourceRole = "evidence" | "reference" | "both";

/** 入库来源：文件上传 / 四种标识符导入 / 检索自动入库（M6.3+ 预留） */
export type SourceOrigin =
  | "USER_ADDED"
  | "DOI_IMPORT"
  | "ARXIV_IMPORT"
  | "URL_IMPORT"
  | "BIBTEX_IMPORT"
  | "AGENT_RETRIEVED";

/** 条目状态：metadata_only（有元数据无全文）→ pending → available / partial / failed + rejected */
export type SourceStatus =
  | "pending"
  | "metadata_only"
  | "available"
  | "partial"
  | "failed"
  | "rejected";

/** 条目类型：前五种对应上传文件（按扩展名推断），后四种是 metadata-only 导入 */
export type SourceType =
  | "pdf"
  | "bibtex"
  | "text"
  | "markdown"
  | "image"
  | "doi"
  | "arxiv"
  | "url"
  | "metadata";

/** 同一研究工作内的版本类型（link 关系的语义标注；不参与身份判等） */
export type SourceVersionType = "preprint" | "conference" | "journal" | "other";

export interface SourceMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
  url?: string;
  venue?: string;
  abstract?: string;
}

export interface SourceItemView {
  sourceId: string;
  /** 存储文件名；metadata-only 条目（DOI/arXiv/URL 导入）为空 */
  fileName?: string;
  originalName?: string;
  sourceType?: SourceType;
  sourceRole: SourceRole;
  origin: SourceOrigin;
  status: SourceStatus;
  preferred: boolean;
  metadata: SourceMetadata;
  /** 元数据可信层级：user > resolved > inferred；缺省视为 inferred（老数据） */
  metadataProvenance?: "user" | "resolved" | "inferred";
  contentHash?: string;
  workKey?: string;
  versionType?: SourceVersionType;
  relatedSourceIds?: string[];
  /**
   * 全文获取 provenance（M9.3 前端消费；Backend 全量序列化，此处只取
   * 状态列需要的最小子集——判等键细节不进 DTO）。缺省 = 老数据 / 未尝试。
   */
  fullText?: SourceFullTextView;
  /** 身份键子集（Backend 全量序列化；UI 只用于「可否自动获取全文」判定） */
  identity?: { doi?: string; arxivId?: string; openalexId?: string };
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 全文获取 provenance（与 Backend SourceFullTextProvenance 对齐）：
 * resolved=全文已挂载；not_found=明确无 OA（重试无意义）；failed=系统性失败
 * （可重试）。manual-upload 是 resolver 字段的保留值（手动补挂来源标记）。
 */
export interface SourceFullTextView {
  status: "resolved" | "not_found" | "failed";
  /** 命中的 resolver（unpaywall / oa-url / arxiv / manual-upload） */
  resolver?: string;
  url?: string;
  license?: string;
  note?: string;
  attempts: number;
  attemptedAt: string;
  resolvedAt?: string;
  bytes?: number;
}

/** 全文解析调用结局（Backend FullTextOutcome；数据不是异常） */
export type FullTextOutcomeView =
  | "resolved"
  | "not_found"
  | "failed"
  | "skipped_has_file"
  | "not_resolvable";

/** 单篇全文解析响应：POST /sources/:sid/resolve-fulltext | POST /sources/:sid/fulltext */
export interface FullTextResolveResultView {
  source: SourceItemView;
  outcome: FullTextOutcomeView;
  note?: string;
}

/** 批量全文解析响应（M9.3；partial success 汇总） */
export interface BatchFullTextResultView {
  summary: {
    total: number;
    resolved: number;
    notFound: number;
    failed: number;
    notResolvable: number;
    skipped: number;
  };
  results: Array<{
    sourceId: string;
    outcome: FullTextOutcomeView;
    source?: SourceItemView;
    note?: string;
  }>;
}

/** DOI / arXiv 导入附带的元数据解析记录（如实呈现 resolver 结论；解析失败不阻塞导入） */
export interface SourceResolveNote {
  outcome: "match" | "mismatch" | "ambiguous" | "not_found" | "unresolved";
  provider?: string;
  note?: string;
}

/** DOI / arXiv / URL 导入响应：created=false = 库中已有同身份条目（幂等） */
export interface SourceImportResult {
  source: SourceItemView;
  created: boolean;
  resolve?: SourceResolveNote;
}

/** BibTeX 批量导入响应（恒 200）：逐条独立判等，解析错误逐条记录不中断 */
export interface BibTexImportResultView {
  results: Array<{ source: SourceItemView; created: boolean; entryKey: string }>;
  errors: Array<{ line: number; message: string }>;
}

/** 标识符导入的四种模式（对应四个后端端点） */
export type SourceImportMode = "doi" | "arxiv" | "url" | "bibtex";

/**
 * Discovery 候选（M7.1c 前端消费）——与 Backend src/sources/CandidateStore.ts
 * 的 CandidateSource 对齐。identity 内部结构（判等键）不进前端 DTO，展示
 * 用顶层元数据字段即可。候选 ≠ 正式文献：promote 前只存在于 candidates.json。
 */

/** 候选生命周期：pending_review → accepted（promote 成功）| rejected（用户否决） */
export type CandidateStatus = "pending_review" | "accepted" | "rejected";

/** 候选发现方：学术检索 / Web 检索（M6.3 discovery 写入）/ 手动添加（M6.2） */
export type CandidateOrigin = "academic_search" | "web_search" | "manual";

export interface CandidateSourceView {
  candidateId: string;
  origin: CandidateOrigin;
  /** 发现方（openalex / searxng / manual / …） */
  provider: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  snippetOrAbstract?: string;
  /** 发现该候选的检索词（provenance） */
  query?: string;
  status: CandidateStatus;
  /** promotion 后指向正式 Source（幂等重入依据） */
  promotedSourceId?: string;
  createdAt: string;
  updatedAt: string;
}

/** promote 响应：created=false = 文献库已有同身份条目（幂等合并返回既有） */
export interface CandidatePromoteResult {
  source: SourceItemView;
  created: boolean;
  candidate: CandidateSourceView;
}
