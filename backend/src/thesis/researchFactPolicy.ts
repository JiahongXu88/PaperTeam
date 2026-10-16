/**
 * M14.6：Experiment Policy 与学位论文研究输入事实的**统一口径**（全体 Agent 同源）。
 *
 * M14.5 F5 的真实失败形态：review prompt 先说「本项目当前没有已导入的实验数据……不得出现
 * 任何具体实验指标数值」（Experiment Policy 零实验包行），紧接着才给出研究输入已确认事实表
 * ——两条指令自相矛盾，reviewer 取前者，把作者已确认的 75.37% 判为「无授权 / 仅见于外部来源」
 * 并要求删除。本模块把两者合成**一个**口径块：
 *
 * - 有已确认研究输入事实时，零实验包不再渲染「没有实验数据」行，而是明确说明本论文的
 *   实验数据与参数来源就是研究输入事实表；
 * - 既有实验包又有研究输入事实时，两者并列为合法来源；
 * - 事实行携带 Fact ID / ResearchInput ID / 来源锚点 / 核验与确认状态 / 冲突状态，
 *   Writer / Reviewer / Revision 对同一事实看到同一行（控制预算：≤ MAX_FACT_LINES 行）；
 * - source_verified 未确认事实只以计数 + 口径出现（不自动升级为 author_confirmed）；
 * - 不在表内、也无其他授权来源的具体数值仍按实验支撑缺口报告（反例必须仍能被拦截）。
 */

import { renderExperimentPolicyLines, type ExperimentPolicyView } from "../experiments/experimentPolicy.js";
import type { FactView, ResearchInputSummary } from "./researchInputTypes.js";

/** 单次注入的事实行上限（与 Writer 纪律块同预算） */
export const RESEARCH_FACT_POLICY_MAX_LINES = 30;

export const RESEARCH_FACT_POLICY_HEADER = "===== 学位论文研究输入已确认事实（Research Input Facts；全体角色一致）=====";

export interface ResearchFactPolicyContext {
  facts: {
    authorConfirmed: FactView[];
    sourceVerifiedUnconfirmed: FactView[];
    conflicted: FactView[];
  };
  inputs?: { included: ResearchInputSummary[] };
}

/** 事实行（统一渲染；Writer / Reviewer / Revision 同源） */
export function renderResearchFactLine(fact: FactView): string {
  const key = describeFactKey(fact);
  const unit = fact.value.unit !== undefined && fact.value.unit !== "" && !fact.surface.endsWith(fact.value.unit) ? `，单位 ${fact.value.unit}` : "";
  const verification =
    fact.verification === "author_confirmed"
      ? "作者已确认"
      : fact.verification === "source_verified"
        ? "来源核验通过、待作者确认"
        : "仅抽取";
  const conflict = fact.conflictStatus === "none" ? "" : `｜冲突 ${fact.conflictStatus}`;
  return `- ${fact.surface}（${key}${unit}）｜事实 ${fact.factId}｜来源 ${fact.researchInputId} ${fact.location}｜来源核验 ${fact.sourceCheck}｜${verification}${conflict}`;
}

function describeFactKey(fact: FactView): string {
  const key = fact.key;
  const parts: string[] = [];
  if (key.subject !== undefined && key.subject !== "") parts.push(key.subject);
  if (key.dataset !== undefined && key.dataset !== "") parts.push(key.dataset);
  if (key.metric !== undefined && key.metric !== "") parts.push(key.metric);
  if (key.parameter !== undefined && key.parameter !== "") parts.push(key.parameter);
  return parts.length > 0 ? parts.join(" / ") : fact.kind;
}

