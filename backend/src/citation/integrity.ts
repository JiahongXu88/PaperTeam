/**
 * Citation Integrity 领域类型。
 *
 * 两层核验严格分离（核心原则）：
 *   Layer 1 文献真实性（metadata verification，确定性代码 + 外部学术库）
 *   Layer 2 文献是否支持 claim（semantic verification，LLM judge + 真实检索证据）
 * 「查无此文」(NOT_FOUND) 与「文献不支持论断」(UNSUPPORTED) 是两个不同问题；
 * LLM 不负责决定文献是否存在（禁止凭记忆判定，evidence 必须来自实际检索）。
 *
 * (claim, citation) 单记录模型借鉴 RefWarden
 * (Agents4Academia-AI/citation_verification, MIT, pin ae85ae3)：
 * 同一文献被引用 N 次 = N 条 ClaimCitationRecord，主键 (citationId, referenceId)。
 */

import type { FindingSeverity } from "../review/finding.js";

// ---- Reference / Callout（从最终 PDF 提取） ----

/** 参考文献条目（References 章节） */
export interface ReferenceEntry {
  referenceId: string;
  /** numeric 引用风格的编号（[4] → 4）；author-year 风格缺省 */
  number?: number;
  /** 条目原文（解析与指纹的依据） */
  rawText: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  /** 归一化 DOI（小写、无 doi: 前缀） */
  doi?: string;
  arxivId?: string;
  url?: string;
  /** 条目所在页 / 章节（provenance） */
  page: number;
  sectionId: string;
  chunkId?: string;
  /** sha256(rawText)：stage 复用判据（rawText 不变则不重查） */
  fingerprint: string;
}

/**
 * 正文引用标记（callout）。
 * [4-7] / [2,3] 展开为 references[] 多条 relation，不保留区间字符串。
 */
