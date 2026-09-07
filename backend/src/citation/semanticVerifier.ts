/**
 * Claim-Citation Semantic Verification（M4.3.5）。
 *
 * ONE RECORD 原则（借鉴 RefWarden, MIT, pin ae85ae3）：同一文献被引用 N 次
 * = N 条 ClaimCitationRecord（主键 citationId+referenceId）——只验证一次
 * bibliography 不能宣告「引用正确」；必须回答这篇真实论文是否支持这一句论断。
 *
 * 链路：Claim → Citation → (Layer1 已 VERIFIED 的) Canonical Paper →
 *       Retrieved Evidence → LLM Judge → Verdict
 *
 * 硬纪律：
 * - 模型禁止凭记忆判定：prompt 只给 claim + canonical metadata + 真实检索
 *   到的证据引文；judge 引用的 keyQuote 必须逐字来自证据（伪造引文会被剥离）；
 * - 真实性未确立（NOT_FOUND/UNRESOLVED/AMBIGUOUS）→ semantic SKIPPED，
 *   绝不跳过真实性 Gate 去「验证」不存在的文献；
 * - 只有 abstract 时 evidenceLevel=abstract，不假装 full-text verified；
 *   证据不足 → INSUFFICIENT_EVIDENCE，绝不 SUPPORTED；
 * - severity 由 deriveClaimSeverity 确定性派生，模型不定级。
 */

import { extractJsonObject } from "../agents/outputParsing.js";
import { AgentRunFailedError } from "../errors.js";
import { fingerprintJson } from "../util/hash.js";
import {
  type ClaimCitationRecord,
  type ClaimPriority,
  type ClaimSupportVerdict,
  type CitationCallout,
  type CitationVerificationRecord,
  type EvidenceRecord,
  type ReferenceEntry,
} from "./integrity.js";

/** judge prompt 中证据段上限（token 控制） */
const EVIDENCE_MAX_CHARS = 4000;

export interface ClaimJudgeOutput {
  verdict: ClaimSupportVerdict;
  reason: string;
  /** judge 声称的关键引文（必须来自证据原文，否则被剥离） */
  keyQuote?: string;
}

/** （claim, citation）任务构建：callout × 已解析 reference relation */
export function buildClaimRecords(
  callouts: CitationCallout[],
  references: ReferenceEntry[],
  metadataRecords: Map<string, CitationVerificationRecord>,
  sectionTitles: Map<string, string>,
  now: string,
): ClaimCitationRecord[] {
  const records: ClaimCitationRecord[] = [];
  for (const callout of callouts) {
    for (const relation of callout.references) {
      if (relation.status !== "resolved" || relation.referenceId === undefined) {
        continue; // 未关联/无效标记走 findings（citation-invalid），不进 semantic
      }
      const reference = references.find((r) => r.referenceId === relation.referenceId);
      if (reference === undefined) {
        continue;
      }
      const metadata = metadataRecords.get(reference.referenceId);
      const metadataStatus: ClaimCitationRecord["metadataStatus"] =
        metadata?.status ?? "SKIPPED_NO_METADATA";
      const priority = classifyPriority(sectionTitles.get(callout.sectionId) ?? "");
      const canonicalFingerprint =
        metadata?.canonical !== undefined
          ? fingerprintJson(metadata.canonical)
          : "no-canonical";
      records.push({
        claimCitationId: `${callout.citationId}-${reference.referenceId}`,
        citationId: callout.citationId,
        referenceId: reference.referenceId,
        claimText: callout.sentence,
        sectionId: callout.sectionId,
        page: callout.page,
        chunkId: callout.chunkId,
        priority,
        metadataStatus,
        verdict: "INSUFFICIENT_EVIDENCE",
        reason: undefined,
        evidence: [],
        severity: "info",
        status: "pending",
        fingerprint: fingerprintJson({
          claim: callout.sentence,
          referenceId: reference.referenceId,
          canonical: canonicalFingerprint,
        }),
      });
    }
  }
  void now;
  return records;
}

