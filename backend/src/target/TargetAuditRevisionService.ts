/**
 * TargetAuditRevisionService（M15.17）：证据审计 gapPlan → 可控修订闭环。
 *
 * 把 M15.16 已产品化的「目标期刊证据审计」工件（research/target-contribution-audit.json，
 * 只读 advisory）转换为可检查、可批准、可执行、可复评的修订计划：
 *
 *   审计工件（fresh 校验 fail-closed）
 *     → 确定性分类（B2 门禁：不能只信模型 actionType）
 *     → 锚投影（claimQuote → manuscript 可编辑章节文件，quote 回放核验）
 *     → 计划工件 research/target-audit-revision-plan.json（幂等）
 *     → 作者逐项决策（approve / reject；approve ≠ 自动批准改稿——只转入意见队列）
 *     → 转入 ExternalInstructionStore（source="target_audit"）：
 *         REWRITE_ELIGIBLE    → pending 指令（section 限定；由既有 improvement /
 *                               revision 工作流派发 Writer，全套 Patch/Fact/
 *                               Citation/Scope 守卫与 HITL 原样生效）
 *         NEEDS_REAL_EXPERIMENT → AUTHOR_DECISION_REQUIRED 指令（永不派发 Writer；
 *                               进入既有作者裁决队列 / revision.report / TaskGate）
 *     → 修订后确定性复评（reassess：指令状态 + patch lineage + 守卫结果 →
 *        VALIDATED_FIXED / PARTIALLY_ADDRESSED / STILL_OPEN / NEEDS_AUTHOR_DECISION /
 *        ALREADY_SATISFIED / AUTHOR_REJECTED / NOT_EVALUATED）
 *
 * 纪律（任务书 B1–B3 / Phase C）：
 * - 防陈旧：计划与决策绑定审计 inputFingerprint + 修订号；任何不一致 → 409
 *   TARGET_AUDIT_STALE，不应用旧计划。跨项目 / 跨稿 / 跨期刊误用由指令内容
 *   哈希 id（embed planId + fingerprint）天然阻断。
 * - 不升格证据：pool 候选 / 摘要 / verified_fulltext 材料一律不写 EvidenceStore；
 *   先前工作身份只作为指令中的归因上下文（且只允许引用既有 bib key）。
 * - 审计项不得高于真人意见：source="target_audit" 在 buildRevisionPlan 中
 *   priority=high（见 revisionPlan.ts），派发文案如实标注 advisory。
 * - 审计是 advisory：不改任何 QualityGate；本服务不执行任何模型调用
 *  （分类 / 投影 / 决策 / 复评全部确定性）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { PaperDocument } from "../paper/types.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
type RevisionCounter = Pick<ManuscriptRevisionStore, "currentRevision">;
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import { protectedInventory } from "../review/styleInvariants.js";
import { locateFileSpans, DEFAULT_REVISION_UNIT_MAX_CHARS } from "../review/logicalSpan.js";
import {
  ExternalInstructionStore,
  EXTERNAL_SOURCE_LABELS,
  type ExternalInstruction,
  type PlanItemOutcome,
} from "../review/externalInstructions.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { PatchValidationRecord } from "../review/patchValidation.js";
import { revisionSourceHash } from "../review/revisionScope.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import type {
  ContributionAuditArtifact,
  ContributionAuditInputFingerprint,
  ContributionComparison,
  ContributionUnit,
  ExperimentPlan,
  GapPlanItem,
  PriorWorkSourceLevel,
} from "./ContributionAuditService.js";

export const TARGET_AUDIT_REVISION_PLAN_SCHEMA_VERSION = 1;
export const TARGET_AUDIT_CLOSURE_REPORT_SCHEMA_VERSION = 1;

/** PDF 重建引用标记的长度下限（与 PaperReconstructor.MIN_SECTION_CHARS 同口径的启发式） */
const PROJECTION_MIN_QUOTE_CHARS = 12;
/** CJK 引文的最小字符数（信息密度高于拉丁词；过短不做包含判定） */
const PROJECTION_MIN_CJK_QUOTE_CHARS = 8;

// ---- 类型 ----

export type AuditGapClassification =
  | "REWRITE_ELIGIBLE"
  | "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT"
  | "NEEDS_TARGETED_EVIDENCE"
  | "EVIDENCE_INSUFFICIENT"
  | "UNMAPPABLE_TARGET";

export const AUDIT_CLASSIFICATION_LABELS: Record<AuditGapClassification, string> = {
  REWRITE_ELIGIBLE: "可基于现有证据改写",
  NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT: "需真实实验 / 作者输入",
  NEEDS_TARGETED_EVIDENCE: "需查阅 / 补充证据",
  EVIDENCE_INSUFFICIENT: "审计证据不足（作者裁决）",
  UNMAPPABLE_TARGET: "无法定位可编辑目标",
};

export interface AuditPlanAnchorProjection {
  status: "resolved" | "unresolved";
  file?: string;
  basis?: "quote-replay" | "ordinal-hint+quote-replay";
  ambiguous?: boolean;
  reason?: "no-editable-manuscript" | "quote-not-found" | "quote-ambiguous" | "quote-too-short";
}

export interface AuditPlanPriorWorkNote {
  title: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  sourceLevel?: PriorWorkSourceLevel;
  resolvesToPool: boolean;
  priorQuoteVerified?: boolean;
  timeCausalityViolation?: boolean;
}

export interface TargetAuditRevisionPlanItem {
  /** 稳定 id：ta-gap-{gapPlan 序号（1 基）}——同一审计工件内确定性 */
  itemId: string;
  contributionId: string;
  gap: string;
  sourceActionType: GapPlanItem["actionType"];
  classification: AuditGapClassification;
  /** 确定性分类依据（机器可读短语 + 人读说明） */
  classificationReason: string;
  experimentPlan?: ExperimentPlan;
  anchor: {
    claimQuote: string;
    sectionId: string;
    anchorVerified: boolean;
    projection: AuditPlanAnchorProjection;
    /**
     * 派发用 section 引用：短文件 = 文件路径（整文件目标直接匹配）；超长文件
     * （> 编辑单元上限，会被展开为 logicalSpan 单元）= quote 所在 span 的标题
     * （heading 引用可匹配单元目标；文件路径对单元目标不是合法授权）。
     * 指令文本中的「quote 锚」进一步把派发收敛到引文所在段落单元。
     */
    dispatchSection?: string;
    /**
     * 从重建 TeX 提取的逐字锚（M15.17 E2E 实证修复：派发端锚定是逐字匹配，
     * PDF 原文中的 %/&/_ 转义与 [n]→\cite 替换会使 PDF 形态锚失效）。
     * 对齐失败缺省——指令退回 PDF 原文锚（短文件仍可派发）。
     */
    texAnchor?: string;
  };
  priorWork: AuditPlanPriorWorkNote[];
  comparisonStatus?: ContributionComparison["status"];
  /** 目标文件快照：改写中禁止增删的数值 token 与 \cite key（展示 + 纪律声明） */
  forbidden: { values: string[]; citationKeys: string[] };
  /** 允许的修改方向（模板化；随先前工作可解析性分化） */
  allowedScope: string;
  authorDecision?: { decision: "approve" | "reject"; decidedAt: string };
  /** 决策 approve 后转入意见队列的稳定指令 id */
  instructionId?: string;
}

export interface TargetAuditRevisionPlanArtifact {
  schemaVersion: typeof TARGET_AUDIT_REVISION_PLAN_SCHEMA_VERSION;
  planId: string;
  projectId: string;
  source: {
    auditArtifact: "research/target-contribution-audit.json";
    inputFingerprint: ContributionAuditInputFingerprint;
    auditEvaluatedAt: string;
    venueId?: string;
    documentType: string;
    manuscriptRevisionAtPlan: number | null;
  };
  createdAt: string;
  status: "generated" | "decided";
  items: TargetAuditRevisionPlanItem[];
  summary: {
    total: number;
    rewriteEligible: number;
    needsRealExperiment: number;
    needsTargetedEvidence: number;
    evidenceInsufficient: number;
    unmappable: number;
    approved: number;
    rejected: number;
  };
}

