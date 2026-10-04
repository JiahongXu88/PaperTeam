/**
 * Unsupported Claim Resolution Contract（M11.2.3，D-1/D-3）。
 *
 * M11.2 的行为缺口：Reviewer 产出 UNSUPPORTED 后，Writer 得到的是「自由修复」
 * 授权（整节可改），既不区分「证据已在库、只是没绑定」与「语料根本无法支撑」，
 * 也没有 Evidence-First 顺序——弱化成为第一反应，修好 A 破坏 B。
 *
 * 本模块给每个 unsupported claim 先确定 resolution action（确定性，无 LLM）：
 *
 * 1. use_existing_evidence     已有 formal Evidence 可支撑（词面候选命中），
 *                              Writer 只需正确引用 / 绑定，不动事实。
 * 2. ground_existing_source    已有全文（chunks 在库）但证据未采——先定向
 *                              Evidence Grounding（D-3），再绑定。
 * 3. targeted_evidence_search  语料确实不足（引用源 metadata_only）且 claim
 *                              重要（blocking 口径）——bounded 补搜索（§9 限额）。
 * 4. author_decision_required  已透明披露的未核验转述（transparent_unverified）
 *                              无 grounding 通路——诚实终态已达成，进一步处置
 *                              （取全文 / 删除 / 保留）属作者裁决，不自动改稿。
 * 5. remove_unsupported_detail 无 grounding 通路且含数字——数值只许删除
 *                              （M11.2.1 既有授权类别）。
 * 6. weaken_claim_strength     无 grounding 通路、无数字、弱化形态可接受
 *                              （weakenedClaim 判定）——降断言强度。
 * 7. remove_claim              弱化形态不可接受（比较 / 性能语义就是 claim 核心）
 *                              且语料无法支撑——整条删除（窄授权，M11.2.3 新增）。
 *
 * Reviewer 只发现问题；本合同决定「先做什么」。授权仍是 typed / narrow /
 * traceable（weakeningAuthorization 台账），Fact Preservation 依旧 fail-closed。
 */

import { isUnsupportedVerdict, lookupSectionCitedSourceIds, type ClaimGroundingEntry } from "./claimGrounding.js";
import { assessWeakenedClaim } from "./weakenedClaim.js";
import { tokenizeText } from "../retrieval/tokenize.js";

export type ClaimResolutionAction =
  | "use_existing_evidence"
  | "ground_existing_source"
  | "targeted_evidence_search"
  | "author_decision_required"
  | "remove_unsupported_detail"
  | "weaken_claim_strength"
  | "remove_claim";

export interface ClaimResolution {
  claimId: string;
  section: string;
  claim: string;
  verdict: ClaimGroundingEntry["verdict"];
  action: ClaimResolutionAction;
  /** 机器可读依据（审计 / 测试断言） */
  basis: string;
  /** 人读说明（计划条目 / 报告） */
  reason: string;
  /** ground_existing_source / targeted_evidence_search 的目标源（确定性排序） */
  sourceIds?: string[];
  /** use_existing_evidence 的候选证据 id（claim grounding repairCandidates） */
  evidenceIds?: string[];
}

/** 源的可 grounding 性（revision.plan 现场计算：fulltext resolved + chunks 在库） */
export interface SourceGroundability {
  sourceId: string;
  /** 源标题（词面相关度判定；缺失 = 不参与词面通道） */
  title?: string;
  /** 全文 chunks 可用（sources/chunks/{id}.jsonl 非空） */
  hasChunks: boolean;
  /** 引用源存在但全文未取得（metadata_only / not_found / failed） */
  metadataOnly: boolean;
}

export interface ClaimResolutionContext {
  /** 语料内全部源的可 grounding 性（按 sourceId 索引消费） */
  sources: readonly SourceGroundability[];
  /** claim 所在章节引用的 sourceId（survey literatureRefs / \cite 解析；可缺省） */
  sectionCitedSourceIds?: Record<string, string[]>;
  /**
   * 本轮 targeted evidence search 剩余额度（query 数；0 / 缺省 = 不启用搜索，
   * §9 bounded——搜索是运维动作，由调用方按预算授权，不是分类器的默认出口）。
   */
  targetedSearchBudget?: number;
}

