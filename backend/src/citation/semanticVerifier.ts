/**
 * Claim-Citation Semantic Verification（v4：atomic claim × citation group）。
 *
 * 核验粒度升级（v3 及以前的问题）：
 *   v3（旧）  sentence × every reference：[35, 2, 5] 被展开成三条独立记录，
 *             每篇文献都被要求单独支撑整个复合句——把「组内分工」错判成
 *             「单篇不支持」，产生系统性 false positive；
 *   v4（新）  atomic claim × citation group：复合句先拆成原子论断，每个引用
 *             组对绑定的论断产生一条记录，组内成员共同承担支撑责任。
 *
 * 链路：Sentence → Atomic Claims（claimDecomposition）→ Citation Group 绑定 →
 *       (Layer 1 已 VERIFIED 的) Canonical Paper 组 → 组证据合并 → LLM Judge →
 *       Verdict（组级）
 *
 * verdict 语义（收紧后）：
 *   SUPPORTED             组证据整体明确支撑该原子论断
 *   PARTIALLY_SUPPORTED   组证据确实支撑论断的一部分，且论断仍有重要未支撑成分
 *                         （不是因为某篇组员只承担部分责任）
 *   UNSUPPORTED           证据与论断主题相关且足够具体，可较高置信度确认该组
 *                         不能支撑论断（不是「没找到足够证据」）
 *   CONTRADICTED          证据中有与论断明确相反的陈述，且 judge 引出逐字
 *                         keyQuote（引不出 → 确定性降级 INSUFFICIENT_EVIDENCE）
 *   INSUFFICIENT_EVIDENCE 证据不足 / 无法判断——只表示自动核验无法判断，
 *                         绝不是论文问题（severity=info，不进 Finding，不阻 Gate）
 *
 * 硬纪律：
 * - 模型禁止凭记忆判定（即使它认识这篇论文）：prompt 只给 atomic claim +
 *   canonical metadata + 真实检索到的证据引文；judge 引用的 keyQuote 必须
 *   逐字来自证据（伪造引文会被剥离，矛盾结论随之降级）；
 * - 真实性未确立（NOT_FOUND/UNRESOLVED/AMBIGUOUS/PROVIDER_ERROR）→ 该组员
 *   被排除出证据；组内全员不可判 → semantic SKIPPED，绝不验证不存在的文献；
 * - 只有 abstract 时 evidenceLevel=abstract，不假装 full-text verified；
 *   metadata-only（无摘要）绝不做语义判断 → INSUFFICIENT_EVIDENCE / SKIPPED；
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
import type { CitationSemanticMode } from "./semanticMode.js";
import {
  calloutRawText,
  type SentenceCalloutGroup,
  type SentenceClaimPlan,
} from "./claimDecomposition.js";

/** judge prompt 中单条证据上限（token 控制） */
const EVIDENCE_MAX_CHARS = 4000;

/** judge prompt 纳入的组员上限（更大的组截断并注明——prompt 体量控制） */
const GROUP_EVIDENCE_MEMBER_LIMIT = 6;

/**
 * 语义核验算法版本（纳入 claim 指纹 + 写入每条记录）：
 * v4：atomic claim × citation group 重构——记录 id / 指纹 / prompt / verdict
 *     口径全部变化，旧版本记录视为过期缓存，不再读出。
 * v5：绑定语义收紧——预告性/组织性论断（拆解 markers 为空）不再继承句内
 *     引用组（model 计划严格绑定；fallback 计划保持全组兜底）。
 */
export const SEMANTIC_VERIFICATION_VERSION = 5;

export interface ClaimJudgeOutput {
  verdict: ClaimSupportVerdict;
  reason: string;
  /** judge 声称的关键引文（必须来自证据原文，否则被剥离） */
  keyQuote?: string;
}

/**
 * （atomic claim, citation group）任务构建：句子拆解规划 × 绑定的引用组。
 * 一个组（含单引用组）对一条原子论断 = 一条记录；组内成员不再各自成条。
 */