export interface TargetAuditRevisionPlanView {
  plan: TargetAuditRevisionPlanArtifact;
  /** 计划相对当前状态是否仍可用（审计指纹 / 修订号一致性） */
  fresh: boolean;
  staleReason?: string;
  currentManuscriptRevision: number | null;
  /** 决策已转入的意见（含状态——执行进展可见） */
  instructions: ExternalInstruction[];
}

export type AuditGapClosure =
  | "VALIDATED_FIXED"
  | "PARTIALLY_ADDRESSED"
  | "STILL_OPEN"
  | "NEEDS_AUTHOR_DECISION"
  | "ALREADY_SATISFIED"
  | "AUTHOR_REJECTED"
  | "NOT_EVALUATED";

export const AUDIT_CLOSURE_LABELS: Record<AuditGapClosure, string> = {
  VALIDATED_FIXED: "已验证解决（机器可证）",
  PARTIALLY_ADDRESSED: "部分解决",
  STILL_OPEN: "仍未解决",
  NEEDS_AUTHOR_DECISION: "待作者决策 / 实验补充",
  ALREADY_SATISFIED: "基线已覆盖（无需修改）",
  AUTHOR_REJECTED: "作者不采纳",
  NOT_EVALUATED: "不可复评",
};

export interface TargetAuditClosureReportItem {
  itemId: string;
  classification: AuditGapClassification;
  closure: AuditGapClosure;
  /** 确定性依据（指令状态 / patch lineage / 守卫结果 / 无执行路径原因） */
  basis: string;
  instruction?: { instructionId: string; status: ExternalInstruction["status"]; statusNote?: string };
  patches?: Array<{ patchId: string; revision: number; finalStatus: string }>;
  verification?: { scope?: boolean; fact?: boolean; citation?: boolean; evidence?: boolean };
  /** M15.18：落盘 lineage（applied 子条：修订号 / 文件 / 前后 SHA / patch） */
  lineage?: PlanItemOutcome[];
  /** M15.18：仍开放的 Planner 子条（作者裁决 / 仅证据 / 未核验 NO-OP / 类型缺失） */
  openSubItems?: PlanItemOutcome[];
  /** M15.18：VALIDATED_FIXED 的逐项证据核对结果（机器可读） */
  checks?: { lineage: boolean; targetBinding: boolean; contentChanged: boolean; notReverted: boolean; guards: boolean };
}

export interface TargetAuditClosureReport {
  schemaVersion: typeof TARGET_AUDIT_CLOSURE_REPORT_SCHEMA_VERSION;
  reportId: string;
  planId: string;
  projectId: string;
  generatedAt: string;
  assessedAtRevision: number | null;
  /** 复评时的审计陈旧状态（如实披露；闭环判定不依赖重新审计） */
  auditStaleNow: boolean;
  items: TargetAuditClosureReportItem[];
  summary: { total: number } & Record<AuditGapClosure, number>;
  disclaimer: string;
}

// ---- 纯函数（导出供测试） ----

/** PDF 正文 → 重建 LaTeX 的近似逆变换（escapeLatexText 逆 + \cite 还原为分隔） */
export function latexToComparablePlain(content: string): string {
  return content
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\([*&%$#_{}])/g, "$1")
    .replace(/\\cite\{[^}]*\}/g, " ")
    .replace(/\\(section|subsection)\{[^}]*\}/g, " ");
}

/** quote 侧：剥离 [12] / [12,13] 引用标记（重建时已被替换为 \cite） */
export function quoteToComparablePlain(quote: string): string {
  return quote.replace(/\[\d+(?:\s*[,\-–]\s*\d+)*\]/g, " ");
}

const hasCjk = (text: string): boolean => /[㐀-鿿豈-﫿　-〿＀-￯]/.test(text);
const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const stripAllWhitespace = (text: string): string => text.replace(/\s+/g, "");

/** 归一化包含判定（CJK 追加全空白剥离回退——与审计锚校验同纪律） */
export function comparableContains(haystackPlain: string, needlePlain: string): boolean {
  if (!meetsProjectionMinLength(needlePlain)) {
    return false;
  }
  const a = collapseWhitespace(haystackPlain);
  const b = collapseWhitespace(needlePlain);
  if (b !== "" && a.includes(b)) {
    return true;
  }
  if (hasCjk(needlePlain)) {
    return stripAllWhitespace(a).includes(stripAllWhitespace(b));
  }
  return false;
}

export interface ProjectionFile {
  /** 相对 manuscript/ 的路径；"abstract" 表示 outline 摘要虚拟目标 */
  relativePath: string;
  content: string;
}

/** 引文达到可比对最小长度（拉丁 ≥12；CJK ≥8——信息密度差异） */
function meetsProjectionMinLength(needlePlain: string): boolean {
  if (collapseWhitespace(needlePlain).length >= PROJECTION_MIN_QUOTE_CHARS) {
    return true;
  }
  return hasCjk(needlePlain) && stripAllWhitespace(needlePlain).length >= PROJECTION_MIN_CJK_QUOTE_CHARS;
}

/**
 * 从重建 TeX 中提取与 PDF quote 对应的「TeX 逐字」锚（M15.17 E2E 实证修复）：
 * 派发端的单元定位（resolveUnitByQuotes → anchorPattern）是逐字匹配，而 PDF
 * 原文中的 %/&/_ 等在 TeX 中已转义、[n] 引用标记已替换为 \cite——PDF 形态的
 * 锚在长章节（多编辑单元、无整 span 回退）中必然 ANCHOR_NOT_FOUND → 指令
 * unmatched。此处在计划期做归一化对齐并把命中区段映射回原始 TeX 字节，
 * 指令文本内嵌可逐字回放的锚；对齐失败返回 undefined（调用方退回 PDF 原文）。
 */
export function extractTexVerbatimQuote(tex: string, pdfQuote: string): string | undefined {
  const haystack = latexToComparablePlain(tex);
  const needle = quoteToComparablePlain(pdfQuote);
  if (!meetsProjectionMinLength(needle)) {
    return undefined;
  }
  // 归一化索引：折叠空白 + 小写，记录每个输出字符在 haystack 中的位置
  const out: string[] = [];
  const index: number[] = [];
  let lastWasSpace = true; // 行首空白折叠
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out.push(" ");
        index.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    out.push(ch.toLowerCase());
    index.push(i);
    lastWasSpace = false;
  }
  const normalizedHaystack = out.join("");
  const normalizedNeedle = collapseWhitespace(needle);
  let start = -1;
  let end = -1;
  if (normalizedNeedle !== "") {
    start = normalizedHaystack.indexOf(normalizedNeedle);
    if (start !== -1) {
      end = start + normalizedNeedle.length - 1;
    }
  }
  if (start === -1 && hasCjk(needle)) {
    // CJK 回退：剥全部空白后命中（双索引映射回收敛索引位置）
    const strippedOut: string[] = [];
    const strippedIndex: number[] = [];
    for (let i = 0; i < normalizedHaystack.length; i += 1) {
      const ch = normalizedHaystack[i]!;
      if (ch !== " ") {
        strippedOut.push(ch);
        strippedIndex.push(i);
      }
    }
    const strippedHay = strippedOut.join("");
    const strippedNeedle = stripAllWhitespace(needle);
    const pos = strippedHay.indexOf(strippedNeedle);
    if (pos !== -1 && strippedIndex[pos + strippedNeedle.length - 1] !== undefined) {
      start = strippedIndex[pos]!;
      end = strippedIndex[pos + strippedNeedle.length - 1]!;
    }
  }
  if (start === -1 || end === -1 || index[start] === undefined || index[end] === undefined) {
    return undefined;
  }
  const rawStart = index[start]!;
  const rawEnd = index[end]!;
  const verbatim = tex.slice(rawStart, rawEnd + 1).trim();
  // 锚必须达到派发端锚定阈值（directiveAnchors 要求引号内 ≥12 字符），否则无意义
  return meetsProjectionMinLength(verbatim) ? verbatim : undefined;
}

