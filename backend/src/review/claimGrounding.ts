/**
 * Claim Grounding（M9.7.6）：从「引用有来源」升级到「具体事实性论断有证据」。
 *
 * 定位与边界（审计 §1.2 之后的设计决定）：
 * - 判定端完全复用 Fact Reviewer——`FactClaimCheck{claim, verdict, evidenceId?}`
 *   就是既有 Claim → Evidence 结构；本模块只做**确定性整理**，不新增任何
 *   LLM 判定、不建平行 claim store；
 * - claim id 是派生指纹（`c-{sha256(section|claim)[0:12]}`，与 findingFingerprint
 *   同思想）：不落存储、跨轮仅当 claim 文本不变时稳定（修订后文本变化 = 新
 *   指纹，跨轮追踪在评估层做，不在产品层伪造连续性）；
 * - evidenceBound 判定 = verdict ∈ {SUPPORTED, PARTIALLY_SUPPORTED} 且
 *   evidenceId 存在且解析到 formal evidence（verified + 锚点）——语义支撑，
 *   不是 citation key 存在性（citation-backed ≠ claim-supported，§10）；
 * - 候选证据检索 = tokenizeText（retrieval 同源 tokenizer）对 formal evidence
 *   claim+quote+title 的词面评分，bounded Top-K，不足阈值返回空（不强配）。
 */

import { createHash } from "node:crypto";

import type { FactClaimCheck, FactVerdict } from "../agents/ReviewerService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import { resolveEvidenceCitationKey } from "../citation/bibliography.js";
import { tokenizeText } from "../retrieval/tokenize.js";

/** Repair Context 的候选证据上限（§9：bounded Top-K，3~5） */
export const CLAIM_REPAIR_TOP_K = 5;
/** 词面重叠低于该不同词数 = 无足够相关证据（返回空，不强配错误 Evidence） */
export const CLAIM_REPAIR_MIN_MATCHED_TERMS = 2;

/** bibliography 解析用最小结构（BibRenderEntry / BibEntrySummary 的公共子集） */
export interface ClaimGroundingBibEntry {
  key: string;
  sourceId?: string;
  title?: string;
  doi?: string;
  year?: number;
}

export function claimFingerprint(section: string, claim: string): string {
  const hash = createHash("sha256").update(`${section}|${claim}`).digest("hex").slice(0, 12);
  return `c-${hash}`;
}

export function isUnsupportedVerdict(verdict: FactVerdict): boolean {
  return verdict === "UNSUPPORTED" || verdict === "CONTRADICTED";
}

/**
 * M11.2.3（D-2）：UNSUPPORTED claim 的披露口径分类——「凭空断言」与「透明
 * 未核验转述」不同罪。判定对象是 claim 文本自身的确定性 marker（与
 * weakeningAuthorization 的弱化指令词表同族，但语义更严：透明转述须同时
 * 具备来源归因 + 核验缺口声明）：
 * - transparent_unverified：如「文献摘要报告 X，但当前尚缺全文证据核验」/
 *   「据其原文自述且未经独立核验」——诚实披露证据边界，severity 低于
 *   fabricated / overclaimed assertion，但仍不是 evidence-backed（不入
 *   SUPPORTED，学术评分照常反映引用支撑缺口）。
 * - opaque_assertion：如「已有研究证明 X 一定有效」——无归因无披露的
 *   强断言，维持 UNSUPPORTED 的完整阻断语义。
 * 诚实边界：marker 级确定性判定，不是语义理解。学术阈值不动（口径修复
 * 只修「同一根因的重复惩罚与透明披露的分级」，见 gates 规则 4/5/6）。
 */
export type ClaimDisclosure = "opaque_assertion" | "transparent_unverified";

