/**
 * Experiment Policy 渲染（M13.6）。
 *
 * 把范围级授权视图（ExperimentPackageService.experimentPolicy）渲染成各
 * Agent 共享的简短口径。边界纪律：
 * - 这里**不出现任何具体指标数值**——数值级上下文（Experiment Context）
 *   只注入 Researcher / Outline / Writer / Revision 这些真正产出数值表述的角色；
 * - Feasibility / Reviewer 等评估角色只共享「哪些范围可用、哪些不可用、
 *   零授权时禁写数值」的政策口径，保证对实验数据的使用权限、可引用范围
 *   和缺失数据状态的判断一致（NB-11 类摘要/正文口径矛盾的收口）。
 */

import type { ExperimentPackageService } from "./ExperimentPackageService.js";

export type ExperimentPolicyView = Awaited<ReturnType<ExperimentPackageService["experimentPolicy"]>>;

const STATUS_LABEL: Record<string, string> = { candidate: "待核对", confirmed: "已确认", conflict: "有矛盾" };
const USE_LABEL: Record<string, string> = { allowed: "已授权进入工作流", excluded: "已明确排除", undecided: "未授权（不进入工作流）" };
const SPLIT_LABEL = (split: string) => (split === "unknown" ? "未声明范围" : split);

export function renderExperimentPolicyLines(policy: ExperimentPolicyView): string[] {
  const header = "===== Experiment Policy（实验数据使用口径；全体角色一致）=====";
  if (policy.entries.length === 0 && policy.legacyConfirmedGroupIds.length === 0) {
    return [
      "",
      header,
      "本项目当前没有已导入的实验数据：涉及实验结论的表述一律按「待补实验」处理，不得出现任何具体实验指标数值、超参数或统计量。",
    ];
  }
  const lines: string[] = ["", header];
  if (policy.legacyConfirmedGroupIds.length > 0) {
    lines.push(`旧版整组确认（schema v1）：实验组 ${policy.legacyConfirmedGroupIds.join("、")} 的观测按既有规则进入工作流上下文。`);
  }
  for (const entry of policy.entries) {
    lines.push(
      `- 实验组 ${entry.groupId} / 评测范围 ${SPLIT_LABEL(entry.split)}：${STATUS_LABEL[entry.status] ?? entry.status} · ${USE_LABEL[entry.workflowUse] ?? entry.workflowUse}（${entry.observationCount} 条观测 / ${entry.metricCount} 种指标）`,
    );
  }
  const allowed = policy.entries.filter((entry) => entry.workflowUse === "allowed").length;
  const blocked = policy.entries.filter((entry) => entry.workflowUse !== "allowed").length;
  if (allowed > 0) {
    lines.push(
      `口径：仅「已授权进入工作流」的范围（${allowed} 个）可作为当前论文的实验事实来源；其余 ${blocked} 个范围（未确认 / 未授权 / 已排除）的数据不得出现在大纲、摘要或正文的具体数值表述中。作者确认 = 记录真实 ≠ 外部核验（Verified Evidence）。`,
    );
  } else if (policy.entries.length > 0) {
    lines.push(
      "口径：当前没有任何已授权进入工作流的实验范围——任何角色不得写出具体实验指标数值、超参数或统计量；缺失的实验支撑应如实标注为待补实验（需作者完成实验数据核对与授权）。",
    );
  }
  return lines;
}