export interface CitationCallout {
  citationId: string;
  style: "numeric" | "author-year";
  /** 展开后的每个被引用对象一条 relation；无法可靠关联 → status=unresolved（不猜） */
  references: CitationCalloutReference[];
  page: number;
  sectionId: string;
  chunkId: string;
  /** 含引用标记的句子 */
  sentence: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface CitationCalloutReference {
  /** 关联成功时指向 ReferenceEntry.referenceId */
  referenceId?: string;
  /** 原始标记（如 "4" 或 "Vaswani et al., 2017"） */
  label: string;
  /** invalid：numeric 超出 References 条目范围 */
  status: "resolved" | "unresolved" | "invalid";
}

// ---- Layer 1：metadata verification（确定性） ----

/** 学术库来源（canonical record 必须保留 provenance） */
export type ScholarlyProvider = "crossref" | "openalex" | "semantic-scholar" | "arxiv";

export interface CanonicalPaperRecord {
  provider: ScholarlyProvider;
  /** provider 原生记录 id（DOI / OpenAlex id / S2 paperId / arxiv id） */
  recordId: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  /** 摘要（semantic verification 的主要证据来源） */
  abstract?: string;
  retrievedAt: string;
}

/**
 * metadata 核验结论：
 *   VERIFIED           找到唯一匹配且字段一致（DOI exact match 优先级最高）
 *   METADATA_MISMATCH  找到文献但字段不符（年份/作者/venue 与草稿不一致）
 *   AMBIGUOUS          多个候选无法唯一确定
 *   NOT_FOUND          多源检索成功但均无匹配（检索本身没失败）
 *   UNRESOLVED         检索失败（网络/限流/超时）——绝不等于 NOT_FOUND
 */
export type CitationMetadataStatus =
  | "VERIFIED"
  | "METADATA_MISMATCH"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "UNRESOLVED";

/** 单 provider 尝试记录（失败语义与结论分离） */
export interface ProviderAttempt {
  provider: ScholarlyProvider;
  outcome: "match" | "mismatch" | "not_found" | "error" | "ambiguous";
  note?: string;
}

export interface CitationFieldMismatch {
  field: "title" | "authors" | "year" | "venue" | "doi";
  /** 草稿所写 */
  expected?: string;
  /** canonical 实际 */
  actual?: string;
  note?: string;
}

export interface CitationVerificationRecord {
  referenceId: string;
  status: CitationMetadataStatus;
  /**
   * 存在性可疑（probable fabrication）：仅当强证据（多源一致 NOT_FOUND、
   * 且各次检索本身成功）才为 true。NOT_FOUND 本身不等于捏造。
   */
  probableFabrication: boolean;
  canonical?: CanonicalPaperRecord;
  mismatches?: CitationFieldMismatch[];
  attempts: ProviderAttempt[];
  checkedAt: string;
  /** 输入指纹 = ReferenceEntry.fingerprint（复用判据） */
  fingerprint: string;
  error?: string;
}

// ---- Layer 2：semantic verification（(claim, citation) 单记录） ----

/**
 * 文献是否支持正文论断（verdict 枚举冻结，不随意扩展）。
 * INSUFFICIENT_EVIDENCE ≠ 不支持——只表示证据不足以判定（如仅拿到 abstract）。
 */
export type ClaimSupportVerdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE"
  | "SKIPPED";

/** 证据等级（诚实标注，不假装 full-text verified） */
export type EvidenceLevel = "abstract" | "metadata" | "snippet" | "web" | "fulltext";

export interface EvidenceRecord {
  /** 证据来源（provider:recordId 或 URL） */
  source: string;
  /** 实际检索到的引文——禁止模型生成「像论文原文」的内容 */
  text: string;
  evidenceLevel: EvidenceLevel;
  /** 被引论文内位置（fulltext 证据才有） */
  page?: number;
  url?: string;
  doi?: string;
  retrievedAt: string;
}

/** 引用优先级（RefWarden rubric：obligatory = 论断依赖该来源） */
export type ClaimPriority = "obligatory" | "helpful";

export type ClaimCitationStatus = "pending" | "verified" | "skipped" | "failed";

/** 一条 (claim, citation) 语义核验记录（同文献多处被引 = 多条记录） */
export interface ClaimCitationRecord {
  claimCitationId: string;
  citationId: string;
  referenceId: string;
  /** 正文论断（callout 所在句子） */
  claimText: string;
  sectionId: string;
  page: number;
  chunkId: string;
  priority: ClaimPriority;
  /** 前置 Layer 1 结论快照（NOT_FOUND/UNRESOLVED 时 semantic 应 SKIPPED） */
  metadataStatus: CitationMetadataStatus | "SKIPPED_NO_METADATA";
  verdict: ClaimSupportVerdict;
  reason?: string;
  evidence: EvidenceRecord[];
  /** 确定性派生（deriveClaimSeverity），模型不凭感觉定级 */
  severity: FindingSeverity;
  status: ClaimCitationStatus;
  /** judge 模型标签（telemetry） */
  model?: string;
  error?: string;
  verifiedAt?: string;
  /** 输入指纹（claim+reference canonical 指纹） */
  fingerprint: string;
}

// ---- 确定性 severity 派生（RefWarden derive_severity 规则适配） ----

/**
 * severity 从 (fabrication, verdict, priority) 确定性派生：
 *   probable fabrication                    → critical（存在性硬伤）
 *   UNSUPPORTED/CONTRADICTED + obligatory   → critical（关键论断无支撑）
 *   UNSUPPORTED/CONTRADICTED + helpful      → minor
 *   PARTIALLY_SUPPORTED + obligatory       → major
 *   PARTIALLY_SUPPORTED + helpful          → minor
 *   INSUFFICIENT_EVIDENCE                  → minor（不等于捏造；要求补证据/人工复核）
 *   SUPPORTED / SKIPPED                    → info（不构成问题）
 */
export function deriveClaimSeverity(input: {
  probableFabrication: boolean;
  verdict: ClaimSupportVerdict;
  priority: ClaimPriority;
}): FindingSeverity {
  if (input.probableFabrication) {
    return "critical";
  }
  if (input.verdict === "UNSUPPORTED" || input.verdict === "CONTRADICTED") {
    return input.priority === "obligatory" ? "critical" : "minor";
  }
  if (input.verdict === "PARTIALLY_SUPPORTED") {
    return input.priority === "obligatory" ? "major" : "minor";
  }
  if (input.verdict === "INSUFFICIENT_EVIDENCE") {
    return "minor";
  }
  return "info";
}