export function buildClaimRecords(
  groups: SentenceCalloutGroup[],
  plans: Map<string, SentenceClaimPlan>,
  references: ReferenceEntry[],
  metadataRecords: Map<string, CitationVerificationRecord>,
  sectionTitles: Map<string, string>,
  mode: CitationSemanticMode = "full",
): ClaimCitationRecord[] {
  const records: ClaimCitationRecord[] = [];
  const knownReferenceIds = new Set(references.map((reference) => reference.referenceId));
  for (const group of groups) {
    const plan = plans.get(group.sentenceKey);
    if (plan === undefined) {
      continue;
    }
    const calloutById = new Map(group.groups.map((callout) => [callout.citationId, callout]));
    for (const claim of plan.claims) {
      const boundCallouts = claim.citationIds
        .map((citationId) => calloutById.get(citationId))
        .filter((callout): callout is CitationCallout => callout !== undefined);
      if (boundCallouts.length === 0) {
        if (plan.method === "fallback") {
          continue; // 防御：fallback 单论断本应绑定全部组，空 = 组内无 resolved 成员
        }
        // model 计划严格绑定：空绑定 = 拆解判定该论断（预告性/组织性表述）
        // 不需要引用支撑——不生成核验记录，绝不把结构自述错当被引论断
        continue;
      }
      for (const callout of boundCallouts) {
        const members = callout.references
          .filter(
            (relation) =>
              relation.status === "resolved" &&
              relation.referenceId !== undefined &&
              knownReferenceIds.has(relation.referenceId),
          )
          .map((relation) => relation.referenceId!);
        if (members.length === 0) {
          continue; // 组内无可关联文献（unresolved/invalid 走 findings，不进 semantic）
        }
        const metadata = metadataRecords.get(members[0]!);
        const metadataStatus: ClaimCitationRecord["metadataStatus"] =
          metadata?.status ?? "SKIPPED_NO_METADATA";
        const priority = classifyPriority(sectionTitles.get(callout.sectionId) ?? "");
        const canonicalFingerprints = members.map((referenceId) => {
          const canonical = metadataRecords.get(referenceId)?.canonical;
          return canonical === undefined ? "no-canonical" : fingerprintJson(canonical);
        });
        records.push({
          claimCitationId: `${callout.citationId}-AC${claim.claimIndex}`,
          citationId: callout.citationId,
          referenceId: members[0]!,
          referenceIds: members,
          groupRawText: calloutRawText(callout),
          claimIndex: claim.claimIndex,
          claimText: claim.claimText,
          sourceSentence: group.sentence,
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
          semanticVersion: SEMANTIC_VERIFICATION_VERSION,
          fingerprint: fingerprintJson({
            semanticVersion: SEMANTIC_VERIFICATION_VERSION,
            mode,
            claim: claim.claimText,
            claimIndex: claim.claimIndex,
            referenceIds: members,
            canonicals: canonicalFingerprints,
          }),
        });
      }
    }
  }
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

/** 单篇 canonical record 组装证据（scholarly：abstract 级；software：repository 描述级） */
export function buildEvidence(record: CitationVerificationRecord, now: string): EvidenceRecord[] {
  const abstract = record.canonical?.abstract;
  if (abstract === undefined || abstract.trim() === "") {
    return [];
  }
  const source =
    record.canonical !== undefined
      ? `${record.canonical.provider}:${record.canonical.recordId || record.canonical.doi || "record"}`
      : record.referenceId;
  const isSoftware = record.canonical?.software !== undefined;
  return [
    {
      source,
      text: abstract.slice(0, EVIDENCE_MAX_CHARS),
      evidenceLevel: isSoftware ? "repository" : "abstract",
      ...(record.canonical?.doi !== undefined ? { doi: record.canonical.doi } : {}),
      ...(record.canonical?.url !== undefined ? { url: record.canonical.url } : {}),
      retrievedAt: record.canonical?.retrievedAt ?? now,
    },
  ];
}

/** 组证据组装：逐成员取 abstract / 仓库描述（metadata-only 成员天然无证据，不参与判断） */
export function buildGroupEvidence(
  referenceIds: string[],
  metadataRecords: Map<string, CitationVerificationRecord>,
  now: string,
): EvidenceRecord[] {
  const evidence: EvidenceRecord[] = [];
  for (const referenceId of referenceIds.slice(0, GROUP_EVIDENCE_MEMBER_LIMIT)) {
    const record = metadataRecords.get(referenceId);
    if (record === undefined) {
      continue;
    }
    evidence.push(...buildEvidence(record, now));
  }
  return evidence;
}

/** 组成员 canonical 概览行（judge prompt 用：每篇一行，标注 provider） */
function groupMemberLines(
  referenceIds: string[],
  references: ReferenceEntry[],
  metadataRecords: Map<string, CitationVerificationRecord>,
): string {
  const titleByReference = new Map(references.map((reference) => [reference.referenceId, reference]));
  return referenceIds
    .slice(0, GROUP_EVIDENCE_MEMBER_LIMIT)
    .map((referenceId, index) => {
      const reference = titleByReference.get(referenceId);
      const canonical = metadataRecords.get(referenceId)?.canonical;
      const title = canonical?.title ?? reference?.title ?? reference?.rawText.slice(0, 100) ?? referenceId;
      const year = canonical?.year ?? reference?.year;
      const provider = canonical?.provider ?? "—";
      return `- 组员${index + 1}：${title}${year !== undefined ? `（${year}）` : ""}［来源 ${provider}］`;
    })
    .join("\n");
}

/**
 * judge prompt（v4：atomic claim + citation group 口径；只含 claim + canonical +
 * 检索证据；禁止记忆判定；verdict 定义收紧；按 mode 切换判定口径）。
 */
export function buildJudgePrompt(
  input: {
    claimText: string;
    /** 组全部成员（含未纳入证据的；展示责任归属） */
    referenceIds: string[];
    references: ReferenceEntry[];
    metadataRecords: Map<string, CitationVerificationRecord>;
    groupRawText: string;
    evidence: EvidenceRecord[];
  },
  mode: CitationSemanticMode = "full",
): string {
  const memberLines = groupMemberLines(input.referenceIds, input.references, input.metadataRecords);
  const evidenceLines = input.evidence
    .map((evidence, index) => `【证据${index + 1}】（来源：${evidence.source}，等级：${evidence.evidenceLevel}）\n${evidence.text}`)
    .join("\n\n");
  const groupIntro = [
    input.referenceIds.length > 1
      ? `【被引文献组 ${input.groupRawText}】（${input.referenceIds.length} 篇共同支撑紧邻论断；已经外部学术库核验为真实存在）`
      : `【被引文献（已经外部学术库核验为真实存在）】 ${input.groupRawText}`,
    memberLines,
  ].join("\n");

  const shared = [
    `【正文原子论断】\n${input.claimText}`,
    "",
    groupIntro,
    "",
    `【检索证据】\n${evidenceLines || "（无证据）"}`,
    "",
    '只输出一个 JSON 对象（无围栏）：{"verdict": "...", "reason": "一句话中文理由", "keyQuote": "证据中最关键的一句"}',
  ];

  if (mode === "contradiction_only") {
    return [
      "你是引用矛盾检查员。只判断一件事情：下方引用组的检索证据，是否与论文正文中的这条原子论断存在实质性矛盾（证据明确表达相反结论）。",
      "",
      "严格规则：",
      "1. 只能依据下方【检索证据】判断；即使你认识这些文献，也禁止使用自己的记忆、训练知识或常识推断文献内容；",
      "2. 引用组共同提供证据：组内多篇文献的证据合在一起判断，不要求每篇单独与论断相关；",
      "3. 只有证据与论断直接相反（如论断称 X 优于 Y，证据明确报告 X 不优于 Y）才回答 CONTRADICTED，且 keyQuote 必须逐字复制该反向陈述；证据只是未提及、不充分、方向不明，都不是矛盾；",
      "4. 检查过证据且未发现相反内容 → NO_CONTRADICTION_DETECTED；证据与论断主题无关、无法开展矛盾核对 → INSUFFICIENT_EVIDENCE；绝不能把「证据不足」当成矛盾；",
      "5. verdict 只能是：CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE；",
      "6. keyQuote 必须逐字复制自【检索证据】原文。",
      "",
      ...shared,
    ].join("\n");
  }
  return [
    "你是引用语义核验员。判断下方引用组的检索证据整体是否支撑论文正文中的这一条原子论断。",
    "",
    "背景：论文写作中，引用组（如 [35, 2, 5]）表示组内文献共同支撑紧邻的论断——各篇可以分工承担论断的不同部分，不要求任何一篇单独覆盖论断全部内容。",
    "",
    "严格规则：",
    "1. 只能依据下方【检索证据】判断；即使你认识这些文献，也禁止使用自己的记忆、训练知识或常识推断文献内容；",
    "2. 待判断的是一条原子论断（单一命题），不要按整段话的标准要求证据；",
    "3. 引用组共同提供支撑：把组内所有证据合在一起判断；某篇组员只支撑了论断的一部分，不构成「不支持」；",
    "4. SUPPORTED：组证据整体明确支撑该论断；",
    "5. PARTIALLY_SUPPORTED：组证据确实支撑论断的一部分、但论断中仍有重要成分未被任何证据覆盖（不是因为组内单篇只承担部分责任）；",
    "6. UNSUPPORTED：证据内容与论断主题明确相关且足够具体，使你能较高置信度确认这组文献并不能支撑该论断。「证据未提及」「证据过于笼统」「主题对不上无法判断」都不是 UNSUPPORTED——那是 INSUFFICIENT_EVIDENCE（没有证据 ≠ 证明不支持）；",
    "7. CONTRADICTED：证据中有与论断明确相反的陈述，keyQuote 必须逐字复制该反向陈述；不能由「不支持」推出「矛盾」；",
    "8. 证据不足以判断时必须回答 INSUFFICIENT_EVIDENCE，绝不猜测；",
    "9. verdict 只能是：SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED / INSUFFICIENT_EVIDENCE；",
    "10. keyQuote 必须逐字复制自【检索证据】原文。",
    "",
    ...shared,
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

const CONTRADICTION_VERDICTS: readonly ClaimSupportVerdict[] = [
  "CONTRADICTED",
  "NO_CONTRADICTION_DETECTED",
  "INSUFFICIENT_EVIDENCE",
];

/** judge 输出解析 + 引文真实性校验（伪造 quote 一律剥离；按 mode 校验合法 verdict） */
export function parseJudgeOutput(
  raw: string,
  evidence: EvidenceRecord[],
  mode: CitationSemanticMode = "full",
): { verdict: ClaimSupportVerdict; reason: string; keyQuote?: string } {
  const parsed = extractJsonObject(raw, "引用语义核验结果") as unknown as {
    verdict?: unknown;
    reason?: unknown;
    keyQuote?: unknown;
  };
  const allowed = mode === "contradiction_only" ? CONTRADICTION_VERDICTS : VERDICTS;
  const verdict = allowed.includes(parsed.verdict as ClaimSupportVerdict)
    ? (parsed.verdict as ClaimSupportVerdict)
    : undefined;
  if (verdict === undefined) {
    throw new AgentRunFailedError(
      mode === "contradiction_only"
        ? "verdict 缺失或非法（必须是 CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE 之一）"
        : "verdict 缺失或非法（必须是枚举值之一）",
    );
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
  /** 引用组维度统计（v4）：单引用记录 / 多引用组记录条数 */
  groupShape: { single: number; group: number };
  /** 去重后的原子论断条数（同句多条记录共享论断时只计一次） */
  atomicClaims: number;
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
    NO_CONTRADICTION_DETECTED: 0,
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
  let single = 0;
  let group = 0;
  const claimKeys = new Set<string>();
  for (const claim of claims) {
    byVerdict[claim.verdict] += 1;
    bySeverity[claim.severity] += 1;
    if ((claim.referenceIds?.length ?? 1) > 1) {
      group += 1;
    } else {
      single += 1;
    }
    claimKeys.add(`${claim.chunkId}::${claim.claimIndex ?? 1}::${claim.claimText}`);
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
    if (
      claim.priority === "obligatory" &&
      claim.referenceIds?.some((referenceId) => notFound.has(referenceId)) === true
    ) {
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
    groupShape: { single, group },
    atomicClaims: claimKeys.size,
    gate: {
      probableFabricated: fabrications.size,
      notFoundObligatory,
      unsupportedCritical,
      mismatchCritical: mismatchCritical.size,
      insufficientEvidence: insufficient,
    },
  };
}
