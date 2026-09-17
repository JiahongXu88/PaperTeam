/**
 * Project Retrieval 领域模型（M6.4：D-0033 第 6 层 RetrievalService+RetrievalIndex）。
 *
 * 边界纪律（D-0033 / 指令冻结）：
 * - Search ≠ RAG ≠ Evidence：本域只消费「已入库且有真实全文的正式 Source」，
 *   产出 RetrievedChunk——**Retrieved ≠ Verified**，任何本域组件不得写
 *   EvidenceStore（M6.5 才做 EvidenceCandidate / quote 校验）；
 * - Index = Derived State：SourceChunk 落盘（sources/chunks/）、进程内索引与
 *   向量旁车文件全部可删除可重建，不能成为唯一事实来源；
 * - 无 Vector DB / 无外部数据库进程（D-0033 拒绝项）；单项目几十篇 ×
 *   数千 chunk 的进程内索引规模。
 *
 * SourceChunk 可回溯链（硬 invariant）：
 *   Project → Source（manifest 绑定 sourceContentHash）→ Section → Page（parser
 *   能提供时）→ Chunk → 原文（chunkId 确定性、text 逐字来自解析层）。
 */

import type { SourceRole, SourceType } from "../sources/SourceStore.js";

/** 稳定 chunk 身份："<sourceId>:<sectionId>:<节内序号>:<内容hash10>" */
export type SourceChunkId = string;

export interface SourceChunk {
  chunkId: SourceChunkId;
  projectId: string;
  sourceId: string;
  sectionId: string;
  /** 章节标题（TOC / 标题正则 / markdown 标题；退化路径为 "Whole Document"） */
  sectionTitle: string;
  /** 层级 >1 时的最近小节标题（如存在；filter/展示用） */
  subsection?: string;
  /** 1-based 页码（parser 无法提供时省略——不伪造页码） */
  pageStart?: number;
  pageEnd?: number;
  /** source 内文档顺序（1 起单调递增；邻近判定与排序用） */
  ordinal: number;
  /** 逐字来自解析层的 chunk 文本（含 overlap 尾句时与相邻 chunk 部分重复） */
  text: string;
  charCount: number;
  /** estimateTextTokens 同口径（CJK 感知估算；与 Context Packing 一致） */
  tokenCount: number;
  /** chunk 文本 sha256（hex 前 10 位；chunkId 组成部 + 稳定性判据） */
  contentHash: string;
  generatedAt: string;
}

/** chunk 生成分辨率（stats / 诊断如实呈现） */
export type ChunkParserKind = "pymupdf" | "builtin-pdf-text" | "text" | "markdown";

/** 单个 Source 的 chunk 生成结果（结构化失败——不抛给整库） */
export interface SourceChunkOutcome {
  sourceId: string;
  status: "indexed" | "skipped";
  chunkCount: number;
  parser?: ChunkParserKind;
  /** skipped 原因（indexed 时缺省） */
  reason?: "full_text_unavailable" | "not_indexable" | "empty_content" | "parse_failed";
  /** 短摘要（不含全文），供诊断与报告 */
  note?: string;
}

/** metadata filter（只暴露真正有查询价值的字段；其余不过滤） */
export interface ChunkFilter {
  sourceIds?: string[];
  sourceRole?: SourceRole;
  /** 章节标题（不区分大小写；前缀匹配——"method" 命中 "Method" / "Methodology"） */
  section?: string;
  yearFrom?: number;
  yearTo?: number;
  sourceType?: SourceType;
}

export type RetrievalMode = "lexical" | "hybrid";

export interface SearchOptions {
  /** 1-50（默认 8） */
  topK?: number;
  filter?: ChunkFilter;
  /**
   * auto（缺省）：embedding 可用 → hybrid，否则 lexical-only；
   * lexical：强制 lexical；hybrid：显式要求 dense 通道（无 provider 时
   * 抛 EMBEDDING_UNAVAILABLE——显式请求不静默降级；默认路径永不因 dense
   * 不可用而失败，D-0033「dense 是 optional」红线）。
   */
  mode?: "auto" | RetrievalMode;
}

/** 检索命中的单条结果（不泄漏内部 index 状态） */
export interface RetrievedChunk {
  chunk: SourceChunk;
  /** 来源摘要（SourceItem 投影；Agent 引用定位用） */
  source: {
    sourceId: string;
    title?: string;
    year?: number;
    sourceRole: SourceRole;
    sourceType?: SourceType;
    doi?: string;
    arxivId?: string;
  };
  /** 融合后得分（RRF；量纲-free）与各通道名次/原始分 */
  score: {
    fused: number;
    lexicalRank?: number;
    lexicalScore?: number;
    denseRank?: number;
    denseScore?: number;
  };
  /** 命中通道 */
  channels: Array<"lexical" | "dense">;
}

export interface RetrievalResult {
  mode: RetrievalMode;
  query: string;
  results: RetrievedChunk[];
  diagnostics: {
    lexical: boolean;
    dense: boolean;
    /** dense 不可用 / 降级原因（如实呈现；成功时缺省） */
    denseNote?: string;
    /** 邻近去重压掉的候选数 */
    suppressedAdjacent: number;
    /** 当前索引 chunk 总数 */
    indexChunks: number;
  };
}

export interface RetrievalStats {
  mode: RetrievalMode;
  sources: {
    total: number;
    indexed: number;
    skipped: number;
    /** contentHash 已变化、等待重建的条目数 */
    stale: number;
  };
  chunks: number;
  vectors?: {
    provider: string;
    identity: string;
    dimensions: number;
    chunks: number;
  };
  builtAt?: string;
}

/**
 * EmbeddingProvider（可选 dense 通道抽象；D-0033 §12 草案落地）。
 *
 * M6.4 不接外部 vendor：实现本接口的只有测试用确定性 provider（生产默认
 * 不注册 → lexical-only 健康运行）。identity 是缓存失效判据之一——
 * provider/model 变化必须使旧向量失效。
 */
export interface EmbeddingProvider {
  readonly name: string;
  /** 向量维度（全库一致；变更 = identity 变更） */
  readonly dimensions: number;
  /** provider + model 的稳定身份（嵌入缓存 key 组成部） */
  readonly identity: string;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

/** Context Budget Packing 输出（Agent 上下文供给的最小完整形状） */
export interface PackedRetrievalContext {
  /** 带 [SRC:… CHUNK:… SECTION:… PAGE:…] 引用标记的渲染文本 */
  text: string;
  included: RetrievedChunk[];
  usedTokens: number;
  budgetTokens: number;
  excluded: {
    budget: number;
    adjacent: number;
    diversity: number;
  };
}
