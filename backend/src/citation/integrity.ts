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
 * 正文引用标记（callout）。一个 callout = 一次方括号/圆括号引用 = 一个 citation
 * group：[35, 2, 5] 是「三篇文献共同支撑紧邻论断」的一个组，不是三条独立引用。
 * range 展开进 references[]，rawText 保留原始标记（组信息不丢失）。
 */
export interface CitationCallout {
  citationId: string;
  style: "numeric" | "author-year";
  /** 展开后的每个被引用对象一条 relation；无法可靠关联 → status=unresolved（不猜） */
  references: CitationCalloutReference[];
  /** 原始标记文本（如 "[35, 2, 5]" / "(Vaswani et al., 2017)"）；v3 前的旧记录无此字段 */
  rawText?: string;
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

/**
 * 引用条目类型（核验语义分派依据）：
 *   scholarly_paper  学术论文——Crossref/OpenAlex/S2/arXiv 核验（默认）
 *   software         软件/模型（如 Ultralytics YOLO11，无正式 paper）——官方
 *                    repository / documentation 核验；学术库未收录 ≠ 不存在
 *   dataset / documentation / web_resource  预留（本轮只做类型建模，
 *                    暂无独立 resolver；推断保守，不会误标）
 *   unknown          无可判信号
 */
export type ReferenceKind =
  | "scholarly_paper"
  | "software"
  | "dataset"
  | "documentation"
  | "web_resource"
  | "unknown";

/** canonical 来源（学术库 + 软件权威源） */
export type CanonicalSourceProvider = ScholarlyProvider | "github";

/** 软件类 canonical 的权威来源信息（repository / 官方文档） */
export interface SoftwareSourceRecord {
  /** 官方代码仓库（GitHub / GitLab） */
  repositoryUrl: string;
  /** 官方文档 / 主页（repo homepage；有才填） */
  homepage?: string;
  /** 仓库描述（作为语义核验的 repository 级证据） */
  description?: string;
  stars?: number;
  /** 最近一次推送（活跃度参考） */
  pushedAt?: string;
}

export interface CanonicalPaperRecord {
  provider: CanonicalSourceProvider;
  /** provider 原生记录 id（DOI / OpenAlex id / S2 paperId / arxiv id / GitHub full_name） */
  recordId: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  /** 摘要（semantic verification 的主要证据来源）；software = 仓库描述 */
  abstract?: string;
  /** provider = github 时的软件权威来源信息 */
  software?: SoftwareSourceRecord;
  retrievedAt: string;
}

/**
 * metadata 核验结论：
 *   VERIFIED           找到唯一匹配且字段一致（DOI exact match 优先级最高）
 *   METADATA_MISMATCH  找到文献但字段不符（年份/作者/venue 与草稿不一致）
 *   AMBIGUOUS          多个候选无法唯一确定
 *   NOT_FOUND          多源检索成功但均无匹配（检索本身没失败）
 *   PROVIDER_ERROR     核验暂未完成——timeout/429/5xx/network（绝不等于 NOT_FOUND，
 *                      不参与 not-found vote；下次核验自动重试）
 *   UNRESOLVED         旧记录的同类语义（v3 前的 PROVIDER_ERROR），仅用于读取兼容
 */
export type CitationMetadataStatus =
  | "VERIFIED"
  | "METADATA_MISMATCH"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "UNRESOLVED";

/** 单 provider 尝试记录（失败语义与结论分离） */
export interface ProviderAttempt {
  provider: CanonicalSourceProvider;
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
  /** 条目类型（v3 起；software 走官方 repository/docs 核验而非学术库） */
  kind?: ReferenceKind;
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
  /**
   * 核验算法版本（归一化 / 打分 / query plan）。与当前版本不一致的记录视为过期，
   * 下次核验自动重查——算法升级后旧 NOT_FOUND 不会因条目原文未变而被沿用。
   * 旧记录无此字段 → 过期。
   */
  algorithmVersion?: string;
  error?: string;
}

// ---- Layer 2：semantic verification（(claim, citation) 单记录） ----

/**
 * 文献是否支持正文论断（verdict 枚举冻结，不随意扩展）。
 * INSUFFICIENT_EVIDENCE ≠ 不支持——只表示证据不足以判定（如仅拿到 abstract）。
 * NO_CONTRADICTION_DETECTED 仅在 contradiction_only 模式产生：检查过证据、
 * 未发现明显矛盾（不是「支持」的判断）。
 */
export type ClaimSupportVerdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE"
  | "SKIPPED"
  | "NO_CONTRADICTION_DETECTED";

/** 证据等级（诚实标注，不假装 full-text verified） */
export type EvidenceLevel =
  | "abstract"
  | "metadata"
  | "snippet"
  | "web"
  | "fulltext"
  | "repository"
  | "official_docs";

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

/**
 * 证据不足 / 跳过的结构化原因（有限枚举，UI 可按类别解释；不做自由文本归因）：
 *   NO_EVIDENCE          只获取到书目 metadata，没有摘要/正文/仓库描述等可判证据
 *   ABSTRACT_ONLY        只有 abstract（或 repository 描述）级证据，claim 超出其支持范围
 *   FULLTEXT_UNAVAILABLE 全文无法获取（预留：fulltext 证据链路）
 *   PROVIDER_ERROR       模型 / 检索 provider 查询失败
 *   REFERENCE_UNVERIFIED 文献真实性未确立（NOT_FOUND/PROVIDER_ERROR 等），语义核验跳过
 *   LOW_RELEVANCE        现有证据与 claim 相关性不足（预留：相关性打分）
 */
/**
 * 证据不足 / 跳过的结构化原因（有限枚举，UI 可按类别解释；不做自由文本归因）：
 *   NO_EVIDENCE            只获取到书目 metadata，没有摘要/正文/仓库描述等可判证据
 *   ABSTRACT_ONLY          只有 abstract（或 repository 描述）级证据，claim 超出其支持范围
 *   FULLTEXT_UNAVAILABLE   全文无法获取（预留：fulltext 证据链路）
 *   PROVIDER_ERROR         模型 / 检索 provider 查询失败
 *   REFERENCE_UNVERIFIED   文献真实性未确立（NOT_FOUND/PROVIDER_ERROR 等），语义核验跳过
 *   LOW_RELEVANCE          现有证据与 claim 相关性不足（预留：相关性打分）
 *   UNQUOTED_CONTRADICTION judge 判 CONTRADICTED 但引不出逐字反向引文——矛盾结论
 *                          不可采信，确定性降级为 INSUFFICIENT_EVIDENCE
 */
export type InsufficientReasonCode =
  | "NO_EVIDENCE"
  | "ABSTRACT_ONLY"
  | "FULLTEXT_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "REFERENCE_UNVERIFIED"
  | "LOW_RELEVANCE"
  | "UNQUOTED_CONTRADICTION";

/**
 * 一条 (atomic claim, citation group) 语义核验记录。
 *
 * 记录粒度 = 原子论断 × 引用组（v4 起）：一个引用组（如 [35, 2, 5]）对一条
 * 原子论断产生一条记录，组内成员在 referenceIds 中共同承担支撑责任；
 * 不再是「句子 × 每篇文献」的笛卡尔积——不要求组内每篇单独覆盖整个论断。
 * referenceId 保留为首成员（anchor，兼容旧 UI / 导出定位）。
 */
export interface ClaimCitationRecord {
  claimCitationId: string;
  /** 引用组锚点 callout（组的 citationId） */
  citationId: string;
  /** anchor 成员（referenceIds[0]；兼容单引用展示） */
  referenceId: string;
  /** 引用组全部成员（共同支撑；单引用 = 长度 1） */
  referenceIds: string[];
  /** 原始引用标记（如 "[35, 2, 5]"；旧记录缺省 = 单引用） */
  groupRawText?: string;
  /** 该论断在句内拆解后的序号（1 起；单论断句子为 1） */
  claimIndex?: number;
  /** 原子论断（可独立判断真假的单一命题；拆解自 callout 所在句子） */
  claimText: string;
  /** 拆解来源句（展示/追溯用；marker 原样） */
  sourceSentence?: string;
  sectionId: string;
  page: number;
  chunkId: string;
  priority: ClaimPriority;
  /** 前置 Layer 1 结论快照（anchor 成员；NOT_FOUND/PROVIDER_ERROR 等 → semantic SKIPPED） */
  metadataStatus: CitationMetadataStatus | "SKIPPED_NO_METADATA";
  verdict: ClaimSupportVerdict;
  reason?: string;
  /** INSUFFICIENT_EVIDENCE / SKIPPED / failed 的结构化原因（有限枚举） */
  reasonCode?: InsufficientReasonCode;
  evidence: EvidenceRecord[];
  /** 组内被排除出证据的成员（真实性未确立 / 无摘要），追溯用 */
  excludedReferenceIds?: string[];
  /** 确定性派生（deriveClaimSeverity），模型不凭感觉定级 */
  severity: FindingSeverity;
  status: ClaimCitationStatus;
  /** judge 模型标签（telemetry） */
  model?: string;
  error?: string;
  verifiedAt?: string;
  /** 输入指纹（atomic claim + 引用组 canonical 指纹 + 模式） */
  fingerprint: string;
  /** 写入时的语义核验算法版本（SEMANTIC_VERIFICATION_VERSION；旧版本记录视为过期缓存） */
  semanticVersion?: number;
}

// ---- 确定性 severity 派生（RefWarden derive_severity 规则适配） ----

/**
 * severity 从 (fabrication, verdict, priority) 确定性派生：
 *   probable fabrication                    → critical（存在性硬伤）
 *   UNSUPPORTED/CONTRADICTED + obligatory   → critical（关键论断无支撑）
 *   UNSUPPORTED/CONTRADICTED + helpful      → minor
 *   PARTIALLY_SUPPORTED + obligatory       → major
 *   PARTIALLY_SUPPORTED + helpful          → minor
 *   INSUFFICIENT_EVIDENCE                  → info（自动核验无法判断 ≠ 论文问题，
 *                                          不构成任何级别的论文 Finding，仅诊断展示）
 *   SUPPORTED / SKIPPED /
 *   NO_CONTRADICTION_DETECTED              → info（不构成问题）
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
  return "info";
}