/**
 * 引用优先级（确定性启发，RefWarden obligatory/helpful 的规则化版本）：
 * 方法/实验/评估章节的论断依赖被引来源 → obligatory；引言/相关工作/摘要 → helpful。
 */
export function classifyPriority(sectionTitle: string): ClaimPriority {
  return /\b(method|approach|experiment|evaluation|result|implementation|baseline|dataset)\b/i.test(
    sectionTitle,
  )
    ? "obligatory"
    : "helpful";
}

/** 从 canonical record 组装证据（v1：abstract 级） */
export function buildEvidence(record: CitationVerificationRecord, now: string): EvidenceRecord[] {
  const abstract = record.canonical?.abstract;
  if (abstract === undefined || abstract.trim() === "") {
    return [];
  }
  const source =
    record.canonical !== undefined
      ? `${record.canonical.provider}:${record.canonical.recordId || record.canonical.doi || "record"}`
      : record.referenceId;
  return [
    {
      source,
      text: abstract.slice(0, EVIDENCE_MAX_CHARS),
      evidenceLevel: "abstract",
      ...(record.canonical?.doi !== undefined ? { doi: record.canonical.doi } : {}),
      ...(record.canonical?.url !== undefined ? { url: record.canonical.url } : {}),
      retrievedAt: record.canonical?.retrievedAt ?? now,
    },
  ];
}

/** judge prompt（只含 claim + canonical + 检索证据；禁止记忆判定） */
export function buildJudgePrompt(input: {
  claimText: string;
  reference: ReferenceEntry;
  canonical?: CitationVerificationRecord["canonical"];
  evidence: EvidenceRecord[];
}): string {
  const canonicalLines: string[] = [];
  if (input.canonical !== undefined) {
    if (input.canonical.title !== undefined) {
      canonicalLines.push(`标题：${input.canonical.title}`);
    }
    if (input.canonical.authors !== undefined) {
      canonicalLines.push(`作者：${input.canonical.authors.join(", ")}`);
    }
    if (input.canonical.year !== undefined) {
      canonicalLines.push(`年份：${input.canonical.year}`);
    }
    if (input.canonical.venue !== undefined) {
      canonicalLines.push(`出处：${input.canonical.venue}`);
    }
    if (input.canonical.doi !== undefined) {
      canonicalLines.push(`DOI：${input.canonical.doi}`);
    }
  }
  const evidenceLines = input.evidence
    .map((evidence, index) => `【证据${index + 1}】（来源：${evidence.source}，等级：${evidence.evidenceLevel}）\n${evidence.text}`)
    .join("\n\n");
  return [
    "你是引用语义核验员。判断下面这篇真实文献的检索证据是否支持论文正文中的论断。",
    "",
    "严格规则：",
    "1. 只能依据下方【检索证据】判断；禁止使用你自己的记忆、训练知识或常识推断文献内容；",
    "2. 证据不足以判断时必须回答 INSUFFICIENT_EVIDENCE，绝不猜测；",
    "3. verdict 只能是：SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED / INSUFFICIENT_EVIDENCE；",
    "4. keyQuote 必须逐字复制自【检索证据】原文。",
    "",
    `【正文论断】\n${input.claimText}`,
    "",
    `【被引文献（已经外部学术库核验为真实存在）】\n${canonicalLines.join("\n") || input.reference.rawText}`,
    "",
    `【检索证据】\n${evidenceLines || "（无证据）"}`,
    "",
    '只输出一个 JSON 对象（无围栏）：{"verdict": "...", "reason": "一句话中文理由", "keyQuote": "证据中最关键的一句"}',
  ].join("\n");
}

const VERDICTS: readonly ClaimSupportVerdict[] = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
  "SKIPPED",
];