/**
 * claimQuote → 可编辑章节文件投影（确定性；quote 回放核验）。
 * - 唯一命中 → resolved（basis=quote-replay）
 * - 多文件命中 → 期望序 hint 命中其中之一 → resolved（ambiguous=true，basis 带 hint）；
 *   无 hint / hint 未命中 → unresolved(quote-ambiguous)——不猜位置
 * - 零命中 → unresolved(quote-not-found)
 */
export function projectQuoteToManuscript(
  quote: string,
  files: readonly ProjectionFile[],
  ordinalHintFile?: string,
): AuditPlanAnchorProjection {
  const needle = quoteToComparablePlain(quote);
  if (!meetsProjectionMinLength(needle)) {
    return { status: "unresolved", reason: "quote-too-short" };
  }
  const matches = files
    .filter((file) => comparableContains(latexToComparablePlain(file.content), needle))
    .map((file) => file.relativePath);
  if (matches.length === 1) {
    return { status: "resolved", file: matches[0], basis: "quote-replay", ambiguous: false };
  }
  if (matches.length > 1) {
    if (ordinalHintFile !== undefined && matches.includes(ordinalHintFile)) {
      return { status: "resolved", file: ordinalHintFile, basis: "ordinal-hint+quote-replay", ambiguous: true };
    }
    return { status: "unresolved", reason: "quote-ambiguous" };
  }
  return { status: "unresolved", reason: "quote-not-found" };
}

/**
 * 审计节 id → 期望重建文件序（仅作多命中 tie-break hint；复制
 * PaperReconstructor 的正文节过滤口径：排除 References/摘要/过短节）。
 */
export function expectedFileForAuditSection(
  document: PaperDocument,
  sectionId: string,
  files: readonly ProjectionFile[],
): string | undefined {
  const chunksBySection = new Map<string, number>();
  for (const chunk of document.chunks) {
    chunksBySection.set(chunk.sectionId, (chunksBySection.get(chunk.sectionId) ?? 0) + chunk.text.trim().length);
  }
  const skipped = [document.referencesSectionId, document.abstractSectionId];
  let ordinal = 0;
  for (const section of document.sections) {
    if (skipped.includes(section.sectionId)) {
      continue;
    }
    if ((chunksBySection.get(section.sectionId) ?? 0) < 80) {
      continue;
    }
    ordinal += 1;
    if (section.sectionId === sectionId) {
      const file = files.find((candidate) => candidate.relativePath === `sections/sec${String(ordinal).padStart(2, "0")}.tex`);
      return file !== undefined ? file.relativePath : undefined;
    }
  }
  return undefined;
}

export interface ClassifyGapInput {
  gap: GapPlanItem;
  contribution: ContributionUnit | undefined;
  comparison: ContributionComparison | undefined;
  projection: AuditPlanAnchorProjection;
}

export interface ClassifyGapResult {
  classification: AuditGapClassification;
  reason: string;
}

/** B2 确定性分类门禁（不信任模型 actionType 单独放行） */
export function classifyAuditGap(input: ClassifyGapInput): ClassifyGapResult {
  const { gap, contribution, comparison, projection } = input;
  if (gap.actionType === "requires_real_experiment_or_author_input") {
    return {
      classification: "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT",
      reason: "审计判定该差距需要真实实验 / 作者提供研究材料（experimentPlan 在案；模型停在提议，不造数据）",
    };
  }
  // actionType = can_rewrite_from_existing_evidence：独立复核证据与锚
  if (contribution === undefined || !contribution.anchorVerified || contribution.claimQuote.trim() === "") {
    return {
      classification: "EVIDENCE_INSUFFICIENT",
      reason: "贡献锚缺失或未经审计锚校验（claimQuote 不可回放）——不允许对不可追溯位置改写",
    };
  }
  if (projection.status === "unresolved") {
    return {
      classification: "UNMAPPABLE_TARGET",
      reason:
        projection.reason === "no-editable-manuscript"
          ? "项目无可编辑稿件（manuscript/ 无章节文件）——审计为只读上下文，不改写；导入为「改进」目标可重建可修订稿"
          : `claimQuote 无法唯一投影到可编辑章节（${projection.reason ?? "unknown"}）——不猜位置改写`,
    };
  }
  const resolvablePrior = (comparison?.nearestPriorWorks ?? []).some(
    (ref) => ref.resolvesToPool && ref.timeCausalityViolation !== true,
  );
  if (comparison !== undefined && comparison.status === "INSUFFICIENT_EVIDENCE" && !resolvablePrior) {
    return {
      classification: "NEEDS_TARGETED_EVIDENCE",
      reason: "审计四态判定为 INSUFFICIENT_EVIDENCE 且先前工作无可解析身份——改写缺乏比较依据，先补证据 / 作者裁决",
    };
  }
  return {
    classification: "REWRITE_ELIGIBLE",
    reason: `审计判定可基于现有证据改写（锚已核验并投影到 ${projection.file}；${
      comparison === undefined
        ? "无比较记录，仅限弱化 / 一致性修正"
        : resolvablePrior
          ? "先前工作身份可解析，可作归因 / 比较表述依据"
          : "先前工作身份不可解析，仅限弱化 / 一致性修正"
    }）`,
  };
}

/** 允许的修改方向（模板化；随先前工作可解析性分化） */
export function allowedScopeText(priorWork: readonly AuditPlanPriorWorkNote[]): string {
  const resolvable = priorWork.some((ref) => ref.resolvesToPool && ref.timeCausalityViolation !== true);
  return resolvable
    ? "仅限：①弱化过度声称（把无支撑的强表述降为稿件现有证据可支撑的强度）；②修正前后不一致的表述；③基于指令内列出的已核验先前工作身份修正比较 / 归因表述（只可引用 references.bib 中已有 key，不得新增文献）；④修正范围 / 适用性限定词"
    : "仅限：①弱化过度声称（把无支撑的强表述降为稿件现有证据可支撑的强度）；②修正前后不一致的表述；③修正范围 / 适用性限定词。不得新增比较结论或先前工作归因（审计材料中无可解析先前工作身份）";
}

// ---- 指令文案（确定性模板；嵌入 planId + 指纹保证跨稿幂等与可追溯） ----

