/**
 * Search 域共享类型（M6.1 ADR §12 接口草案的 M6.3 落地）。
 *
 * 纪律：
 * - Web 与 Academic 是不同数据形状（URL/snippet vs DOI/venue），不合并为万能
 *   SearchProvider（paper-search-mcp 4 套字段并存是实证反面样本）；
 * - Provider-specific raw payload 不泄漏到 ResearchDiscoveryService /
 *   CandidateStore / Researcher——归一化投影是唯一出口；
 * - search（发现）≠ lookup/resolve（核验，既有 ScholarlyResolver 语义不变）。
 */

import type { CanonicalPaperRecord } from "../citation/integrity.js";
import type { SourceIdentity } from "../sources/identity.js";
import type { ProviderHealthSnapshot } from "./providerHttp.js";

export interface SearchOptions {
  /** 结果条数（默认 10；API 层硬帽 50，provider 层单源 ≤ 25——ADR §12） */
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  /** 只保留开放获取结果（provider 原生支持则服务端过滤，否则客户端过滤） */
  openAccessOnly?: boolean;
  /** 语言提示（"zh" / "en"；不支持语言的 provider 忽略） */
  language?: string;
  signal?: AbortSignal;
}

/** 学术发现结果（CanonicalPaperRecord 的检索投影 + 跨源身份） */
export interface AcademicSearchResult {
  /** 归一化跨源身份（判等键 = identity.ts 分层键；M6.2 复用，不再造第二套 dedup） */
  identity: SourceIdentity;
  record: CanonicalPaperRecord;
  citationCount?: number;
  openAccess?: boolean;
  relevance: {
    provider: string;
    /** 该 provider 结果集内名次（1 起） */
    rank: number;
  };
}

/** Web 检索结果（SearXNG JSON API 的归一化投影；URL 已 canonical 化） */
export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  /** 命中引擎（SearXNG 聚合 engines 字段） */
  engines: string[];
  /** 融合分（多引擎命中时为引擎分合并） */
  score: number;
  /** 服务端合并后名次（1 起） */
  rank?: number;
  /** ISO 日期（引擎提供时才有） */
  publishedDate?: string;
  provider: string;
}

export interface AcademicSearchProvider {
  /** "openalex" | "semantic-scholar" | "arxiv" | "aminer" */
  readonly name: string;
  /** 真关键词发现检索（无相似度门控——那是 lookup 的语义） */
  search(query: string, opts?: SearchOptions): Promise<AcademicSearchResult[]>;
  healthSnapshot(): ProviderHealthSnapshot;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<WebSearchResult[]>;
  healthSnapshot(): ProviderHealthSnapshot;
}

/** 单 provider 参与情况（diagnostics；不暴露 header / API key） */
export interface ProviderAttempt {
  provider: string;
  outcome:
    | "ok"
    | "not_configured"
    | "skipped_cooldown"
    | "skipped_circuit_open"
    | "failed"
    | "degraded";
  /** ok/degraded：返回条数；failed：0 */
  resultCount: number;
  /** failed：类型化错误 kind + message（无敏感信息） */
  error?: { kind: string; message: string };
  /** degraded 原因（如 SearXNG unresponsive_engines 非空） */
  note?: string;
  latencyMs: number;
}

export interface SearchDiagnostics {
  /** 全部已注册 provider 的尝试记录（含跳过者） */
  providers: ProviderAttempt[];
  /** 多源去重前的原始结果总数 */
  rawResultCount: number;
  /** 融合去重后的结果数（= results.length） */
  fusedResultCount: number;
}