/** claim 的目标源选取上限（ground_existing_source 每条 claim 最多 3 源） */
export const RESOLUTION_SOURCE_LIMIT = 3;

function groundableSourcesFor(
  entry: ClaimGroundingEntry,
  context: ClaimResolutionContext,
): SourceGroundability[] {
  // M11.3：章节键归一化命中（claim.section = sections/x.tex ↔ 投影键 = x；
  // 双键兼容旧投影 / 测试夹具的原始键形）
  const cited = lookupSectionCitedSourceIds(context.sectionCitedSourceIds, entry.section);
  const byId = new Map(context.sources.map((source) => [source.sourceId, source]));
  const ranked: SourceGroundability[] = [];
  // 1) 章节引用的源（survey literatureRefs 的确定性投影）
  for (const sourceId of cited) {
    const source = byId.get(sourceId);
    if (source !== undefined) {
      ranked.push(source);
    }
  }
  // 2) 词面相关源（claim ↔ 源标题 token 重合 ≥2；重合数降序、同分 sourceId
  //    字典序——确定性）。与检索 tokenizer 同源（中英兼容，CJK bigram）。
  const claimTerms = new Set(tokenizeText(entry.claim));
  const lexical = context.sources
    .filter((source) => !ranked.includes(source) && (source.title ?? "").trim() !== "")
    .map((source) => ({
      source,
      overlap: new Set(tokenizeText(source.title ?? "").filter((term) => claimTerms.has(term))).size,
    }))
    .filter((hit) => hit.overlap >= 2)
    .sort(
      (a, b) => b.overlap - a.overlap || (a.source.sourceId < b.source.sourceId ? -1 : 1),
    )
    .map((hit) => hit.source);
  ranked.push(...lexical);
  return ranked.slice(0, RESOLUTION_SOURCE_LIMIT);
}

/**
 * 单条 unsupported claim 的 resolution（纯函数，确定性）。
 * 顺序见模块头；每个分支互斥，同输入同输出。
 */
