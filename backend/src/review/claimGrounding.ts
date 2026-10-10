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
export type ClaimDisclosure = "opaque_assertion" | "transparent_unverified" | "author_experiment_data";

/**
 * 授权实验观测（Round 2）：claim 的全部数值都能在作者确认并授权进入工作流的
 * 观测值里找到 → 披露口径 author_experiment_data——作者自己的实验结果不需要
 * 外部文献重证（与 M10.3.1 claimGapAudit 的 excluded_author_data 同一原则，
 * 但数据来源是 M13.5/M13.6 的 workflowContext 而不是 user_confirmed Evidence，
 * 因此 idea_to_paper 工作流也能覆盖）。诚实边界：仍不是 evidence-backed，
 * 不入 SUPPORTED；gate 单独呈现计数，不计入「凭空断言」阻断口径。
 */
export interface AuthorizedObservationValue {
  value: number;
  metric?: string;
  split?: string;
  groupId?: string;
}

/** claim 文本中的独立数值 run（排除粘连在字母上的数字，如 Dev25 / IDF1 / S014） */
export function claimNumberRuns(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\d.])\d+(?:\.\d+)?(?![\p{L}\d])/gu)]
    .map((match) => match[0] ?? "")
    .filter((token) => token !== "");
}

function numericEquals(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

/**
 * claim 的全部数值是否都由授权观测值覆盖（≥1 个数值；数值比较按浮点相等，
 * 0.628030 与 0.62803 视为同一值）。返回命中的观测标签（metric@split=value）
 * 以便报告溯源；不覆盖 → null。
 */
export function authorizedObservationsCovering(
  claimText: string,
  observations: readonly AuthorizedObservationValue[],
): string[] | null {
  if (observations.length === 0) {
    return null;
  }
  const numbers = [...new Set(claimNumberRuns(claimText))];
  if (numbers.length === 0) {
    return null;
  }
  const labels: string[] = [];
  for (const token of numbers) {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      return null;
    }
    const hit = observations.find((observation) => numericEquals(observation.value, value));
    if (hit === undefined) {
      return null;
    }
    labels.push(`${hit.metric ?? "?"}${hit.split !== undefined ? `@${hit.split}` : ""}=${hit.value}`);
  }
  return labels;
}

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
  /** 候选证据所属源（M11.3 支持质量门槛：来源合法性判定） */
  sourceId?: string;
  score: number;
  matchedTerms: number;
}

/**
 * M11.3（Phase B）：数值密集 claim 要求 direct 级支持——含数字的论断
 * （性能数值 / 百分比 / 规模）不得由 partial 级证据短路绑定。
 */
export function claimRequiresDirectSupport(claimText: string): boolean {
  return /\d/.test(claimText);
}

/**
 * M11.3（Phase B）证据记录级支持质量（§10）：
 * - 已 verified + 锚点（isFormalEvidence，既有口径）；
 * - verificationLevel ≠ metadata——metadata-only 记录不得伪装成正文证据；
 * - supportStrength 达到 claim 所需最低等级：含数字 claim 要求 direct，
 *   其余 direct / partial 皆可；strength 缺失 = 不足（fail-closed，不猜）。
 */
export function meetsEvidenceSupportQuality(record: EvidenceRecord, claimText: string): boolean {
  if ((record.verificationLevel ?? "") === "metadata") {
    return false;
  }
  const strength = record.supportStrength;
  if (strength === undefined) {
    return false;
  }
  if (strength === "direct") {
    return true;
  }
  return strength === "partial" && !claimRequiresDirectSupport(claimText);
}

/**
 * M11.3（Phase B）数值锚定：claim 中的特征数字（小数 / 百分比 / ≥3 位整数，
 * 剔除纯年份）必须在证据文本中出现至少一个——数值 claim 与不含该数值的
 * 词面相似证据不得短路（「词面相关 ≠ 支撑该数值」）。
 */
export function distinctiveNumbers(text: string): string[] {
  const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.filter((value) => {
    if (value.includes(".")) {
      return true;
    }
    if (value.length < 3) {
      return false;
    }
    const numeric = Number.parseInt(value, 10);
    return !(numeric >= 1900 && numeric <= 2099); // 纯年份不构成特征数值
  });
}

/** bibliography key → sourceId（claim 点名文献的源映射；无 sourceId 条目跳过） */
function bibKeySourceIndex(bibEntries: readonly ClaimGroundingBibEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of bibEntries) {
    if (entry.key.trim() !== "" && (entry.sourceId ?? "").trim() !== "") {
      index.set(entry.key, entry.sourceId!);
    }
  }
  return index;
}