/** 来源归因 marker（转述范围限定到具体来源；不是普遍化断言） */
const DISCLOSURE_ATTRIBUTION_MARKERS: readonly string[] = [
  "据其原文自述",
  "据其自述",
  "据其摘要",
  "摘要级",
  "据报道",
  "据其报告",
  "据其报道",
  "据文献报告",
  "据文献报道",
  "文献摘要报告",
  "作者自述",
];

/** 核验缺口声明 marker（显式承认证据未核验 / 待全文） */
const DISCLOSURE_UNVERIFIED_MARKERS: readonly string[] = [
  "待核验",
  "尚待验证",
  "尚待证据",
  "尚待证据级核验",
  "未经独立核验",
  "未经独立验证",
  "未经核验",
  "尚缺全文证据",
  "待全文核验",
  "无全文核验",
  "尚无全文级核验",
];

export function classifyClaimDisclosure(claimText: string): ClaimDisclosure {
  const text = claimText.trim();
  const hasAttribution = DISCLOSURE_ATTRIBUTION_MARKERS.some((marker) => text.includes(marker));
  const hasUnverified = DISCLOSURE_UNVERIFIED_MARKERS.some((marker) => text.includes(marker));
  return hasAttribution && hasUnverified ? "transparent_unverified" : "opaque_assertion";
}

export interface EvidenceCandidate {
  evidenceId: string;
  score: number;
  matchedTerms: number;
}

/**
 * unsupported claim → formal evidence 池的确定性词面匹配（§9）。
 *
 * 打分对象 = evidence 的 claim + quote + source title（证据「自称能支撑什么」的
 * 全部文本面）；tokenize 与 lexical 检索同源（中英兼容，CJK bigram）。排序：
 * matchedTerms 降序 → score 降序 → evidenceId 字典序（确定性，无随机因素）。
 * 池内每条证据只按自身 token 集合打分（df/长度归一在此规模下不增加区分度，
 * 保持实现最小）；不同词命中数 < 2 的直接不返回——宁可空候选走 WEAKEN/REMOVE，
 * 不把不相关证据强配给 claim。
 */
export function findEvidenceCandidates(
  claimText: string,
  formalEvidence: readonly EvidenceRecord[],
  options: { topK?: number } = {},
): EvidenceCandidate[] {
  const topK = options.topK ?? CLAIM_REPAIR_TOP_K;
  const claimTerms = new Set(tokenizeText(claimText));
  if (claimTerms.size === 0) {
    return [];
  }
  const hits: EvidenceCandidate[] = [];
  for (const record of formalEvidence) {
    if (!isFormalEvidence(record)) {
      continue; // 只有 formal（verified + 锚点）证据可进 Repair Context
    }
    const evidenceText = [
      record.claim,
      record.quote ?? "",
      record.source?.title ?? "",
    ].join("\n");
    const evidenceTerms = new Set(tokenizeText(evidenceText));
    let matchedTerms = 0;
    for (const term of claimTerms) {
      if (evidenceTerms.has(term)) {
        matchedTerms += 1;
      }
    }
    if (matchedTerms < CLAIM_REPAIR_MIN_MATCHED_TERMS) {
      continue;
    }
    // score = 覆盖率（命中 claim 词占比）× 池内区分度（命中词在证据文本中的占比）
    const coverage = matchedTerms / claimTerms.size;
    const evidenceHit = matchedTerms / Math.max(1, evidenceTerms.size);
    hits.push({ evidenceId: record.id, score: Number((coverage * evidenceHit).toFixed(6)), matchedTerms });
  }
  hits.sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || (a.evidenceId < b.evidenceId ? -1 : 1));
  return hits.slice(0, topK);
}

