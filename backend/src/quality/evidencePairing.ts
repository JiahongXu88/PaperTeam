/**
 * M15.6 阶段 C：Evidence-Aware 判定桥接层（gate-input adapter；纯函数、确定性、零模型）。
 *
 * 修复的语义缺口（M15.5 N1）：规则 4/5/6 把「证据库无记录」（fact reviewer 契约：无 verified
 * Evidence 时强论断必须 UNSUPPORTED）计成「已证实的论断违规」——已发表论文 / 库空项目的
 * blocking 44-100% 是该工件。本模块按预登记状态表（PRE_REGISTERED_PROTOCOL.md §1）把
 * claim 级与 finding 级的计数输入分层：
 *
 *  claim 级（规则 4）：
 *   - VERIFIED_CONTRADICTION：claimChecks CONTRADICTED / claimGrounding 中 CONTRADICTED 且
 *     evidenceId 解析为 formal evidence（E001/S003 型）——计违规（真实缺陷保持阻断）。
 *   - REVIEWER_SUSPECTED：CONTRADICTED 无 formal 解析——计违规（CONTRADICTED ≠ 没找到证据）。
 *   - EVIDENCE_GAP_NOT_EVALUATED：UNSUPPORTED 且无 pairing 材料（formal 池空 + 证据库空）——
 *     不计违规；published 只读 = 评估缺口（不阻断），author 稿件 = 必需核验未完成（required 仍阻断）。
 *   - 有 pairing 材料时的 UNSUPPORTED 维持既有计数口径（claimGrounding opaque /
 *     claimGapAudit revisionIntroduced——检索执行后无支持 = 作者须补证据，M11.2.3 语义不动）。
 *
 *  finding 级（规则 5/6）：
 *   - 无 pairing 材料时，evidence_gap 类 heavy finding 与 rootCauseKey 归因到 gap claim 的
 *     fact/evidence_gap finding = 工件 → 不计违规（NOT_EVALUATED 呈现）。
 *   - published 只读口径：模型按 rubric 自报 verification=AUTHOR_CHECK_REQUIRED /
 *     EXTERNAL_DATA_REQUIRED 的 finding = 核验不足（不是已证实违规）→ 不计违规；
 *     VERIFIED_IN_TEXT（稿内可证）照旧计数。
 *   - 与既有 rootCauseKey 去重、claimGapAudit 归因排除、deterministicDisconfirmed 反证互不干扰
 *     （本模块只做加性排除，输入口径不变）。
 *
 * 硬约束：NOT_EVALUATED ≠ PASS；VERIFIED_* 只来自 claimChecks / formal evidence 解析 /
 * （下游规则）claimCertificate；LLM 自报 confidence 与 CandidateProposer ACCEPTED 永不进入。
 */

import type { ClaimGroundingReport, ClaimGroundingEntry } from "../review/claimGrounding.js";
import type { ClaimCheckGateSummary } from "../experiments/claimChecks.js";
import type { ReviewIssue, FactVerdict } from "../agents/ReviewerService.js";

export const EVIDENCE_PAIRING_SCHEMA = "paperteam.evidence-pairing/v1";

/** 证据记录的最小投影（域相关性检查用；调用方从 EvidenceStore 传入） */
export interface EvidenceRecordProjection {
  id: string;
  claim: string;
  quote?: string;
  title?: string;
}

export interface EvidencePairingInput {
  reviewPurpose: "author_manuscript" | "published_paper_assessment";
  /** EvidenceStats 投影（total / verified 计数——pairing 材料判定） */
  evidence: { total: number; verified: number; contradictory: number };
  claimGrounding: ClaimGroundingReport | null;
  claimChecks: ClaimCheckGateSummary | undefined;
  /** review.scores.factVerdicts（缺省 null） */
  factVerdicts: Record<FactVerdict, number> | null;
  /** review.unsupportedCriticalClaims（legacy 计数路径） */
  unsupportedCriticalClaims: number;
  issues: readonly ReviewIssue[];
  /** 证据记录投影（域检查；空数组 = 无记录可查） */
  evidenceRecords: readonly EvidenceRecordProjection[];
}

