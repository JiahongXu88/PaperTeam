/**
 * M14.9.5 P0：审稿 finding 的三轴口径——severity（问题本身的学术严重程度）、verification（能否只凭
 * 本文确认）、blocking（当前审稿场景下是否构成实质阻断）。三者分别判断，不互相机械推导。
 *
 * 依据（零模型归因，D:\PaperTeamData\M14_9_5_QualityGateReliability\severity-attribution.json）：
 * 长文档单元 prompt 与跨章 prompt 对 severity / blocking 没有任何书面定义（JSON 模板字面量
 * "blocking": false），已发表论文只读口径又只在禁止语境提到 blocking——同一根因（P008 粗率与校正
 * OR 方向反转、P016 校正 OR 与原始分布不相容）两轮间 blocking 由 true 变 false，差异无法解释；
 * 伦理批件年份这类只能凭外部记录判定的问题也只能计成已证实的 major。
 *
 * 本轮只在 published_paper_assessment 口径启用（renderPublishedAssessmentPolicyLines 注入）；作者稿件
 * 口径（thesis / MOT / existing-paper 有各自的实验事实边界）prompt 逐字节不变。生产 Quality Gate
 * 的计数与规则不读 verification——它只进入只读评估视图的分列与一致性提示，从不改写模型判定。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";

export type FindingVerification = "VERIFIED_IN_TEXT" | "AUTHOR_CHECK_REQUIRED" | "EXTERNAL_DATA_REQUIRED";

export const FINDING_VERIFICATIONS: readonly FindingVerification[] = ["VERIFIED_IN_TEXT", "AUTHOR_CHECK_REQUIRED", "EXTERNAL_DATA_REQUIRED"];

/** verification 解析：只承认大小写 / 分隔符差异；其余值视为未给出（不猜、不整条拒绝） */
export function normalizeFindingVerification(value: unknown): FindingVerification | undefined {
  if (typeof value !== "string") return undefined;
  const canonical = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (FINDING_VERIFICATIONS as readonly string[]).includes(canonical) ? (canonical as FindingVerification) : undefined;
}

/** 已发表论文只读评估的 severity / verification / blocking 口径（published 口径块的一部分） */
export function renderPublishedSeverityRubricLines(): string[] {
  return [
    "- 严重程度、可核验性、阻断三者分别判断：",
    "  · severity 表示问题本身的学术严重程度，与论文是否已发表无关。critical：已能从稿内证据确立、使论文的核心结论或主要结果不能成立或方向相反（例如核心结论所依据的数值与原始表格自相矛盾、无法同时成立）；major：削弱关键论证、方法有效性或结果解释（变量定义与测量不符、筛选口径与数据矛盾、结论超出结果等），以及核心结论受到实质质疑但需作者说明 / 补充分析才能定论的情况；minor：引用、统计描述、术语、表述等可修复的写作问题，不改变结论。",
    "  · 每条 issue 另给字段 verification：VERIFIED_IN_TEXT（只凭本文及其表格即可核对确认，如算术、表文不一致、方向矛盾、显著性与 P 值不符）/ AUTHOR_CHECK_REQUIRED（稿内存在具体疑点，但论文未报告的分析、变量分布或定义可能合理解释；或本单元未写、按章节索引可能写在其他章节的内容）/ EXTERNAL_DATA_REQUIRED（只有原始数据、伦理审批记录、外部文献原文等才能判定）。critical 必须是 VERIFIED_IN_TEXT；AUTHOR_CHECK_REQUIRED / EXTERNAL_DATA_REQUIRED 的问题不得写成「已经出错」，最高记 major。",
    "  · blocking 在本场景的含义：澄清之前，不应把论文摘要所述的某个核心结论当作可靠发现引用；它不是退稿 / 撤稿建议。只有 VERIFIED_IN_TEXT 且使该核心结论不可依赖的问题才设 blocking=true——不得因论文已发表而不设，也不得因缺少原始数据而设。",
    "  · 同一根因（同一组数值、同一处矛盾）只报告一次，写在最直接可定位的位置，其他位置的相关表述在 description 中一并列出；已复核且一致、算术正确的内容不要报告为问题。",
  ];
}

export type RubricFlag =
  /** blocking=true 但未声明 VERIFIED_IN_TEXT（rubric 要求阻断问题可只凭本文确认） */
  | "BLOCKING_WITHOUT_TEXT_VERIFICATION"
  /** critical 却声明需要作者 / 外部数据核验（rubric：此类问题最高 major） */
  | "CRITICAL_NOT_TEXT_VERIFIED"
  /** 模型未给出 verification（旧产物 / 作者稿件口径恒为此值） */
  | "VERIFICATION_UNSPECIFIED";

/** finding 与 rubric 的确定性一致性提示（只读：不改 severity / blocking，不进入 Gate） */
export function rubricFlags(issue: Pick<ReviewIssue, "severity" | "blocking" | "verification">): RubricFlag[] {
  const flags: RubricFlag[] = [];
  if (issue.verification === undefined) flags.push("VERIFICATION_UNSPECIFIED");
  if (issue.blocking && issue.verification !== undefined && issue.verification !== "VERIFIED_IN_TEXT") flags.push("BLOCKING_WITHOUT_TEXT_VERIFICATION");
  if (issue.severity === "critical" && issue.verification !== undefined && issue.verification !== "VERIFIED_IN_TEXT") flags.push("CRITICAL_NOT_TEXT_VERIFIED");
  return flags;
}