export interface ClaimGroundingEntry {
  /** 派生指纹（c-…）：审计 / 修订派发 / 跨轮评估的稳定引用 */
  claimId: string;
  section: string;
  claim: string;
  verdict: FactVerdict;
  /** Reviewer 给出的支撑证据 id（SUPPORTED / PARTIALLY 时可能携带） */
  evidenceId?: string;
  /** evidenceId 是否解析到 formal evidence（verified + 锚点） */
  evidenceFormal: boolean;
  /** 绑定证据解析出的 citation key（与 Writer 引用 / coverage gate 同源解析链） */
  citationKey?: string;
  /** UNSUPPORTED / CONTRADICTED 的修复候选（formal 池词面 Top-K；可空） */
  repairCandidates: EvidenceCandidate[];
  /** M11.2.3（D-2）：UNSUPPORTED claim 的披露口径（凭空断言 vs 透明未核验转述） */
  disclosure?: ClaimDisclosure;
}

export interface ClaimGroundingReport {
  schemaVersion: 1;
  /** 稳定 id：cg-r{round} */
  reportId: string;
  projectId: string;
  round: number;
  generatedAt: string;
  /** Fact Reviewer 检出的 factual claim 总数（无 fact claims = 0，兼容 legacy） */
  totalClaims: number;
  supportedClaims: number;
  partiallySupportedClaims: number;
  unsupportedClaims: number;
  contradictedClaims: number;
  /** verdict 有支撑且 evidenceId 解析到 formal evidence 的 claim 数 */
  evidenceBoundClaims: number;
  /** evidenceBoundClaims / totalClaims（totalClaims=0 时为 0） */
  evidenceBindingRate: number;
  /** UNSUPPORTED + CONTRADICTED 的 claimId 列表 */
  unsupportedClaimIds: string[];
  /**
   * M11.2.3（D-2）：unsupported 的披露口径拆分——opaque 计入
   * unsupported_critical_claims_zero 阻断口径；transparent 单独可见
   * （gate 明细 + 评分仍如实反映，不是 evidence-backed）。
   */
  opaqueUnsupportedClaims: number;
  transparentUnsupportedClaims: number;
  claims: ClaimGroundingEntry[];
  /** 参与绑定的 formal evidence 池规模（审计：分母口径） */
  formalEvidencePool: number;
}

export interface ClaimGroundingInput {
  projectId: string;
  round: number;
  /** Fact Reviewer 的逐 claim 核验结果（缺省 = 无 fact claims，全零报告） */
  factClaims: readonly FactClaimCheck[];
  /** 候选检索与绑定解析的证据池（formal 之外的记录不参与） */
  formalEvidence: readonly EvidenceRecord[];
  /** bibliography 摘要（citation key 解析；空数组 = 不解析 key） */
  bibEntries: readonly ClaimGroundingBibEntry[];
  generatedAt?: string;
}

/**
 * 生成 Claim Grounding Report（纯函数，无 LLM）：复用 Reviewer verdict，
 * 逐 claim 判定 evidenceId 绑定有效性，对 unsupported claim 附 bounded 候选。
 */
