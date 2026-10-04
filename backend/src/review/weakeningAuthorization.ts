/**
 * Typed Authorized Weakening（M11.2.1）。
 *
 * M11.2 真实 E2E 暴露的结构性冲突：Survey Reviewer 对弱证据 claim 做合理弱化
 * （加「据文献报道 / 尚待验证」限定、改定性表述、删无证据数值）时，Writer 的
 * 合法弱化会被 Fact Preservation 的方向哨兵（句子级首指标 / 末方向词启发式）
 * 误判为 metric_direction_flip——Reviewer 要求弱化 → Writer 弱化 → Guard 恢复
 * → Reviewer 再要求弱化的振荡。两个机制单独都正确；缺口是 Fact Preservation
 * 不知道「哪些变化已由 Reviewer → Revision Plan 明确授权」。
 *
 * 本模块定义最小扩展（不做 Policy Engine、不开 blanket bypass）：
 * - 授权只来自受控链：Reviewer Finding（needsEvidence / 弱化措辞）或
 *   Claim Grounding（UNSUPPORTED / CONTRADICTED）→ Revision Plan →
 *   授权台账（append-only）→ Writer 修订 → Fact Preservation 带类型核验。
 * - 两种类型，语义互斥：
 *   * weaken_claim_strength：只允许断言强度下降（加弱化限定 / 删强断言词）。
 *     数值 / 方向词 / 强表述 marker 必须保持不变（Fact Preservation 侧核验）。
 *   * remove_unsupported_detail：只允许删除目标细节（授权文本点名的数值）。
 *     永远不允许替换成另一个值（配对 swap 会进 changed 桶，fail-closed）。
 * - 授权粒度 = section 引用 + 授权文本（claim / finding 原文）；Fact
 *   Preservation 匹配沿用 sectionRefMatchesFile / mentionsValue 的既有口径，
 *   不建 NLP span matching。
 *
 * 诚实边界：授权匹配与类别核验都是确定性启发式（与 mentionsValue 同级），
 * 不是语义理解。同文件两处方向词对调互换（multiset 不变）不在本判定能力内，
 * 依赖每轮 claim grounding 复核与人工 HITL。
 */

import type { RevisionPlan, RevisionPlanItem } from "./revisionPlan.js";
import type { ClaimGroundingReport } from "./claimGrounding.js";
import { isUnsupportedVerdict } from "./claimGrounding.js";

/** 授权类型（语义见模块头；remove_claim 为 M11.2.3 新增窄授权） */
export type WeakeningAuthorizationKind =
  | "weaken_claim_strength"
  | "remove_unsupported_detail"
  | "remove_claim";

/** Fact Preservation 消费的最小输入形状（台账条目 / 匹配计划现场派生共用） */
export interface WeakeningAuthorizationInput {
  kind: WeakeningAuthorizationKind;
  /** 章节引用（路径 / 文件名 / stem / 括号多目标；与派发同口径的宽松匹配） */
  section: string;
  /** 授权文本（claim 原文 / finding problem+instruction；删除授权的数值点名来源） */
  targetSpan: string;
  /** 稳定条目标识（计划条目 id / claim 指纹） */
  itemId: string;
  findingId?: string;
  claimId?: string;
  /** 创建轮次（review round；审计追溯） */
  round?: number;
  reason?: string;
}

/** 指令文本中的弱化语义标记（reviewer 要求降低断言强度的确定性信号） */
const WEAKENING_INSTRUCTION_WORDS =
  /(弱化|降格|改为定性|定性表述|据报道|据其报告|据文献报告|据其报道|据其原文|待核验|尚待验证|尚待证据|保守表述|留作线索)/;

/** 指令文本中的删除语义标记（reviewer 明确要求删去无证据细节） */
const DETAIL_REMOVAL_WORDS = /(删去|删除|移除|去掉|剪除)/;

/** 授权文本长度上限（claim / finding 原文截断；防台账膨胀） */
const TARGET_SPAN_MAX_LENGTH = 600;

/**
 * 条目是否构成 weaken_claim_strength 授权（确定性）：
 * - needsEvidence 条目（fact / evidence_gap 类：证据不足只许弱化 / 删除），或
 * - 指令文本显式要求弱化口径。
 * 只认 review_finding / external_instruction（fact_preserve 是恢复指令，
 * 其 before → after 文本永不进入授权——M10.3.1 漂洗封堵语义保持）。
 */
function itemGrantsWeakening(item: RevisionPlanItem): boolean {
  if (item.kind !== "review_finding" && item.kind !== "external_instruction") {
    return false;
  }
  if (item.needsEvidence === true) {
    return true;
  }
  const text = `${item.problem}\n${item.instruction}`;
  return WEAKENING_INSTRUCTION_WORDS.test(text);
}

/** 已执行 / 已批准的条目同样构成授权（pairwise 判定在 gate 时刻消费的正是这些；skipped / rejected 除外） */
function itemAuthorizationEligible(item: RevisionPlanItem): boolean {
  return item.status !== "skipped" && item.status !== "rejected";
}