export interface EvidencePairingClaimCounts {
  evaluated: number;
  /** 已证实矛盾（计违规）：formal evidence 解析的 CONTRADICTED */
  verifiedContradictions: number;
  /** 审稿 CONTRADICTED 无 formal 解析（计违规，REVIEWER_SUSPECTED） */
  reviewerContradictions: number;
  /** 规则 4d（experiment_claims_recomputed）的 CONTRADICTED 数——单独呈现，不并入规则 4 计数（同根因不双计） */
  claimCheckContradicted: number;
  /** 域不匹配被拒绝的 CONTRADICTED pairing（不计违规；PAIRING_DOMAIN_MISMATCH） */
  domainMismatchContradictions: number;
  /** 无 pairing 材料下的 UNSUPPORTED（不计违规；author 语境 required NOT_EVALUATED） */
  evidenceGapUnsupported: number;
  /** 维持计数的 UNSUPPORTED（有 pairing：opaque / legacy 口径；或 claimGapAudit 语境——由调用方另行处理） */
  countedUnsupported: number;
  authorDataPending: number;
  transparentReported: number;
}

export interface EvidencePairingFindingCounts {
  blockingTotal: number;
  blockingEvidenceGapExcluded: number;
  criticalTotal: number;
  criticalEvidenceGapExcluded: number;
  majorTotal: number;
  majorEvidenceGapExcluded: number;
  /** published rubric 自报核验状态分布（heavy findings） */
  verificationDeclared: { verifiedInText: number; authorCheck: number; externalData: number; undeclared: number };
  /** 因 rubric 核验声明被排除的 heavy finding 数（只读口径） */
  verificationDeclaredExcluded: number;
}

export interface EvidencePairingSummary {
  schema: typeof EVIDENCE_PAIRING_SCHEMA;
  pairingStatus: "NO_PAIRING_MATERIAL" | "PAIRING_AVAILABLE";
  formalEvidencePool: number;
  claims: EvidencePairingClaimCounts;
  findings: EvidencePairingFindingCounts;
  domainMismatches: Array<{ evidenceId: string; note: string }>;
  notes: string[];
}

/**
 * 区分词集合（域检查的负向信号：零重叠 = 证据与论断无任何词面关联）。
 * 拉丁词按词元（≥4 字符）；CJK 无词边界，按 2-gram（整句成串时单 term 永不重叠）。
 */