export function computeClaimGroundingReport(input: ClaimGroundingInput): ClaimGroundingReport {
  const formalById = new Map(
    input.formalEvidence.filter((record) => isFormalEvidence(record)).map((record) => [record.id, record]),
  );
  const entries: ClaimGroundingEntry[] = [];
  const unsupportedClaimIds: string[] = [];
  let supported = 0;
  let partial = 0;
  let unsupported = 0;
  let contradicted = 0;
  let bound = 0;
  let opaqueUnsupported = 0;
  let transparentUnsupported = 0;
  for (const check of input.factClaims) {
    const claimId = claimFingerprint(check.section, check.claim);
    const evidenceRecord =
      check.evidenceId !== undefined ? formalById.get(check.evidenceId) : undefined;
    const evidenceFormal = evidenceRecord !== undefined;
    if (check.verdict === "SUPPORTED" || check.verdict === "PARTIALLY_SUPPORTED") {
      if (evidenceFormal) {
        bound += 1;
      }
    }
    switch (check.verdict) {
      case "SUPPORTED":
        supported += 1;
        break;
      case "PARTIALLY_SUPPORTED":
        partial += 1;
        break;
      case "UNSUPPORTED":
        unsupported += 1;
        break;
      case "CONTRADICTED":
        contradicted += 1;
        break;
    }
    if (isUnsupportedVerdict(check.verdict)) {
      unsupportedClaimIds.push(claimId);
    }
    const disclosure = isUnsupportedVerdict(check.verdict)
      ? classifyClaimDisclosure(check.claim)
      : undefined;
    if (disclosure === "transparent_unverified") {
      transparentUnsupported += 1;
    } else if (disclosure === "opaque_assertion") {
      opaqueUnsupported += 1;
    }
    entries.push({
      claimId,
      section: check.section,
      claim: check.claim,
      verdict: check.verdict,
      ...(check.evidenceId !== undefined ? { evidenceId: check.evidenceId } : {}),
      evidenceFormal,
      ...(evidenceRecord !== undefined
        ? (() => {
            const key = resolveEvidenceCitationKey(evidenceRecord, input.bibEntries);
            return key !== null ? { citationKey: key } : {};
          })()
        : {}),
      repairCandidates: isUnsupportedVerdict(check.verdict)
        ? findEvidenceCandidates(check.claim, input.formalEvidence)
        : [],
      ...(disclosure !== undefined ? { disclosure } : {}),
    });
  }
  const total = entries.length;
  return {
    schemaVersion: 1,
    reportId: `cg-r${input.round}`,
    projectId: input.projectId,
    round: input.round,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    totalClaims: total,
    supportedClaims: supported,
    partiallySupportedClaims: partial,
    unsupportedClaims: unsupported,
    contradictedClaims: contradicted,
    evidenceBoundClaims: bound,
    evidenceBindingRate: total === 0 ? 0 : Number((bound / total).toFixed(4)),
    unsupportedClaimIds,
    opaqueUnsupportedClaims: opaqueUnsupported,
    transparentUnsupportedClaims: transparentUnsupported,
    claims: entries,
    formalEvidencePool: formalById.size,
  };
}

/** 派发给 Writer 的 Unsupported Claim Repair Context（§7） */
export interface ClaimRepairCandidateView {
  evidenceId: string;
  claim: string;
  quote?: string;
  citationKey?: string;
}

export interface ClaimRepairDirective {
  claimId: string;
  section: string;
  claim: string;
  verdict: FactVerdict;
  candidates: ClaimRepairCandidateView[];
}

/**
 * Report → 修订派发用的 Repair Directives（确定性投影）：
 * 候选 evidence 记录从 evidenceById 解析（库内记录可见性 = §6 修改前依据同口径），
 * 解析不到的候选如实丢弃（不强渲染不可用 id）；candidates 为空的 claim 照样派发
 * （WEAKEN / REMOVE 路径），不因无候选而静默跳过。
 */
export function buildClaimRepairDirectives(
  report: ClaimGroundingReport,
  matchesSection: (claimSection: string) => boolean,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
  bibEntries: readonly ClaimGroundingBibEntry[],
): ClaimRepairDirective[] {
  const directives: ClaimRepairDirective[] = [];
  for (const entry of report.claims) {
    if (!isUnsupportedVerdict(entry.verdict) || !matchesSection(entry.section)) {
      continue;
    }
    const candidates: ClaimRepairCandidateView[] = [];
    for (const candidate of entry.repairCandidates) {
      const record = evidenceById.get(candidate.evidenceId);
      if (record === undefined) {
        continue;
      }
      const key = resolveEvidenceCitationKey(record, bibEntries);
      candidates.push({
        evidenceId: record.id,
        claim: record.claim,
        ...(record.quote !== undefined && record.quote !== "" ? { quote: record.quote } : {}),
        ...(key !== null ? { citationKey: key } : {}),
      });
    }
    directives.push({
      claimId: entry.claimId,
      section: entry.section,
      claim: entry.claim,
      verdict: entry.verdict,
      candidates,
    });
  }
  return directives;
}