/** 已确认事实表（表头 + 口径 + 事实行；无已确认事实 → []） */
export function renderResearchFactTableLines(context: ResearchFactPolicyContext): string[] {
  const confirmed = context.facts.authorConfirmed;
  if (confirmed.length === 0) return [];
  const lines: string[] = ["", RESEARCH_FACT_POLICY_HEADER];
  const included = context.inputs?.included ?? [];
  if (included.length > 0) {
    lines.push(
      `研究输入（作者本人的已发表 / 已确认研究成果；版本以 contentHash 前 12 位标识）：${included
        .slice(0, 8)
        .map((input) => `${input.inputId}《${input.title}》${input.versionLabel !== undefined ? `（${input.versionLabel}）` : ""}#${input.contentHash.slice(0, 12)}`)
        .join("；")}${included.length > 8 ? `；其余 ${included.length - 8} 个略` : ""}`,
    );
  }
  lines.push(
    "本论文由作者已确认的研究输入扩展而成；下表数值经来源核验（quote 逐字命中原文 / 文本层）并由作者确认，是本论文合法的实验数据与参数来源（等价于已授权进入工作流的实验数据）。稿件中与下表一致的数值不得判为「无实验数据」「未授权」「仅见于外部来源」或「证据库无记录」；对其只核验口径（指标 / 条件 / 单位）与表述一致性。作者确认 = 来源真实 ≠ 外部独立复现：不要求删除，但不得夸大为外部已验证结论。",
  );
  for (const fact of confirmed.slice(0, RESEARCH_FACT_POLICY_MAX_LINES)) {
    lines.push(renderResearchFactLine(fact));
  }
  if (confirmed.length > RESEARCH_FACT_POLICY_MAX_LINES) {
    lines.push(`-（其余 ${confirmed.length - RESEARCH_FACT_POLICY_MAX_LINES} 条已确认事实略；数值出现在正文时同样视为合法来源）`);
  }
  if (context.facts.sourceVerifiedUnconfirmed.length > 0) {
    lines.push(
      `另有 ${context.facts.sourceVerifiedUnconfirmed.length} 条仅来源核验、未经作者确认的事实（不在上表）：其数值出现在正文时按「待作者确认」报告，不得写成作者已确认结论，也不自动视为已授权。`,
    );
  }
  if (context.facts.conflicted.length > 0) {
    lines.push(`存在 ${context.facts.conflicted.length} 条未裁决冲突事实：正文选取任一方数值均应报告为未裁决冲突。`);
  }
  lines.push("不在上表、也无实验包授权或已核验 Evidence 支撑的具体数值（指标 / 超参数 / 统计量）仍按实验支撑缺口如实报告。");
  return lines;
}

/**
 * Experiment Policy + 研究输入事实的统一口径块。
 * - 无已确认研究输入事实：与 renderExperimentPolicyLines 完全一致（非 thesis 项目零变化）。
 * - 有已确认事实、零实验包：不渲染「没有已导入的实验数据」行，改为「数据来源 = 研究输入事实表」。
 * - 有已确认事实、有实验包：两者并列。
 */
export function composeExperimentAndResearchFactPolicyLines(
  policy: ExperimentPolicyView,
  factContext: ResearchFactPolicyContext | null,
): string[] {
  const confirmed = factContext?.facts.authorConfirmed ?? [];
  if (factContext === null || confirmed.length === 0) {
    return renderExperimentPolicyLines(policy);
  }
  const zeroPackages = policy.entries.length === 0 && policy.legacyConfirmedGroupIds.length === 0;
  if (zeroPackages) {
    return [
      "",
      "===== Experiment Policy（实验数据使用口径；全体角色一致）=====",
      "本项目没有导入独立的实验包；本论文的实验数据与参数来源是下方「研究输入已确认事实」表（作者本人已发表 / 已确认的研究成果）。不得把未来实验写为已完成结果；不在该表内且无其他授权来源的具体实验指标数值、超参数或统计量仍按实验支撑缺口如实报告。",
      ...renderResearchFactTableLines(factContext),
    ];
  }
  return [
    ...renderExperimentPolicyLines(policy),
    "除上述实验包范围外，以下研究输入已确认事实同为本论文合法的实验数据与参数来源：",
    ...renderResearchFactTableLines(factContext),
  ];
}