function priorWorkLines(priorWork: readonly AuditPlanPriorWorkNote[]): string[] {
  if (priorWork.length === 0) {
    return ["（本差距无已核验先前工作身份——不得新增比较结论）"];
  }
  return priorWork.map((ref) => {
    const identity = [
      ref.year !== undefined ? String(ref.year) : "年份未解析",
      ref.doi !== undefined ? `doi:${ref.doi}` : undefined,
      ref.arxivId !== undefined ? `arXiv:${ref.arxivId}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
    const level =
      ref.sourceLevel !== undefined
        ? ref.sourceLevel === "pool_fulltext"
          ? "已核验全文片段"
          : ref.sourceLevel === "pool_abstract"
            ? "摘要级"
            : ref.sourceLevel === "pool_metadata"
              ? "题录级"
              : "模型记忆（未核验，不得作为依据）"
        : "等级未标注";
    const verification = [
      `身份解析：${ref.resolvesToPool ? "可对上审计 pool" : "不可解析"}`,
      ref.priorQuoteVerified === true ? "quote 已在其材料内回放" : undefined,
      ref.timeCausalityViolation === true ? "时间因果违规（不作依据）" : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join("；");
    return `- ${ref.title}（${identity}）〔材料等级：${level}；${verification}〕`;
  });
}

export function rewriteInstructionText(
  item: TargetAuditRevisionPlanItem,
  plan: TargetAuditRevisionPlanArtifact,
): string {
  // 「」包裹的原文锚：revision 派发的单元定位（directiveAnchors）按出现顺序提取
  // 引号内 ≥12 字片段——texAnchor（逐字可回放）优先放最前，PDF 原文锚随后；
  // 短文件整文件目标不依赖锚，长文件由首个可唯一命中的锚收敛到编辑单元。
  const anchorLines =
    item.anchor.texAnchor !== undefined
      ? [
          `【目标原文锚（TeX 逐字，定位与改写基准）】「${item.anchor.texAnchor}」`,
          `【审计引文（PDF 原文，语义参照）】「${item.anchor.claimQuote}」`,
        ]
      : [`【稿件原文锚（审计逐字引用）】「${item.anchor.claimQuote}」`];
  return [
    `【来源】${EXTERNAL_SOURCE_LABELS["target_audit"]}；计划 ${plan.planId}（审计指纹 ${plan.source.inputFingerprint.manuscriptSha256}；贡献 ${item.contributionId}；条目 ${item.itemId}）`,
    `【审计发现的差距】${item.gap}`,
    ...anchorLines,
    `【审计定位】稿件解析节 ${item.anchor.sectionId}；可编辑目标：${item.anchor.projection.file ?? "(未投影)"}（quote 回放核验通过）`,
    "【先前工作身份（仅供归因 / 比较表述；不构成新证据，不得新造引用）】",
    ...priorWorkLines(item.priorWork),
    `【允许的修改】${item.allowedScope}`,
    "【禁止】不得新增数值 / 实验结果 / 图表 / 基线 / 新的正面性能声称；不得新增或删除任何 \\cite key；不得改变既有数字、单位、公式、否定关系、比较方向与结论强度语义；若认为必须新增科学事实才能解决该差距，不要修改，报告 CONFLICT 并说明。",
    "【依据边界】本指令来自模型证据审计（advisory）的 can_rewrite_from_existing_evidence 判定；不授权任何实验事实变更。改写后由事实 / 引用 / 范围守卫复核。",
  ].join("\n");
}

export function authorDecisionInstructionText(
  item: TargetAuditRevisionPlanItem,
  plan: TargetAuditRevisionPlanArtifact,
): string {
  const experiment = item.experimentPlan;
  return [
    `【来源】${EXTERNAL_SOURCE_LABELS["target_audit"]}；计划 ${plan.planId}（审计指纹 ${plan.source.inputFingerprint.manuscriptSha256}；贡献 ${item.contributionId}；条目 ${item.itemId}）`,
    `【审计发现的差距】${item.gap}`,
    `【稿件原文锚（审计逐字引用）】「${item.anchor.claimQuote}」`,
    "【所需真实实验 / 作者输入（系统不自动执行，不伪造数据）】",
    ...(experiment !== undefined
      ? [
          `目的：${experiment.purpose}`,
          experiment.baselines !== undefined ? `基线：${experiment.baselines}` : undefined,
          experiment.datasets !== undefined ? `数据集：${experiment.datasets}` : undefined,
          experiment.metrics !== undefined ? `指标：${experiment.metrics}` : undefined,
          experiment.expectedEvidence !== undefined ? `所需证据形态：${experiment.expectedEvidence}` : undefined,
        ].filter((line): line is string => line !== undefined)
      : ["（审计未给出结构化实验计划——需作者补充研究材料）"]),
    "【处置】该项需要作者补充真实实验结果或作者输入后方可改写；系统停在作者裁决，不产生任何修改。作者完成后可手动录入意见或上传证据再派发。",
  ].join("\n");
}

export function authorDecisionStatusNote(item: TargetAuditRevisionPlanItem, plan: TargetAuditRevisionPlanArtifact): string {
  return `AUTHOR_DECISION_REQUIRED: 需真实实验 / 作者输入（${EXTERNAL_SOURCE_LABELS["target_audit"]} ${plan.planId} 条目 ${item.itemId}：${item.gap.slice(0, 120)}）`;
}

/** 复评输入：本条目关联指令在计划修订号之后的 patch 记录（attemptHistory 不计） */
export interface ClosurePatchEvidence {
  revision: number;
  record: PatchValidationRecord;
}

const OPEN_SUB_ITEM_OUTCOMES = new Set<PlanItemOutcome["outcome"]>(["author_decision", "evidence_only", "action_type_missing", "noop_unverified"]);

/**
 * M15.18 确定性复评（纯函数）。VALIDATED_FIXED 需要同时具备：
 *   ① 可核验落盘 lineage（accepted+pass 的 span patch，或文件级 applied 子条带前后 SHA 且不同）
 *   ② 目标绑定（lineage 文件 = 计划投影文件）
 *   ③ 内容真实变化（before ≠ after）
 *   ④ 未被回退（当前文件 SHA ≠ 修订前 SHA；无法读取当前文件 → 不可证）
 *   ⑤ 守卫通过（patch scope/fact/citation 无 false；指令仍为 handled——gate 复核失败会降级）
 *   ⑥ 无仍开放的 Planner 子条（否则 PARTIALLY_ADDRESSED，如实列出）
 * 只有 handled 状态而无 lineage（旧工件 / 证据缺失）→ NOT_EVALUATED，绝不凭状态判已修复。
 */
export function assessRewriteClosure(input: {
  item: Pick<TargetAuditRevisionPlanItem, "itemId" | "classification" | "anchor">;
  instruction: ExternalInstruction;
  patches: readonly ClosurePatchEvidence[];
  /** 当前磁盘目标文件内容的 revisionSourceHash（读不到 → undefined） */
  currentTargetFileHash: string | undefined;
}): Pick<TargetAuditClosureReportItem, "closure" | "basis" | "lineage" | "openSubItems" | "checks"> {
  const { item, instruction, patches } = input;
  const targetFile = instruction.origin?.targetFile ?? item.anchor.projection.file;
  const outcomes = instruction.planItemOutcomes ?? [];
  const appliedLatest = new Map<string, PlanItemOutcome>();
  for (const outcome of outcomes) {
    if (outcome.outcome === "applied") appliedLatest.set(`${outcome.planItemId}@${outcome.file ?? ""}`, outcome);
  }
  const resolvedPlanItems = new Set(outcomes.filter((outcome) => outcome.outcome === "applied" || outcome.outcome === "noop_verified").map((outcome) => outcome.planItemId));
  const openSubItems = outcomes.filter((outcome) => OPEN_SUB_ITEM_OUTCOMES.has(outcome.outcome) && !resolvedPlanItems.has(outcome.planItemId));
  const fileLineage = [...appliedLatest.values()].filter(
    (outcome) => outcome.beforeSha256 !== undefined && outcome.afterSha256 !== undefined && outcome.beforeSha256 !== outcome.afterSha256,
  );
  const acceptedPatches = patches.filter(
    (entry) => entry.record.overall === "pass" && entry.record.apply.ok && (entry.record.finalStatus ?? "accepted") === "accepted" &&
      entry.record.beforeFileHash !== entry.record.afterFileHash,
  );
  const hasLineage = fileLineage.length > 0 || acceptedPatches.length > 0;
  const boundFiles = new Set([...fileLineage.map((outcome) => outcome.file), ...acceptedPatches.map((entry) => entry.record.file)]
    .filter((file): file is string => file !== undefined));
  const targetBinding = targetFile !== undefined && boundFiles.has(targetFile);
  const contentChanged = hasLineage;
  const earliestBefore = [...fileLineage.filter((outcome) => outcome.file === targetFile).map((outcome) => outcome.beforeSha256!),
    ...acceptedPatches.filter((entry) => entry.record.file === targetFile).map((entry) => entry.record.beforeFileHash)];
  const notReverted = input.currentTargetFileHash !== undefined && earliestBefore.length > 0 &&
    earliestBefore.every((hash) => hash !== input.currentTargetFileHash);
  const guardFailure = patches.some((entry) => entry.record.overall === "pass" && (!entry.record.scope.ok || !entry.record.fact.ok || !entry.record.citation.ok)) ||
    instruction.resolutionTrace?.verification.fact === false || instruction.resolutionTrace?.verification.citation === false;
  const guards = !guardFailure && instruction.status === "handled";
  const checks = { lineage: hasLineage, targetBinding, contentChanged, notReverted, guards };
  const lineage = [...fileLineage, ...acceptedPatches.map((entry): PlanItemOutcome => ({
    planItemId: entry.record.planItemIds.join(",") || "(external)",
    outcome: "applied",
    summary: `patch ${entry.record.patchId} accepted (${entry.record.logicalTarget})`,
    revision: entry.revision,
    file: entry.record.file,
    patchIds: [entry.record.patchId],
    beforeSha256: entry.record.beforeFileHash,
    afterSha256: entry.record.afterFileHash,
    at: "",
  }))];
  const extras = { ...(lineage.length > 0 ? { lineage } : {}), ...(openSubItems.length > 0 ? { openSubItems } : {}), checks };
  const lineageText = lineage.map((entry) => `${entry.patchIds?.join("+") ?? entry.planItemId}@rev${entry.revision ?? "?"}:${entry.file ?? "?"}`).join(", ");
  const rejected = outcomes.filter((outcome) => outcome.outcome === "candidate_rejected");

  if (instruction.status === "handled") {
    if (!hasLineage) {
      return { closure: "NOT_EVALUATED", basis: "指令状态为 handled，但缺少可核验的落盘修订 lineage（旧工件或证据缺失）——不凭状态判定已解决", ...extras };
    }
    if (!targetBinding) {
      return { closure: "STILL_OPEN", basis: `修订落在 ${[...boundFiles].join(", ") || "(未知文件)"}，未命中审计目标文件 ${targetFile ?? "(未投影)"}——目标绑定不成立`, ...extras };
    }
    if (!notReverted) {
      return {
        closure: input.currentTargetFileHash === undefined ? "NOT_EVALUATED" : "STILL_OPEN",
        basis: input.currentTargetFileHash === undefined ? "当前目标文件不可读，无法核对修订是否仍在稿件中" : "目标文件已回到修订前内容（修订被回退 / 恢复）",
        ...extras,
      };
    }
    if (!guards) {
      return { closure: "STILL_OPEN", basis: `存在守卫失败记录（scope/fact/citation），不视为已解决；lineage：${lineageText}`, ...extras };
    }
    if (openSubItems.length > 0) {
      return {
        closure: "PARTIALLY_ADDRESSED",
        basis: `可改写部分已落盘并通过守卫（${lineageText}）；Planner 另拆出 ${openSubItems.length} 个子条仍待作者（${openSubItems.map((entry) => `${entry.planItemId}:${entry.outcome}`).join(", ")}）`,
        ...extras,
      };
    }
    return { closure: "VALIDATED_FIXED", basis: `已落盘修订 + 目标绑定 ${targetFile} + 内容变化 + 守卫通过；lineage：${lineageText}`, ...extras };
  }
  if (instruction.status === "partially_handled") {
    return { closure: "PARTIALLY_ADDRESSED", basis: instruction.statusNote ?? "部分目标已执行，其余未报告", ...extras };
  }
  if (instruction.status === "conflict") {
    return { closure: "STILL_OPEN", basis: `改写与稿件实验事实 / Evidence 冲突，系统未篡改事实：${instruction.conflictBasis ?? instruction.statusNote ?? ""}`, ...extras };
  }
  if (instruction.status === "already_satisfied") {
    return { closure: "ALREADY_SATISFIED", basis: instruction.statusNote ?? "确定性核验：当前稿已满足该意见（无需修改）", ...extras };
  }
  if (rejected.length > 0) {
    return { closure: "STILL_OPEN", basis: `候选修改被守卫拒绝、未落盘（${rejected.map((entry) => `${entry.planItemId}@rev${entry.revision ?? "?"}`).join(", ")}）：${instruction.statusNote ?? ""}`, ...extras };
  }
  return { closure: "STILL_OPEN", basis: instruction.statusNote ?? "指令尚未派发或派发后未产生可验证修改", ...extras };
}

// ---- 服务 ----

export interface TargetAuditRevisionServiceOptions {
  projects: ProjectStore;
  papers: PaperStore;
  revisions: RevisionCounter;
  externalInstructions: ExternalInstructionStore;
  reviewArtifacts: ReviewArtifactStore;
  now?: () => Date;
  log?: (message: string) => void;
}

export class TargetAuditRevisionService {
  private readonly projects: ProjectStore;
  private readonly papers: PaperStore;
  private readonly revisions: RevisionCounter;
  private readonly externalInstructions: ExternalInstructionStore;
  private readonly reviewArtifacts: ReviewArtifactStore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetAuditRevisionServiceOptions) {
    this.projects = options.projects;
    this.papers = options.papers;
    this.revisions = options.revisions;
    this.externalInstructions = options.externalInstructions;
    this.reviewArtifacts = options.reviewArtifacts;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private planPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-audit-revision-plan.json");
  }

  private reportPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-audit-revision-report.json");
  }

  private auditPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-contribution-audit.json");
  }

  /** 冻结指南的 venueId（读工件；无指南 → undefined——审计允许无 venue 语境） */
  private async readGuidelineVenueId(projectId: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(this.projects.researchDir(projectId), "target-guideline.json"), "utf8");
      const parsed = JSON.parse(raw) as { venueId?: unknown };
      return typeof parsed.venueId === "string" && parsed.venueId !== "" ? parsed.venueId : undefined;
    } catch {
      return undefined;
    }
  }

  /** 审计工件 + 当前稿一致性（零网络；不一致 → 明确 staleReason，不猜） */
  private async checkFreshness(projectId: string): Promise<
    { artifact: ContributionAuditArtifact; document: PaperDocument | null; currentRevision: number; staleReason?: string }
  > {
    let raw: string;
    try {
      raw = await readFile(this.auditPath(projectId), "utf8");
    } catch {
      throw new BusinessError(
        "TARGET_AUDIT_PLAN_INVALID_STATE",
        "尚无证据审计工件——先执行证据审计（POST /target/evidence-audit）再制定修改计划",
      );
    }
    const artifact = JSON.parse(raw) as ContributionAuditArtifact;
    const document = await this.papers.loadDocument(projectId);
    const currentRevision = await this.revisions.currentRevision(projectId).catch(() => 0);
    if (document === null) {
      return { artifact, document: null, currentRevision, staleReason: "当前项目无可读稿件解析产物" };
    }
    const currentSha = sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
    if (currentSha !== artifact.inputFingerprint.manuscriptSha256) {
      return {
        artifact,
        document,
        currentRevision,
        staleReason: `稿件内容已变更（artifact 指纹 ${artifact.inputFingerprint.manuscriptSha256} ≠ 当前 ${currentSha}）`,
      };
    }
    if (
      artifact.manuscriptRevision !== undefined &&
      artifact.manuscriptRevision !== null &&
      artifact.manuscriptRevision !== currentRevision
    ) {
      return {
        artifact,
        document,
        currentRevision,
        staleReason: `稿件修订号已变更（artifact ${artifact.manuscriptRevision} ≠ 当前 ${currentRevision}）`,
      };
    }
    // 跨期刊防误用：审计工件带 venue 语境而当前冻结指南已切换到另一 venue → 陈旧
    const guidelineVenueId = await this.readGuidelineVenueId(projectId);
    if (
      artifact.venueId !== undefined &&
      guidelineVenueId !== undefined &&
      artifact.venueId !== guidelineVenueId
    ) {
      return {
        artifact,
        document,
        currentRevision,
        staleReason: `目标期刊已切换（审计基于 ${artifact.venueId}，当前指南 ${guidelineVenueId}）——旧审计不可用于当前目标`,
      };
    }
    return { artifact, document, currentRevision };
  }

  /** 读取可编辑投影目标（sections/*.tex + outline 摘要虚拟目标） */
  private async loadProjectionFiles(projectId: string): Promise<ProjectionFile[]> {
    const files = await collectLatexFiles(this.projects.manuscriptDir(projectId));
    const projection: ProjectionFile[] = files.sections.map((file) => ({
      relativePath: file.relativePath.replaceAll("\\", "/"),
      content: file.content,
    }));
    if (files.mainTex !== null && projection.length === 0) {
      projection.push({ relativePath: "main.tex", content: files.mainTex.content });
    }
    let outlineAbstract = "";
    try {
      const outline = JSON.parse(
        await readFile(join(this.projects.manuscriptDir(projectId), "outline.json"), "utf8"),
      ) as { abstract?: string };
      outlineAbstract = outline.abstract ?? "";
    } catch {
      outlineAbstract = "";
    }
    if (outlineAbstract.trim() !== "") {
      projection.push({ relativePath: "abstract", content: outlineAbstract });
    }
    return projection;
  }

  /** GET：计划 + 新鲜度 + 已转入指令的当前状态 */
  async getPlan(projectId: string): Promise<TargetAuditRevisionPlanView | null> {
    let raw: string;
    try {
      raw = await readFile(this.planPath(projectId), "utf8");
    } catch {
      return null;
    }
    const plan = JSON.parse(raw) as TargetAuditRevisionPlanArtifact;
    const currentRevision = await this.revisions.currentRevision(projectId).catch(() => 0);
    let fresh = true;
    let staleReason: string | undefined;
    let currentAudit: { manuscriptSha256: string; evaluatedAt: string } | undefined;
    try {
      const auditRaw = await readFile(this.auditPath(projectId), "utf8");
      const parsed = JSON.parse(auditRaw) as ContributionAuditArtifact;
      currentAudit = {
        manuscriptSha256: parsed.inputFingerprint.manuscriptSha256,
        evaluatedAt: parsed.evaluatedAt,
      };
    } catch {
      currentAudit = undefined;
    }
    // 重新审计（evaluatedAt 变化）即视为新快照——旧计划决策入口关闭（幂等只对同一工件成立）
    if (
      currentAudit !== undefined &&
      (currentAudit.manuscriptSha256 !== plan.source.inputFingerprint.manuscriptSha256 ||
        currentAudit.evaluatedAt !== plan.source.auditEvaluatedAt)
    ) {
      fresh = false;
      staleReason = "证据审计已重新执行（新工件）——本计划基于旧审计，决策入口已关闭";
    } else {
      // 审计工件未动，但稿件本身可能已变（换稿未重审计）——重算当前稿指纹核对
      const document = await this.papers.loadDocument(projectId);
      if (document !== null) {
        const currentSha = sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
        if (currentSha !== plan.source.inputFingerprint.manuscriptSha256) {
          fresh = false;
          staleReason = `稿件内容已变更（计划指纹 ${plan.source.inputFingerprint.manuscriptSha256} ≠ 当前 ${currentSha}）——需重新审计后再决策`;
        }
      }
    }
    if (
      fresh &&
      plan.source.manuscriptRevisionAtPlan !== null &&
      plan.source.manuscriptRevisionAtPlan !== currentRevision
    ) {
      fresh = false;
      staleReason = `稿件修订号已变更（计划 ${plan.source.manuscriptRevisionAtPlan} ≠ 当前 ${currentRevision}）——旧决策不可继续应用`;
    }
    if (fresh) {
      // 审计指纹与修订号一致时，再核对 venue 是否切换（跨期刊防误用）
      const guidelineVenueId = await this.readGuidelineVenueId(projectId);
      if (
        plan.source.venueId !== undefined &&
        guidelineVenueId !== undefined &&
        plan.source.venueId !== guidelineVenueId
      ) {
        fresh = false;
        staleReason = `目标期刊已切换（计划基于 ${plan.source.venueId}，当前指南 ${guidelineVenueId}）`;
      }
    }
    const instructions = await this.externalInstructions.load(projectId).catch(() => [] as ExternalInstruction[]);
    const planInstructionIds = new Set(plan.items.map((item) => item.instructionId).filter((id): id is string => id !== undefined));
    return {
      plan,
      fresh,
      ...(staleReason !== undefined ? { staleReason } : {}),
      currentManuscriptRevision: currentRevision,
      instructions: instructions.filter((instruction) => planInstructionIds.has(instruction.instructionId)),
    };
  }

  /** POST：从冻结审计工件确定性生成计划（幂等：同指纹 + 同修订号 → 同 planId，不重建） */
  async generatePlan(projectId: string): Promise<TargetAuditRevisionPlanView> {
    await this.projects.getRequired(projectId);
    const freshness = await this.checkFreshness(projectId);
    if (freshness.staleReason !== undefined) {
      throw new BusinessError("TARGET_AUDIT_STALE", `证据审计相对当前稿已陈旧，拒绝生成修改计划：${freshness.staleReason}`);
    }
    const { artifact, document, currentRevision } = freshness;
    if (document === null) {
      throw new BusinessError("TARGET_AUDIT_STALE", "当前项目无可读稿件解析产物，拒绝生成修改计划");
    }

    // 幂等：同一审计工件（指纹 + evaluatedAt）+ 同修订号的既有计划直接返回；
    // 重新审计产生新工件（哪怕指纹相同）→ 旧 generated 计划按新审计重建，decided 计划拒绝覆盖
    const existing = await this.getPlan(projectId);
    if (existing !== null) {
      const sameArtifact =
        existing.plan.source.inputFingerprint.manuscriptSha256 === artifact.inputFingerprint.manuscriptSha256 &&
        existing.plan.source.auditEvaluatedAt === artifact.evaluatedAt;
      if (!sameArtifact) {
        if (existing.plan.status === "decided") {
          throw new BusinessError(
            "TARGET_AUDIT_PLAN_INVALID_STATE",
            "证据审计已重新执行且现有计划已有作者决策——不允许静默覆盖；请基于新审计重新走决策流程",
          );
        }
      } else if (existing.plan.source.manuscriptRevisionAtPlan === currentRevision) {
        return existing;
      } else if (existing.plan.status === "decided") {
        throw new BusinessError(
          "TARGET_AUDIT_STALE",
          `稿件修订号已变更（计划 ${existing.plan.source.manuscriptRevisionAtPlan} ≠ 当前 ${currentRevision}）且已有作者决策——不应用旧计划；请重新审计后重新生成`,
        );
      }
    }

    const projectionFiles = await this.loadProjectionFiles(projectId);
    const items: TargetAuditRevisionPlanItem[] = [];
    artifact.gapPlan.forEach((gap, index) => {
      const contribution = artifact.inventory.find((unit) => unit.contributionId === gap.contributionId);
      const comparison = artifact.comparisons.find((entry) => entry.contributionId === gap.contributionId);
      // 锚投影（PDF-only 只读项目 → 全部不可映射；可编辑项目 → quote 回放核验）
      const projection: AuditPlanAnchorProjection =
        projectionFiles.length === 0
          ? { status: "unresolved", reason: "no-editable-manuscript" }
          : projectQuoteToManuscript(
              contribution?.claimQuote ?? "",
              projectionFiles,
              contribution !== undefined
                ? expectedFileForAuditSection(document, contribution.sectionId, projectionFiles)
                : undefined,
            );
      const classification = classifyAuditGap({ gap, contribution, comparison, projection });
      const priorWork: AuditPlanPriorWorkNote[] = (comparison?.nearestPriorWorks ?? [])
        .filter((ref) => ref.title.trim() !== "")
        .slice(0, 3)
        .map((ref) => ({
          title: ref.title,
          ...(ref.year !== undefined ? { year: ref.year } : {}),
          ...(ref.doi !== undefined ? { doi: ref.doi } : {}),
          ...(ref.arxivId !== undefined ? { arxivId: ref.arxivId } : {}),
          ...(ref.sourceLevel !== undefined ? { sourceLevel: ref.sourceLevel } : {}),
          resolvesToPool: ref.resolvesToPool,
          ...(ref.priorQuoteVerified !== undefined ? { priorQuoteVerified: ref.priorQuoteVerified } : {}),
          ...(ref.timeCausalityViolation !== undefined ? { timeCausalityViolation: ref.timeCausalityViolation } : {}),
        }));
      // 目标文件禁止项快照（守卫仍以既有 Fact/Citation 口径为准；此处为计划展示与纪律声明）
      const targetFile =
        projection.status === "resolved" ? projectionFiles.find((file) => file.relativePath === projection.file) : undefined;
      const inventory = targetFile !== undefined ? protectedInventory(targetFile.content) : { citationKeys: [], numbers: [] };
      // 派发节引用：超长文件（会被展开为编辑单元）用 quote 所在 span 的标题；
      // 短文件直接用文件路径（整文件目标匹配）
      let dispatchSection: string | undefined;
      let texAnchor: string | undefined;
      if (targetFile !== undefined && targetFile.relativePath !== "abstract") {
        if (targetFile.content.length > DEFAULT_REVISION_UNIT_MAX_CHARS) {
          const spans = locateFileSpans(targetFile.relativePath, targetFile.content);
          const needle = quoteToComparablePlain(contribution?.claimQuote ?? "");
          const span = spans.find((candidate) => comparableContains(latexToComparablePlain(candidate.content), needle));
          dispatchSection = span !== undefined && span.heading.trim() !== "" ? span.heading.trim() : targetFile.relativePath;
        } else {
          dispatchSection = targetFile.relativePath;
        }
        // 逐字锚：归一化对齐提取（派发端逐字回放用；PDF 形态锚会被转义破坏）
        texAnchor = extractTexVerbatimQuote(targetFile.content, contribution?.claimQuote ?? "");
      } else if (targetFile !== undefined && targetFile.relativePath === "abstract") {
        dispatchSection = "abstract";
      }
      items.push({
        itemId: `ta-gap-${index + 1}`,
        contributionId: gap.contributionId,
        gap: gap.gap,
        sourceActionType: gap.actionType,
        classification: classification.classification,
        classificationReason: classification.reason,
        ...(gap.experimentPlan !== undefined ? { experimentPlan: gap.experimentPlan } : {}),
        anchor: {
          claimQuote: contribution?.claimQuote ?? "",
          sectionId: contribution?.sectionId ?? "",
          anchorVerified: contribution?.anchorVerified ?? false,
          projection,
          ...(dispatchSection !== undefined ? { dispatchSection } : {}),
          ...(texAnchor !== undefined ? { texAnchor } : {}),
        },
        priorWork,
        ...(comparison !== undefined ? { comparisonStatus: comparison.status } : {}),
        forbidden: { values: inventory.numbers.slice(0, 40), citationKeys: inventory.citationKeys.slice(0, 30) },
        allowedScope: allowedScopeText(priorWork),
      });
    });

    const planId = `tap-${artifact.inputFingerprint.manuscriptSha256.slice(0, 12)}-rev${currentRevision}`;
    const plan: TargetAuditRevisionPlanArtifact = {
      schemaVersion: TARGET_AUDIT_REVISION_PLAN_SCHEMA_VERSION,
      planId,
      projectId,
      source: {
        auditArtifact: "research/target-contribution-audit.json",
        inputFingerprint: artifact.inputFingerprint,
        auditEvaluatedAt: artifact.evaluatedAt,
        ...(artifact.venueId !== undefined ? { venueId: artifact.venueId } : {}),
        documentType: artifact.documentType,
        manuscriptRevisionAtPlan: currentRevision,
      },
      createdAt: this.now().toISOString(),
      status: "generated",
      items,
      summary: summarizePlan(items),
    };
    await writeJsonAtomic(this.planPath(projectId), plan);
    this.log(
      `[target] projectId=${projectId} 审计修订计划生成：planId=${planId} items=${items.length}（rewrite ${plan.summary.rewriteEligible} / 需实验 ${plan.summary.needsRealExperiment} / 需补证 ${plan.summary.needsTargetedEvidence} / 证据不足 ${plan.summary.evidenceInsufficient} / 不可映射 ${plan.summary.unmappable}）`,
    );
    const view = await this.getPlan(projectId);
    if (view === null) {
      throw new BusinessError("INTERNAL_ERROR", "计划写入后不可读（不应发生）");
    }
    return view;
  }

  /** POST decide：作者逐项决策；approve 转入意见队列（幂等），rewrite 项不自动改稿 */
  async decide(
    projectId: string,
    input: { decisions: Array<{ itemId: string; decision: "approve" | "reject" }> },
  ): Promise<TargetAuditRevisionPlanView> {
    await this.projects.getRequired(projectId);
    const view = await this.getPlan(projectId);
    if (view === null) {
      throw new BusinessError("TARGET_AUDIT_PLAN_INVALID_STATE", "尚无修改计划（先生成计划再决策）");
    }
    if (!view.fresh) {
      throw new BusinessError("TARGET_AUDIT_STALE", `计划相对当前状态已陈旧，拒绝决策：${view.staleReason ?? "状态不一致"}`);
    }
    const plan = view.plan;
    // 已决策计划允许同值幂等重试与未决策条目补交（内容哈希指令 id 天然去重）
    const byId = new Map(plan.items.map((item) => [item.itemId, item]));
    const decisions = new Map<string, "approve" | "reject">();
    for (const entry of input.decisions) {
      const item = byId.get(entry.itemId);
      if (item === undefined) {
        throw new BusinessError("INVALID_REQUEST", `未知计划条目 ${entry.itemId}`);
      }
      if (entry.decision !== "approve" && entry.decision !== "reject") {
        throw new BusinessError("INVALID_REQUEST", `非法决策值 ${String(entry.decision)}（允许 approve / reject）`);
      }
      decisions.set(entry.itemId, entry.decision);
    }
    const decidedAt = this.now().toISOString();
    let createdInstructions = 0;
    for (const item of plan.items) {
      const decision = decisions.get(item.itemId);
      if (decision === undefined) {
        continue;
      }
      if (item.authorDecision !== undefined && item.authorDecision.decision === decision) {
        continue; // 幂等：同值重复决策不重复处理
      }
      item.authorDecision = { decision, decidedAt };
      if (decision === "reject") {
        continue;
      }
      // approve：转入意见队列（rewrite → pending 待派发；其余 → AUTHOR_DECISION_REQUIRED 永不派发）
      if (item.classification === "REWRITE_ELIGIBLE" && item.anchor.projection.status === "resolved") {
        const section = item.anchor.dispatchSection ?? item.anchor.projection.file ?? undefined;
        const created = await this.externalInstructions.add(projectId, {
          source: "target_audit",
          reviewerLabel: `审计计划 ${plan.planId}`,
          text: rewriteInstructionText(item, plan),
          ...(section !== undefined ? { section } : {}),
          origin: {
            kind: "target_audit_rewrite",
            planId: plan.planId,
            itemId: item.itemId,
            contributionId: item.contributionId,
            claimQuote: item.anchor.claimQuote,
            ...(item.anchor.texAnchor !== undefined ? { texAnchor: item.anchor.texAnchor } : {}),
            ...(item.anchor.projection.file !== undefined ? { targetFile: item.anchor.projection.file } : {}),
            approvedAt: decidedAt,
          },
        });
        if (created !== null) {
          createdInstructions += 1;
          item.instructionId = created.instructionId;
          this.log(`[target] projectId=${projectId} 审计条目 ${item.itemId} 已转入修订意见（${created.instructionId}，pending 待派发）`);
        }
      } else {
        const created = await this.externalInstructions.add(projectId, {
          source: "target_audit",
          reviewerLabel: `审计计划 ${plan.planId}`,
          text: authorDecisionInstructionText(item, plan),
          statusNote: authorDecisionStatusNote(item, plan),
          origin: {
            kind: "target_audit_author_decision",
            planId: plan.planId,
            itemId: item.itemId,
            contributionId: item.contributionId,
            claimQuote: item.anchor.claimQuote,
            approvedAt: decidedAt,
          },
        });
        if (created !== null) {
          createdInstructions += 1;
          item.instructionId = created.instructionId;
          this.log(
            `[target] projectId=${projectId} 审计条目 ${item.itemId} 已登记作者裁决项（${created.instructionId}；不派发 Writer）`,
          );
        }
      }
    }
    // 全部条目决策完毕才算 decided（部分决策保持 generated——剩余条目可继续补交）
    plan.status = plan.items.every((item) => item.authorDecision !== undefined) ? "decided" : "generated";
    plan.summary = summarizePlan(plan.items);
    await writeJsonAtomic(this.planPath(projectId), plan);
    this.log(
      `[target] projectId=${projectId} 审计修订计划决策完成：approve ${plan.summary.approved} / reject ${plan.summary.rejected}（新建指令 ${createdInstructions}）`,
    );
    const updated = await this.getPlan(projectId);
    if (updated === null) {
      throw new BusinessError("INTERNAL_ERROR", "计划写入后不可读（不应发生）");
    }
    return updated;
  }

  /** POST reassess：确定性复评（零模型；指令状态 + patch lineage + 守卫结果） */
  async reassess(projectId: string): Promise<TargetAuditClosureReport> {
    await this.projects.getRequired(projectId);
    const view = await this.getPlan(projectId);
    if (view === null) {
      throw new BusinessError("TARGET_AUDIT_PLAN_INVALID_STATE", "尚无修改计划（无可复评对象）");
    }
    const plan = view.plan;
    const currentRevision = await this.revisions.currentRevision(projectId).catch(() => 0);
    const instructions = await this.externalInstructions.load(projectId);
    const instructionById = new Map(instructions.map((instruction) => [instruction.instructionId, instruction]));
    // patch lineage：扫描计划绑定修订号至当前修订号之间的 patch 校验产物
    const planRevision = plan.source.manuscriptRevisionAtPlan ?? 0;
    const patchesByInstruction = new Map<string, Array<{ patchId: string; revision: number; finalStatus: string }>>();
    const recordsByInstruction = new Map<string, ClosurePatchEvidence[]>();
    const guardsByInstruction = new Map<string, { fact?: boolean; citation?: boolean; scope?: boolean; evidence?: boolean }>();
    for (let revision = planRevision + 1; revision <= currentRevision; revision += 1) {
      const artifact = await this.reviewArtifacts.loadPatchValidation(projectId, revision).catch(() => null);
      if (artifact === null) {
        continue;
      }
      for (const record of artifact.records) {
        for (const commentId of record.commentIds) {
          const list = patchesByInstruction.get(commentId) ?? [];
          list.push({ patchId: record.patchId, revision, finalStatus: record.finalStatus ?? "(unrecorded)" });
          patchesByInstruction.set(commentId, list);
          recordsByInstruction.set(commentId, [...(recordsByInstruction.get(commentId) ?? []), { revision, record }]);
          const guards = guardsByInstruction.get(commentId) ?? {};
          guardsByInstruction.set(commentId, {
            scope: guards.scope === false ? false : record.scope.ok || undefined,
            fact: guards.fact === false ? false : record.fact.ok || undefined,
            citation: guards.citation === false ? false : record.citation.ok || undefined,
            evidence: guards.evidence === false ? false : record.evidence.ok || undefined,
          });
        }
      }
    }

    // 当前目标文件内容（回退核查：修订被恢复到修订前 → 不可判已解决）
    const currentHashes = new Map<string, string>();
    const manuscriptDir = this.projects.manuscriptDir(projectId);
    for (const file of new Set(plan.items.flatMap((item) => item.anchor.projection.file !== undefined ? [item.anchor.projection.file] : []))) {
      try {
        currentHashes.set(file, revisionSourceHash(await readFile(join(manuscriptDir, file), "utf8")));
      } catch {
        // 不可读 → 缺省（assessRewriteClosure 判 NOT_EVALUATED）
      }
    }
    const items: TargetAuditClosureReportItem[] = plan.items.map((item) => {
      const instruction = item.instructionId !== undefined ? instructionById.get(item.instructionId) : undefined;
      if (item.authorDecision?.decision === "reject") {
        return {
          itemId: item.itemId,
          classification: item.classification,
          closure: "AUTHOR_REJECTED" as const,
          basis: `作者于 ${item.authorDecision.decidedAt} 明确不采纳该审计建议`,
        };
      }
      if (instruction === undefined) {
        if (item.authorDecision === undefined) {
          return {
            itemId: item.itemId,
            classification: item.classification,
            closure: "NEEDS_AUTHOR_DECISION" as const,
            basis: "作者尚未决策（计划待定）",
          };
        }
        return {
          itemId: item.itemId,
          classification: item.classification,
          closure: "NOT_EVALUATED" as const,
          basis: "已批准但意见记录缺失（可能被人工删除）——不可复评",
        };
      }
      const patches = patchesByInstruction.get(instruction.instructionId) ?? [];
      const verification = guardsByInstruction.get(instruction.instructionId);
      const base = {
        itemId: item.itemId,
        classification: item.classification,
        instruction: {
          instructionId: instruction.instructionId,
          status: instruction.status,
          ...(instruction.statusNote !== undefined ? { statusNote: instruction.statusNote } : {}),
        },
        ...(patches.length > 0 ? { patches } : {}),
        ...(verification !== undefined ? { verification } : {}),
      };
      if (item.classification !== "REWRITE_ELIGIBLE") {
        // 需实验 / 证据不足 / 不可定位项：永不派发 Writer——只能停在作者裁决或作者拒绝
        const isAuthorDecisionItem = /^AUTHOR_DECISION_REQUIRED\b/.test(instruction.statusNote ?? "");
        return {
          ...base,
          closure: (isAuthorDecisionItem ? "NEEDS_AUTHOR_DECISION" : "NOT_EVALUATED") as AuditGapClosure,
          basis: isAuthorDecisionItem
            ? "需真实实验 / 作者输入：系统停在作者裁决，不产生修改（预期行为，非失败）"
            : `非改写项的意见状态异常（${instruction.status}；${instruction.statusNote ?? ""}）——不可复评`,
        };
      }
      const targetFile = instruction.origin?.targetFile ?? item.anchor.projection.file;
      const currentTargetFileHash = targetFile !== undefined ? currentHashes.get(targetFile) : undefined;
      return {
        ...base,
        ...assessRewriteClosure({ item, instruction, patches: recordsByInstruction.get(instruction.instructionId) ?? [], currentTargetFileHash }),
      };
    });

    const summary = { total: items.length } as Record<AuditGapClosure, number> & { total: number };
    for (const key of Object.keys(AUDIT_CLOSURE_LABELS) as AuditGapClosure[]) {
      summary[key] = items.filter((item) => item.closure === key).length;
    }
    const report: TargetAuditClosureReport = {
      schemaVersion: TARGET_AUDIT_CLOSURE_REPORT_SCHEMA_VERSION,
      reportId: `tar-${plan.planId}-${this.now().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
      planId: plan.planId,
      projectId,
      generatedAt: this.now().toISOString(),
      assessedAtRevision: currentRevision,
      auditStaleNow: !view.fresh,
      items,
      summary,
      disclaimer:
        "本复评为确定性机器核对（指令状态 / patch lineage / 守卫结果 / 逐字锚），不构成期刊录用判断；学术性差距的最终解决以作者实验与决策为准。",
    };
    await writeJsonAtomic(this.reportPath(projectId), report);
    this.log(
      `[target] projectId=${projectId} 审计闭环复评：${report.reportId}（fixed ${summary.VALIDATED_FIXED} / partial ${summary.PARTIALLY_ADDRESSED} / open ${summary.STILL_OPEN} / author ${summary.NEEDS_AUTHOR_DECISION} / notEval ${summary.NOT_EVALUATED}）@rev${currentRevision}`,
    );
    return report;
  }

  /** GET：最近一次复评报告（无 → null） */
  async getReport(projectId: string): Promise<TargetAuditClosureReport | null> {
    let raw: string;
    try {
      raw = await readFile(this.reportPath(projectId), "utf8");
    } catch {
      return null;
    }
    return JSON.parse(raw) as TargetAuditClosureReport;
  }
}

function summarizePlan(items: readonly TargetAuditRevisionPlanItem[]): TargetAuditRevisionPlanArtifact["summary"] {
  return {
    total: items.length,
    rewriteEligible: items.filter((item) => item.classification === "REWRITE_ELIGIBLE").length,
    needsRealExperiment: items.filter((item) => item.classification === "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT").length,
    needsTargetedEvidence: items.filter((item) => item.classification === "NEEDS_TARGETED_EVIDENCE").length,
    evidenceInsufficient: items.filter((item) => item.classification === "EVIDENCE_INSUFFICIENT").length,
    unmappable: items.filter((item) => item.classification === "UNMAPPABLE_TARGET").length,
    approved: items.filter((item) => item.authorDecision?.decision === "approve").length,
    rejected: items.filter((item) => item.authorDecision?.decision === "reject").length,
  };
}