/**
 * 匹配修订计划 → 弱化授权（纯函数）。
 * 每个合格条目产出：weaken_claim_strength（必产）+ remove_unsupported_detail
 * （指令含删除语义时）。派生在两处消费：revision.plan 落台账（planned 条目）
 * 与 Fact Preservation 现场派生（匹配轮次计划，条目状态不限生命周期）——
 * 两处输入同源，结果确定性一致。
 */
export function derivePlanWeakeningAuthorizations(
  plan: RevisionPlan,
  options: { plannedOnly?: boolean } = {},
): WeakeningAuthorizationInput[] {
  const entries: WeakeningAuthorizationInput[] = [];
  for (const item of plan.items) {
    if (options.plannedOnly === true && item.status !== "planned") {
      continue;
    }
    if (!itemAuthorizationEligible(item) || !itemGrantsWeakening(item)) {
      continue;
    }
    const targetSpan = `${item.problem}\n${item.instruction}`.slice(0, TARGET_SPAN_MAX_LENGTH);
    const base = {
      section: item.section,
      targetSpan,
      itemId: item.id,
      ...(item.kind === "review_finding" ? { findingId: item.id } : {}),
      ...(plan.reviewRound !== undefined ? { round: plan.reviewRound } : {}),
    };
    entries.push({
      kind: "weaken_claim_strength",
      ...base,
      reason: `修订计划条目 ${item.id}（${item.needsEvidence === true ? "needsEvidence" : "弱化措辞"}）`,
    });
    if (DETAIL_REMOVAL_WORDS.test(targetSpan)) {
      entries.push({
        kind: "remove_unsupported_detail",
        ...base,
        reason: `修订计划条目 ${item.id} 明确要求删除无证据细节`,
      });
    }
  }
  return entries;
}

/**
 * Claim Grounding 报告 → 弱化授权（纯函数）。
 * UNSUPPORTED / CONTRADICTED claim 是 Reviewer（fact 模式）的结构化裁决：
 * - 每条产出 weaken_claim_strength（弱化为归因式 / 有限定表述）；
 * - claim 文本含数字时追加 remove_unsupported_detail（那些数值只许删除，
 *   不许替换——替换走 changed 桶须 Evidence / 计划点名双值授权）。
 */
export function deriveClaimGroundingWeakeningAuthorizations(
  report: ClaimGroundingReport,
): WeakeningAuthorizationInput[] {
  const entries: WeakeningAuthorizationInput[] = [];
  for (const claim of report.claims) {
    if (!isUnsupportedVerdict(claim.verdict)) {
      continue;
    }
    const targetSpan = claim.claim.slice(0, TARGET_SPAN_MAX_LENGTH);
    const base = {
      section: claim.section,
      targetSpan,
      itemId: `claimgrounding:${claim.claimId}`,
      claimId: claim.claimId,
      round: report.round,
    };
    entries.push({
      kind: "weaken_claim_strength",
      ...base,
      reason: `claim grounding r${report.round}：${claim.verdict}（无已核验证据支撑）`,
    });
    if (/\d/.test(claim.claim)) {
      entries.push({
        kind: "remove_unsupported_detail",
        ...base,
        reason: `claim grounding r${report.round}：${claim.verdict} 的无证据数值只许删除`,
      });
    }
  }
  return entries;
}

/** describe 口径（gate / 报告用） */
export function describeWeakeningAuthorizations(entries: readonly WeakeningAuthorizationInput[]): string {
  const weaken = entries.filter((entry) => entry.kind === "weaken_claim_strength").length;
  const removal = entries.filter((entry) => entry.kind === "remove_unsupported_detail").length;
  const removalClaim = entries.filter((entry) => entry.kind === "remove_claim").length;
  return `授权弱化 ${weaken} 条 / 授权删细节 ${removal} 条 / 授权删 claim ${removalClaim} 条`;
}

/**
 * M11.2.3：Claim Resolution Contract → typed 授权（纯函数）。
 * 只消费两个产生删除语义的动作（窄授权，不放大）：
 * - remove_unsupported_detail：claim 含数字且无 grounding 通路——数值只许删；
 * - remove_claim：弱化形态不可接受且语料无法支撑——整条删除（claim 文本点名，
 *   Fact Preservation 侧按 remove_unsupported_detail 同一消费路径放行「删除」
 *   方向，永远不放行替换 / 加强）。
 * use_existing_evidence / ground_existing_source 不产生授权（它们不改事实）；
 * weaken 的授权已由 deriveClaimGroundingWeakeningAuthorizations 覆盖，不重复铸造。
 */
export function deriveClaimResolutionAuthorizations(
  resolutions: readonly import("./claimResolution.js").ClaimResolution[],
  round: number,
): WeakeningAuthorizationInput[] {
  const entries: WeakeningAuthorizationInput[] = [];
  for (const resolution of resolutions) {
    if (resolution.action !== "remove_unsupported_detail" && resolution.action !== "remove_claim") {
      continue;
    }
    entries.push({
      kind: resolution.action,
      section: resolution.section,
      targetSpan: resolution.claim.slice(0, TARGET_SPAN_MAX_LENGTH),
      itemId: `resolution:${resolution.claimId}`,
      claimId: resolution.claimId,
      round,
      reason: `claim resolution r${round}（${resolution.action}）：${resolution.basis}`,
    });
  }
  return entries;
}