function distinctiveTermSet(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const token of normalized.match(/[a-z]{4,}/g) ?? []) {
    terms.add(token);
  }
  for (const run of normalized.match(/[一-鿿]{2,}/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return terms;
}

/**
 * 域相关性（N3 防御，只降级不升级）：证据记录与被它 CONTRADICT 的论断零区分词重叠
 * → 该 pairing 不能证明论断错误（PAIRING_DOMAIN_MISMATCH）。注意：同领域证据（E001 vs
 * ByteTrack 均为 MOT 域）有词面重叠、不受本检查保护——跨域污染的根治靠评测侧隔离
 * （M15.6 D1 清洁副本）与来源元数据，本检查只挡住「完全无关证据」的极端形态。
 */
function evidenceDomainMatches(record: EvidenceRecordProjection, claimText: string): boolean {
  const evidenceText = [record.claim, record.quote ?? "", record.title ?? ""].join(" ");
  const evidenceTerms = distinctiveTermSet(evidenceText);
  const claimTerms = distinctiveTermSet(claimText);
  if (claimTerms.size === 0 || evidenceTerms.size === 0) return true; // 无法判定 = 不拒绝（fail-open 只用于本防御性降级开关）
  for (const term of claimTerms) {
    if (evidenceTerms.has(term)) return true;
  }
  return false;
}

/**
 * 计算 Evidence-Aware 分层（纯函数）。调用方：evaluateProjectQualityGate（唯一生产入口，
 * workflow 与手动 POST 共用）；gates.ts 规则 4/5/6 消费其输出（undefined = 旧口径，兼容旧产物）。
 */
export function deriveEvidencePairing(input: EvidencePairingInput): EvidencePairingSummary {
  const formalEvidencePool = input.claimGrounding?.formalEvidencePool ?? 0;
  const pairingAvailable = input.evidence.verified > 0 || formalEvidencePool > 0 || input.evidence.total > 0;
  const notes: string[] = [];
  const domainMismatches: Array<{ evidenceId: string; note: string }> = [];

  // ---- claim 级分层（规则 4 计数输入） ----
  const verdicts = input.factVerdicts;
  const evaluated =
    verdicts === null
      ? 0
      : verdicts.SUPPORTED + verdicts.PARTIALLY_SUPPORTED + verdicts.UNSUPPORTED + verdicts.CONTRADICTED;
  const recordById = new Map(input.evidenceRecords.map((record) => [record.id, record]));
  let verifiedContradictions = 0;
  let reviewerContradictions = 0;
  let domainMismatchContradictions = 0;
  let gapUnsupported = 0;
  let countedUnsupported = 0;
  let authorDataPending = 0;
  let transparentReported = 0;
  const gapClaimIds = new Set<string>();

  if (input.claimGrounding !== null) {
    for (const entry of input.claimGrounding.claims as readonly ClaimGroundingEntry[]) {
      if (entry.verdict === "CONTRADICTED") {
        // CONTRADICTED + formal evidence 解析（域匹配）→ VERIFIED_CONTRADICTION（计违规；E001/S003 锚）
        if (entry.evidenceFormal && entry.evidenceId !== undefined) {
          const record = recordById.get(entry.evidenceId);
          if (record !== undefined && !evidenceDomainMatches(record, entry.claim)) {
            domainMismatchContradictions += 1;
            domainMismatches.push({ evidenceId: entry.evidenceId, note: `证据 ${entry.evidenceId} 与论断零词面关联（PAIRING_DOMAIN_MISMATCH）：该 CONTRADICTED 判定不作为论断违规计数` });
          } else {
            verifiedContradictions += 1;
          }
          continue;
        }
        // CONTRADICTED 无 formal 解析：维持 claimGrounding 既有披露口径——opaque 计数（REVIEWER_SUSPECTED），
        // transparent（「据其原文自述且未经独立核验」的矛盾陈述）不计数（现状语义，M11.2.3）
        if (entry.disclosure === "transparent_unverified" || entry.disclosure === "author_experiment_data") {
          transparentReported += 1;
        } else {
          reviewerContradictions += 1;
        }
        continue;
      }
      if (entry.verdict === "UNSUPPORTED") {
        if (entry.disclosure === "author_experiment_data") {
          authorDataPending += 1;
        } else if (entry.disclosure === "transparent_unverified") {
          transparentReported += 1;
        } else if (!pairingAvailable) {
          // M15.6 N1：证据库无 pairing 材料 → UNSUPPORTED = 核验缺口，不是论断违规
          gapUnsupported += 1;
          gapClaimIds.add(entry.claimId);
        } else {
          countedUnsupported += 1; // opaque（检索执行后无支持）——维持计数
        }
      }
    }
  } else if (verdicts !== null) {
    // legacy 路径（无 claimGrounding；纯单元输入 / 旧轮次）：UNSUPPORTED+CONTRADICTED 均计数（现状），
    // 仅在无 pairing 材料时把 UNSUPPORTED 部分降为核验缺口
    reviewerContradictions += verdicts.CONTRADICTED;
    if (!pairingAvailable) {
      gapUnsupported = verdicts.UNSUPPORTED;
    } else {
      countedUnsupported = verdicts.UNSUPPORTED;
    }
  }
  // claimChecks CONTRADICTED 由规则 4d 单独计数 / FAIL——此处只作呈现统计，不并入规则 4 违规计数（同根因不双计）
  const claimCheckContradicted = input.claimChecks?.contradicted.length ?? 0;

  // ---- finding 级分层（规则 5/6 计数输入） ----
  const heavy = (issue: ReviewIssue): boolean => issue.severity === "critical" || issue.severity === "major" || issue.blocking;
  const verificationDeclared = { verifiedInText: 0, authorCheck: 0, externalData: 0, undeclared: 0 };
  let blockingEvidenceGapExcluded = 0;
  let criticalEvidenceGapExcluded = 0;
  let majorEvidenceGapExcluded = 0;
  let verificationDeclaredExcluded = 0;
  const published = input.reviewPurpose === "published_paper_assessment";
  // 已由既有 rootCauseKey 去重覆盖的 finding（归因到本轮 unsupported claim——规则 5/6 已排除，
  // 规则 4 的 claim 口径已计）不在本模块重复排除（防同一条 finding 双扣）；核验声明直方图仍覆盖全部 heavy finding
  const unsupportedClaimIdSet = new Set(input.claimGrounding?.unsupportedClaimIds ?? []);
  for (const issue of input.issues) {
    if (!heavy(issue)) continue;
    const declared = issue.verification;
    if (declared === "VERIFIED_IN_TEXT") verificationDeclared.verifiedInText += 1;
    else if (declared === "AUTHOR_CHECK_REQUIRED") verificationDeclared.authorCheck += 1;
    else if (declared === "EXTERNAL_DATA_REQUIRED") verificationDeclared.externalData += 1;
    else verificationDeclared.undeclared += 1;
    if (issue.rootCauseKey !== undefined && unsupportedClaimIdSet.has(issue.rootCauseKey)) continue;
    // (a) 无 pairing 材料：evidence_gap 类 = 工件
    const gapCategory = !pairingAvailable && issue.category === "evidence_gap";
    // (b) rootCauseKey 归因到 gap claim（fact / evidence_gap 类）
    const gapRootCaused =
      !pairingAvailable &&
      (issue.category === "fact" || issue.category === "evidence_gap") &&
      issue.rootCauseKey !== undefined &&
      gapClaimIds.has(issue.rootCauseKey);
    // (c) published 只读：rubric 自报「需作者核对 / 需外部数据」= 核验不足，不是已证实违规
    const declaredUnverified = published && (declared === "AUTHOR_CHECK_REQUIRED" || declared === "EXTERNAL_DATA_REQUIRED");
    const excluded = gapCategory || gapRootCaused || declaredUnverified;
    if (!excluded) continue;
    if (declaredUnverified && !gapCategory && !gapRootCaused) verificationDeclaredExcluded += 1;
    if (issue.blocking) blockingEvidenceGapExcluded += 1;
    if (issue.severity === "critical") criticalEvidenceGapExcluded += 1;
    if (issue.severity === "major") majorEvidenceGapExcluded += 1;
  }

  if (!pairingAvailable) {
    notes.push(
      published
        ? "证据库无 pairing 材料：UNSUPPORTED 类论断与 evidence_gap 类 finding 按预登记状态表降为 NOT_EVALUATED（只读评估的核验缺口，不是已证实论断违规）"
        : "证据库无 pairing 材料：UNSUPPORTED 类论断按预登记状态表降为 NOT_EVALUATED（必需核验未完成——author 稿件语境下仍阻断 READY，失败原因 = 缺核验而非科学错误）",
    );
  }
  if (input.claimGrounding !== null && input.claimGrounding.formalEvidencePool === 0 && input.evidence.total > 0) {
    notes.push(`证据库有 ${input.evidence.total} 条记录但无 formal（verified+锚点）证据：claim 级 pairing 以 formal 池为准`);
  }

  return {
    schema: EVIDENCE_PAIRING_SCHEMA,
    pairingStatus: pairingAvailable ? "PAIRING_AVAILABLE" : "NO_PAIRING_MATERIAL",
    formalEvidencePool,
    claims: {
      evaluated,
      verifiedContradictions,
      reviewerContradictions,
      claimCheckContradicted,
      domainMismatchContradictions,
      evidenceGapUnsupported: gapUnsupported,
      countedUnsupported,
      authorDataPending,
      transparentReported,
    },
    findings: {
      blockingTotal: input.issues.filter((issue) => issue.blocking).length,
      blockingEvidenceGapExcluded,
      criticalTotal: input.issues.filter((issue) => issue.severity === "critical").length,
      criticalEvidenceGapExcluded,
      majorTotal: input.issues.filter((issue) => issue.severity === "major").length,
      majorEvidenceGapExcluded,
      verificationDeclared,
      verificationDeclaredExcluded,
    },
    domainMismatches,
    notes,
  };
}

/**
 * 规则 4 的违规计数（消费方：gates.ts）。
 * claimGapAudit 语境（existing-paper 返修）调用方自行走 audit.counts.revisionIntroduced
 * ——任务口径的修订引入违规不因证据库状态降级（修订不得添加无支撑论断）。
 */
export function evidenceAwareUnsupportedCount(pairing: EvidencePairingSummary): number {
  return pairing.claims.countedUnsupported + pairing.claims.reviewerContradictions + pairing.claims.verifiedContradictions;
}