/**
 * 章节引用键归一化（M11.3）：claim.section（如 sections/taxonomy-framework.tex）
 * 与 outline section.file / id（taxonomy-framework.tex / taxonomy-framework）
 * 统一按「去路径、去扩展名、小写」成同一键——M11.2.3 的投影因键形不一致
 * 从未真正命中（claimResolution.groundableSourcesFor 一直拿到空引用面）。
 */
export function normalizeSectionKey(ref: string): string {
  const normalized = ref.trim().replaceAll("\\", "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.tex$/, "");
}

/** outline literatureRefs（entryId = M-{sourceId}，M11.1.1）→ sourceId 列表 */
export function literatureRefSourceIds(refs: readonly string[]): string[] {
  const sourceIds: string[] = [];
  for (const ref of refs) {
    const value = ref.trim();
    if (value === "") {
      continue;
    }
    const sourceId = value.startsWith("M-") ? value.slice(2) : value;
    if (!sourceIds.includes(sourceId)) {
      sourceIds.push(sourceId);
    }
  }
  return sourceIds;
}

/**
 * M11.3（Phase B）来源合法性（§10 第 4 条）：候选证据的源必须与 claim 存在
 * 合法关联。优先级：
 * 1. claim 文本点名了具体文献（出现完整 bib key，如「miah2024learning …」）
 *    → 严格限定到点名源（claim 是关于那几篇的，其他源的证据词面再像也不算）；
 * 2. 否则若章节引用面已知（outline literatureRefs 投影）→ 限定到章节引用源；
 * 3. 都不可得 → 不限定（无信息，不因缺投影而误杀）。
 */
/** 章节引用面查找（键形兼容：归一化键优先，原键回退——旧投影 / 测试夹具） */
export function lookupSectionCitedSourceIds(
  map: Record<string, string[]> | undefined,
  section: string,
): string[] {
  if (map === undefined) {
    return [];
  }
  const normalized = normalizeSectionKey(section);
  return map[normalized] ?? map[section.trim()] ?? [];
}

export function eligibleSourceIdsForClaim(
  claimText: string,
  options: { section?: string; sectionCitedSourceIds?: Record<string, string[]>; bibEntries?: readonly ClaimGroundingBibEntry[] } = {},
): { scope: "claim_named" | "section_cited" | "all"; sourceIds?: string[] } {
  const bib = options.bibEntries ?? [];
  if (bib.length > 0) {
    const keyToSource = bibKeySourceIndex(bib);
    const named: string[] = [];
    for (const [key, sourceId] of keyToSource) {
      if (claimText.includes(key) && !named.includes(sourceId)) {
        named.push(sourceId);
      }
    }
    if (named.length > 0) {
      return { scope: "claim_named", sourceIds: named };
    }
  }
  const cited = lookupSectionCitedSourceIds(options.sectionCitedSourceIds, options.section ?? "");
  if (cited.length > 0) {
    return { scope: "section_cited", sourceIds: cited };
  }
  return { scope: "all" };
}

/**
 * unsupported claim → formal evidence 池的确定性词面匹配（§9 + M11.3 §10/§11）。
 *
 * 打分对象 = evidence 的 claim + quote + source title（证据「自称能支撑什么」的
 * 全部文本面）；tokenize 与 lexical 检索同源（中英兼容，CJK bigram）。排序：
 * matchedTerms 降序 → score 降序 → evidenceId 字典序（确定性，无随机因素）。
 * 池内每条证据只按自身 token 集合打分（df/长度归一在此规模下不增加区分度，
 * 保持实现最小）；不同词命中数 < 2 的直接不返回——宁可空候选走 WEAKEN/REMOVE，
 * 不把不相关证据强配给 claim。
 *
 * M11.3（Phase B）候选资格三层门槛（防「词面相关 ≠ 真支撑」的过早短路）：
 * 1. 记录级：meetsEvidenceSupportQuality（verified+锚点 且 非 metadata 级 且
 *    strength 达 claim 所需最低等级）；
 * 2. 来源级：eligibleSourceIdsForClaim（claim 点名 → 章节 citation 面 → 全池）；
 * 3. 数值锚定：claim 含特征数字时，证据文本须含其中至少一个数字。
 * 不达标候选不进 Repair Context（resolution ladder 第 1 级随之不短路，
 * 自然落到 ground / search / weaken / remove 阶梯——§11）。
 */
export function findEvidenceCandidates(
  claimText: string,
  formalEvidence: readonly EvidenceRecord[],
  options: {
    topK?: number;
    section?: string;
    sectionCitedSourceIds?: Record<string, string[]>;
    bibEntries?: readonly ClaimGroundingBibEntry[];
  } = {},
): EvidenceCandidate[] {
  const topK = options.topK ?? CLAIM_REPAIR_TOP_K;
  const claimTerms = new Set(tokenizeText(claimText));
  if (claimTerms.size === 0) {
    return [];
  }
  const eligibility = eligibleSourceIdsForClaim(claimText, options);
  const eligibleSources =
    eligibility.sourceIds !== undefined ? new Set(eligibility.sourceIds) : null;
  const anchorNumbers = distinctiveNumbers(claimText);
  const hits: EvidenceCandidate[] = [];
  for (const record of formalEvidence) {
    if (!isFormalEvidence(record)) {
      continue; // 只有 formal（verified + 锚点）证据可进 Repair Context
    }
    if (!meetsEvidenceSupportQuality(record, claimText)) {
      continue; // M11.3：记录级支持质量不足（metadata 伪装 / strength 不达 claim 所需）
    }
    const sourceId = record.source?.sourceId;
    if (eligibleSources !== null && (sourceId === undefined || !eligibleSources.has(sourceId))) {
      continue; // M11.3：来源与 claim 无合法关联（非点名源 / 非本章引用源）
    }
    const evidenceText = [
      record.claim,
      record.quote ?? "",
      record.source?.title ?? "",
    ].join("\n");
    if (
      anchorNumbers.length > 0 &&
      !anchorNumbers.some((value) => evidenceText.includes(value))
    ) {
      continue; // M11.3：数值锚定失败（词面像但不含 claim 的特征数值）
    }
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
    hits.push({
      evidenceId: record.id,
      ...(sourceId !== undefined ? { sourceId } : {}),
      score: Number((coverage * evidenceHit).toFixed(6)),
      matchedTerms,
    });
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
  /** M11.2.3（D-2）：UNSUPPORTED claim 的披露口径（凭空断言 vs 透明未核验转述 vs 作者授权实验数据） */
  disclosure?: ClaimDisclosure;
  /** disclosure=author_experiment_data 时命中的授权观测标签（metric@split=value；溯源） */
  authorizedObservations?: string[];
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
  /**
   * Round 2：数值全部由作者授权实验观测覆盖的 UNSUPPORTED claim 数（单独呈现，
   * 不计入凭空断言阻断口径；仍不是 evidence-backed）。缺省 0（旧报告兼容）。
   */
  authorDataUnsupportedClaims?: number;
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
  /**
   * M11.3（Phase B）：章节引用源投影（outline literatureRefs；file key →
   * sourceIds）——候选证据来源合法性判定（§10）。缺省 = 无投影（不限定来源）。
   */
  sectionCitedSourceIds?: Record<string, string[]>;
  /**
   * Round 2：作者确认并授权进入工作流的实验观测值（workflowContext）。提供时，
   * 数值全部被覆盖的 UNSUPPORTED claim 披露为 author_experiment_data。
   */
  authorizedObservations?: readonly AuthorizedObservationValue[];
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
  let authorDataUnsupported = 0;
  const authorizedObservations = input.authorizedObservations ?? [];
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
    // Round 2：UNSUPPORTED（非 CONTRADICTED）且数值全部由授权观测覆盖 → 作者实验数据
    const authorizedHit =
      check.verdict === "UNSUPPORTED" ? authorizedObservationsCovering(check.claim, authorizedObservations) : null;
    const disclosure: ClaimDisclosure | undefined = isUnsupportedVerdict(check.verdict)
      ? authorizedHit !== null
        ? "author_experiment_data"
        : classifyClaimDisclosure(check.claim)
      : undefined;
    if (disclosure === "transparent_unverified") {
      transparentUnsupported += 1;
    } else if (disclosure === "author_experiment_data") {
      authorDataUnsupported += 1;
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
        ? findEvidenceCandidates(check.claim, input.formalEvidence, {
            section: check.section,
            ...(input.sectionCitedSourceIds !== undefined
              ? { sectionCitedSourceIds: input.sectionCitedSourceIds }
              : {}),
            bibEntries: input.bibEntries,
          })
        : [],
      ...(disclosure !== undefined ? { disclosure } : {}),
      ...(authorizedHit !== null ? { authorizedObservations: authorizedHit } : {}),
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
    authorDataUnsupportedClaims: authorDataUnsupported,
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