export function classifyClaimResolution(
  entry: ClaimGroundingEntry,
  context: ClaimResolutionContext,
): ClaimResolution {
  const base = {
    claimId: entry.claimId,
    section: entry.section,
    claim: entry.claim,
    verdict: entry.verdict,
  };
  if (!isUnsupportedVerdict(entry.verdict)) {
    throw new Error(`classifyClaimResolution 只接受 UNSUPPORTED/CONTRADICTED claim（${entry.claimId}）`);
  }

  // 1. 已有 formal Evidence：候选命中 → 只需绑定（不动事实）
  if (entry.repairCandidates.length > 0) {
    return {
      ...base,
      action: "use_existing_evidence",
      basis: `repair_candidates:${entry.repairCandidates.length}`,
      reason: `已有 ${entry.repairCandidates.length} 条 formal 证据词面命中——Writer 修正引用 / 绑定即可，不得改写事实`,
      evidenceIds: entry.repairCandidates.map((candidate) => candidate.evidenceId),
    };
  }

  const groundable = groundableSourcesFor(entry, context);
  const withChunks = groundable.filter((source) => source.hasChunks);
  // 2. 全文在库、证据未采：定向 grounding 优先于任何文字修改（Evidence First）
  if (withChunks.length > 0) {
    return {
      ...base,
      action: "ground_existing_source",
      basis: `chunked_sources:${withChunks.map((source) => source.sourceId).join("+")}`,
      reason: `全文已在库（${withChunks.map((source) => source.sourceId).join("、")}）但证据未采——先定向 evidence grounding，成功后绑定，不先改文字`,
      sourceIds: withChunks.map((source) => source.sourceId),
    };
  }

  // 3. 引用源存在但全文缺失：blocking 口径下才允许 bounded 补搜索（§9）；
  //    无预算 / 非引用性 claim → 走弱化 / 删除阶梯
  const citedOnlyMetadata = groundable.filter((source) => source.metadataOnly);
  if (
    citedOnlyMetadata.length > 0 &&
    (context.targetedSearchBudget ?? 0) > 0
  ) {
    return {
      ...base,
      action: "targeted_evidence_search",
      basis: `metadata_only_sources:${citedOnlyMetadata.map((source) => source.sourceId).join("+")}`,
      reason: `引用源（${citedOnlyMetadata.map((source) => source.sourceId).join("、")}）全文未取得——bounded 定向补搜索（≤${context.targetedSearchBudget} queries）；不可得则回落弱化 / 删除`,
      sourceIds: citedOnlyMetadata.map((source) => source.sourceId),
    };
  }

  // 4. 已透明披露的未核验转述：诚实终态已达成，不自动改稿（口径属作者）
  if (entry.disclosure === "transparent_unverified") {
    return {
      ...base,
      action: "author_decision_required",
      basis: "transparent_unverified_no_grounding",
      reason:
        "该论断已按「据来源转述 + 未核验」透明披露且无 grounding 通路——保持现状不计入阻断口径；是否取全文 / 删除属作者裁决",
    };
  }

  // 5-7. 凭空断言（opaque）：数值 → 删除；可弱化 → 弱化；弱化形态不可接受 → 整条删除
  if (/\d/.test(entry.claim)) {
    return {
      ...base,
      action: "remove_unsupported_detail",
      basis: "numeric_no_grounding",
      reason: "无 grounding 通路且含数字——数值只许删除（不得替换 / 改写后保留），核心表述降为可支撑范围",
    };
  }
  const weakening = assessWeakenedClaim(entry.claim);
  if (weakening.acceptable) {
    return {
      ...base,
      action: "weaken_claim_strength",
      basis: "weaken_form_acceptable",
      reason: `弱化形态可接受（${weakening.reason}）——降断言强度，保留归因与范围`,
    };
  }
  return {
    ...base,
    action: "remove_claim",
    basis: `weaken_form_rejected:${weakening.violatedRules.join("+")}`,
    reason: `弱化形态不可接受（${weakening.reason}）且语料无法支撑——整条删除（窄授权，须计划点名）`,
  };
}

export interface ClaimResolutionReport {
  schemaVersion: 1;
  projectId: string;
  round: number;
  generatedAt: string;
  resolutions: ClaimResolution[];
  counts: Record<ClaimResolutionAction, number>;
}

/** 批量分类（确定性；输入 = 同轮 claim grounding 的 unsupported 条目） */
export function computeClaimResolutions(
  entries: readonly ClaimGroundingEntry[],
  context: ClaimResolutionContext,
  meta: { projectId: string; round: number; generatedAt?: string },
): ClaimResolutionReport {
  const resolutions: ClaimResolution[] = [];
  const counts = {
    use_existing_evidence: 0,
    ground_existing_source: 0,
    targeted_evidence_search: 0,
    author_decision_required: 0,
    remove_unsupported_detail: 0,
    weaken_claim_strength: 0,
    remove_claim: 0,
  } satisfies Record<ClaimResolutionAction, number>;
  for (const entry of entries) {
    if (!isUnsupportedVerdict(entry.verdict)) {
      continue;
    }
    const resolution = classifyClaimResolution(entry, context);
    resolutions.push(resolution);
    counts[resolution.action] += 1;
  }
  return {
    schemaVersion: 1,
    projectId: meta.projectId,
    round: meta.round,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    resolutions,
    counts,
  };
}

/**
 * 分类的派发语义（计划构建 / 报告消费）：
 * - writerDispatch=true 的 action 产生修订派发与 typed 授权；
 * - author_decision_required 只记录（报告 / HITL），不派发 Writer——已透明
 *   披露的终态反复派发正是 M11.2 修订振荡的一族根因。
 */
export function resolutionRequiresWriterDispatch(action: ClaimResolutionAction): boolean {
  return (
    action === "use_existing_evidence" ||
    action === "remove_unsupported_detail" ||
    action === "weaken_claim_strength" ||
    action === "remove_claim"
  );
}