/** judge 输出解析 + 引文真实性校验（伪造 quote 一律剥离） */
export function parseJudgeOutput(
  raw: string,
  evidence: EvidenceRecord[],
): { verdict: ClaimSupportVerdict; reason: string; keyQuote?: string } {
  const parsed = extractJsonObject(raw, "引用语义核验结果") as unknown as {
    verdict?: unknown;
    reason?: unknown;
    keyQuote?: unknown;
  };
  const verdict = VERDICTS.includes(parsed.verdict as ClaimSupportVerdict)
    ? (parsed.verdict as ClaimSupportVerdict)
    : undefined;
  if (verdict === undefined) {
    throw new AgentRunFailedError("verdict 缺失或非法（必须是六个枚举值之一）");
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 1000) : "";
  let keyQuote: string | undefined =
    typeof parsed.keyQuote === "string" && parsed.keyQuote.trim() !== ""
      ? parsed.keyQuote.trim()
      : undefined;
  if (keyQuote !== undefined && !quoteFromEvidence(keyQuote, evidence)) {
    keyQuote = undefined; // judge 编造的引文：剥离，不进记录
  }
  return { verdict, reason, ...(keyQuote !== undefined ? { keyQuote } : {}) };
}

/** keyQuote 必须来自证据原文（空白不敏感的包含式校验） */
export function quoteFromEvidence(quote: string, evidence: EvidenceRecord[]): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (needle === "") {
    return false;
  }
  return evidence.some((record) => normalize(record.text).includes(needle));
}

/** 汇总（Quality Gate 输入；确定性） */
export interface SemanticSummary {
  total: number;
  byVerdict: Record<ClaimSupportVerdict, number>;
  bySeverity: { critical: number; major: number; minor: number; info: number };
  skipped: number;
  failed: number;
  pending: number;
  /** Quality Gate 硬规则输入 */
  gate: {
    probableFabricated: number;
    notFoundObligatory: number;
    unsupportedCritical: number;
    mismatchCritical: number;
    insufficientEvidence: number;
  };
}

export function summarizeSemantic(
  metadataRecords: CitationVerificationRecord[],
  claims: ClaimCitationRecord[],
): SemanticSummary {
  const byVerdict: Record<ClaimSupportVerdict, number> = {
    SUPPORTED: 0,
    PARTIALLY_SUPPORTED: 0,
    UNSUPPORTED: 0,
    CONTRADICTED: 0,
    INSUFFICIENT_EVIDENCE: 0,
    SKIPPED: 0,
  };
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  const fabrications = new Set(
    metadataRecords.filter((record) => record.probableFabrication).map((r) => r.referenceId),
  );
  const notFound = new Set(
    metadataRecords.filter((record) => record.status === "NOT_FOUND").map((r) => r.referenceId),
  );
  const mismatchCritical = new Set(
    metadataRecords
      .filter(
        (record) =>
          record.status === "METADATA_MISMATCH" &&
          (record.mismatches?.some((m) => m.field === "title" || m.field === "doi") ?? false),
      )
      .map((r) => r.referenceId),
  );
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  let unsupportedCritical = 0;
  let notFoundObligatory = 0;
  let insufficient = 0;
  for (const claim of claims) {
    byVerdict[claim.verdict] += 1;
    bySeverity[claim.severity] += 1;
    if (claim.status === "skipped") {
      skipped += 1;
    } else if (claim.status === "failed") {
      failed += 1;
    } else if (claim.status === "pending") {
      pending += 1;
    }
    if (claim.verdict === "INSUFFICIENT_EVIDENCE") {
      insufficient += 1;
    }
    if (claim.priority === "obligatory" && notFound.has(claim.referenceId)) {
      notFoundObligatory += 1;
    }
    if (
      claim.severity === "critical" &&
      claim.status === "verified" &&
      (claim.verdict === "UNSUPPORTED" || claim.verdict === "CONTRADICTED")
    ) {
      unsupportedCritical += 1;
    }
  }
  return {
    total: claims.length,
    byVerdict,
    bySeverity,
    skipped,
    failed,
    pending,
    gate: {
      probableFabricated: fabrications.size,
      notFoundObligatory,
      unsupportedCritical,
      mismatchCritical: mismatchCritical.size,
      insufficientEvidence: insufficient,
    },
  };
}
